'use client';

// Refactored to SVT form-pattern per design pass.
//
// UploadDocumentDialog
// ---------------------------------------------------------------------------
// MUI Dialog for uploading a single Document for a student. The backend
// accepts multipart/form-data with two parts:
//   - file     : the binary
//   - metadata : a JSON string conforming to UploadDocumentMetadata
// (see apps/backend/src/modules/documents/documents.controller.ts).
//
// We let axios infer Content-Type from the FormData payload by *deleting* the
// default 'application/json' header for this single request — otherwise the
// boundary parameter would never make it onto the wire.

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';

import { api, ApiError } from '@/lib/api';
import { useDocumentTypes } from '@/lib/queries';
import { formatBytes } from '@/lib/format';
import { FormDialog } from '../sectionShared';
import LabeledField from '@/components/LabeledField';

// The /lookups/document-types endpoint returns the full DocumentType row,
// which includes `id` (the FK target). The shared lookup type only declares
// `key`/`label` so we widen it locally.
type DocumentTypeRow = {
  id: string;
  key: string;
  label: string;
  category?: string | null;
};

const ACCEPT_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

export type UploadDocumentDialogProps = {
  open: boolean;
  studentId: string;
  onClose: () => void;
};

export default function UploadDocumentDialog({
  open,
  studentId,
  onClose,
}: UploadDocumentDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const docTypesQuery = useDocumentTypes();

  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<DocumentTypeRow | null>(null);
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setDocType(null);
    setIssuedOn('');
    setExpiresOn('');
    setLocalError(null);
  }, [open]);

  const docTypeOptions = useMemo<DocumentTypeRow[]>(
    () => (docTypesQuery.data as unknown as DocumentTypeRow[] | undefined) ?? [],
    [docTypesQuery.data],
  );

  const uploadMutation = useMutation<unknown, ApiError, FormData>({
    mutationFn: async (form) => {
      const res = await api.post(`/students/${studentId}/documents`, form, {
        // Let axios derive the multipart boundary; setting Content-Type
        // explicitly here would clobber the boundary parameter.
        headers: { 'Content-Type': undefined as unknown as string },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Document uploaded', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['students', studentId, 'documents'] });
      onClose();
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || 'Upload failed', {
        variant: 'error',
      });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (!file) {
      setLocalError('Please choose a file.');
      return;
    }
    if (!docType) {
      setLocalError('Please pick a document type.');
      return;
    }

    const meta: Record<string, string> = { document_type_id: docType.id };
    if (issuedOn) meta['issued_on'] = issuedOn;
    if (expiresOn) meta['expires_on'] = expiresOn;

    const form = new FormData();
    form.append('file', file);
    form.append('metadata', JSON.stringify(meta));

    uploadMutation.mutate(form);
  }

  return (
    <FormDialog
      open={open}
      title="Upload document"
      formId="upload-document-form"
      isSubmitting={uploadMutation.isPending}
      errorText={uploadMutation.error?.detail ?? localError ?? null}
      onClose={onClose}
      submitLabel="Upload"
    >
      <Box
        component="form"
        id="upload-document-form"
        onSubmit={handleSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, autocomplete and
          // text fields line up vertically — matches the SVT form pattern.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        <Stack spacing={2.5}>
          {/* Required-field legend — explicit so the convention is unambiguous. */}
          <Typography variant="caption" color="text.secondary">
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>
          <LabeledField
            label="File"
            required
            helperText={
              file
                ? `${file.name} — ${formatBytes(file.size)}`
                : 'PDF, PNG, JPEG, WebP, HEIC, DOCX, or XLSX. Max 10 MiB.'
            }
          >
            <Stack spacing={1}>
              <Button
                component="label"
                variant="outlined"
                startIcon={<UploadFileOutlinedIcon />}
                sx={{ alignSelf: 'flex-start' }}
              >
                {file ? 'Change file' : 'Choose file'}
                <input
                  hidden
                  type="file"
                  accept={ACCEPT_MIME}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Button>
            </Stack>
          </LabeledField>

          <LabeledField
            label="Document type"
            required
            htmlFor="ud-type"
          >
            <Autocomplete
              options={docTypeOptions}
              value={docType}
              onChange={(_, v) => setDocType(v)}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              loading={docTypesQuery.isLoading}
              fullWidth
              size="medium"
              renderInput={(params) => (
                <TextField
                  {...params}
                  id="ud-type"
                  hiddenLabel
                  placeholder="Pick a document type"
                />
              )}
            />
          </LabeledField>

          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            }}
          >
            <LabeledField label="Issued on" htmlFor="ud-issued">
              <TextField
                id="ud-issued"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)}
              />
            </LabeledField>
            <LabeledField label="Expires on" htmlFor="ud-expires">
              <TextField
                id="ud-expires"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                value={expiresOn}
                onChange={(e) => setExpiresOn(e.target.value)}
              />
            </LabeledField>
          </Box>

          {docTypesQuery.isError ? (
            <Alert severity="warning">
              Could not load document types. The list may be empty.
            </Alert>
          ) : null}
        </Stack>
      </Box>
    </FormDialog>
  );
}
