'use client';

// Refactored to SVT form-pattern per design pass.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { rememberExportId } from '@/features/io/util';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';

type Resource = 'students' | 'institutions' | 'programs' | 'enrollments' | 'program_fees';
type Format = 'csv' | 'xlsx' | 'json' | 'jsonl';

const RESOURCES: Resource[] = ['students', 'institutions', 'programs', 'enrollments', 'program_fees'];
const FORMATS: Format[] = ['csv', 'xlsx', 'json', 'jsonl'];

export type NewExportDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
};

export default function NewExportDialog({ open, onClose, onCreated }: NewExportDialogProps) {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const isAdmin = user?.role === 'ADMIN';

  const [resource, setResource] = useState<Resource>('students');
  const [format, setFormat] = useState<Format>('csv');
  const [redact, setRedact] = useState<boolean>(true);
  const [filterText, setFilterText] = useState<string>('{}');
  const [filterError, setFilterError] = useState<string | null>(null);

  const reset = () => {
    setResource('students');
    setFormat('csv');
    setRedact(true);
    setFilterText('{}');
    setFilterError(null);
  };

  const mut = useMutation({
    mutationFn: async () => {
      let filter: Record<string, unknown> = {};
      try {
        const trimmed = filterText.trim() || '{}';
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Filter must be a JSON object');
        }
        filter = parsed as Record<string, unknown>;
        setFilterError(null);
      } catch (e) {
        const msg = (e as Error).message;
        setFilterError(msg);
        throw new ApiError({
          type: 'about:blank',
          status: 400,
          title: 'Invalid filter JSON',
          detail: msg,
        });
      }
      const res = await api.post<{ id: string; status: string }>('/exports', {
        resource,
        format,
        filter,
        redact_pii: redact,
        locale: 'en',
        timezone: 'UTC',
      });
      return res.data;
    },
    onSuccess: (data) => {
      rememberExportId(data.id);
      onCreated(data.id);
      reset();
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Could not create export';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const handleClose = () => {
    if (mut.isPending) return;
    reset();
    onClose();
  };

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="New export"
      subtitle="Queue a background export job. You'll receive a download link when it's ready."
      maxWidth="sm"
      primaryAction={{
        label: 'Queue export',
        loadingLabel: 'Queueing…',
        loading: mut.isPending,
        onClick: () => mut.mutate(),
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        <Stack spacing={2.5}>
          <LabeledField
            label="Resource"
            required
            htmlFor="nex-resource"
            helperText="Which collection to export."
          >
            <TextField
              id="nex-resource"
              select
              fullWidth
              size="medium"
              hiddenLabel
              value={resource}
              onChange={(e) => setResource(e.target.value as Resource)}
            >
              {RESOURCES.map((r) => (
                <MenuItem key={r} value={r}>
                  {r}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>

          <LabeledField
            label="Format"
            required
            htmlFor="nex-format"
            helperText="CSV is best for spreadsheets; JSONL for streaming pipelines."
          >
            <TextField
              id="nex-format"
              select
              fullWidth
              size="medium"
              hiddenLabel
              value={format}
              onChange={(e) => setFormat(e.target.value as Format)}
            >
              {FORMATS.map((f) => (
                <MenuItem key={f} value={f}>
                  {f}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>

          <FormControlLabel
            control={
              <Switch
                checked={redact}
                onChange={(_, v) => setRedact(v)}
                disabled={!isAdmin && !redact}
              />
            }
            label={`Redact PII (${redact ? 'on' : 'off — admin only'})`}
          />

          {!isAdmin ? (
            <Alert severity="info" variant="outlined">
              Only admins can switch redaction off. Counsellors get redacted exports by default.
            </Alert>
          ) : null}

          <LabeledField
            label="Filter"
            htmlFor="nex-filter"
            error={Boolean(filterError)}
            helperText={
              filterError ?? 'Optional JSON object — leave as {} for no filter.'
            }
          >
            <TextField
              id="nex-filter"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder='e.g. {"destination_country":"GB"}'
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              error={Boolean(filterError)}
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
            />
          </LabeledField>
        </Stack>
      </Box>
    </AppDialog>
  );
}
