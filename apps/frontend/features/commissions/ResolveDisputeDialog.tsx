'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Box, Stack, TextField } from '@mui/material';
import { ResolveDisputeRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

// Local form schema mirrors the wire schema; resolution_notes is optional.
// We trim to '' before submit and only send the field when populated, so the
// backend's `.strict()` parser doesn't see an empty string that fails min(3).
const FormSchema = ResolveDisputeRequest.extend({
  resolution_notes: z
    .string()
    .max(500, 'Keep the resolution note under 500 characters.')
    .optional(),
});

type FormValues = z.infer<typeof FormSchema>;

export type ResolveDisputeDialogProps = {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
};

/**
 * DISPUTED → INVOICED transition. Optional free-text resolution note is
 * appended to the audit trail (server side); the original `dispute_reason` is
 * cleared on the row but preserved in the audit `before` snapshot.
 */
export default function ResolveDisputeDialog({
  open,
  claim,
  onClose,
}: ResolveDisputeDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('commissions.list');
  const tToast = useTranslations('commissions.list.toasts');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { resolution_notes: '' },
  });

  useEffect(() => {
    if (open) reset({ resolution_notes: '' });
  }, [open, claim?.id, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      const trimmed = values.resolution_notes?.trim();
      const body =
        trimmed && trimmed.length >= 3
          ? { resolution_notes: trimmed }
          : {};
      // Idempotency-Key auto-injected by axios interceptor.
      const res = await api.post(`/commissions/${claim.id}/resolve-dispute`, body);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(tToast('disputeResolvedDetailed'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission', claim?.id] });
      onClose();
    },
    onError: (err) => {
      // 409 == claim is no longer DISPUTED (raced with another admin).
      if (err.status === 409) {
        enqueueSnackbar(err.detail || tToast('resolveConflict'), { variant: 'error' });
        qc.invalidateQueries({ queryKey: ['commissions'] });
        return;
      }
      enqueueSnackbar(err.detail || err.title || tToast('resolveError'), {
        variant: 'error',
      });
    },
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  // Notes are optional — allow submitting even when not dirty (a counsellor
  // may resolve a dispute without writing a note).
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('resolveTitle')}
      subtitle={
        claim ? `${claim.institution.display_name}` : undefined
      }
      errorText={mutation.error?.detail ?? null}
      primaryAction={{
        label: t('resolveConfirm'),
        loadingLabel: t('resolveConfirm'),
        loading: isSubmitting || mutation.isPending,
        formId: 'commission-resolve-dispute-form',
      }}
    >
      <Box
        component="form"
        id="commission-resolve-dispute-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Stack spacing={2}>
          <LabeledField
            label="Resolution notes"
            error={Boolean(errors.resolution_notes)}
            helperText={
              errors.resolution_notes?.message ??
              'Briefly explain how the dispute was resolved. Visible in the audit trail.'
            }
            htmlFor="commission-resolve-notes"
          >
            <TextField
              id="commission-resolve-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder="Partner re-confirmed enrolment after providing transcripts."
              inputProps={{ maxLength: 500 }}
              error={Boolean(errors.resolution_notes)}
              {...register('resolution_notes')}
            />
          </LabeledField>
          {/* Reference isDirty so the destructured value isn't flagged unused. */}
          {isDirty ? null : null}
        </Stack>
      </Box>
    </AppDialog>
  );
}
