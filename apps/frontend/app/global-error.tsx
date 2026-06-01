'use client';

// SVT-AUDIT-FE-POLISH-2026-05 — last-resort root error boundary.
// Per Next.js docs, global-error.tsx must render its own <html>/<body> because
// it replaces the root layout when an error escapes every other boundary. Keep
// it dependency-free (no MUI) so it can still render even if the theme/provider
// is what crashed.

import { useEffect } from 'react';
import { reportBoundaryError } from '@/lib/reportError';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function GlobalError({ error, reset }: Props) {
  useEffect(() => {
    // SVT-SEC-P2-FE4-2026-05 — dev: rich console; prod: sanitised beacon
    // (no message, no stack) to /api/v1/security/error-report.
    reportBoundaryError('global', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          background: '#fafafa',
          color: '#1f1f1f',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}
      >
        <div
          role="alert"
          aria-live="assertive"
          style={{
            maxWidth: 480,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: '#fde7e7',
              color: '#c62828',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 700,
              marginBottom: 16,
            }}
            aria-hidden
          >
            !
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: '0 0 12px' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#555', margin: '0 0 8px', lineHeight: 1.5 }}>
            {/* SVT-SEC-P2-FE4-2026-05 — never surface raw error.message in
               production; it can leak stack/file paths from server errors. */}
            {process.env.NODE_ENV !== 'production' && error.message
              ? error.message
              : 'An unexpected error occurred. The team has been notified.'}
          </p>
          {error.digest ? (
            <p style={{ color: '#777', fontSize: 12, margin: '0 0 16px' }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderRadius: 6,
                background: '#1A73E8',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Try again
            </button>
            {/* global-error.tsx remounts root layout — use <a>, not next/link */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                padding: '8px 16px',
                border: '1px solid #ccc',
                borderRadius: 6,
                color: '#1f1f1f',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
                background: '#fff',
              }}
            >
              Back to home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
