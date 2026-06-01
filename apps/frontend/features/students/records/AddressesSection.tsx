'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { z } from 'zod';
import { AddressTypeEnum, CreateAddressRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCountries } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
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

type Address = {
  id: string;
  line1: string;
  line2?: string | null;
  line3?: string | null;
  locality: string;
  region?: string | null;
  postal_code?: string | null;
  country_code: string;
  formatted?: string | null;
};

type StudentAddress = {
  id: string;
  address_id: string;
  type: 'PERMANENT' | 'CURRENT' | 'DESTINATION' | 'CORRESPONDENCE';
  is_current: boolean;
  valid_from?: string | null;
  valid_to?: string | null;
  address?: Address;
};

const TYPE_LABELS: Record<string, string> = {
  PERMANENT: 'Permanent',
  CURRENT: 'Current',
  DESTINATION: 'Destination',
  CORRESPONDENCE: 'Correspondence',
};

export type AddressesSectionProps = { studentId: string };

export default function AddressesSection({ studentId }: AddressesSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<StudentAddress>();
  const deleteDlg = useDialogState<StudentAddress>();

  const queryKey = ['students', studentId, 'addresses'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/addresses`);
      return unwrapList<StudentAddress>(res.data);
    },
  });

  const formatAddress = (a?: Address) => {
    if (!a) return '—';
    return (
      a.formatted ??
      [a.line1, a.line2, a.line3, a.locality, a.region, a.postal_code, a.country_code]
        .filter(Boolean)
        .join(', ')
    );
  };

  const columns: DataTableColumn<StudentAddress>[] = [
    {
      key: 'type',
      label: 'Type',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <span>{TYPE_LABELS[r.type] ?? r.type}</span>
          {r.is_current ? <Chip size="small" label="Current" color="success" /> : null}
        </Stack>
      ),
    },
    { key: 'address', label: 'Address', render: (r) => formatAddress(r.address) },
    { key: 'from', label: 'Valid from', render: (r) => formatDate(r.valid_from ?? '') },
    { key: 'to', label: 'Valid to', render: (r) => formatDate(r.valid_to ?? '') },
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

  const removeMutation = useMutation<void, ApiError, StudentAddress>({
    mutationFn: async (row) => {
      await api.delete(`/students/${studentId}/addresses/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Address removed', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Addresses"
        description="Permanent, current, destination and correspondence addresses."
        onAdd={dlg.openCreate}
        addLabel="Add address"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="addresses"
        onAdd={dlg.openCreate}
        addLabel="Add address"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <AddressFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Remove address?"
        description="This unlinks the address from the student. The underlying Address record is unaffected."
        confirmText="Remove"
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
// Combined form: edits / creates the underlying Address AND the link in a
// single submit. For "create" we POST /addresses then POST the link; for
// "edit" we PATCH both /addresses/:id and /students/:id/addresses/:linkId.
// ---------------------------------------------------------------------------

// Form schema: validate the address fields exactly as `CreateAddressRequest`
// does, plus the StudentAddress link metadata. We rebuild a non-strict object
// rather than .extend()-ing the strict source, so unknown keys (link fields)
// don't trip the .strict() check.
const FormSchema = z.object({
  type: AddressTypeEnum,
  is_current: z.boolean().default(false),
  valid_from: z.string().optional(),
  valid_to: z.string().optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  line3: z.string().max(200).optional(),
  locality: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postal_code: z.string().max(20).optional(),
  country_code: CreateAddressRequest.shape.country_code,
  formatted: z.string().max(500).optional(),
});

type FormValues = z.infer<typeof FormSchema> & {
  // Help TypeScript narrow CreateAddressRequest fields when we destructure later.
  line2?: string;
  line3?: string;
  region?: string;
  postal_code?: string;
  formatted?: string;
};

function AddressFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: StudentAddress | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const countries = useCountries();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      type: 'CURRENT',
      is_current: true,
      line1: '',
      line2: '',
      line3: '',
      locality: '',
      region: '',
      postal_code: '',
      country_code: '',
      formatted: '',
    } as FormValues,
  });

  useEffect(() => {
    if (!open) return;
    const a = editing?.address;
    reset({
      type: editing?.type ?? 'CURRENT',
      is_current: editing?.is_current ?? true,
      valid_from: editing?.valid_from?.slice(0, 10),
      valid_to: editing?.valid_to?.slice(0, 10),
      line1: a?.line1 ?? '',
      line2: a?.line2 ?? '',
      line3: a?.line3 ?? '',
      locality: a?.locality ?? '',
      region: a?.region ?? '',
      postal_code: a?.postal_code ?? '',
      country_code: a?.country_code ?? '',
      formatted: a?.formatted ?? '',
    } as FormValues);
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const { type, is_current, valid_from, valid_to, ...addressFields } = raw;
      const addressBody = compactPayload(addressFields);
      const linkBody = compactPayload({ type, is_current, valid_from, valid_to });

      if (editing && editing.address_id) {
        // Update both records in parallel.
        await Promise.all([
          api.patch(`/addresses/${editing.address_id}`, addressBody),
          api.patch(`/students/${studentId}/addresses/${editing.id}`, linkBody),
        ]);
        return;
      }
      // Create the address first, then link it.
      const addressRes = await api.post<{ id: string } | Address>('/addresses', addressBody);
      const addressId =
        (addressRes.data as { id?: string }).id ?? (addressRes.data as Address).id;
      await api.post(`/students/${studentId}/addresses`, {
        ...linkBody,
        address_id: addressId,
      });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Address updated' : 'Address added', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit address' : 'Add address'}
      formId="address-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="address-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, text, select all line
          // up vertically — matches the SVT form pattern.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend — explicit so the convention is unambiguous. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          <LabeledField
            label="Address type"
            required
            error={Boolean(errors.type)}
            helperText={errors.type?.message ?? ''}
            htmlFor="addr-type"
          >
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <TextField
                  id="addr-type"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.type)}
                  {...field}
                >
                  {AddressTypeEnum.options.map((o) => (
                    <MenuItem key={o} value={o}>
                      {TYPE_LABELS[o] ?? o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <Controller
            name="is_current"
            control={control}
            render={({ field }) => (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  checked={Boolean(field.value)}
                  onChange={(e) => field.onChange(e.target.checked)}
                />
                <span>Currently in use</span>
              </Stack>
            )}
          />
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Address line 1"
              required
              error={Boolean(errors.line1)}
              helperText={errors.line1?.message ?? ''}
              htmlFor="addr-l1"
            >
              <TextField
                id="addr-l1"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Street address"
                error={Boolean(errors.line1)}
                {...register('line1')}
              />
            </LabeledField>
          </Box>
          <LabeledField
            label="Address line 2"
            error={Boolean(errors.line2)}
            helperText={errors.line2?.message ?? ''}
            htmlFor="addr-l2"
          >
            <TextField
              id="addr-l2"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Apt, suite, unit"
              error={Boolean(errors.line2)}
              {...register('line2')}
            />
          </LabeledField>
          <LabeledField
            label="Address line 3"
            error={Boolean(errors.line3)}
            helperText={errors.line3?.message ?? ''}
            htmlFor="addr-l3"
          >
            <TextField
              id="addr-l3"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Building, district"
              error={Boolean(errors.line3)}
              {...register('line3')}
            />
          </LabeledField>
          <LabeledField
            label="City / locality"
            required
            error={Boolean(errors.locality)}
            helperText={errors.locality?.message ?? ''}
            htmlFor="addr-city"
          >
            <TextField
              id="addr-city"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. Sydney"
              error={Boolean(errors.locality)}
              {...register('locality')}
            />
          </LabeledField>
          <LabeledField
            label="Region / state"
            error={Boolean(errors.region)}
            helperText={errors.region?.message ?? ''}
            htmlFor="addr-region"
          >
            <TextField
              id="addr-region"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. NSW"
              error={Boolean(errors.region)}
              {...register('region')}
            />
          </LabeledField>
          <LabeledField
            label="Postal code"
            error={Boolean(errors.postal_code)}
            helperText={errors.postal_code?.message ?? ''}
            htmlFor="addr-pc"
          >
            <TextField
              id="addr-pc"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 2000"
              error={Boolean(errors.postal_code)}
              {...register('postal_code')}
            />
          </LabeledField>
          <LabeledField
            label="Country"
            required
            error={Boolean(errors.country_code)}
            helperText={errors.country_code?.message ?? ''}
            htmlFor="addr-country"
          >
            <Controller
              name="country_code"
              control={control}
              render={({ field }) => (
                <TextField
                  id="addr-country"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.country_code)}
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
          <LabeledField
            label="Valid from"
            error={Boolean(errors.valid_from)}
            helperText={errors.valid_from?.message ?? ''}
            htmlFor="addr-vf"
          >
            <TextField
              id="addr-vf"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.valid_from)}
              {...register('valid_from')}
            />
          </LabeledField>
          <LabeledField
            label="Valid to"
            error={Boolean(errors.valid_to)}
            helperText={errors.valid_to?.message ?? ''}
            htmlFor="addr-vt"
          >
            <TextField
              id="addr-vt"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.valid_to)}
              {...register('valid_to')}
            />
          </LabeledField>
        </Box>
      </Box>
    </FormDialog>
  );
}
