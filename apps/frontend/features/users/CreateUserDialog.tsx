'use client';

// Refactored to SVT form-pattern per design pass.
import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import { CreateUserRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';

type FormValues = {
  email: string;
  given_name: string;
  family_name: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  password: string;
};

const ROLES: { value: FormValues['role']; label: string }[] = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'COUNSELLOR', label: 'Counsellor' },
  { value: 'VIEWER', label: 'Viewer' },
];

// Cryptographically random 16-char password using browser crypto.
// We bias the alphabet to printable ASCII, excluding ambiguous chars.
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

export type CreateUserDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function CreateUserDialog({ open, onClose }: CreateUserDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(
      CreateUserRequest.pick({
        email: true,
        given_name: true,
        family_name: true,
        role: true,
        password: true,
      }),
    ),
    mode: 'onBlur',
    defaultValues: {
      email: '',
      given_name: '',
      family_name: '',
      role: 'COUNSELLOR',
      password: '',
    },
  });

  const createMut = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await api.post('/users', values);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('User created.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      reset();
      setShowPassword(false);
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (
            fe.path === 'email' ||
            fe.path === 'given_name' ||
            fe.path === 'family_name' ||
            fe.path === 'role' ||
            fe.path === 'password'
          ) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to create user.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => createMut.mutate(values));

  const handleGenerate = () => {
    const pwd = generatePassword(16);
    setValue('password', pwd, { shouldValidate: true, shouldDirty: true });
    setShowPassword(true);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    setShowPassword(false);
    onClose();
  };

  // Save gating: disabled until any field is dirty (matches the gold-standard
  // EditCoreProfileDialog pattern even on create-only flows — we still want
  // the "make a change" cue if the user opens the dialog and walks away).
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="New user"
      subtitle="Create a workspace account. The user will sign in with the email and password you provide."
      maxWidth="sm"
      primaryAction={{
        label: 'Create user',
        loadingLabel: 'Creating…',
        loading: isSubmitting || createMut.isPending,
        disabled: Boolean(saveBlockedReason) || isSubmitting || createMut.isPending,
        formId: 'create-user-form',
      }}
    >
      <Box
        component="form"
        id="create-user-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        <Stack spacing={2.5}>
          <LabeledField
            label="Email"
            required
            htmlFor="cu-email"
            error={Boolean(errors.email)}
            helperText={errors.email?.message ?? 'Used for sign-in and recovery.'}
          >
            <TextField
              id="cu-email"
              type="email"
              fullWidth
              size="medium"
              hiddenLabel
              autoComplete="off"
              placeholder="counsellor@example.com"
              error={Boolean(errors.email)}
              {...register('email')}
            />
          </LabeledField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Box sx={{ flex: 1 }}>
              <LabeledField
                label="Given name"
                required
                htmlFor="cu-given_name"
                error={Boolean(errors.given_name)}
                helperText={errors.given_name?.message ?? ''}
              >
                <TextField
                  id="cu-given_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Priya"
                  error={Boolean(errors.given_name)}
                  {...register('given_name')}
                />
              </LabeledField>
            </Box>
            <Box sx={{ flex: 1 }}>
              <LabeledField
                label="Family name"
                required
                htmlFor="cu-family_name"
                error={Boolean(errors.family_name)}
                helperText={errors.family_name?.message ?? ''}
              >
                <TextField
                  id="cu-family_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Sharma"
                  error={Boolean(errors.family_name)}
                  {...register('family_name')}
                />
              </LabeledField>
            </Box>
          </Stack>

          <LabeledField
            label="Role"
            required
            htmlFor="cu-role"
            error={Boolean(errors.role)}
            helperText={errors.role?.message ?? 'Permissions can be changed later.'}
          >
            <Controller
              name="role"
              control={control}
              render={({ field }) => (
                <TextField
                  id="cu-role"
                  {...field}
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.role)}
                >
                  {ROLES.map((r) => (
                    <MenuItem key={r.value} value={r.value}>
                      {r.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>

          <LabeledField
            label="Password"
            required
            htmlFor="cu-password"
            error={Boolean(errors.password)}
            helperText={errors.password?.message ?? 'Minimum 12 characters. Use the wand to generate.'}
          >
            <TextField
              id="cu-password"
              type={showPassword ? 'text' : 'password'}
              fullWidth
              size="medium"
              hiddenLabel
              autoComplete="new-password"
              placeholder="At least 12 characters"
              error={Boolean(errors.password)}
              {...register('password')}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Generate strong password">
                      <IconButton
                        onClick={handleGenerate}
                        edge="end"
                        aria-label="Generate password"
                      >
                        <AutoAwesomeOutlinedIcon />
                      </IconButton>
                    </Tooltip>
                    <IconButton
                      onClick={() => setShowPassword((s) => !s)}
                      edge="end"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <VisibilityOffOutlinedIcon /> : <VisibilityOutlinedIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </LabeledField>
        </Stack>

        {saveBlockedReason ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 2, textAlign: 'right' }}
          >
            {saveBlockedReason}
          </Typography>
        ) : null}
      </Box>
    </AppDialog>
  );
}
