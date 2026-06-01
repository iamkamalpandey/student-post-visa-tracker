// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import {
  CreateDependentRequest,
  type CreateDependentRequest as CreateDependentRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCountries, useRelationshipTypes } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  compactPayload,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../sectionShared';

type Dependent = {
  id: string;
  relationship_id: string;
  given_name: string;
  family_name: string;
  date_of_birth: string;
  nationality_code: string;
  passport_number?: string | null;
  visa_status?: string | null;
  accompanies_principal: boolean;
  notes?: string | null;
};

export type DependentsSectionProps = { studentId: string };

export default function DependentsSection({ studentId }: DependentsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Dependent>();
  const deleteDlg = useDialogState<Dependent>();

  const queryKey = ['students', studentId, 'dependents'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/dependents`);
      return unwrapList<Dependent>(res.data);
    },
  });

  const relationshipTypes = useRelationshipTypes();
  const relationshipLabel = (id: string) =>
    relationshipTypes.data?.find((r) => r.key === id)?.label ?? id;

  const columns: DataTableColumn<Dependent>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (r) => `${r.given_name} ${r.family_name}`,
    },
    { key: 'rel', label: 'Relationship', render: (r) => relationshipLabel(r.relationship_id) },
    { key: 'dob', label: 'Date of birth', render: (r) => formatDate(r.date_of_birth) },
    { key: 'nat', label: 'Nationality', render: (r) => r.nationality_code },
    { key: 'passport', label: 'Passport', render: (r) => r.passport_number ?? '—' },
    {
      key: 'accompanies',
      label: 'Accompanies',
      render: (r) => (r.accompanies_principal ? 'Yes' : 'No'),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite={canWrite}
          onEdit={() => dlg.openEdit(r)}
          onDelete={() => deleteDlg.openEdit(r)}
        />
      ),
    },
  ];

  const removeMutation = useMutation<void, ApiError, Dependent>({
    mutationFn: async (row) => {
      await api.delete(`/dependents/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Dependent deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Dependents"
        description="Spouses and children travelling on dependent visas (F-2, Tier 4 dep, etc.)."
        onAdd={dlg.openCreate}
        addLabel="Add dependent"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="dependents"
        onAdd={dlg.openCreate}
        addLabel="Add dependent"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <DependentFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete dependent?"
        description="This permanently removes the dependent record."
        confirmText="Delete"
        loading={removeMutation.isPending}
        errorText={removeMutation.error?.detail ?? null}
        onClose={() => deleteDlg.close()}
        onConfirm={() => {
          if (deleteDlg.editing) removeMutation.mutate(deleteDlg.editing);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------

type FormValues = CreateDependentRequestType;

function DependentFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Dependent | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const countries = useCountries();
  const relationshipTypes = useRelationshipTypes();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateDependentRequest),
    defaultValues: {
      relationship_id: '',
      given_name: '',
      family_name: '',
      date_of_birth: '',
      nationality_code: '',
      passport_number: '',
      visa_status: '',
      accompanies_principal: true,
      notes: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      relationship_id: editing?.relationship_id ?? '',
      given_name: editing?.given_name ?? '',
      family_name: editing?.family_name ?? '',
      date_of_birth: editing?.date_of_birth?.slice(0, 10) ?? '',
      nationality_code: editing?.nationality_code ?? '',
      passport_number: editing?.passport_number ?? '',
      visa_status: editing?.visa_status ?? '',
      accompanies_principal: editing?.accompanies_principal ?? true,
      notes: editing?.notes ?? '',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/dependents/${editing.id}`, body);
      return api.post(`/students/${studentId}/dependents`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Dependent updated' : 'Dependent added', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));
  const saveDisabled = (!editing && !isDirty) || isSubmitting || mutation.isPending;

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit dependent' : 'Add dependent'}
      formId="dependent-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="dependent-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        {saveDisabled && !isSubmitting && !mutation.isPending ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Make a change to enable saving
          </Typography>
        ) : null}

        <FormSection
          title="Identity"
          subtitle="Who the dependent is"
          icon={<PersonOutlineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              <LabeledField
                label="Relationship"
                required
                error={Boolean(errors.relationship_id)}
                helperText={errors.relationship_id?.message ?? ''}
                htmlFor="dp-rel"
              >
                <Controller
                  name="relationship_id"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="dp-rel"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.relationship_id)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      {(relationshipTypes.data ?? []).map((r) => (
                        <MenuItem key={r.key} value={r.key}>
                          {r.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Given name"
                required
                error={Boolean(errors.given_name)}
                helperText={errors.given_name?.message ?? ''}
                htmlFor="dp-given"
              >
                <TextField
                  id="dp-given"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Anish"
                  error={Boolean(errors.given_name)}
                  {...register('given_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Family name"
                required
                error={Boolean(errors.family_name)}
                helperText={errors.family_name?.message ?? ''}
                htmlFor="dp-family"
              >
                <TextField
                  id="dp-family"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Sharma"
                  error={Boolean(errors.family_name)}
                  {...register('family_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Date of birth"
                required
                error={Boolean(errors.date_of_birth)}
                helperText={errors.date_of_birth?.message ?? ''}
                htmlFor="dp-dob"
              >
                <TextField
                  id="dp-dob"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.date_of_birth)}
                  {...register('date_of_birth')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Nationality"
                required
                error={Boolean(errors.nationality_code)}
                helperText={errors.nationality_code?.message ?? ''}
                htmlFor="dp-nat"
              >
                <Controller
                  name="nationality_code"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="dp-nat"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.nationality_code)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      {(countries.data ?? []).map((c) => (
                        <MenuItem key={c.code_alpha2} value={c.code_alpha2}>
                          {c.name} ({c.code_alpha2})
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Travel documents"
          subtitle="Passport and visa status"
          icon={<PublicOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Passport number"
                encrypted
                error={Boolean(errors.passport_number)}
                helperText={errors.passport_number?.message ?? ''}
                htmlFor="dp-pp"
              >
                <TextField
                  id="dp-pp"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. P9876543"
                  error={Boolean(errors.passport_number)}
                  {...register('passport_number')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Visa status"
                error={Boolean(errors.visa_status)}
                helperText={errors.visa_status?.message ?? ''}
                htmlFor="dp-vs"
              >
                <TextField
                  id="dp-vs"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Tier 4 dependent"
                  error={Boolean(errors.visa_status)}
                  {...register('visa_status')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Controller
                  name="accompanies_principal"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Accompanies the student</Typography>
              </Stack>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Notes"
          subtitle="Internal commentary"
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? ''}
            htmlFor="dp-notes"
          >
            <TextField
              id="dp-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. Travelling separately on later flight."
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
