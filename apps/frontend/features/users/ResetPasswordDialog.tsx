'use client';

// Refactored to SVT form-pattern per design pass.

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Box,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { ResetPasswordRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import type { UserRow } from './types';

type FormValues = {
  new_password: string;
  force_change_on_next_login: boolean;
};

// Same generator as CreateUserDialog — kept local to avoid an extra util module.
function generatePassword(length = 16): string {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const out = new Array<string>(length);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const buf = new Uint32Array(length);
    window.crypto.getRandomValues(buf);
    for (let i = 0; i < length; i += 1) {
      out[i] = alphabet[buf[i]! % alphabet.length]!;
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      out[i] = alphabet[Math.floor(Math.random() * alphabet.length)]!;
    }
  }
  return out.join('');
}

export type ResetPasswordDialogProps = {
  open: boolean;
  user: UserRow | null;
  onClose: () => void;
};

export default function ResetPasswordDialog({ open, user, onClose }: ResetPasswordDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('users.dialogs.resetPassword');
  const tCommon = useTranslations('common');
  const [showPassword, setShowPassword] = useState(false);
  // We only show the generated password if the admin used the helper button,
  // and only after a successful reset. We never log it.
  const [generatedToReveal, setGeneratedToReveal] = useState<string | null>(null);
  const [didGenerate, setDidGenerate] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(ResetPasswordRequest),
    mode: 'onBlur',
    defaultValues: {
      new_password: '',
      force_change_on_next_login: true,
    },
  });

  const resetMut = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!user) throw new Error('No user selected');
      await api.post(`/users/${user.id}/reset-password`, values);
      return values.new_password;
    },
    onSuccess: (newPassword) => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      // Only surface the password if the admin used the generator helper.
      if (didGenerate) {
        setGeneratedToReveal(newPassword);
        setShowPassword(true);
      } else {
        handleClose();
      }
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'new_password' || fe.path === 'force_change_on_next_login') {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || t('errorToast'), {
          variant: 'error',
        });
      } else {
        enqueueSnackbar(t('networkError'), { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => resetMut.mutate(values));

  const handleGenerate = () => {
    const pwd = generatePassword(16);
    setValue('new_password', pwd, { shouldValidate: true, shouldDirty: true });
    setDidGenerate(true);
    setShowPassword(true);
  };

  const handleCopy = async () => {
    if (!generatedToReveal) return;
    try {
      await navigator.clipboard.writeText(generatedToReveal);
      enqueueSnackbar(t('copySuccess'), { variant: 'success' });
    } catch {
      enqueueSnackbar(t('copyFailed'), { variant: 'warning' });
    }
  };

  function handleClose() {
    if (isSubmitting) return;
    reset();
    setShowPassword(false);
    setDidGenerate(false);
    setGeneratedToReveal(null);
    onClose();
  }

  // After a generated password reveal, switch to a single "Done" button. We
  // emulate this by giving AppDialog a primary "Done" action and a hidden
  // secondary (label is empty + click closes — but AppDialog always shows it).
  // The simplest way to get a single-button bar is to point both actions at
  // close in this state.
  const revealing = Boolean(generatedToReveal);
  const saveDisabled = !isDirty || isSubmitting || resetMut.isPending || !user;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={t('title')}
      primaryAction={
        revealing
          ? {
              label: t('done'),
              onClick: handleClose,
            }
          : {
              label: t('submit'),
              loadingLabel: t('submitting'),
              loading: isSubmitting,
              formId: 'reset-password-form',
              color: 'warning',
              disabled: saveDisabled,
            }
      }
      secondaryAction={
        revealing
          ? { label: tCommon('cancel'), onClick: handleClose, disabled: true }
          : undefined
      }
    >
      {user ? (
        <Box
          component="form"
          id="reset-password-form"
          onSubmit={onSubmit}
          noValidate
          sx={{
            '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
            '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          }}
        >
          <Stack spacing={2.5}>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {`${user.given_name} ${user.family_name}`.trim() || user.email}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {user.email}
              </Typography>
            </Stack>

            {generatedToReveal ? (
              <Alert severity="info" variant="outlined">
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {t('shareNotice')}
                </Typography>
                <Box
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: 14,
                    p: 1.25,
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    wordBreak: 'break-all',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                  }}
                >
                  <Box component="span" sx={{ flexGrow: 1 }}>
                    {generatedToReveal}
                  </Box>
                  <Tooltip title={t('copyTooltip')}>
                    <IconButton size="small" onClick={handleCopy} aria-label={t('copyAria')}>
                      <ContentCopyOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Alert>
            ) : (
              <>
                {/*
                  Note: passwords are hashed (Argon2 / bcrypt) at rest, not
                  encrypted — leave the LabeledField bare without the encrypted
                  badge so we don't mislead about cryptographic posture.
                */}
                <LabeledField
                  label={t('newPassword')}
                  required
                  error={Boolean(errors.new_password)}
                  helperText={errors.new_password?.message ?? t('minHelp')}
                  htmlFor="reset-pw-new"
                >
                  <TextField
                    id="reset-pw-new"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    fullWidth
                    hiddenLabel
                    size="medium"
                    placeholder="Min 12 chars · mix of letters, digits and symbols"
                    error={Boolean(errors.new_password)}
                    {...register('new_password')}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <Tooltip title={t('generateTooltip')}>
                            <IconButton
                              onClick={handleGenerate}
                              edge="end"
                              aria-label={t('generateAria')}
                            >
                              <AutoAwesomeOutlinedIcon />
                            </IconButton>
                          </Tooltip>
                          <IconButton
                            onClick={() => setShowPassword((s) => !s)}
                            edge="end"
                            aria-label={showPassword ? t('hidePassword') : t('showPassword')}
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
                <Controller
                  name="force_change_on_next_login"
                  control={control}
                  render={({ field }) => (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, checked) => field.onChange(checked)}
                        />
                      }
                      label={t('forceChange')}
                    />
                  )}
                />
                {saveBlockedReason && (
                  <Tooltip title="">
                    <Typography variant="caption" color="text.secondary">
                      {saveBlockedReason}
                    </Typography>
                  </Tooltip>
                )}
              </>
            )}
          </Stack>
        </Box>
      ) : null}
    </AppDialog>
  );
}
