'use client';

// Refactored to SVT form-pattern per design pass.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { z } from 'zod';
import { LoginRequest } from '@spv/zod-schemas';
import { useAuth, ApiError } from '@/lib/auth';
import LabeledField from '@/components/LabeledField';

// Wrap LoginRequest so the empty mfa_code default doesn't fail the optional 6-digit regex.
// SVT-SEC-MFA-RECOVERY-2026-05 — also allow an optional recovery_code (10 base32 chars,
// hyphen optional). At submit time we send exactly ONE of mfa_code / recovery_code.
const LoginFormSchema = LoginRequest.extend({
  mfa_code: z
    .union([z.literal(''), z.string().regex(/^\d{6}$/, 'MFA code must be 6 digits')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  recovery_code: z
    .union([
      z.literal(''),
      z.string().regex(/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/i, 'Recovery code must be 10 base32 chars'),
    ])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Student Post-Visa Tracker';

type FormValues = {
  email: string;
  password: string;
  mfa_code?: string;
  recovery_code?: string;
};

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { login } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [showPassword, setShowPassword] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  // SVT-SEC-MFA-RECOVERY-2026-05 — toggle between TOTP and recovery code flows
  // when the authenticator device is lost. Defaults to TOTP.
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(LoginFormSchema),
    mode: 'onBlur',
    defaultValues: { email: '', password: '', mfa_code: '', recovery_code: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await login(values.email, values.password, {
        // SVT-SEC-MFA-RECOVERY-2026-05 — toggle decides which second factor we
        // submit. Recovery codes are single-use and bypass TOTP entirely.
        ...(useRecoveryCode
          ? { recoveryCode: values.recovery_code || undefined }
          : { mfaCode: values.mfa_code || undefined }),
      });
      // SVT-SEC-2026-05 — open-redirect guard. Only accept same-origin paths
      // (single leading slash followed by a non-slash char). Reject `//evil`,
      // `/\evil`, absolute URLs, and `javascript:` URIs.
      const raw = search?.get('redirect') ?? '/';
      const redirect = /^\/(?![\\/])/.test(raw) && !raw.toLowerCase().startsWith('/javascript:')
        ? raw
        : '/';
      router.replace(redirect);
    } catch (err) {
      if (err instanceof ApiError) {
        // MFA challenge: backend signals via 401 + detail "MFA required".
        const requiresMfa =
          err.status === 401 &&
          (err.detail?.toLowerCase().includes('mfa') ||
            err.errors.some((e) => e.path === 'mfa_code'));
        if (requiresMfa) {
          setMfaRequired(true);
          setSubmitError(
            useRecoveryCode
              ? 'Enter one of your saved recovery codes.'
              : 'Enter the 6-digit code from your authenticator app.',
          );
          setTimeout(
            () => setFocus(useRecoveryCode ? 'recovery_code' : 'mfa_code'),
            0,
          );
          return;
        }

        // Map field errors back to the form.
        for (const fe of err.errors) {
          if (
            fe.path === 'email' ||
            fe.path === 'password' ||
            fe.path === 'mfa_code' ||
            fe.path === 'recovery_code'
          ) {
            setError(fe.path, { type: 'server', message: fe.message });
          }
        }

        const message =
          err.status === 401
            ? 'Incorrect email or password.'
            : err.detail || err.title || 'Sign-in failed.';
        setSubmitError(message);
        enqueueSnackbar(message, { variant: 'error' });
      } else {
        setSubmitError('Network error. Please try again.');
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
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
              // Standardise input heights to 44px so email, password and the
              // MFA code field line up vertically — matches the SVT form pattern
              // applied across student / settings forms.
              '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
              '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
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
                  Sign in to {APP_NAME}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Use your work email to access the counsellor workspace.
                </Typography>
              </Box>
            </Stack>

            {submitError ? (
              <Alert severity={mfaRequired ? 'info' : 'error'} variant="outlined">
                {submitError}
              </Alert>
            ) : null}

            {/* Required-field legend — explicit so the convention is unambiguous. */}
            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
              Required
            </Typography>

            <LabeledField
              label="Email"
              required
              error={Boolean(errors.email)}
              helperText={errors.email?.message ?? ''}
              htmlFor="login-email"
            >
              <TextField
                id="login-email"
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

            <Box>
              <LabeledField
                label="Password"
                required
                error={Boolean(errors.password)}
                helperText={errors.password?.message ?? ''}
                htmlFor="login-password"
              >
                <TextField
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="Enter your password"
                  error={Boolean(errors.password)}
                  {...register('password')}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => setShowPassword((s) => !s)}
                          edge="end"
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                          {showPassword ? (
                            <VisibilityOffOutlinedIcon />
                          ) : (
                            <VisibilityOutlinedIcon />
                          )}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />
              </LabeledField>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.25 }}>
                <Typography
                  component={Link}
                  href="/forgot-password"
                  variant="caption"
                  sx={{
                    color: 'primary.main',
                    fontWeight: 500,
                    textDecoration: 'none',
                    '&:hover': { textDecoration: 'underline' },
                  }}
                >
                  Forgot password?
                </Typography>
              </Box>
            </Box>

            {mfaRequired ? (
              <Stack spacing={1}>
                {useRecoveryCode ? (
                  // Recovery code field — wider input (10 chars + optional hyphen).
                  <Box sx={{ maxWidth: 260 }}>
                    <LabeledField
                      label="Recovery code"
                      required
                      error={Boolean(errors.recovery_code)}
                      helperText={
                        errors.recovery_code?.message ?? 'One of the codes you saved at MFA enrolment'
                      }
                      htmlFor="login-recovery"
                    >
                      <TextField
                        id="login-recovery"
                        type="text"
                        autoComplete="one-time-code"
                        fullWidth
                        size="medium"
                        hiddenLabel
                        placeholder="XXXXX-XXXXX"
                        error={Boolean(errors.recovery_code)}
                        {...register('recovery_code')}
                        inputProps={{
                          maxLength: 11,
                          // Uppercase as user types — codes are base32 (A-Z2-7) by spec.
                          style: { textTransform: 'uppercase' },
                        }}
                      />
                    </LabeledField>
                  </Box>
                ) : (
                  // Narrow MFA code field — the input shouldn't stretch full-width.
                  <Box sx={{ maxWidth: 180 }}>
                    <LabeledField
                      label="Authentication code"
                      required
                      error={Boolean(errors.mfa_code)}
                      helperText={errors.mfa_code?.message ?? '6-digit code from your authenticator app'}
                      htmlFor="login-mfa"
                    >
                      <TextField
                        id="login-mfa"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        fullWidth
                        size="medium"
                        hiddenLabel
                        placeholder="123456"
                        error={Boolean(errors.mfa_code)}
                        {...register('mfa_code')}
                        inputProps={{
                          maxLength: 6,
                          pattern: '\\d{6}',
                        }}
                      />
                    </LabeledField>
                  </Box>
                )}
                {/* SVT-SEC-MFA-RECOVERY-2026-05 — toggle between TOTP and recovery code.
                    Recovery codes are the documented fallback when the user has lost
                    their authenticator device. Clears the other field so we never
                    submit both factors in a single request. */}
                <Button
                  type="button"
                  size="small"
                  variant="text"
                  onClick={() => setUseRecoveryCode((v) => !v)}
                  sx={{ alignSelf: 'flex-start', textTransform: 'none', px: 0.5 }}
                >
                  {useRecoveryCode
                    ? 'Use authenticator code instead'
                    : 'Use recovery code instead'}
                </Button>
              </Stack>
            ) : null}

            <Button
              type="submit"
              variant="contained"
              size="large"
              fullWidth
              disabled={isSubmitting}
              startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
              sx={{ mt: 1 }}
            >
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>

            {/* SVT-LEGAL-2026-05 — footer now links to the legal surface
                (/legal/terms, /legal/privacy). Resolves the CTO-audit gap
                where the original text referenced a policy with no URL. */}
            <Typography variant="caption" color="text.secondary" textAlign="center">
              By continuing you agree to our{' '}
              <Box
                component={Link}
                href="/legal/terms"
                sx={{
                  color: 'primary.main',
                  fontWeight: 500,
                  textDecoration: 'none',
                  '&:hover': { textDecoration: 'underline' },
                }}
              >
                Terms
              </Box>{' '}
              and{' '}
              <Box
                component={Link}
                href="/legal/privacy"
                sx={{
                  color: 'primary.main',
                  fontWeight: 500,
                  textDecoration: 'none',
                  '&:hover': { textDecoration: 'underline' },
                }}
              >
                Privacy Policy
              </Box>
              .
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
