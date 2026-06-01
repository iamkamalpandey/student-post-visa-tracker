'use client';

// SVT-SEC-2026-05 — self-service password reset confirmation page.
// Accepts the opaque single-use token from the emailed link, posts it with
// the chosen new password, and handles backend status codes per the audit:
//   204 → success, redirect to /login
//   401 → token invalid / expired
//   422 → weak password (HIBP, length, complexity)

import { useEffect, useState } from 'react';
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
import { api, ApiError } from '@/lib/api';
import LabeledField from '@/components/LabeledField';

const ResetSchema = z
  .object({
    new_password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be 128 characters or fewer'),
    confirm: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((v) => v.new_password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });

type FormValues = z.infer<typeof ResetSchema>;

export default function ResetPasswordClient() {
  const router = useRouter();
  const search = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();

  const token = search?.get('token') ?? '';

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(ResetSchema),
    mode: 'onBlur',
    defaultValues: { new_password: '', confirm: '' },
  });

  useEffect(() => {
    if (!token) {
      setTokenError(
        'This reset link is missing its token. Please request a new password reset.',
      );
    }
  }, [token]);

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    if (!token) {
      setTokenError(
        'This reset link is missing its token. Please request a new password reset.',
      );
      return;
    }
    try {
      await api.post('/auth/password/reset-confirm', {
        token,
        new_password: values.new_password,
      });
      enqueueSnackbar('Password updated. Please sign in with your new password.', {
        variant: 'success',
      });
      router.replace('/login');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setTokenError('Reset link invalid or expired.');
          return;
        }
        if (err.status === 422) {
          // Map field errors back to the form when the backend supplies them.
          let mapped = false;
          for (const fe of err.errors) {
            if (fe.path === 'new_password' || fe.path === 'confirm') {
              setError(fe.path as 'new_password' | 'confirm', {
                type: 'server',
                message: fe.message,
              });
              mapped = true;
            }
          }
          const message =
            err.detail ||
            (mapped
              ? 'Please choose a stronger password.'
              : 'This password is too weak or has appeared in a known data breach. Please choose another.');
          if (!mapped) {
            setError('new_password', { type: 'server', message });
          }
          setSubmitError(message);
          return;
        }
        const message = err.detail || err.title || 'Could not reset password.';
        setSubmitError(message);
        enqueueSnackbar(message, { variant: 'error' });
      } else {
        const message = 'Network error. Please try again.';
        setSubmitError(message);
        enqueueSnackbar(message, { variant: 'error' });
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
                  Choose a new password
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Use at least 12 characters. Avoid passwords you have used elsewhere.
                </Typography>
              </Box>
            </Stack>

            {tokenError ? (
              <Stack spacing={1.5}>
                <Alert severity="error" variant="outlined">
                  {tokenError}
                </Alert>
                <Typography variant="body2" color="text.secondary" textAlign="center">
                  <Box
                    component={Link}
                    href="/forgot-password"
                    sx={{
                      color: 'primary.main',
                      fontWeight: 500,
                      textDecoration: 'none',
                      '&:hover': { textDecoration: 'underline' },
                    }}
                  >
                    Request a new reset link
                  </Box>
                </Typography>
              </Stack>
            ) : (
              <>
                {submitError ? (
                  <Alert severity="error" variant="outlined">
                    {submitError}
                  </Alert>
                ) : null}

                <Typography variant="caption" color="text.secondary">
                  <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>
                    *
                  </Box>
                  Required
                </Typography>

                <LabeledField
                  label="New password"
                  required
                  error={Boolean(errors.new_password)}
                  helperText={errors.new_password?.message ?? 'At least 12 characters'}
                  htmlFor="reset-new-password"
                >
                  <TextField
                    id="reset-new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoFocus
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="Enter a new password"
                    error={Boolean(errors.new_password)}
                    {...register('new_password')}
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

                <LabeledField
                  label="Confirm new password"
                  required
                  error={Boolean(errors.confirm)}
                  helperText={errors.confirm?.message ?? ''}
                  htmlFor="reset-confirm-password"
                >
                  <TextField
                    id="reset-confirm-password"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="Re-enter the new password"
                    error={Boolean(errors.confirm)}
                    {...register('confirm')}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            onClick={() => setShowConfirm((s) => !s)}
                            edge="end"
                            aria-label={showConfirm ? 'Hide password' : 'Show password'}
                          >
                            {showConfirm ? (
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

                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  fullWidth
                  disabled={isSubmitting}
                  startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
                  sx={{ mt: 1 }}
                >
                  {isSubmitting ? 'Updating…' : 'Update password'}
                </Button>

                <Typography variant="body2" color="text.secondary" textAlign="center">
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
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
