import type { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestsTotal, httpActiveRequests } from '../config/metrics.js';

function normalizeRoute(req: Request): string {
  if (req.route?.path) {
    return req.baseUrl + (req.route.path === '/' ? '' : req.route.path);
  }
  const url = req.originalUrl.split('?')[0] ?? req.originalUrl;
  return url
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  httpActiveRequests.inc();

  res.on('finish', () => {
    httpActiveRequests.dec();
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const route = normalizeRoute(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });

  next();
}
