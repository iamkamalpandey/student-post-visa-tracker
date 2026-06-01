'use client';

// SVT-SEC-2026-05 — self-service password reset request page.
// Always renders the same generic confirmation regardless of whether the
// address exists, mirroring the backend's anti-enumeration response.

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
  TextField,
} from '@mui/material';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import LabeledField from '@/components/LabeledField';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Student Post-Visa Tracker';

const ForgotSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
});

type FormValues = z.infer<typeof ForgotSchema>;

const GENERIC_MESSAGE = 'If that email exists we sent a reset link.';

export default function ForgotPasswordClient() {
  const { enqueueSnackbar } = useSnackbar();
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(ForgotSchema),
    mode: 'onBlur',
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post('/auth/password/reset-request', { email: values.email });
    } catch (err) {
      // Anti-enumeration: even on backend error we MUST NOT leak whether the
      // email exists. Log non-validation errors to the console only.
      if (err instanceof ApiError && err.status !== 422) {
        // eslint-disable-next-line no-console
        console.warn('[forgot-password] request failed', err.status, err.detail);
      }
    } finally {
      setSubmitted(true);
      enqueueSnackbar(GENERIC_MESSAGE, { variant: 'success' });
    }
  });

  return (
    <Box
      sx={{
        flexGrow: 1,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: 6,
      }}
    >
      <Card
        sx={{
          width: '100%',
          maxWidth: 420,
          borderRadius: 4,
          border: (t) => `1px solid ${t.palette.divider}`,
          boxShadow: (t) =>
            t.palette.mode === 'light'
              ? '0px 24px 48px -12px rgba(16, 24, 40, 0.18)'
              : '0px 24px 48px -12px rgba(0, 0, 0, 0.55)',
        }}
        elevation={0}
      >
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack
            spacing={3}
            component="form"
            onSubmit={onSubmit}
            noValidate
            sx={{
              '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
              '& .MuiOutlinedInput-input:not(textarea)': {
                paddingTop: 0,
                paddingBottom: 0,
                height: '100%',
              },
            }}
          >
            <Stack spacing={1.5} alignItems="flex-start">
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: '14px',
                  background: 'linear-gradient(135deg, #1A73E8 0%, #7E57C2 100%)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 18,
                  letterSpacing: 0.5,
                }}
                aria-hidden
              >
                SP
              </Box>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 600 }}>
                  Reset your password
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Enter your {APP_NAME} email and we&apos;ll send you a reset link.
                </Typography>
              </Box>
            </Stack>

            {submitted ? (
              <Alert severity="success" variant="outlined">
                {GENERIC_MESSAGE}
              </Alert>
            ) : null}

            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>
                *
              </Box>
              Required
            </Typography>

            <LabeledField
              label="Email"
              required
              error={Boolean(errors.email)}
              helperText={errors.email?.message ?? ''}
              htmlFor="forgot-email"
            >
              <TextField
                id="forgot-email"
                type="email"
                autoComplete="email"
                autoFocus
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="name@example.com"
                error={Boolean(errors.email)}
                {...register('email')}
              />
            </LabeledField>

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={isSubmitting}
              startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
              sx={{ mt: 1 }}
            >
              {isSubmitting ? 'Sending…' : 'Send reset link'}
            </Button>

            <Typography variant="body2" color="text.secondary" textAlign="center">
              Remembered it?{' '}
              <Box
                component={Link}
                href="/login"
                sx={{
                  color: 'primary.main',
                  fontWeight: 500,
                  textDecoration: 'none',
                  '&:hover': { textDecoration: 'underline' },
                }}
              >
                Back to sign in
              </Box>
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
