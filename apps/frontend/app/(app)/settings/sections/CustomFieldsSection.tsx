'use client';

// SVT-UNLOCK-2026-08 — admin management of tenant-defined custom fields.
//
// The AttributeDefinition backend shipped complete (full CRUD, ADMIN-gated
// writes, zod validation, tenant isolation, audit) and had no UI, so a feature
// the database supported was unreachable. This is the definition half; values
// are edited per-record by features/attributes/CustomFieldsSection.tsx.
//
// Contract notes verified against the backend rather than assumed:
//   * `GET /attribute-definitions` returns a BARE ARRAY, not `{ data }`.
//   * `PaginationQuery.limit` caps at 100 and the list query is `.strict()`.
//   * `key` must match /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/ and is immutable in
//     practice — changing it orphans existing values, so we only allow it on
//     create.

import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  CreateAttributeDefinitionRequest,
  type CreateAttributeDefinitionRequest as CreateAttributeDefinitionRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import LabeledField from '@/components/LabeledField';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  unwrapList,
  useDialogState,
} from '@/features/students/sectionShared';
import type { AttributeDefinition } from '@/features/attributes/CustomFieldsSection';

/** Entity types a tenant may attach custom fields to. */
const ENTITY_TYPES = ['student', 'lead', 'enrollment', 'institution'] as const;
const DATA_TYPES = ['text', 'number', 'date', 'bool', 'enum'] as const;
const LIST_LIMIT = 100;

export default function CustomFieldsSection() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const isAdmin = user?.role === 'ADMIN';
  const [entityType, setEntityType] = useState<string>('student');
  const dlg = useDialogState<AttributeDefinition>();
  const deleteDlg = useDialogState<AttributeDefinition>();

  const queryKey = ['attribute-definitions', entityType];
  const listQuery = useQuery({
    queryKey,
    enabled: isAdmin,
    queryFn: async () => {
      const res = await api.get('/attribute-definitions', {
        params: { entity_type: entityType, limit: LIST_LIMIT },
      });
      return unwrapList<AttributeDefinition>(res.data);
    },
  });

  const removeMutation = useMutation<void, ApiError, AttributeDefinition>({
    mutationFn: async (row) => {
      await api.delete(`/attribute-definitions/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Custom field deleted', { variant: 'success' });
      void qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  if (!isAdmin) return null;

  const columns: DataTableColumn<AttributeDefinition>[] = [
    { key: 'label', label: 'Label', render: (r) => r.label },
    {
      key: 'key',
      label: 'Key',
      render: (r) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {r.key}
        </Typography>
      ),
    },
    { key: 'type', label: 'Type', render: (r) => r.data_type },
    {
      key: 'flags',
      label: 'Flags',
      render: (r) => (
        <Stack direction="row" spacing={0.5}>
          {r.is_required ? <Chip size="small" label="Required" /> : null}
          {r.is_pii ? <Chip size="small" variant="outlined" label="PII" /> : null}
        </Stack>
      ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite
          itemLabel={r.label}
          onEdit={() => dlg.openEdit(r)}
          onDelete={() => deleteDlg.openEdit(r)}
        />
      ),
    },
  ];

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent>
        <SectionHeader
          title="Custom fields"
          description="Define extra fields for your workspace. They appear on the matching record's detail page."
          onAdd={dlg.openCreate}
          addLabel="Add field"
        />
        <Box sx={{ mb: 2, maxWidth: 260 }}>
          <LabeledField label="Applies to" htmlFor="cf-entity-type">
            <TextField
              id="cf-entity-type"
              select
              fullWidth
              size="small"
              hiddenLabel
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            >
              {ENTITY_TYPES.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
        </Box>
        <SectionStates
          query={listQuery}
          resource="custom fields"
          onAdd={dlg.openCreate}
          addLabel="Add field"
        >
          {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
        </SectionStates>
      </CardContent>

      <DefinitionFormDialog
        open={dlg.open}
        editing={dlg.editing}
        entityType={entityType}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete this custom field?"
        description="Every value recorded against this field is deleted with it. This cannot be undone."
        confirmText="Delete"
        loading={removeMutation.isPending}
        errorText={removeMutation.error?.detail ?? null}
        onClose={() => deleteDlg.close()}
        onConfirm={() => {
          if (deleteDlg.editing) removeMutation.mutate(deleteDlg.editing);
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

type FormValues = CreateAttributeDefinitionRequestType & { enum_values_raw?: string };

function DefinitionFormDialog({
  open,
  editing,
  entityType,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: AttributeDefinition | null;
  entityType: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();

  const {
    register,
    control,
    watch,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateAttributeDefinitionRequest) as never,
    defaultValues: {
      entity_type: entityType,
      key: '',
      label: '',
      data_type: 'text',
      is_pii: false,
      is_required: false,
    },
  });

  const dataType = watch('data_type');

  useEffect(() => {
    if (!open) return;
    reset({
      entity_type: editing?.entity_type ?? entityType,
      key: editing?.key ?? '',
      label: editing?.label ?? '',
      data_type: editing?.data_type ?? 'text',
      is_pii: editing?.is_pii ?? false,
      is_required: editing?.is_required ?? false,
      enum_values_raw: (editing?.enum_values ?? []).join(', '),
    });
  }, [open, editing, entityType, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const enumValues = (values.enum_values_raw ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        entity_type: values.entity_type,
        label: values.label,
        data_type: values.data_type,
        is_pii: values.is_pii,
        is_required: values.is_required,
        ...(values.data_type === 'enum' && enumValues.length > 0
          ? { enum_values: enumValues }
          : {}),
      };
      if (editing) {
        // `key` is deliberately omitted on update: changing it would orphan
        // every value already recorded against the definition.
        return api.patch(`/attribute-definitions/${editing.id}`, body);
      }
      return api.post('/attribute-definitions', { ...body, key: values.key });
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Custom field updated' : 'Custom field added', {
        variant: 'success',
      });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit custom field' : 'Add custom field'}
      formId="attribute-definition-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box component="form" id="attribute-definition-form" onSubmit={onSubmit} noValidate>
        <Grid container spacing={2.5}>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Label"
              required
              error={Boolean(errors.label)}
              helperText={errors.label?.message ?? 'Shown to users on the record.'}
              htmlFor="cf-label"
            >
              <TextField id="cf-label" fullWidth hiddenLabel {...register('label')} />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Key"
              required
              error={Boolean(errors.key)}
              helperText={
                errors.key?.message ??
                (editing
                  ? 'Cannot be changed — existing values reference it.'
                  : 'Lowercase slug, e.g. sponsor_reference.')
              }
              htmlFor="cf-key"
            >
              <TextField
                id="cf-key"
                fullWidth
                hiddenLabel
                disabled={Boolean(editing)}
                placeholder="sponsor_reference"
                {...register('key')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Data type"
              required
              error={Boolean(errors.data_type)}
              helperText={errors.data_type?.message ?? ''}
              htmlFor="cf-data-type"
            >
              <Controller
                name="data_type"
                control={control}
                render={({ field }) => (
                  <TextField id="cf-data-type" select fullWidth hiddenLabel {...field}>
                    {DATA_TYPES.map((t) => (
                      <MenuItem key={t} value={t}>
                        {t}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
          </Grid>
          {dataType === 'enum' ? (
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Options"
                helperText="Comma-separated, e.g. Bronze, Silver, Gold"
                htmlFor="cf-enum"
              >
                <TextField id="cf-enum" fullWidth hiddenLabel {...register('enum_values_raw')} />
              </LabeledField>
            </Grid>
          ) : null}
          <Grid item xs={12}>
            <Stack direction="row" spacing={3}>
              <Controller
                name="is_required"
                control={control}
                render={({ field }) => (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={Boolean(field.value)}
                        onChange={(e) => field.onChange(e.target.checked)}
                      />
                    }
                    label="Required"
                  />
                )}
              />
              <Controller
                name="is_pii"
                control={control}
                render={({ field }) => (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={Boolean(field.value)}
                        onChange={(e) => field.onChange(e.target.checked)}
                      />
                    }
                    label="Contains personal data"
                  />
                )}
              />
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </FormDialog>
  );
}
