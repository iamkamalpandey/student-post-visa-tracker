'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { z } from 'zod';
import { CreateSubProcessorRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';

export type SubProcessorRow = {
  id: string;
  name: string;
  purpose: string;
  region: string;
  contract_url: string | null;
  added_at: string;
  removed_at: string | null;
};

type FormValues = {
  name: string;
  purpose: string;
  region: string;
  contract_url?: string;
};

// Form-side preprocessor: blank contract_url -> undefined so the URL validator
// doesn't trip on empty strings for new entries.
const FormSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const obj = { ...(value as Record<string, unknown>) };
  if (typeof obj['contract_url'] === 'string' && (obj['contract_url'] as string).trim() === '') {
    delete obj['contract_url'];
  }
  return obj;
}, CreateSubProcessorRequest);

export type SubProcessorDialogProps = {
  open: boolean;
  /** When provided, dialog is in edit mode; otherwise create mode. */
  subProcessor: SubProcessorRow | null;
  onClose: () => void;
};

export default function SubProcessorDialog({
  open,
  subProcessor,
  onClose,
}: SubProcessorDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const isEdit = Boolean(subProcessor);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: { name: '', purpose: '', region: '', contract_url: '' },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: subProcessor?.name ?? '',
        purpose: subProcessor?.purpose ?? '',
        region: subProcessor?.region ?? '',
        contract_url: subProcessor?.contract_url ?? '',
      });
    }
  }, [open, subProcessor, reset]);

  const mut = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload: Record<string, unknown> = {
        name: values.name,
        purpose: values.purpose,
        region: values.region,
      };
      if (values.contract_url && values.contract_url.trim() !== '') {
        payload['contract_url'] = values.contract_url.trim();
      }
      if (isEdit && subProcessor) {
        const res = await api.patch(`/sub-processors/${subProcessor.id}`, payload);
        return res.data;
      }
      const res = await api.post('/sub-processors', payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Sub-processor updated.' : 'Sub-processor added.', {
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['sub-processors'] });
      reset();
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (
            fe.path === 'name' ||
            fe.path === 'purpose' ||
            fe.path === 'region' ||
            fe.path === 'contract_url'
          ) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to save sub-processor.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => mut.mutate(values));

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    onClose();
  };

  const saveDisabled = !isDirty || isSubmitting || mut.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? 'Edit sub-processor' : 'Add sub-processor'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add sub-processor',
        loadingLabel: 'Saving…',
        loading: isSubmitting,
        formId: 'sub-processor-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="sub-processor-form"
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
        <Stack spacing={2.5}>
          <LabeledField
            label="Name"
            required
            error={Boolean(errors.name)}
            helperText={errors.name?.message ?? ''}
            htmlFor="sub-name"
          >
            <TextField
              id="sub-name"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="Acme Mailgun Inc."
              error={Boolean(errors.name)}
              {...register('name')}
            />
          </LabeledField>
          <LabeledField
            label="Purpose"
            required
            error={Boolean(errors.purpose)}
            helperText={errors.purpose?.message ?? 'What this vendor processes on our behalf.'}
            htmlFor="sub-purpose"
          >
            <TextField
              id="sub-purpose"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="Transactional email delivery (visa-grant notifications)."
              error={Boolean(errors.purpose)}
              {...register('purpose')}
            />
          </LabeledField>
          <LabeledField
            label="Region"
            required
            error={Boolean(errors.region)}
            helperText={errors.region?.message ?? 'e.g. EU, US, UK, Global'}
            htmlFor="sub-region"
          >
            <TextField
              id="sub-region"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="EU"
              error={Boolean(errors.region)}
              {...register('region')}
            />
          </LabeledField>
          <LabeledField
            label="Contract URL"
            error={Boolean(errors.contract_url)}
            helperText={errors.contract_url?.message ?? 'Link to the DPA / contract (optional).'}
            htmlFor="sub-contract"
          >
            <TextField
              id="sub-contract"
              type="url"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="https://example.com/dpa-2026.pdf"
              error={Boolean(errors.contract_url)}
              {...register('contract_url')}
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
