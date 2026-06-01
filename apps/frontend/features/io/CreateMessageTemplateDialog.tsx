'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { TEMPLATES_QK } from '@/features/io/util';
import { api, ApiError } from '@/lib/api';

type Channel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';

const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP'];

export type TemplateRecord = {
  id: string;
  key: string;
  channel: Channel;
  subject: string | null;
  body_md: string;
  destination_country: string | null;
  stage_id: string | null;
  is_active: boolean;
};

export type CreateMessageTemplateDialogProps = {
  open: boolean;
  onClose: () => void;
  /** When provided, dialog edits this record instead of creating. */
  template?: TemplateRecord | null;
};

export default function CreateMessageTemplateDialog({
  open,
  onClose,
  template,
}: CreateMessageTemplateDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();

  const [key, setKey] = useState('');
  const [channel, setChannel] = useState<Channel>('EMAIL');
  const [subject, setSubject] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [destinationCountry, setDestinationCountry] = useState('');
  const [stageId, setStageId] = useState('');

  // Capture the snapshot we last seeded the form with so we can compute "dirty".
  const initial = useMemo(
    () => ({
      key: template?.key ?? '',
      channel: (template?.channel ?? 'EMAIL') as Channel,
      subject: template?.subject ?? '',
      bodyMd: template?.body_md ?? '',
      destinationCountry: template?.destination_country ?? '',
      stageId: template?.stage_id ?? '',
    }),
    [template],
  );

  useEffect(() => {
    if (open) {
      setKey(initial.key);
      setChannel(initial.channel);
      setSubject(initial.subject);
      setBodyMd(initial.bodyMd);
      setDestinationCountry(initial.destinationCountry);
      setStageId(initial.stageId);
    }
  }, [open, initial]);

  const isEdit = !!template;
  const isDirty =
    key !== initial.key ||
    channel !== initial.channel ||
    subject !== initial.subject ||
    bodyMd !== initial.bodyMd ||
    destinationCountry !== initial.destinationCountry ||
    stageId !== initial.stageId;

  const mut = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        key: key.trim(),
        channel,
        body_md: bodyMd,
        is_active: true,
      };
      if (subject.trim()) payload['subject'] = subject.trim();
      if (destinationCountry.trim()) payload['destination_country'] = destinationCountry.trim().toUpperCase();
      if (stageId.trim()) payload['stage_id'] = stageId.trim();

      if (isEdit && template) {
        // Strip key on edit — backend treats key as immutable identifier.
        delete payload['key'];
        const res = await api.patch(`/message-templates/${template.id}`, payload);
        return res.data;
      }
      const res = await api.post('/message-templates', payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Template updated.' : 'Template created.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: TEMPLATES_QK.all });
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Could not save template';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const handleClose = () => {
    if (mut.isPending) return;
    onClose();
  };

  const saveDisabled = !isDirty || mut.isPending || !key.trim() || !bodyMd.trim();
  const saveBlockedReason = !isDirty
    ? 'Make a change to enable saving'
    : !key.trim() || !bodyMd.trim()
      ? 'Key and body are required'
      : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title={isEdit ? 'Edit template' : 'New template'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create template',
        loadingLabel: isEdit ? 'Saving…' : 'Creating…',
        loading: mut.isPending,
        onClick: () => mut.mutate(),
        disabled: saveDisabled,
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <LabeledField
            label="Key"
            required
            helperText={
              isEdit
                ? 'Key cannot be changed after creation.'
                : 'Lowercase letters, digits, dash or underscore (2–80 chars).'
            }
            htmlFor="tpl-key"
          >
            <TextField
              id="tpl-key"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="visa-grant-welcome"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={isEdit}
            />
          </LabeledField>
          <LabeledField
            label="Channel"
            required
            htmlFor="tpl-channel"
          >
            <TextField
              id="tpl-channel"
              select
              fullWidth
              hiddenLabel
              size="medium"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              {CHANNELS.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField
            label="Subject"
            helperText="Optional. Used by EMAIL and IN_APP channels."
            htmlFor="tpl-subject"
          >
            <TextField
              id="tpl-subject"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="Your visa has been granted — next steps"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              inputProps={{ maxLength: 200 }}
            />
          </LabeledField>
          <LabeledField
            label="Body (Markdown)"
            required
            helperText="Supports ICU placeholders like {given_name}."
            htmlFor="tpl-body"
          >
            <TextField
              id="tpl-body"
              fullWidth
              hiddenLabel
              multiline
              minRows={6}
              placeholder={'Hi {given_name},\n\nGreat news — your visa was granted on {grant_date}.'}
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
              inputProps={{ maxLength: 20000 }}
            />
          </LabeledField>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Destination country (ISO α-2)"
                helperText="Optional. Scopes the template to a single country."
                htmlFor="tpl-country"
              >
                <TextField
                  id="tpl-country"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="AU"
                  value={destinationCountry}
                  onChange={(e) => setDestinationCountry(e.target.value)}
                  inputProps={{ maxLength: 2 }}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Stage ID"
                helperText="Optional UUID — pins the template to a workflow stage."
                htmlFor="tpl-stage"
              >
                <TextField
                  id="tpl-stage"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="3f1b…"
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                />
              </LabeledField>
            </Grid>
          </Grid>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
