// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import ContactMailOutlinedIcon from '@mui/icons-material/ContactMailOutlined';
import WorkOutlineOutlinedIcon from '@mui/icons-material/WorkOutlineOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import {
  CreateContactRequest,
  type CreateContactRequest as CreateContactRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCurrencies, useRelationshipTypes, useTenant } from '@/lib/queries';
import { formatPhone } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import PhoneField from '@/components/PhoneField';
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

type Contact = {
  id: string;
  relationship_id: string;
  given_name: string;
  family_name: string;
  phone_e164?: string | null;
  email?: string | null;
  occupation?: string | null;
  employer?: string | null;
  annual_income_minor?: number | string | null;
  income_currency?: string | null;
  is_primary_guardian: boolean;
  is_emergency_contact: boolean;
  is_financial_sponsor: boolean;
  address_id?: string | null;
};

export type ContactsSectionProps = { studentId: string };

export default function ContactsSection({ studentId }: ContactsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Contact>();
  const deleteDlg = useDialogState<Contact>();

  const queryKey = ['students', studentId, 'contacts'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/contacts`);
      return unwrapList<Contact>(res.data);
    },
  });

  const relationshipTypes = useRelationshipTypes();
  const relationshipLabel = (id: string) =>
    relationshipTypes.data?.find((r) => r.key === id)?.label ?? id;

  const columns: DataTableColumn<Contact>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (r) => `${r.given_name} ${r.family_name}`,
    },
    {
      key: 'relationship',
      label: 'Relationship',
      render: (r) => relationshipLabel(r.relationship_id),
    },
    { key: 'phone', label: 'Phone', render: (r) => formatPhone(r.phone_e164) || '—' },
    { key: 'email', label: 'Email', render: (r) => r.email ?? '—' },
    {
      key: 'roles',
      label: 'Role',
      render: (r) => (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" rowGap={0.5}>
          {r.is_primary_guardian ? <Chip size="small" label="Guardian" color="primary" /> : null}
          {r.is_emergency_contact ? <Chip size="small" label="Emergency" color="warning" /> : null}
          {r.is_financial_sponsor ? <Chip size="small" label="Sponsor" color="success" /> : null}
        </Stack>
      ),
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

  const removeMutation = useMutation<void, ApiError, Contact>({
    mutationFn: async (row) => {
      await api.delete(`/contacts/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Contact deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Contacts"
        description="Guardians, sponsors and emergency contacts."
        onAdd={dlg.openCreate}
        addLabel="Add contact"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="contacts"
        onAdd={dlg.openCreate}
        addLabel="Add contact"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <ContactFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => {
          qc.invalidateQueries({ queryKey });
          qc.invalidateQueries({ queryKey: ['student', studentId] });
        }}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete contact?"
        description="This permanently removes the contact from this student's profile."
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

type FormValues = CreateContactRequestType;

function ContactFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Contact | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const relationshipTypes = useRelationshipTypes();
  const currencies = useCurrencies();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateContactRequest),
    defaultValues: {
      relationship_id: '',
      given_name: '',
      family_name: '',
      phone_e164: '',
      email: '',
      occupation: '',
      employer: '',
      income_currency: '',
      is_primary_guardian: false,
      is_emergency_contact: false,
      is_financial_sponsor: false,
    },
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed income_currency from tenant default on create.
  const tenantQ = useTenant(open && !editing);

  useEffect(() => {
    if (!open) return;
    reset({
      relationship_id: editing?.relationship_id ?? '',
      given_name: editing?.given_name ?? '',
      family_name: editing?.family_name ?? '',
      phone_e164: editing?.phone_e164 ?? '',
      email: editing?.email ?? '',
      occupation: editing?.occupation ?? '',
      employer: editing?.employer ?? '',
      annual_income_minor:
        editing?.annual_income_minor != null ? String(editing.annual_income_minor) : undefined,
      income_currency: editing?.income_currency ?? (tenantQ.data?.default_currency ?? ''),
      is_primary_guardian: editing?.is_primary_guardian ?? false,
      is_emergency_contact: editing?.is_emergency_contact ?? false,
      is_financial_sponsor: editing?.is_financial_sponsor ?? false,
    });
  }, [open, editing, reset, tenantQ.data?.default_currency]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/contacts/${editing.id}`, body);
      return api.post(`/students/${studentId}/contacts`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Contact updated' : 'Contact added', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));
  // For edit flows pre-existing data isn't dirty until the user touches it,
  // so we treat editing flows as always-saveable (the API still rejects no-ops).
  const saveDisabled = (!editing && !isDirty) || isSubmitting || mutation.isPending;

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit contact' : 'Add contact'}
      formId="contact-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="contact-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
          '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
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
          title="Relationship & name"
          subtitle="How this person relates to the student"
          icon={<GroupOutlinedIcon />}
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
                htmlFor="ct-rel"
              >
                <Controller
                  name="relationship_id"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ct-rel"
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
                htmlFor="ct-given"
              >
                <TextField
                  id="ct-given"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Maya"
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
                htmlFor="ct-family"
              >
                <TextField
                  id="ct-family"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Sharma"
                  error={Boolean(errors.family_name)}
                  {...register('family_name')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Contact details"
          subtitle="Phone and email"
          icon={<ContactMailOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Phone"
                error={Boolean(errors.phone_e164)}
                helperText={errors.phone_e164?.message ?? 'E.164 with country code.'}
              >
                <Controller
                  name="phone_e164"
                  control={control}
                  render={({ field }) => (
                    <PhoneField
                      label=""
                      fullWidth
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      error={Boolean(errors.phone_e164)}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Email"
                error={Boolean(errors.email)}
                helperText={errors.email?.message ?? ''}
                htmlFor="ct-email"
              >
                <TextField
                  id="ct-email"
                  type="email"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="contact@example.com"
                  error={Boolean(errors.email)}
                  {...register('email')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Employment & sponsorship"
          subtitle="Income context for sponsor evaluation"
          icon={<WorkOutlineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Occupation"
                error={Boolean(errors.occupation)}
                helperText={errors.occupation?.message ?? ''}
                htmlFor="ct-occ"
              >
                <TextField
                  id="ct-occ"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Civil engineer"
                  error={Boolean(errors.occupation)}
                  {...register('occupation')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Employer"
                error={Boolean(errors.employer)}
                helperText={errors.employer?.message ?? ''}
                htmlFor="ct-emp"
              >
                <TextField
                  id="ct-emp"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Acme Pvt. Ltd."
                  error={Boolean(errors.employer)}
                  {...register('employer')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Annual income (minor units)"
                encrypted
                error={Boolean(errors.annual_income_minor)}
                helperText={errors.annual_income_minor?.message ?? 'Smallest currency unit (cents/paise).'}
                htmlFor="ct-income"
              >
                <TextField
                  id="ct-income"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  inputProps={{ min: 0, step: 1 }}
                  placeholder="e.g. 6000000"
                  error={Boolean(errors.annual_income_minor)}
                  {...register('annual_income_minor')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Income currency"
                error={Boolean(errors.income_currency)}
                helperText={errors.income_currency?.message ?? ''}
                htmlFor="ct-curr"
              >
                <Controller
                  name="income_currency"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ct-curr"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.income_currency)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      <MenuItem value="">—</MenuItem>
                      {(currencies.data ?? []).map((c) => (
                        <MenuItem key={c.code} value={c.code}>
                          {c.code} — {c.name}
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
          title="Roles"
          subtitle="What this contact is responsible for"
          icon={<PersonOutlineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={1.5}>
            <Controller
              name="is_primary_guardian"
              control={control}
              render={({ field }) => (
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Switch
                    checked={Boolean(field.value)}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                  <span>Primary guardian</span>
                </Stack>
              )}
            />
            <Controller
              name="is_emergency_contact"
              control={control}
              render={({ field }) => (
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Switch
                    checked={Boolean(field.value)}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                  <span>Emergency contact</span>
                </Stack>
              )}
            />
            <Controller
              name="is_financial_sponsor"
              control={control}
              render={({ field }) => (
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Switch
                    checked={Boolean(field.value)}
                    onChange={(e) => field.onChange(e.target.checked)}
                  />
                  <span>Financial sponsor</span>
                </Stack>
              )}
            />
          </Stack>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
