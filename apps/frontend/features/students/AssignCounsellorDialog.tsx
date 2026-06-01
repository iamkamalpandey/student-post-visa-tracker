// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Alert, Autocomplete, Box, Stack, TextField, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import { useUsersLite, type UserLite } from '@/lib/queries';

type Props = {
  open: boolean;
  onClose: () => void;
  studentId: string;
  studentVersion: number;
  currentAssigneeId: string | null;
};

export default function AssignCounsellorDialog({ open, onClose, studentId, studentVersion, currentAssigneeId }: Props) {
  const t = useTranslations('students.detail');
  const tCommon = useTranslations('common');
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const usersQuery = useUsersLite(open);
  const [selected, setSelected] = useState<UserLite | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = (usersQuery.data ?? []).find((u) => u.id === currentAssigneeId);
    setSelected(current ?? null);
  }, [open, currentAssigneeId, usersQuery.data]);

  const mutation = useMutation<unknown, ApiError, { assigned_to_id: string | null }>({
    mutationFn: async (body) => {
      const res = await api.patch(`/students/${studentId}`, body, {
        headers: { 'If-Match': `"${studentVersion}"` },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('assignCounsellorSuccess'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      qc.invalidateQueries({ queryKey: ['students'] });
      onClose();
    },
    onError: (e) => {
      enqueueSnackbar(e.detail ?? e.message, { variant: 'error' });
    },
  });

  const dirty = (selected?.id ?? null) !== currentAssigneeId;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('assignCounsellorTitle')}
      maxWidth="xs"
      primaryAction={{
        label: tCommon('save'),
        onClick: () => mutation.mutate({ assigned_to_id: selected?.id ?? null }),
        disabled: !dirty || mutation.isPending,
        loading: mutation.isPending,
      }}
      secondaryAction={{ label: tCommon('cancel'), onClick: onClose }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        <Stack spacing={2}>
          {!dirty ? (
            <Typography variant="caption" color="text.secondary">
              Make a change to enable saving
            </Typography>
          ) : null}
          <LabeledField label={t('counsellorPickerLabel')} htmlFor="assign-counsellor-input">
            <Autocomplete
              id="assign-counsellor-input"
              options={usersQuery.data ?? []}
              value={selected}
              onChange={(_, v) => setSelected(v)}
              getOptionLabel={(u) => `${u.given_name} ${u.family_name}${u.email ? ` (${u.email})` : ''}`}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              loading={usersQuery.isLoading}
              renderInput={(params) => (
                <TextField {...params} hiddenLabel size="medium" placeholder="Search counsellors" />
              )}
              clearOnEscape
            />
          </LabeledField>
          {selected === null && currentAssigneeId !== null && (
            <Alert severity="warning">{t('unassignWarning')}</Alert>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
