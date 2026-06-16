'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { MenuItem, Stack, TextField } from '@mui/material';
import { useSnackbar } from 'notistack';

import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { useUpdateLead, useUsersLite, type CrmLeadDetail } from '@/lib/queries';

const STATUSES = ['ACTIVE', 'COMPLETED', 'WITHDRAWN', 'ON_HOLD'];

type FormValues = { spv_status: string; assigned_to_id: string; spv_notes: string };

export default function EditLeadDialog({ open, lead, onClose }: { open: boolean; lead: CrmLeadDetail; onClose: () => void }) {
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const { enqueueSnackbar } = useSnackbar();
  const usersQuery = useUsersLite(admin);
  const update = useUpdateLead(lead.id);

  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<FormValues>({
    mode: 'onBlur',
    defaultValues: { spv_status: lead.spv_status, assigned_to_id: lead.assigned_to_id ?? '', spv_notes: lead.spv_notes ?? '' },
  });

  useEffect(() => {
    if (open) reset({ spv_status: lead.spv_status, assigned_to_id: lead.assigned_to_id ?? '', spv_notes: lead.spv_notes ?? '' });
  }, [open, lead, reset]);

  const onSubmit = handleSubmit((values) => {
    update.mutate(
      { version: lead.version, patch: { spv_status: values.spv_status, assigned_to_id: values.assigned_to_id ? values.assigned_to_id : null, spv_notes: values.spv_notes.trim() ? values.spv_notes.trim() : null } },
      {
        onSuccess: () => { enqueueSnackbar('Lead updated.', { variant: 'success' }); onClose(); },
        onError: (err) => {
          if (err instanceof ApiError) {
            if (err.status === 412 || err.status === 409) {
              enqueueSnackbar('This record changed elsewhere — reopen and retry.', { variant: 'warning' });
            } else {
              for (const fe of err.errors) {
                const leaf = fe.path.split('.').pop();
                if (leaf === 'spv_status' || leaf === 'assigned_to_id' || leaf === 'spv_notes') setError(leaf as keyof FormValues, { type: 'server', message: fe.message });
              }
              enqueueSnackbar(err.detail || err.title || 'Could not update', { variant: 'error' });
            }
          } else {
            enqueueSnackbar('Could not update', { variant: 'error' });
          }
        },
      },
    );
  });

  return (
    <AppDialog open={open} title="Edit lead" subtitle={lead.full_name} onClose={onClose} primaryAction={{ label: 'Save', formId: 'edit-lead-form', loading: update.isPending }}>
      <form id="edit-lead-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={1.5}>
          <LabeledField label="Status" htmlFor="lead-status" error={Boolean(errors.spv_status)} helperText={errors.spv_status?.message ?? ' '}>
            <TextField id="lead-status" select fullWidth hiddenLabel size="medium" defaultValue={lead.spv_status} error={Boolean(errors.spv_status)} {...register('spv_status')}>
              {STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </LabeledField>
          {admin ? (
            <LabeledField label="Assigned to" htmlFor="lead-assignee" error={Boolean(errors.assigned_to_id)} helperText={errors.assigned_to_id?.message ?? 'Counsellor who owns this lead'}>
              <TextField id="lead-assignee" select fullWidth hiddenLabel size="medium" defaultValue={lead.assigned_to_id ?? ''} error={Boolean(errors.assigned_to_id)} {...register('assigned_to_id')}>
                <MenuItem value="">Unassigned</MenuItem>
                {(usersQuery.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.display_name || `${u.given_name} ${u.family_name}`.trim() || u.id}</MenuItem>)}
              </TextField>
            </LabeledField>
          ) : null}
          <LabeledField label="Notes" htmlFor="lead-notes" error={Boolean(errors.spv_notes)} helperText={errors.spv_notes?.message ?? 'Optional'}>
            <TextField id="lead-notes" fullWidth hiddenLabel size="medium" multiline minRows={3} error={Boolean(errors.spv_notes)} {...register('spv_notes')} />
          </LabeledField>
        </Stack>
      </form>
    </AppDialog>
  );
}
