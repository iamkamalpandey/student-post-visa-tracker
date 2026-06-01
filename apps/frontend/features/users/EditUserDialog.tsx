'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { UpdateUserRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import type { UserRow } from './types';

type FormValues = {
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  is_active: boolean;
};

const ROLES: { value: FormValues['role']; label: string }[] = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'COUNSELLOR', label: 'Counsellor' },
  { value: 'VIEWER', label: 'Viewer' },
];

export type EditUserDialogProps = {
  open: boolean;
  user: UserRow | null;
  onClose: () => void;
};

export default function EditUserDialog({ open, user, onClose }: EditUserDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const t = useTranslations('users.dialogs.edit');

  const {
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(UpdateUserRequest.pick({ role: true, is_active: true })),
    mode: 'onBlur',
    defaultValues: {
      role: 'COUNSELLOR',
      is_active: true,
    },
  });

  // Re-seed when the target user changes (or dialog re-opens).
  useEffect(() => {
    if (user) {
      reset({ role: user.role, is_active: user.is_active });
    }
  }, [user, reset]);

  const updateMut = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!user) throw new Error('No user selected');
      const res = await api.patch(`/users/${user.id}`, values);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'role' || fe.path === 'is_active') {
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

  const onSubmit = handleSubmit((values) => updateMut.mutate(values));

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const saveDisabled = !isDirty || isSubmitting || updateMut.isPending || !user;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={t('title')}
      maxWidth="xs"
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting,
        formId: 'edit-user-form',
        disabled: saveDisabled,
      }}
    >
      {user ? (
        <Box
          component="form"
          id="edit-user-form"
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
            <LabeledField
              label={t('role')}
              required
              error={Boolean(errors.role)}
              helperText={errors.role?.message ?? ''}
              htmlFor="edit-user-role"
            >
              <Controller
                name="role"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    id="edit-user-role"
                    select
                    fullWidth
                    hiddenLabel
                    size="medium"
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
            <Controller
              name="is_active"
              control={control}
              render={({ field }) => (
                <FormControlLabel
                  control={
                    <Switch
                      checked={field.value}
                      onChange={(_, checked) => field.onChange(checked)}
                    />
                  }
                  label={field.value ? t('active') : t('inactive')}
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
          </Stack>
        </Box>
      ) : null}
    </AppDialog>
  );
}
