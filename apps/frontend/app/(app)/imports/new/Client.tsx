'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  ACTIVE_IMPORT_STATUSES,
  downloadAuthedBlob,
  IMPORTS_QK,
  newIdempotencyKey,
  rememberImportId,
  type ImportStatus,
} from '@/features/io/util';
import LabeledField from '@/components/LabeledField';

type Resource = 'students' | 'institutions' | 'programs' | 'enrollments' | 'program_fees';

const RESOURCES: { value: Resource; label: string; hint: string }[] = [
  { value: 'students', label: 'Students', hint: 'Names, DoB, contact, passport identity.' },
  { value: 'institutions', label: 'Institutions', hint: 'Universities, colleges, training providers.' },
  { value: 'programs', label: 'Programs', hint: 'Course catalogue per institution.' },
  { value: 'enrollments', label: 'Enrollments', hint: 'Links a student to a program offering.' },
  { value: 'program_fees', label: 'Program fees', hint: 'Tuition tiers and payment schedules.' },
];

const STEPS = ['Choose resource', 'Upload file', 'Review dry-run', 'Apply', 'Done'];

type StartImportResponse = {
  import_job_id: string;
  status: ImportStatus;
  sniffed_encoding: 'utf-8' | 'unknown';
  sniffed_delimiter: ',' | ';' | '\t' | '|' | null;
  header_sample: string[][];
  suggested_mapping: Record<string, string>;
};

type ImportJob = {
  id: string;
  status: ImportStatus;
  resource: Resource;
  source_filename: string;
  mapping_json: Record<string, string> | null;
  row_total: number | null;
  row_processed: number | null;
  row_created: number | null;
  row_updated: number | null;
  row_skipped: number | null;
  row_failed: number | null;
  error_report_key: string | null;
  result_key: string | null;
};

type ReportSampleError = {
  row_number: number;
  field: string;
  value: unknown;
  error: string;
};

type ReportResponse = {
  totals: { will_create: number; will_update: number; will_skip: number; errors: number };
  sample_errors: ReportSampleError[];
};

export default function NewImportPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const isViewer = user?.role === 'VIEWER';

  const [resource, setResource] = useState<Resource>('students');
  const [file, setFile] = useState<File | null>(null);

  // job state — pre-seeded if ?job=ID is present (e.g. "View / continue" from list).
  const seededJobId = params.get('job');
  const [jobId, setJobId] = useState<string | null>(seededJobId);
  const [startResp, setStartResp] = useState<StartImportResponse | null>(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [downloadingResult, setDownloadingResult] = useState(false);

  // ----- Job polling (live status while uploading/parsing/applying) ---------
  const jobQuery = useQuery<ImportJob>({
    queryKey: jobId ? IMPORTS_QK.detail(jobId) : ['imports', 'detail', 'none'],
    queryFn: async () => {
      const res = await api.get<ImportJob>(`/imports/${jobId}`);
      return res.data;
    },
    enabled: !!jobId,
    refetchInterval: (q) => {
      const data = q.state.data as ImportJob | undefined;
      if (!data) return 2000;
      return ACTIVE_IMPORT_STATUSES.has(data.status) ? 2000 : false;
    },
  });

  const job = jobQuery.data;

  // ----- Dry-run report (run once after upload) ----------------------------
  const reportQuery = useQuery<ReportResponse>({
    queryKey: jobId ? IMPORTS_QK.report(jobId) : ['imports', 'report', 'none'],
    queryFn: async () => {
      const res = await api.get<ReportResponse>(`/imports/${jobId}/report`);
      return res.data;
    },
    enabled:
      !!jobId &&
      !!job &&
      (job.status === 'DRY_RUN_READY' ||
        job.status === 'COMPLETED' ||
        job.status === 'FAILED'),
  });

  // ----- Mutations ---------------------------------------------------------
  const uploadMut = useMutation({
    mutationFn: async (input: { resource: Resource; file: File }) => {
      const fd = new FormData();
      fd.append('file', input.file);
      const res = await api.post<StartImportResponse>(
        `/imports/${input.resource}`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return res.data;
    },
    onSuccess: (data) => {
      setStartResp(data);
      setJobId(data.import_job_id);
      rememberImportId(data.import_job_id);
      enqueueSnackbar('File uploaded — running dry-run.', { variant: 'success' });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Upload failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const applyMut = useMutation({
    mutationFn: async () => {
      if (!jobId || !job) throw new Error('No job to apply');
      const mapping =
        startResp?.suggested_mapping ?? job.mapping_json ?? {};
      const idem = newIdempotencyKey();
      const res = await api.post(
        `/imports/${jobId}/apply`,
        { mapping_json: mapping },
        { headers: { 'Idempotency-Key': idem } },
      );
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Apply started.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: IMPORTS_QK.all });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Apply failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const cancelMut = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error('No job');
      await api.post(`/imports/${jobId}/cancel`, {});
    },
    onSuccess: () => {
      enqueueSnackbar('Import cancelled.', { variant: 'info' });
      void qc.invalidateQueries({ queryKey: IMPORTS_QK.all });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Cancel failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // ----- Template download -------------------------------------------------
  const handleTemplateDownload = async () => {
    setDownloadingTemplate(true);
    try {
      await downloadAuthedBlob(
        `/imports/${resource}/template.csv`,
        `${resource}-template.csv`,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setDownloadingTemplate(false);
    }
  };

  const handleResultDownload = async () => {
    if (!jobId) return;
    setDownloadingResult(true);
    try {
      await downloadAuthedBlob(`/imports/${jobId}/result.jsonl`, `result-${jobId}.jsonl`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setDownloadingResult(false);
    }
  };

  const handleErrorsDownload = async () => {
    if (!jobId) return;
    try {
      await downloadAuthedBlob(`/imports/${jobId}/errors.jsonl`, `errors-${jobId}.jsonl`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(msg, { variant: 'error' });
    }
  };

  // Auto-progress step indicator based on job state.
  const computedStep = useMemo(() => {
    if (!jobId) return file ? 1 : 0;
    if (!job) return 2;
    if (job.status === 'COMPLETED') return 4;
    if (job.status === 'APPLYING') return 3;
    if (job.status === 'DRY_RUN_READY') return 2;
    if (job.status === 'FAILED' || job.status === 'CANCELLED') return 4;
    return 2;
  }, [jobId, file, job]);

  // When user picks a file, kick off the upload immediately.
  useEffect(() => {
    if (!file || jobId) return;
    if (isViewer) return;
    uploadMut.mutate({ resource, file });
    // Fire only on a new file selection; depending on `uploadMut`/`jobId`
    // would re-trigger uploads as the mutation transitions through states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // ----- Render ------------------------------------------------------------
  if (isViewer) {
    return (
      <Stack spacing={3}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>
          New import
        </Typography>
        <Alert severity="info">
          Viewers cannot start imports. Ask a counsellor or admin.
        </Alert>
        <Button
          startIcon={<ArrowBackIcon />}
          component={Link}
          href="/imports"
          sx={{ alignSelf: 'flex-start' }}
        >
          Back to imports
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Button
          startIcon={<ArrowBackIcon />}
          component={Link}
          href="/imports"
          sx={{ alignSelf: 'flex-start' }}
          size="small"
        >
          Back to imports
        </Button>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          New import
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Upload a CSV / JSON / JSONL file. We auto-detect headers, run a dry-run, and apply in chunked transactions on confirm.
        </Typography>
      </Stack>

      <Stepper activeStep={computedStep} alternativeLabel>
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Step 1 — resource picker */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
            1. Choose the resource
          </Typography>
          {/* Required-field legend — explicit so the convention is unambiguous. */}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>
          <LabeledField
            label="Resource type"
            required
            helperText="Pick the destination table for this upload."
          >
            <FormControl disabled={!!jobId}>
              <RadioGroup
                value={resource}
                onChange={(e) => setResource(e.target.value as Resource)}
              >
                {RESOURCES.map((r) => (
                  <FormControlLabel
                    key={r.value}
                    value={r.value}
                    control={<Radio size="small" />}
                    label={
                      <Stack>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {r.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {r.hint}
                        </Typography>
                      </Stack>
                    }
                    sx={{ mb: 0.5 }}
                  />
                ))}
              </RadioGroup>
            </FormControl>
          </LabeledField>
          <Box sx={{ mt: 2 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={
                downloadingTemplate ? <CircularProgress size={14} /> : <DownloadOutlinedIcon />
              }
              onClick={handleTemplateDownload}
              disabled={downloadingTemplate}
            >
              Download {resource}-template.csv
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* Step 2 — file upload */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
            2. Upload file
          </Typography>
          <LabeledField
            label="Source file"
            required
            helperText="Accepted: .csv, .json, .jsonl, .ndjson. Encoding and delimiter are auto-detected."
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
              <Button
                variant="contained"
                component="label"
                disabled={uploadMut.isPending || !!jobId}
              >
                {file ? `Change file (${file.name})` : 'Select .csv / .json / .jsonl'}
                <input
                  type="file"
                  hidden
                  accept=".csv,.json,.jsonl,.ndjson,application/json,text/csv,application/x-ndjson"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setFile(f);
                  }}
                />
              </Button>
            {uploadMut.isPending ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  Uploading…
                </Typography>
              </Stack>
            ) : null}
              {startResp ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    label={`encoding: ${startResp.sniffed_encoding}`}
                  />
                  {startResp.sniffed_delimiter ? (
                    <Chip
                      size="small"
                      label={`delimiter: ${
                        startResp.sniffed_delimiter === '\t' ? '\\t' : startResp.sniffed_delimiter
                      }`}
                    />
                  ) : null}
                </Stack>
              ) : null}
            </Stack>
          </LabeledField>
          {startResp && Object.keys(startResp.suggested_mapping).length > 0 ? (
            <Box sx={{ mt: 2 }}>
              {/* Mapping preview — read-only confirm step. The auto-detected
                  source→target column mapping is surfaced in a table so the
                  reviewer can sanity-check before kicking off Apply. */}
              <LabeledField
                label="Suggested column mapping"
                helperText="Auto-detected from the file headers. Apply uses this mapping verbatim."
              >
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Source column</TableCell>
                        <TableCell>Maps to</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(startResp.suggested_mapping).map(([src, target]) => (
                        <TableRow key={src}>
                          <TableCell sx={{ fontFamily: 'monospace' }}>{src}</TableCell>
                          <TableCell sx={{ fontFamily: 'monospace' }}>{target}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </LabeledField>
            </Box>
          ) : null}
        </CardContent>
      </Card>

      {/* Step 3 — dry-run report */}
      {jobId ? (
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                3. Dry-run report
              </Typography>
              {job ? (
                <Chip
                  size="small"
                  label={job.status}
                  color={
                    job.status === 'COMPLETED'
                      ? 'success'
                      : job.status === 'FAILED'
                        ? 'error'
                        : job.status === 'CANCELLED'
                          ? 'default'
                          : job.status === 'DRY_RUN_READY'
                            ? 'warning'
                            : 'info'
                  }
                />
              ) : null}
            </Stack>
            {reportQuery.isLoading ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  Building dry-run report…
                </Typography>
              </Stack>
            ) : reportQuery.isError ? (
              <Alert severity="error">
                {reportQuery.error instanceof ApiError
                  ? reportQuery.error.detail || reportQuery.error.title
                  : 'Could not build report'}
              </Alert>
            ) : reportQuery.data ? (
              <Stack spacing={2}>
                <Stack direction="row" spacing={1.5} flexWrap="wrap">
                  <Chip
                    label={`Will create: ${reportQuery.data.totals.will_create}`}
                    color="success"
                    variant="outlined"
                  />
                  <Chip
                    label={`Will update: ${reportQuery.data.totals.will_update}`}
                    color="info"
                    variant="outlined"
                  />
                  <Chip
                    label={`Will skip: ${reportQuery.data.totals.will_skip}`}
                    variant="outlined"
                  />
                  <Chip
                    label={`Errors: ${reportQuery.data.totals.errors}`}
                    color="error"
                    variant="outlined"
                  />
                </Stack>
                {reportQuery.data.sample_errors.length > 0 ? (
                  <>
                    <Typography variant="subtitle2">
                      First {reportQuery.data.sample_errors.length} validation errors
                    </Typography>
                    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
                      <Table size="small" stickyHeader>
                        <TableHead>
                          <TableRow>
                            <TableCell>Row</TableCell>
                            <TableCell>Field</TableCell>
                            <TableCell>Value</TableCell>
                            <TableCell>Error</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {reportQuery.data.sample_errors.map((e, i) => (
                            <TableRow key={`${e.row_number}-${e.field}-${i}`}>
                              <TableCell>{e.row_number}</TableCell>
                              <TableCell sx={{ fontFamily: 'monospace' }}>{e.field}</TableCell>
                              <TableCell sx={{ fontFamily: 'monospace' }}>
                                {String(e.value ?? '')}
                              </TableCell>
                              <TableCell>{e.error}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<DownloadOutlinedIcon />}
                      onClick={handleErrorsDownload}
                    >
                      Download all errors (errors.jsonl)
                    </Button>
                  </>
                ) : (
                  <Alert severity="success" variant="outlined">
                    No validation errors detected.
                  </Alert>
                )}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Report will appear here once the job is parsed.
              </Typography>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Step 4 — apply + progress */}
      {jobId && job ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
              4. Apply
            </Typography>
            {job.status === 'APPLYING' ? (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  Applying chunks of 500 rows in idempotent transactions…
                </Typography>
                <LinearProgress
                  variant={
                    job.row_total && job.row_total > 0 ? 'determinate' : 'indeterminate'
                  }
                  value={
                    job.row_total && job.row_total > 0
                      ? Math.min(100, ((job.row_processed ?? 0) / job.row_total) * 100)
                      : undefined
                  }
                />
                <Typography variant="caption" color="text.secondary">
                  Processed {job.row_processed ?? 0} / {job.row_total ?? '?'} ·
                  created {job.row_created ?? 0} ·
                  updated {job.row_updated ?? 0} ·
                  failed {job.row_failed ?? 0}
                </Typography>
                <Button
                  size="small"
                  color="warning"
                  variant="outlined"
                  onClick={() => cancelMut.mutate()}
                  disabled={cancelMut.isPending}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Cancel apply
                </Button>
              </Stack>
            ) : job.status === 'COMPLETED' ? (
              <Stack spacing={1}>
                <Alert severity="success" variant="outlined">
                  Apply complete. Created {job.row_created ?? 0}, updated {job.row_updated ?? 0},
                  skipped {job.row_skipped ?? 0}, failed {job.row_failed ?? 0}.
                </Alert>
              </Stack>
            ) : job.status === 'FAILED' ? (
              <Alert severity="error">Job failed. See errors.jsonl for details.</Alert>
            ) : job.status === 'CANCELLED' ? (
              <Alert severity="warning">Job cancelled.</Alert>
            ) : (
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Button
                  variant="contained"
                  startIcon={<PlayArrowIcon />}
                  disabled={(() => {
                    if (applyMut.isPending) return true;
                    if (job.status !== 'DRY_RUN_READY') return true;
                    const r = reportQuery.data;
                    if (!r) return false;
                    // Block apply only when *every* row would error.
                    if (r.totals.errors > 0 && r.totals.will_create + r.totals.will_update === 0) {
                      return true;
                    }
                    return false;
                  })()}
                  onClick={() => applyMut.mutate()}
                >
                  {applyMut.isPending ? 'Starting…' : 'Apply now'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Sends an Idempotency-Key so retries are safe.
                </Typography>
              </Stack>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Step 5 — result */}
      {jobId && job?.status === 'COMPLETED' ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
              5. Download result
            </Typography>
            <Stack direction="row" spacing={1.5}>
              <Button
                variant="contained"
                startIcon={
                  downloadingResult ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : (
                    <DownloadOutlinedIcon />
                  )
                }
                disabled={!job.result_key || downloadingResult}
                onClick={handleResultDownload}
              >
                Download result.jsonl
              </Button>
              <Button
                variant="outlined"
                onClick={() => router.push('/students')}
              >
                Go to /students
              </Button>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <Button onClick={() => router.push('/imports')}>Back to imports list</Button>
          </CardContent>
        </Card>
      ) : null}
    </Stack>
  );
}
