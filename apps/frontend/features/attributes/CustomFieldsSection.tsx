'use client';

// SVT-UNLOCK-2026-08 — custom fields (tenant-defined attributes).
//
// The backend for this shipped complete — AttributeDefinition + EntityAttribute
// with full CRUD, role gates, zod validation, tenant isolation and audit — and
// nothing in the frontend ever called it. This section is the missing half.
//
// Shape of the feature:
//   * An ADMIN defines fields per entity type (settings → Custom fields).
//   * Everyone sees them here; ADMIN + COUNSELLOR can set values.
//   * A definition with no value yet still renders, so users can see which
//     fields exist and which are required but unset.
//
// Two API details worth knowing, both verified against the backend rather than
// assumed:
//   * Both list endpoints return a BARE ARRAY, not a `{ data }` envelope, so
//     everything goes through `unwrapList`.
//   * `PaginationQuery.limit` is capped at 100 and both list queries are
//     `.strict()`, so sending a larger limit or an undeclared param is a 422.

import { useEffect, useMemo } from 'react';
import {
  Box,
  Chip,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import LabeledField from '@/components/LabeledField';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../students/sectionShared';

/** Mirrors `AttributeDataTypeEnum` in packages/zod-schemas/src/attributes.ts. */
export type AttributeDataType = 'text' | 'number' | 'date' | 'bool' | 'enum';

export type AttributeDefinition = {
  id: string;
  entity_type: string;
  key: string;
  label: string;
  data_type: AttributeDataType;
  enum_values?: string[] | null;
  is_pii: boolean;
  is_required: boolean;
  destination_country?: string | null;
};

export type EntityAttribute = {
  id: string;
  definition_id: string;
  entity_type: string;
  entity_id: string;
  value_text?: string | null;
  // Prisma Decimal(20,6) serialises as a string over the wire.
  value_number?: string | number | null;
  value_date?: string | null;
  value_bool?: boolean | null;
};

/** A definition paired with its value for this entity (value may be absent). */
type FieldRow = {
  definition: AttributeDefinition;
  value: EntityAttribute | null;
};

export type CustomFieldsSectionProps = {
  /** Matches `AttributeDefinition.entity_type`, e.g. 'student' or 'lead'. */
  entityType: string;
  entityId: string;
};

// The list endpoints cap `limit` at 100 (PaginationQuery). A tenant with more
// than 100 definitions on one entity type is well outside the design intent;
// if that ever happens the cursor is there to page through.
const LIST_LIMIT = 100;

export default function CustomFieldsSection({ entityType, entityId }: CustomFieldsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const editDlg = useDialogState<FieldRow>();
  const clearDlg = useDialogState<FieldRow>();

  const defsKey = ['attribute-definitions', entityType];
  const valuesKey = ['entity-attributes', entityType, entityId];

  const defsQuery = useQuery({
    queryKey: defsKey,
    queryFn: async () => {
      const res = await api.get('/attribute-definitions', {
        params: { entity_type: entityType, limit: LIST_LIMIT },
      });
      return unwrapList<AttributeDefinition>(res.data);
    },
  });

  const valuesQuery = useQuery({
    queryKey: valuesKey,
    queryFn: async () => {
      const res = await api.get('/entity-attributes', {
        params: { entity_type: entityType, entity_id: entityId, limit: LIST_LIMIT },
      });
      return unwrapList<EntityAttribute>(res.data);
    },
  });

  // Join definitions to values so a defined-but-unset field still shows.
  const rows = useMemo<FieldRow[]>(() => {
    const defs = defsQuery.data ?? [];
    const values = valuesQuery.data ?? [];
    const byDefinition = new Map(values.map((v) => [v.definition_id, v]));
    return defs.map((definition) => ({
      definition,
      value: byDefinition.get(definition.id) ?? null,
    }));
  }, [defsQuery.data, valuesQuery.data]);

  // Surface whichever query is unhealthy; definitions first since values are
  // meaningless without them.
  const combinedQuery = {
    isLoading: defsQuery.isLoading || valuesQuery.isLoading,
    isError: defsQuery.isError || valuesQuery.isError,
    error: defsQuery.error ?? valuesQuery.error,
    refetch: () => {
      void defsQuery.refetch();
      void valuesQuery.refetch();
    },
    data: rows,
  };

  const clearMutation = useMutation<void, ApiError, FieldRow>({
    mutationFn: async (row) => {
      if (!row.value) return;
      await api.delete(`/entity-attributes/${row.value.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Value cleared', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: valuesKey });
      clearDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const columns: DataTableColumn<FieldRow>[] = [
    {
      key: 'label',
      label: 'Field',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="body2">{r.definition.label}</Typography>
          {r.definition.is_required ? (
            <Box component="span" aria-label="Required" sx={{ color: 'error.main', fontWeight: 700 }}>
              *
            </Box>
          ) : null}
          {r.definition.is_pii ? <Chip size="small" variant="outlined" label="PII" /> : null}
        </Stack>
      ),
    },
    { key: 'type', label: 'Type', render: (r) => r.definition.data_type },
    { key: 'value', label: 'Value', render: (r) => renderValue(r) },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite={canWrite}
          itemLabel={r.definition.label}
          onEdit={() => editDlg.openEdit(r)}
          onDelete={r.value ? () => clearDlg.openEdit(r) : undefined}
        />
      ),
    },
  ];

  return (
    <Box>
      <SectionHeader
        title="Custom fields"
        description="Tenant-defined fields. An administrator manages the field list in Settings."
      />
      <SectionStates query={combinedQuery} resource="custom fields">
        {(list) => <DataTable columns={columns} rows={list} getRowId={(r) => r.definition.id} />}
      </SectionStates>
      <ValueFormDialog
        open={editDlg.open}
        row={editDlg.editing}
        entityType={entityType}
        entityId={entityId}
        onClose={editDlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey: valuesKey })}
      />
      <ConfirmDialog
        open={clearDlg.open}
        title="Clear this value?"
        description="The field definition stays; only the value recorded against this record is removed."
        confirmText="Clear"
        loading={clearMutation.isPending}
        errorText={clearMutation.error?.detail ?? null}
        onClose={() => clearDlg.close()}
        onConfirm={() => {
          if (clearDlg.editing) clearMutation.mutate(clearDlg.editing);
        }}
      />
    </Box>
  );
}

/** Render a stored value according to its definition's data type. */
function renderValue(row: FieldRow) {
  const { definition, value } = row;
  if (!value) return <Typography variant="body2" color="text.secondary">—</Typography>;
  switch (definition.data_type) {
    case 'bool':
      return value.value_bool == null ? '—' : value.value_bool ? 'Yes' : 'No';
    case 'date':
      return formatDate(value.value_date ?? '');
    case 'number':
      // Decimal arrives as a string; render it verbatim so precision is not
      // lost to a float round-trip just for display.
      return value.value_number == null ? '—' : String(value.value_number);
    default:
      return value.value_text?.trim() ? value.value_text : '—';
  }
}

// ---------------------------------------------------------------------------

type FormValues = {
  value_text: string;
  value_number: string;
  value_date: string;
  value_bool: boolean;
};

function ValueFormDialog({
  open,
  row,
  entityType,
  entityId,
  onClose,
  onSaved,
}: {
  open: boolean;
  row: FieldRow | null;
  entityType: string;
  entityId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const definition = row?.definition ?? null;
  const existing = row?.value ?? null;

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { value_text: '', value_number: '', value_date: '', value_bool: false },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      value_text: existing?.value_text ?? '',
      value_number: existing?.value_number == null ? '' : String(existing.value_number),
      value_date: existing?.value_date?.slice(0, 10) ?? '',
      value_bool: existing?.value_bool ?? false,
    });
  }, [open, existing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!definition) return null;
      // Send only the column this data type uses. The update schema is
      // .strict() and every field optional, so an unset value is simply
      // omitted rather than sent as null.
      const body: Record<string, unknown> = {};
      switch (definition.data_type) {
        case 'bool':
          body['value_bool'] = values.value_bool;
          break;
        case 'date':
          if (values.value_date) body['value_date'] = values.value_date;
          break;
        case 'number':
          if (values.value_number.trim()) body['value_number'] = Number(values.value_number);
          break;
        default:
          if (values.value_text.trim()) body['value_text'] = values.value_text.trim();
          break;
      }
      if (existing) return api.patch(`/entity-attributes/${existing.id}`, body);
      return api.post('/entity-attributes', {
        definition_id: definition.id,
        entity_type: entityType,
        entity_id: entityId,
        ...body,
      });
    },
    onSuccess: () => {
      enqueueSnackbar('Value saved', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));
  if (!definition) return null;

  const fieldId = `custom-field-${definition.key}`;

  return (
    <FormDialog
      open={open}
      title={definition.label}
      formId="custom-field-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box component="form" id="custom-field-form" onSubmit={onSubmit} noValidate>
        {definition.data_type === 'bool' ? (
          <LabeledField label={definition.label} htmlFor={fieldId}>
            <Controller
              name="value_bool"
              control={control}
              render={({ field }) => (
                <Switch
                  id={fieldId}
                  checked={Boolean(field.value)}
                  onChange={(e) => field.onChange(e.target.checked)}
                  inputProps={{ 'aria-label': definition.label }}
                />
              )}
            />
          </LabeledField>
        ) : null}

        {definition.data_type === 'enum' ? (
          <LabeledField
            label={definition.label}
            required={definition.is_required}
            error={Boolean(errors.value_text)}
            helperText={errors.value_text?.message ?? ''}
            htmlFor={fieldId}
          >
            <Controller
              name="value_text"
              control={control}
              render={({ field }) => (
                <TextField id={fieldId} select fullWidth hiddenLabel {...field}>
                  {(definition.enum_values ?? []).map((o) => (
                    <MenuItem key={o} value={o}>
                      {o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
        ) : null}

        {definition.data_type === 'text' ? (
          <LabeledField
            label={definition.label}
            required={definition.is_required}
            encrypted={definition.is_pii}
            error={Boolean(errors.value_text)}
            helperText={errors.value_text?.message ?? ''}
            htmlFor={fieldId}
          >
            <TextField id={fieldId} fullWidth hiddenLabel {...register('value_text')} />
          </LabeledField>
        ) : null}

        {definition.data_type === 'number' ? (
          <LabeledField
            label={definition.label}
            required={definition.is_required}
            error={Boolean(errors.value_number)}
            helperText={errors.value_number?.message ?? ''}
            htmlFor={fieldId}
          >
            <TextField
              id={fieldId}
              type="number"
              inputMode="decimal"
              fullWidth
              hiddenLabel
              {...register('value_number')}
            />
          </LabeledField>
        ) : null}

        {definition.data_type === 'date' ? (
          <LabeledField
            label={definition.label}
            required={definition.is_required}
            error={Boolean(errors.value_date)}
            helperText={errors.value_date?.message ?? ''}
            htmlFor={fieldId}
          >
            <TextField id={fieldId} type="date" fullWidth hiddenLabel {...register('value_date')} />
          </LabeledField>
        ) : null}
      </Box>
    </FormDialog>
  );
}
