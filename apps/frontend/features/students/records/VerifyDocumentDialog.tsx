'use client';

// Refactored to SVT form-pattern per design pass.
//
// VerifyDocumentDialog
// ---------------------------------------------------------------------------
// Admin-only dialog wrapping PATCH /documents/:id/verification. The backend
// schema VerifyDocumentRequest accepts:
//   - verification : 'VERIFIED' | 'REJECTED' | 'EXPIRED'
//   - notes        : optional, max 2000 chars
//
// The notes field is *not* persisted on the Document row by the service — it
// is only included in the audit-log entry — but we still send it so the audit
// trail captures the reviewer's reasoning.

import { useEffect, useState } from 'react';
import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';

import { api, ApiError } from '@/lib/api';
import { FormDialog } from '../sectionShared';
import LabeledField from '@/components/LabeledField';

type Verification = 'VERIFIED' | 'REJECTED' | 'EXPIRED';

const VERIFICATION_OPTIONS: { value: Verification; label: string }[] = [
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
];

export type VerifyDocumentDialogProps = {
  open: boolean;
  studentId: string;
  documentId: string | null;
  /** Pre-fill the verification select if the document already has a decision. */
  initialVerification?: Verification | 'PENDING' | null;
  onClose: () => void;
};

export default function VerifyDocumentDialog({
  open,
  studentId,
  documentId,
  initialVerification,
  onClose,
}: VerifyDocumentDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [verification, setVerification] = useState<Verification>('VERIFIED');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setVerification(
      initialVerification && initialVerification !== 'PENDING'
        ? initialVerification
        : 'VERIFIED',
    );
    setNotes('');
  }, [open, initialVerification]);

  const mutation = useMutation<unknown, ApiError, void>({
    mutationFn: async () => {
      if (!documentId) throw new Error('Missing document id');
      const body: { verification: Verification; notes?: string } = { verification };
      const trimmed = notes.trim();
      if (trimmed) body.notes = trimmed;
      const res = await api.patch(`/documents/${documentId}/verification`, body);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Verification updated', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['students', studentId, 'documents'] });
      onClose();
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || 'Could not update verification', {
        variant: 'error',
      });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <FormDialog
      open={open}
      title="Verify document"
      formId="verify-document-form"
      isSubmitting={mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
      submitLabel="Save decision"
    >
      <Box
        component="form"
        id="verify-document-form"
        onSubmit={handleSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so the verification select
          // sits at the canonical row height. Multiline (notes) excluded.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Stack spacing={2.5}>
          {/* Required-field legend — explicit so the convention is unambiguous. */}
          <Typography variant="caption" color="text.secondary">
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>
          <LabeledField
            label="Verification"
            required
            htmlFor="vd-verif"
          >
            <TextField
              id="vd-verif"
              select
              fullWidth
              size="medium"
              hiddenLabel
              value={verification}
              onChange={(e) => setVerification(e.target.value as Verification)}
            >
              {VERIFICATION_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField
            label="Notes"
            helperText="Recorded in the audit log only. Max 2000 characters."
            htmlFor="vd-notes"
          >
            <TextField
              id="vd-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              inputProps={{ maxLength: 2000 }}
            />
          </LabeledField>
        </Stack>
      </Box>
    </FormDialog>
  );
}
