// SVT-SEC-MFA-STEPUP-2026-05 — inline 6-digit TOTP prompt that appears under
// a billing form when the server returns 401 { code: 'mfa_required' }.
//
// Deliberately tiny: a single text input + helper line. We do NOT spin a
// second modal — the user is already mid-task in a confirmation dialog, and
// a stacked modal would feel hostile. Submitting the dialog with the field
// populated re-runs the same mutation with `mfa_code` in the payload (which
// queries.ts forwards as `X-MFA-Code`).
//
// State lives in the parent dialog (so the parent can clear it after a
// successful submit). We only render the controlled input + the helper text
// the FE shows based on the last error code.

'use client';

import { Alert, Box, TextField } from '@mui/material';

export type MfaStepUpStatus = 'idle' | 'required' | 'invalid' | 'replay';

const HELPER_BY_STATUS: Record<Exclude<MfaStepUpStatus, 'idle'>, { severity: 'info' | 'warning' | 'error'; text: string }> = {
  required: {
    severity: 'info',
    text: 'This action needs a second factor — enter your 6-digit authenticator code, then re-submit.',
  },
  invalid: {
    severity: 'error',
    text: 'That code did not verify. Open your authenticator app and try the current 6-digit code.',
  },
  replay: {
    severity: 'warning',
    text: 'That code was just used — wait for your authenticator to roll to the next 6-digit code.',
  },
};

type Props = {
  status: MfaStepUpStatus;
  value: string;
  onChange: (v: string) => void;
  /** Optional id — useful when several copies coexist on one page. */
  id?: string;
};

export function MfaStepUpField({ status, value, onChange, id = 'mfa-stepup-code' }: Props) {
  if (status === 'idle') return null;
  const meta = HELPER_BY_STATUS[status];
  return (
    <Box>
      <Alert severity={meta.severity} variant="outlined" sx={{ mb: 1 }}>
        {meta.text}
      </Alert>
      <TextField
        id={id}
        label="Authenticator code"
        size="small"
        fullWidth
        autoFocus
        inputMode="numeric"
        // Strip non-digits as the user types so paste-with-spaces still works.
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputProps={{ maxLength: 6, pattern: '\\d{6}', 'aria-label': 'Authenticator code' }}
        placeholder="123456"
      />
    </Box>
  );
}

/**
 * Map an ApiError onto an MfaStepUpStatus. Returns null when the error is
 * unrelated to step-up (so the caller can fall through to normal handling).
 */
export function mfaStatusFromError(err: unknown): MfaStepUpStatus | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (code === 'mfa_required') return 'required';
  if (code === 'mfa_invalid') return 'invalid';
  if (code === 'mfa_replay') return 'replay';
  return null;
}
