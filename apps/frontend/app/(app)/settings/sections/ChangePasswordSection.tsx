'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { z } from 'zod';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import { ChangePasswordRequest } from '@spv/zod-schemas';
import { ApiError } from '@/lib/auth';
import { api } from '@/lib/api';
import LabeledField from '@/components/LabeledField';
import {
  MfaStepUpField,
  mfaStatusFromError,
  type MfaStepUpStatus,
} from '@/features/billing/MfaStepUpField';

// Refine ChangePasswordRequest to add a confirm_password field that must match.
const ChangePasswordFormSchema = ChangePasswordRequest.extend({
  confirm_password: z.string().min(1, 'Please confirm your new password'),
}).refine((vals) => vals.new_password === vals.confirm_password, {
  path: ['confirm_password'],
  message: 'Passwords do not match',
});

type ChangePasswordValues = z.infer<typeof ChangePasswordFormSchema>;

export default function ChangePasswordSection() {
  const { enqueueSnackbar } = useSnackbar();
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // SVT-SEC-AUDIT-2026-05 — change-password is now MFA-gated. We start at
  // `idle` so the form looks identical for pre-MFA users; the backend flips
  // us into `required` on the first submit when the caller has enrolled.
  const [mfaStatus, setMfaStatus] = useState<MfaStepUpStatus>('idle');
  const [mfaCode, setMfaCode] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    mode: 'onBlur',
    defaultValues: { current_password: '', new_password: '', confirm_password: '' },
  });

  const changeMut = useMutation({
    mutationFn: async (values: ChangePasswordValues) => {
      await api.post(
        '/auth/change-password',
        {
          current_password: values.current_password,
          new_password: values.new_password,
        },
        // SVT-SEC-AUDIT-2026-05 — when the user supplied a step-up code,
        // forward it as X-MFA-Code. Empty string falls through (no header).
        mfaCode ? { headers: { 'X-MFA-Code': mfaCode } } : undefined,
      );
    },
    onSuccess: () => {
      enqueueSnackbar('Password updated.', { variant: 'success' });
      reset();
      setServerError(null);
      setMfaStatus('idle');
      setMfaCode('');
    },
    onError: (err: unknown) => {
      // SVT-SEC-AUDIT-2026-05 — surface the inline TOTP prompt instead of a
      // toast when the backend asks for step-up. We do NOT toast on this
      // branch — the Alert inside <MfaStepUpField> is the affordance.
      const mfa = mfaStatusFromError(err);
      if (mfa) {
        setMfaStatus(mfa);
        if (mfa !== 'required') setMfaCode('');
        return;
      }
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'current_password' || fe.path === 'new_password') {
            setError(fe.path as keyof ChangePasswordValues, {
              type: 'server',
              message: fe.message,
            });
          }
        }
        const msg = err.detail || err.title || 'Failed to update password.';
        setServerError(msg);
        enqueueSnackbar(msg, { variant: 'error' });
      } else {
        setServerError('Network error. Please try again.');
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    setServerError(null);
    changeMut.mutate(values);
  });

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Change password
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Pick a new password of at least 12 characters. Active sessions are kept; sign out
              everywhere below if you suspect a compromise.
            </Typography>
          </Box>
          <Divider />
          {serverError ? (
            <Alert severity="error" variant="outlined">
              {serverError}
            </Alert>
          ) : null}
          <Stack
            component="form"
            onSubmit={onSubmit}
            spacing={2}
            noValidate
            sx={{
              maxWidth: 480,
              // Standardise input heights to 44px so the three password rows
              // line up vertically — matches the SVT form pattern.
              '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
              '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
            }}
          >
            {/* Required-field legend — explicit so the convention is unambiguous. */}
            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
              Required
            </Typography>
            <LabeledField
              label="Current password"
              required
              error={Boolean(errors.current_password)}
              helperText={errors.current_password?.message ?? ''}
              htmlFor="cp-current"
            >
              <TextField
                id="cp-current"
                type={showCurrent ? 'text' : 'password'}
                autoComplete="current-password"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Your existing password"
                error={Boolean(errors.current_password)}
                {...register('current_password')}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowCurrent((s) => !s)}
                        edge="end"
                        aria-label={showCurrent ? 'Hide password' : 'Show password'}
                      >
                        {showCurrent ? (
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
              label="New password"
              required
              error={Boolean(errors.new_password)}
              helperText={errors.new_password?.message ?? 'Minimum 12 characters.'}
              htmlFor="cp-new"
            >
              <TextField
                id="cp-new"
                type={showNew ? 'text' : 'password'}
                autoComplete="new-password"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="At least 12 characters"
                error={Boolean(errors.new_password)}
                {...register('new_password')}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowNew((s) => !s)}
                        edge="end"
                        aria-label={showNew ? 'Hide password' : 'Show password'}
                      >
                        {showNew ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
            </LabeledField>
            <LabeledField
              label="Confirm new password"
              required
              error={Boolean(errors.confirm_password)}
              helperText={errors.confirm_password?.message ?? ''}
              htmlFor="cp-confirm"
            >
              <TextField
                id="cp-confirm"
                type={showNew ? 'text' : 'password'}
                autoComplete="new-password"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Re-enter the new password"
                error={Boolean(errors.confirm_password)}
                {...register('confirm_password')}
              />
            </LabeledField>
            <MfaStepUpField
              status={mfaStatus}
              value={mfaCode}
              onChange={setMfaCode}
              id="cp-mfa-code"
            />
            <Box>
              <Button
                type="submit"
                variant="contained"
                disabled={isSubmitting}
                startIcon={isSubmitting ? <CircularProgress size={16} color="inherit" /> : null}
              >
                {isSubmitting ? 'Updating…' : 'Update password'}
              </Button>
            </Box>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
