'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Box, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { DisputeRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

// Brief requires min 10 chars. The wire schema only enforces min(1), so we
// strengthen it locally with a refine() — keeps server schema tolerant while
// the UI guides counsellors to write a useful note.
const FormSchema = DisputeRequest.extend({
  dispute_reason: z
    .string()
    .min(10, 'Please describe the dispute in at least 10 characters.')
    .max(2000),
});

type FormValues = z.infer<typeof FormSchema>;

export type DisputeDialogProps = {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
};

/**
 * INVOICED → DISPUTED transition. Captures a free-text reason that gets
 * persisted on the commission for downstream chase / resolution.
 */
export default function DisputeDialog({ open, claim, onClose }: DisputeDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('commissions.dialogs.dispute');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { dispute_reason: '' },
  });

  useEffect(() => {
    if (open) reset({ dispute_reason: '' });
  }, [open, claim?.id, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      const res = await api.post(`/commissions/${claim.id}/dispute`, {
        dispute_reason: values.dispute_reason.trim(),
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'warning' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission', claim?.id] });
      onClose();
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || t('errorToast'), { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  const saveDisabled = !isDirty || isSubmitting || mutation.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={
        claim
          ? t('subtitle', { institution: claim.institution.display_name })
          : undefined
      }
      errorText={mutation.error?.detail ?? null}
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting || mutation.isPending,
        formId: 'commission-dispute-form',
        color: 'error',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="commission-dispute-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2}>
          <LabeledField
            label="Dispute reason"
            required
            error={Boolean(errors.dispute_reason)}
            helperText={
              errors.dispute_reason?.message ??
              'Explain what the institution disagreed with. Visible to admins only.'
            }
            htmlFor="commission-dispute-reason"
          >
            <TextField
              id="commission-dispute-reason"
              fullWidth
              hiddenLabel
              multiline
              minRows={4}
              inputProps={{ maxLength: 2000 }}
              placeholder="The institution claims the student deferred to next intake — see attached email."
              error={Boolean(errors.dispute_reason)}
              {...register('dispute_reason')}
            />
          </LabeledField>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
