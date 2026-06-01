'use client';

// SVT-WAVE-DSAR-PUBLIC-2026-05 — public DSAR submission form.
//
// Hidden branding chrome (no AppShell, no logo, no app name in the visible
// header). The endpoint is at POST /api/v1/public/dsar and always returns a
// generic success message regardless of whether a matching subject exists, so
// this UI never differentiates "submitted" from "subject not found".
//
// tenant_id is taken from the `tenant` query string (passed in the privacy-
// policy link). The user can also paste it manually as a fallback — schools
// are increasingly using QR codes that omit the param.

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { PublicDSARRequest, type PublicDSARRequest as PublicDSARRequestType } from '@spv/zod-schemas';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

const DSAR_TYPE_OPTIONS: Array<{ value: PublicDSARRequestType['dsar_type']; label: string }> = [
  { value: 'ACCESS', label: 'Access — get a copy of my data' },
  { value: 'PORTABILITY', label: 'Portability — get my data in a portable format' },
  { value: 'ERASURE', label: 'Erasure — delete my data' },
  { value: 'RECTIFICATION', label: 'Rectification — correct my data' },
  { value: 'RESTRICTION', label: 'Restriction — limit how my data is used' },
  { value: 'OBJECTION', label: 'Objection — object to processing of my data' },
];

const SUBJECT_TYPE_OPTIONS: Array<{
  value: PublicDSARRequestType['subject_type'];
  label: string;
}> = [
  { value: 'student', label: 'Student / applicant' },
  { value: 'user', label: 'Staff user' },
];

export default function PublicDsarClient() {
  const searchParams = useSearchParams();
  const tenantFromQuery = searchParams?.get('tenant') ?? '';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PublicDSARRequestType>({
    resolver: zodResolver(PublicDSARRequest),
    mode: 'onBlur',
    defaultValues: {
      tenant_id: tenantFromQuery,
      subject_email: '',
      subject_type: 'student',
      dsar_type: 'ACCESS',
      request_text: '',
    },
  });

  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    setServerMessage(null);
    try {
      // P1-WB7 (2026-05) — backend now requires an Idempotency-Key so a
      // double-click / accidental network retry never logs the same DSAR
      // twice. Browser-side crypto.randomUUID is good enough — the value
      // is opaque to the server, only the (tenant, key) tuple matters for
      // the cache lookup.
      const idemKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `dsar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await fetch(`${API_BASE}/public/dsar`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify(values),
      });
      if (res.status === 429) {
        setServerError('Too many requests. Please try again in a minute.');
        return;
      }
      if (res.status === 422 || res.status === 400) {
        setServerError(
          'Some fields are missing or invalid. Please review the form and try again.',
        );
        return;
      }
      // 200 is the only "success" — and intentionally the same response
      // regardless of whether a matching subject was found (anti-enumeration).
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setServerMessage(
        body.message ??
          "If a matching subject exists, we have logged your request. You'll receive a confirmation within 24 hours.",
      );
    } catch {
      setServerError('Network error. Please try again.');
    }
  });

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        px: 2,
        py: 6,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 560, borderRadius: 3 }} elevation={1}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={3}>
            <Box>
              <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }}>
                Submit a data request
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Use this form to exercise your rights of access, portability,
                erasure, rectification, restriction, or objection. Your request
                will be processed within 30 days as required by data-protection
                law.
              </Typography>
            </Box>

            {serverMessage ? (
              <Alert severity="success" variant="outlined">
                {serverMessage}
              </Alert>
            ) : null}
            {serverError ? (
              <Alert severity="error" variant="outlined">
                {serverError}
              </Alert>
            ) : null}

            <Stack component="form" onSubmit={onSubmit} spacing={2.5} noValidate>
              <TextField
                label="Organisation ID"
                helperText={
                  errors.tenant_id?.message ??
                  'Supplied in the link you used to reach this page.'
                }
                error={Boolean(errors.tenant_id)}
                fullWidth
                size="small"
                {...register('tenant_id')}
              />

              <TextField
                label="Your email"
                type="email"
                autoComplete="email"
                helperText={
                  errors.subject_email?.message ??
                  'The email address associated with your record.'
                }
                error={Boolean(errors.subject_email)}
                fullWidth
                size="small"
                {...register('subject_email')}
              />

              <TextField
                select
                label="I am a"
                helperText={errors.subject_type?.message ?? ' '}
                error={Boolean(errors.subject_type)}
                fullWidth
                size="small"
                defaultValue="student"
                {...register('subject_type')}
              >
                {SUBJECT_TYPE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                select
                label="Request type"
                helperText={errors.dsar_type?.message ?? ' '}
                error={Boolean(errors.dsar_type)}
                fullWidth
                size="small"
                defaultValue="ACCESS"
                {...register('dsar_type')}
              >
                {DSAR_TYPE_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                label="Details of your request"
                helperText={
                  errors.request_text?.message ??
                  'Please describe what you need. Do not include passwords or sensitive ID numbers.'
                }
                error={Boolean(errors.request_text)}
                fullWidth
                multiline
                minRows={4}
                maxRows={10}
                inputProps={{ maxLength: 2000 }}
                {...register('request_text')}
              />

              <Button
                type="submit"
                variant="contained"
                size="large"
                disabled={isSubmitting}
                startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
              >
                {isSubmitting ? 'Submitting…' : 'Submit request'}
              </Button>

              <Typography variant="caption" color="text.secondary">
                This is a public submission form. We never confirm or deny
                whether a particular email is on file. If a matching record
                exists, the organisation will respond by email.
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
