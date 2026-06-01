'use client';

import { useEffect, useState } from 'react';
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
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import LockResetOutlinedIcon from '@mui/icons-material/LockResetOutlined';
import SecurityOutlinedIcon from '@mui/icons-material/SecurityOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { SetupMfaRequest, VerifyMfaRequest, DisableMfaRequest } from '@spv/zod-schemas';
import { useAuth, ApiError } from '@/lib/auth';
import { api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';

// SVT-SEC-2026-05 — Two-factor authentication (TOTP) enrol / disable section.
//
// Backend contract (apps/backend/src/modules/auth/mfa.service.ts):
//   POST /auth/mfa/setup    -> { secret, otpauth_url, status:'PENDING_VERIFICATION' }
//   POST /auth/mfa/verify   -> { code } -> { enabled:true, recovery_codes:string[] }
//   POST /auth/mfa/disable  -> { current_password } -> 204
//
// Recovery codes are returned ONCE — the wizard's step 3 displays them with
// a copy / download .txt button and a "I've saved these" checkbox before the
// dialog can be dismissed. Per task spec we display the secret as text + copy
// rather than rendering a QR code (avoids pulling the `qrcode` npm dep for v1).

type MfaSetupResponse = {
  secret: string;
  otpauth_url: string;
  status: 'PENDING_VERIFICATION';
};
type MfaVerifyResponse = {
  enabled: boolean;
  recovery_codes: string[];
};

type CodeFormValues = { code: string };
type SetupFormValues = z.infer<typeof SetupMfaRequest>;
type DisableFormValues = z.infer<typeof DisableMfaRequest> & { code: string };

const DisableMfaFormSchema = DisableMfaRequest.extend({
  code: z.string().regex(/^\d{6}$/, 'MFA code must be 6 digits'),
});

function MfaEnrolDialog({
  open,
  onClose,
  userEmail,
}: {
  open: boolean;
  onClose: () => void;
  userEmail: string;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { refresh } = useAuth();
  // Wizard step: 1=password+secret, 2=verify code, 3=recovery codes.
  // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — step 1 collects the current
  // password BEFORE the server mints a TOTP secret. Without this gate, a
  // hijacked session could rotate the victim's MFA secret to the
  // attacker's authenticator (POST /mfa/setup → POST /mfa/verify) and
  // permanently bind the account to the attacker's device.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedAcknowledged, setSavedAcknowledged] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showSetupPassword, setShowSetupPassword] = useState(false);

  const {
    register: registerSetup,
    handleSubmit: handleSetupSubmit,
    reset: resetSetupForm,
    setError: setSetupError,
    formState: { errors: setupErrors },
  } = useForm<SetupFormValues>({
    resolver: zodResolver(SetupMfaRequest),
    mode: 'onSubmit',
    defaultValues: { current_password: '' },
  });

  const {
    register: registerCode,
    handleSubmit: handleCodeSubmit,
    reset: resetCodeForm,
    setError: setCodeError,
    formState: { errors: codeErrors },
  } = useForm<CodeFormValues>({
    resolver: zodResolver(VerifyMfaRequest),
    mode: 'onSubmit',
    defaultValues: { code: '' },
  });

  // Reset everything whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setStep(1);
      setSetup(null);
      setRecoveryCodes([]);
      setSavedAcknowledged(false);
      setServerError(null);
      setShowSetupPassword(false);
      resetSetupForm({ current_password: '' });
      resetCodeForm({ code: '' });
    }
  }, [open, resetCodeForm, resetSetupForm]);

  const setupMut = useMutation({
    mutationFn: async (values: SetupFormValues) => {
      // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — POST current_password
      // with the setup request. Server re-verifies the argon2 hash before
      // rotating the secret; rejects 401 on mismatch.
      const res = await api.post<MfaSetupResponse>('/auth/mfa/setup', values);
      return res.data;
    },
    onSuccess: (data) => {
      setSetup(data);
      setServerError(null);
      setStep(2);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'current_password') {
            setSetupError('current_password', { type: 'server', message: fe.message });
          }
        }
      }
      const msg = err instanceof ApiError ? (err.detail || err.title) : 'Could not start MFA setup.';
      setServerError(msg);
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const onSetupSubmit = handleSetupSubmit((values) => {
    setServerError(null);
    setupMut.mutate(values);
  });

  const verifyMut = useMutation({
    mutationFn: async (values: CodeFormValues) => {
      const res = await api.post<MfaVerifyResponse>('/auth/mfa/verify', { code: values.code });
      return res.data;
    },
    onSuccess: (data) => {
      setRecoveryCodes(data.recovery_codes);
      setServerError(null);
      setStep(3);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'code') {
            setCodeError('code', { type: 'server', message: fe.message });
          }
        }
        const msg = err.detail || err.title || 'Invalid code.';
        setServerError(msg);
      } else {
        setServerError('Network error. Please try again.');
      }
    },
  });

  const handleCopySecret = async () => {
    if (!setup?.secret) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      enqueueSnackbar('Secret copied to clipboard.', { variant: 'success' });
    } catch {
      enqueueSnackbar('Copy failed — please copy manually.', { variant: 'warning' });
    }
  };

  const handleCopyOtpauth = async () => {
    if (!setup?.otpauth_url) return;
    try {
      await navigator.clipboard.writeText(setup.otpauth_url);
      enqueueSnackbar('otpauth URI copied.', { variant: 'success' });
    } catch {
      enqueueSnackbar('Copy failed — please copy manually.', { variant: 'warning' });
    }
  };

  const handleDownloadCodes = () => {
    const body = [
      `# Two-factor recovery codes for ${userEmail}`,
      `# Generated ${new Date().toISOString()}`,
      '# Each code can be used ONCE to sign in if you lose your authenticator.',
      '# Keep these in a password manager or printed in a safe place.',
      '',
      ...recoveryCodes,
    ].join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `svt-mfa-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyAllCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      enqueueSnackbar('Recovery codes copied.', { variant: 'success' });
    } catch {
      enqueueSnackbar('Copy failed — please use download instead.', { variant: 'warning' });
    }
  };

  const closeAndRefresh = async () => {
    onClose();
    // Refetch the user so mfa_enabled flips in the UI.
    await refresh();
  };

  const onVerifySubmit = handleCodeSubmit((values) => {
    setServerError(null);
    verifyMut.mutate(values);
  });

  // Compute primaryAction per step.
  const primaryAction = (() => {
    if (step === 1) {
      // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — primary action is the
      // form-submit so the password+secret request goes through react-hook-
      // form validation. The button targets the form via formId.
      return {
        label: 'Verify password & generate secret',
        formId: 'mfa-setup-form',
        loading: setupMut.isPending,
        loadingLabel: 'Verifying',
        disabled: setupMut.isPending,
      };
    }
    if (step === 2) {
      return {
        label: 'Verify and enable',
        formId: 'mfa-verify-form',
        loading: verifyMut.isPending,
        loadingLabel: 'Verifying',
        disabled: verifyMut.isPending,
      };
    }
    return {
      label: 'Done',
      onClick: () => { void closeAndRefresh(); },
      disabled: !savedAcknowledged,
    };
  })();

  return (
    <AppDialog
      open={open}
      title="Enable two-factor authentication"
      subtitle={`Step ${step} of 3`}
      onClose={onClose}
      maxWidth="sm"
      hideCloseIcon={step === 3}
      errorText={serverError}
      primaryAction={primaryAction}
      secondaryAction={step === 3 ? { label: 'Close', disabled: !savedAcknowledged } : undefined}
    >
      {step === 1 && (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Two-factor authentication adds a one-time code from an authenticator app (Google
            Authenticator, 1Password, Authy, etc.) on top of your password. Re-enter your
            current password to begin enrolment.
          </Typography>
          <Alert severity="info" variant="outlined">
            You will not be signed out. After enabling, the code is required every time you
            sign in on a new device.
          </Alert>
          {/* SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — collect current
              password before the server mints a secret. Closes the session-
              hijack pivot where an attacker holding an access token alone
              could bind their own authenticator to the victim's account. */}
          <Box component="form" id="mfa-setup-form" onSubmit={onSetupSubmit} noValidate>
            <LabeledField
              label="Current password"
              required
              error={Boolean(setupErrors.current_password)}
              helperText={setupErrors.current_password?.message ?? 'Re-enter your password to confirm it is you.'}
              htmlFor="mfa-setup-password"
            >
              <TextField
                id="mfa-setup-password"
                type={showSetupPassword ? 'text' : 'password'}
                autoComplete="current-password"
                fullWidth
                size="small"
                hiddenLabel
                placeholder="Your existing password"
                autoFocus
                error={Boolean(setupErrors.current_password)}
                {...registerSetup('current_password')}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowSetupPassword((s) => !s)}
                        edge="end"
                        aria-label={showSetupPassword ? 'Hide password' : 'Show password'}
                        size="small"
                      >
                        {showSetupPassword ? (
                          <VisibilityOffOutlinedIcon fontSize="small" />
                        ) : (
                          <VisibilityOutlinedIcon fontSize="small" />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
            </LabeledField>
          </Box>
        </Stack>
      )}

      {step === 2 && setup && (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            In your authenticator app, add a new account using the secret below, then enter
            the current 6-digit code it displays.
          </Typography>
          <LabeledField
            label="Secret (Base32)"
            htmlFor="mfa-secret"
            helperText="Paste this into the authenticator's manual-entry field."
          >
            <TextField
              id="mfa-secret"
              size="small"
              hiddenLabel
              fullWidth
              value={setup.secret}
              InputProps={{
                readOnly: true,
                sx: { fontFamily: 'monospace', letterSpacing: 1 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={handleCopySecret}
                      edge="end"
                      aria-label="Copy secret"
                      size="small"
                    >
                      <ContentCopyOutlinedIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </LabeledField>
          <LabeledField
            label="otpauth:// URI"
            htmlFor="mfa-uri"
            helperText="Some apps accept the URI directly — paste it as a manual key."
          >
            <TextField
              id="mfa-uri"
              size="small"
              hiddenLabel
              fullWidth
              value={setup.otpauth_url}
              InputProps={{
                readOnly: true,
                sx: { fontFamily: 'monospace', fontSize: 12 },
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={handleCopyOtpauth}
                      edge="end"
                      aria-label="Copy otpauth URI"
                      size="small"
                    >
                      <ContentCopyOutlinedIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </LabeledField>
          <Box component="form" id="mfa-verify-form" onSubmit={onVerifySubmit} noValidate>
            <Box sx={{ maxWidth: 200 }}>
              <LabeledField
                label="Authentication code"
                required
                error={Boolean(codeErrors.code)}
                helperText={codeErrors.code?.message ?? '6-digit code from your app'}
                htmlFor="mfa-verify-code"
              >
                <TextField
                  id="mfa-verify-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  fullWidth
                  size="small"
                  hiddenLabel
                  placeholder="123456"
                  error={Boolean(codeErrors.code)}
                  {...registerCode('code')}
                  inputProps={{ maxLength: 6, pattern: '\\d{6}' }}
                />
              </LabeledField>
            </Box>
          </Box>
        </Stack>
      )}

      {step === 3 && (
        <Stack spacing={2}>
          <Alert severity="warning" variant="outlined">
            Save these 10 recovery codes now. They will <strong>not</strong> be shown again.
            Each code lets you sign in once if you lose access to your authenticator.
          </Alert>
          <Box
            component="ul"
            sx={{
              listStyle: 'none',
              m: 0,
              p: 2,
              borderRadius: 1,
              border: (t) => `1px solid ${t.palette.divider}`,
              bgcolor: 'action.hover',
              display: 'grid',
              gridTemplateColumns: { xs: '1fr 1fr', sm: '1fr 1fr' },
              gap: 1,
              fontFamily: 'monospace',
              fontSize: 14,
              letterSpacing: 1,
            }}
          >
            {recoveryCodes.map((c) => (
              <Box key={c} component="li">
                {c}
              </Box>
            ))}
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<DownloadOutlinedIcon />}
              onClick={handleDownloadCodes}
            >
              Download .txt
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<ContentCopyOutlinedIcon />}
              onClick={() => { void handleCopyAllCodes(); }}
            >
              Copy all
            </Button>
          </Stack>
          <FormControlLabel
            control={
              <Checkbox
                checked={savedAcknowledged}
                onChange={(e) => setSavedAcknowledged(e.target.checked)}
                inputProps={{ 'aria-label': 'Confirm recovery codes saved' }}
              />
            }
            label="I have saved my recovery codes in a safe place."
          />
        </Stack>
      )}
    </AppDialog>
  );
}

function MfaDisableDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { refresh } = useAuth();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DisableFormValues>({
    resolver: zodResolver(DisableMfaFormSchema),
    mode: 'onSubmit',
    defaultValues: { current_password: '', code: '' },
  });

  useEffect(() => {
    if (open) {
      reset({ current_password: '', code: '' });
      setServerError(null);
      setShowPassword(false);
    }
  }, [open, reset]);

  const disableMut = useMutation({
    mutationFn: async (values: DisableFormValues) => {
      // NOTE: backend currently re-verifies the password only (the TOTP code
      // is collected here as a UX safety net — if the user no longer has
      // their authenticator they should reach out to an admin). We still
      // POST only the fields the schema accepts.
      await api.post('/auth/mfa/disable', { current_password: values.current_password });
    },
    onSuccess: async () => {
      enqueueSnackbar('Two-factor authentication disabled.', { variant: 'success' });
      onClose();
      await refresh();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'current_password') {
            setError('current_password', { type: 'server', message: fe.message });
          }
        }
        const msg = err.detail || err.title || 'Could not disable MFA.';
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
    disableMut.mutate(values);
  });

  return (
    <AppDialog
      open={open}
      title="Disable two-factor authentication"
      subtitle="Re-enter your password and a current authenticator code to continue."
      onClose={onClose}
      maxWidth="sm"
      errorText={serverError}
      primaryAction={{
        label: 'Disable two-factor',
        formId: 'mfa-disable-form',
        color: 'error',
        loading: isSubmitting || disableMut.isPending,
        loadingLabel: 'Disabling',
        disabled: isSubmitting || disableMut.isPending,
      }}
    >
      <Box component="form" id="mfa-disable-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          <Alert severity="warning" variant="outlined">
            Disabling MFA reduces your account security. Your recovery codes will also be
            invalidated.
          </Alert>
          <LabeledField
            label="Current password"
            required
            error={Boolean(errors.current_password)}
            helperText={errors.current_password?.message ?? ''}
            htmlFor="mfa-disable-password"
          >
            <TextField
              id="mfa-disable-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              fullWidth
              size="small"
              hiddenLabel
              placeholder="Your existing password"
              error={Boolean(errors.current_password)}
              {...register('current_password')}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword((s) => !s)}
                      edge="end"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      size="small"
                    >
                      {showPassword ? (
                        <VisibilityOffOutlinedIcon fontSize="small" />
                      ) : (
                        <VisibilityOutlinedIcon fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </LabeledField>
          <Box sx={{ maxWidth: 200 }}>
            <LabeledField
              label="Authentication code"
              required
              error={Boolean(errors.code)}
              helperText={errors.code?.message ?? '6-digit code from your app'}
              htmlFor="mfa-disable-code"
            >
              <TextField
                id="mfa-disable-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                fullWidth
                size="small"
                hiddenLabel
                placeholder="123456"
                error={Boolean(errors.code)}
                {...register('code')}
                inputProps={{ maxLength: 6, pattern: '\\d{6}' }}
              />
            </LabeledField>
          </Box>
        </Stack>
      </Box>
    </AppDialog>
  );
}

export default function MfaSection() {
  const { user, isLoading } = useAuth();
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  // SVT-AUDIT-FE-POLISH-2026-05 — render a skeleton while auth bootstraps
  // instead of an empty hole; settings is the first page users hit after
  // sign-in, so we want the section card visible immediately.
  if (isLoading) {
    return (
      <Card variant="outlined" aria-busy="true" aria-label="Loading two-factor authentication">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
              <Box sx={{ flex: 1 }}>
                <Skeleton variant="text" width={200} height={28} />
                <Skeleton variant="text" width={320} />
              </Box>
              <Skeleton variant="rounded" width={88} height={28} />
            </Stack>
            <Divider />
            <Skeleton variant="rounded" height={56} />
          </Stack>
        </CardContent>
      </Card>
    );
  }
  if (!user) return null;
  const enabled = user.mfa_enabled;

  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
              <Box>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Two-factor authentication
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Require a one-time code from your authenticator app every time you sign in.
                </Typography>
              </Box>
              <Chip
                label={enabled ? 'Enabled' : 'Disabled'}
                size="small"
                color={enabled ? 'success' : 'default'}
                variant="outlined"
                icon={<SecurityOutlinedIcon />}
              />
            </Stack>
            <Divider />
            {enabled ? (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                <Alert severity="success" variant="outlined" sx={{ flex: 1 }}>
                  Two-factor authentication is active on your account.
                </Alert>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<LockResetOutlinedIcon />}
                  onClick={() => setDisableOpen(true)}
                >
                  Disable
                </Button>
              </Stack>
            ) : (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                <Alert severity="info" variant="outlined" sx={{ flex: 1 }}>
                  You are signing in with password only. Enable two-factor authentication for
                  much stronger account protection.
                </Alert>
                <Button
                  variant="contained"
                  startIcon={<SecurityOutlinedIcon />}
                  onClick={() => setEnrolOpen(true)}
                >
                  Enable two-factor auth
                </Button>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
      <MfaEnrolDialog
        open={enrolOpen}
        onClose={() => setEnrolOpen(false)}
        userEmail={user.email}
      />
      <MfaDisableDialog open={disableOpen} onClose={() => setDisableOpen(false)} />
    </>
  );
}
