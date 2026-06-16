// Background-job runner: combines lock acquisition, retries with exponential
// backoff, and JobRun recording into a single helper.
//
//   await runJob('reminder.dispatcher', { ttlSec: 60 * 60 }, async () => {
//     const r = await runDispatchPass();
//     return { rowsProcessed: r.processed, rowsFailed: r.failed };
//   });
//
// Behaviour:
//   - Acquire a Postgres advisory lock keyed by job name. If another replica
//     holds it, insert a SKIPPED_LOCKED JobRun and return.
//   - Otherwise insert a RUNNING JobRun, then call `withRetry` (3 attempts,
//     1s/5s/15s backoff). On success, update to SUCCEEDED with row counts.
//     On failure, update to FAILED with the error message — do NOT throw.
//   - Optionally write an audit row via writeAudit(); never blocks on its
//     completion.
//
// Failure containment is the central invariant: a thrown error must never
// propagate up into the scheduler interval callback, because that would
// kill the timer and silently disable the job until the next process restart.

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { captureJobException, startJobSpan } from '../config/sentry.js';
import { writeAudit } from '../shared/audit.js';

import { withJobLock } from './lock.js';

export type JobOutcome = {
  rowsProcessed?: number;
  rowsFailed?: number;
  metadata?: Record<string, unknown>;
};

export type RunJobOpts = {
  /**
   * Advisory lock TTL hint (Postgres has no real TTL — released on session
   * end or explicit unlock). Kept for documentation + future migration to
   * a real lock service.
   */
  ttlSec: number;
  /** Max retry attempts (default 3). */
  attempts?: number;
};

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000];

/**
 * Wrap `fn` with exponential backoff retries. Logs every attempt + retry.
 *
 * Returns the value from the last successful attempt; rethrows the last
 * error if every attempt fails.
 */
export async function withRetry<T>(
  name: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  const max = Math.max(1, attempts);
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === max - 1;
      if (isLast) {
        logger.error({ jobName: name, attempt: i + 1, max, err }, 'job: attempt failed (final)');
      } else {
        const wait = DEFAULT_BACKOFF_MS[i] ?? DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1]!;
        logger.warn(
          { jobName: name, attempt: i + 1, max, err, retryInMs: wait },
          'job: attempt failed, retrying',
        );
        // Report intermediate failures too — a job that recovers on attempt 3
        // is still a signal worth surfacing in Sentry as a breadcrumb-level
        // anomaly. We tag attempt so Sentry can group "always-final-fails"
        // separately from "flaky-but-recovers".
        captureJobException(err, { job: name, attempt: i + 1 });
        await new Promise<void>((resolve) => setTimeout(resolve, wait).unref());
      }
    }
  }
  throw lastErr;
}

/**
 * Acquire the advisory lock, record a JobRun, run the job under retry, and
 * persist the outcome. Returns the JobRun id (null when the run was skipped
 * because another replica held the lock).
 */
export async function runJob(
  jobName: string,
  opts: RunJobOpts,
  fn: () => Promise<JobOutcome | void>,
): Promise<string | null> {
  const attempts = opts.attempts ?? 3;

  // The locked body: insert RUNNING, run under retry, persist outcome. Extracted
  // so the entire withJobLock(...) call can sit inside a try/catch below — see
  // the catch for why that matters (lock-acquisition is fail-CLOSED and throws
  // BEFORE this body runs).
  const locked = async (): Promise<string | null> => {
    const startedAt = new Date();
    let runId: string | null = null;
    try {
      const created = await prisma.jobRun.create({
        data: { job_name: jobName, started_at: startedAt, status: 'RUNNING' },
        select: { id: true },
      });
      runId = created.id;
    } catch (err) {
      // If we can't record the run we still want the work to happen — the
      // alternative is to silently never run the job. Log loudly.
      logger.warn({ err, jobName }, 'runJob: failed to insert RUNNING JobRun row');
    }

    try {
      const raw = await startJobSpan<JobOutcome | void>(jobName, () =>
        withRetry(jobName, attempts, fn),
      );
      const out: JobOutcome = (raw ?? {}) as JobOutcome;
      const finishedAt = new Date();
      const rowsProcessed = out.rowsProcessed ?? 0;
      const rowsFailed = out.rowsFailed ?? 0;
      const status = rowsFailed > 0 ? 'PARTIAL' : 'SUCCEEDED';
      if (runId) {
        await prisma.jobRun.update({
          where: { id: runId },
          data: {
            finished_at: finishedAt,
            status,
            rows_processed: rowsProcessed,
            rows_failed: rowsFailed,
            metadata: (out.metadata ?? null) as never,
          },
        });
      }
      // Audit successful background runs at INFO-equivalent so we have a
      // tamper-evident trail for compliance reviews. Never throws.
      void writeAudit({
        action: `job.${jobName}.run`,
        entityType: 'JobRun',
        entityId: runId ?? null,
        after: { status, rowsProcessed, rowsFailed, durationMs: finishedAt.getTime() - startedAt.getTime() },
      });
      logger.info(
        { jobName, runId, status, rowsProcessed, rowsFailed, durationMs: finishedAt.getTime() - startedAt.getTime() },
        'job: completed',
      );
      return runId;
    } catch (err) {
      // All retries exhausted — record FAILED and swallow. Do NOT rethrow:
      // the scheduler interval callback must keep firing.
      const finishedAt = new Date();
      const message = errorMessage(err);
      if (runId) {
        try {
          await prisma.jobRun.update({
            where: { id: runId },
            data: { finished_at: finishedAt, status: 'FAILED', error_message: message.slice(0, 4000) },
          });
        } catch (updErr) {
          logger.error({ updErr, jobName, runId }, 'runJob: failed to record FAILED status');
        }
      }
      void writeAudit({
        action: `job.${jobName}.failed`,
        entityType: 'JobRun',
        entityId: runId ?? null,
        after: { error: message.slice(0, 1000) },
      });
      logger.error(
        { err, jobName, runId, durationMs: finishedAt.getTime() - startedAt.getTime() },
        'job: all retries failed',
      );
      // SVT-OBS-JOBS-2026-05 — report to Sentry with job tag so the
      // observability stack catches cron/worker failures that never touched
      // the express error handler. Sentry-disabled environments no-op.
      captureJobException(
        err,
        { job: jobName },
        {
          runId,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          attempts,
        },
      );
      return runId;
    }
  };

  try {
    return await withJobLock(jobName, opts.ttlSec, locked).then(async (result) => {
      if (result === null) {
        // Lock was already held — record a SKIPPED_LOCKED row so observers can
        // see that the trigger fired but yielded to another replica.
        try {
          const skipped = await prisma.jobRun.create({
            data: {
              job_name: jobName,
              started_at: new Date(),
              finished_at: new Date(),
              status: 'SKIPPED_LOCKED',
            },
            select: { id: true },
          });
          logger.debug({ jobName, runId: skipped.id }, 'job: skipped (lock held by another replica)');
          return skipped.id;
        } catch (err) {
          logger.warn({ err, jobName }, 'runJob: failed to record SKIPPED_LOCKED row');
          return null;
        }
      }
      return result;
    });
  } catch (err) {
    // SVT-REL-2026-06 — Lock acquisition itself failed. withJobLock is
    // fail-CLOSED: it throws here BEFORE the job fn runs (e.g. Postgres
    // unreachable), so the inner try/catch never sees it. Absorb it: the
    // scheduler invokes runJob as `void runJob()`, and a rejected promise there
    // hits server.ts's process.on('unhandledRejection') → process.exit(1),
    // crash-looping the whole API on a transient DB blip. Skip this cycle and
    // let the next trigger retry.
    logger.error({ err, jobName }, 'runJob: lock acquisition failed — run skipped this cycle');
    captureJobException(err, { job: jobName }, { phase: 'lock-acquire' });
    try {
      await prisma.jobRun.create({
        data: {
          job_name: jobName,
          started_at: new Date(),
          finished_at: new Date(),
          status: 'FAILED',
          error_message: errorMessage(err).slice(0, 4000),
        },
      });
    } catch {
      // DB likely unreachable too — nothing we can persist. Already logged above.
    }
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
