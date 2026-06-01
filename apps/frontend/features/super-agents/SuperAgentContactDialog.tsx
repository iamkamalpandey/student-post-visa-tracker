'use client';

// CRUD dialog for SuperAgentContact rows (per-tab on super-agent detail).
// Follows SVT-FORMPATTERN-2026-05: AppDialog + FormSection (compact, muted) +
// LabeledField + 44px input height + status banner for Save UX.

import { useEffect, useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import {
  CreateSuperAgentContactRequest,
  UpdateSuperAgentContactRequest,
} from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';

// Wire row — only the bits the UI consumes.
export type SuperAgentContactRow = {
  id: string;
  super_agent_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone_e164: string | null;
  is_primary: boolean;
  notes: string | null;
};

type Props = {
  open: boolean;
  superAgentId: string;
  row: SuperAgentContactRow | null;
  onClose: () => void;
};

type FormValues = {
  name: string;
  role: string;
  email: string;
  phone_e164: string;
  is_primary: boolean;
  notes: string;
};

function emptyDefaults(): FormValues {
  return { name: '', role: '', email: '', phone_e164: '', is_primary: false, notes: '' };
}

function fromRow(r: SuperAgentContactRow): FormValues {
  return {
    name: r.name,
    role: r.role ?? '',
    email: r.email ?? '',
    phone_e164: r.phone_e164 ?? '',
    is_primary: r.is_primary,
    notes: r.notes ?? '',
  };
}

function toPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: values.name.trim(),
    is_primary: values.is_primary,
  };
  const role = values.role.trim();
  if (role) out['role'] = role;
  const em = values.email.trim();
  if (em) out['email'] = em;
  const ph = values.phone_e164.trim();
  if (ph) out['phone_e164'] = ph;
  const nt = values.notes.trim();
  if (nt) out['notes'] = nt;
  return out;
}

export default function SuperAgentContactDialog({
  open,
  superAgentId,
  row,
  onClose,
}: Props) {
  const isEdit = row !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const defaults = useMemo<FormValues>(
    () => (row ? fromRow(row) : emptyDefaults()),
    [row],
  );
  const resolverSchema = isEdit
    ? UpdateSuperAgentContactRequest
    : CreateSuperAgentContactRequest;

  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: defaults,
    resolver: (async (values: FormValues) => {
      const payload = toPayload(values);
      const parsed = resolverSchema.safeParse(payload);
      if (parsed.success) return { values, errors: {} };
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[0];
        if (typeof path === 'string') {
          fieldErrors[path] = { type: 'validation', message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    }) as Resolver<FormValues>,
  });

  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toPayload(values);
      if (isEdit && row) {
        const res = await api.patch(
          `/super-agents/${superAgentId}/contacts/${row.id}`,
          payload,
        );
        return res.data as SuperAgentContactRow;
      }
      const res = await api.post(
        `/super-agents/${superAgentId}/contacts`,
        payload,
      );
      return res.data as SuperAgentContactRow;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Contact updated' : 'Contact added', {
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['super-agent', superAgentId, 'contacts'] });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  const onSubmit = handleSubmit((v) => mutation.mutate(v));

  const saveBlockedReason = !isDirty
    ? 'Make a change to enable saving'
    : Object.keys(errors).length > 0
      ? 'Fix errors above'
      : null;

  const topLevelError =
    mutation.isError && mutation.error instanceof ApiError
      ? mutation.error.detail || mutation.error.title
      : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit contact: ${row?.name ?? ''}` : 'Add super-agent contact'}
      subtitle="Operational contact at the aggregator. Primary contact is highlighted on the list."
      maxWidth="sm"
      errorText={topLevelError ?? null}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add contact',
        loadingLabel: isEdit ? 'Saving…' : 'Adding…',
        loading: isSubmitting || mutation.isPending,
        disabled: !isDirty || isSubmitting || mutation.isPending,
        formId: 'sa-contact-form',
      }}
    >
      <Box
        component="form"
        id="sa-contact-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // SVT-FORMPATTERN-2026-05: 44px input height (notes excluded).
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': {
            paddingTop: 0,
            paddingBottom: 0,
            height: '100%',
          },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>
            *
          </Box>
          Required
        </Typography>
        <FormSection
          title="Contact"
          subtitle="Name, role, and how to reach them."
          icon={<PersonOutlineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={7}>
              <LabeledField
                label="Name"
                required
                error={Boolean(errors.name)}
                helperText={errors.name?.message ?? ''}
                htmlFor="sac-name"
              >
                <TextField
                  id="sac-name"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="e.g. Priya Patel"
                  error={Boolean(errors.name)}
                  {...register('name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={5}>
              <LabeledField
                label="Role / title"
                error={Boolean(errors.role)}
                helperText={errors.role?.message ?? 'e.g. Partnerships Manager'}
                htmlFor="sac-role"
              >
                <TextField
                  id="sac-role"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="Partnerships Manager"
                  error={Boolean(errors.role)}
                  {...register('role')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Email"
                error={Boolean(errors.email)}
                helperText={errors.email?.message ?? ''}
                htmlFor="sac-email"
              >
                <TextField
                  id="sac-email"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  type="email"
                  placeholder="priya@aggregator.com"
                  error={Boolean(errors.email)}
                  {...register('email')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Phone (E.164)"
                error={Boolean(errors.phone_e164)}
                helperText={errors.phone_e164?.message ?? 'e.g. +442071234567'}
                htmlFor="sac-phone"
              >
                <TextField
                  id="sac-phone"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="+442071234567"
                  error={Boolean(errors.phone_e164)}
                  {...register('phone_e164')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <Controller
                name="is_primary"
                control={control}
                render={({ field }) => (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={field.value}
                        onChange={(_, v) => field.onChange(v)}
                      />
                    }
                    label="Primary contact"
                  />
                )}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Highlighted on the super-agent overview. Only one primary recommended per agent.
              </Typography>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Notes"
                error={Boolean(errors.notes)}
                helperText={errors.notes?.message ?? 'Optional. Up to 2000 characters.'}
                htmlFor="sac-notes"
              >
                <TextField
                  id="sac-notes"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={2}
                  inputProps={{ maxLength: 2000 }}
                  error={Boolean(errors.notes)}
                  {...register('notes')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* Status banner — keeps Save UX consistent with the gold-standard form. */}
        {saveBlockedReason ? (
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Typography variant="caption" color="text.secondary">
              {saveBlockedReason}
            </Typography>
          </Box>
        ) : null}
        {mutation.isError && mutation.error instanceof ApiError && mutation.error.errors?.length ? (
          <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
            Fix the {mutation.error.errors.length} highlighted error
            {mutation.error.errors.length === 1 ? '' : 's'} above and try again.
          </Alert>
        ) : null}
      </Box>
    </AppDialog>
  );
}
