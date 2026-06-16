import client from 'prom-client';

export const register = new client.Registry();

register.setDefaultLabels({ app: 'spv-backend' });
client.collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// HTTP request metrics
// ---------------------------------------------------------------------------

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Background job metrics
// ---------------------------------------------------------------------------

export const jobRunsTotal = new client.Counter({
  name: 'job_runs_total',
  help: 'Total background job runs',
  labelNames: ['job', 'status'] as const,
  registers: [register],
});

export const jobDuration = new client.Histogram({
  name: 'job_duration_seconds',
  help: 'Duration of background job runs in seconds',
  labelNames: ['job'] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

export const jobRowsProcessed = new client.Counter({
  name: 'job_rows_processed_total',
  help: 'Total rows processed by background jobs',
  labelNames: ['job'] as const,
  registers: [register],
});

export const jobRowsFailed = new client.Counter({
  name: 'job_rows_failed_total',
  help: 'Total rows failed in background jobs',
  labelNames: ['job'] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// DB + Redis connectivity gauges
// ---------------------------------------------------------------------------

export const dbUp = new client.Gauge({
  name: 'db_up',
  help: '1 when main database is reachable, 0 when not',
  registers: [register],
});

export const redisUp = new client.Gauge({
  name: 'redis_up',
  help: '1 when Redis is reachable, 0 when not, -1 when not configured',
  registers: [register],
});

// ---------------------------------------------------------------------------
// Active connections / in-flight
// ---------------------------------------------------------------------------

export const httpActiveRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'Number of HTTP requests currently being processed',
  registers: [register],
});
