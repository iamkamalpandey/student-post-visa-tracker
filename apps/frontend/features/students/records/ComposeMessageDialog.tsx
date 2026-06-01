'use client';

// Refactored to SVT form-pattern per design pass.
//
// Compose dialog for the Records → Messages section. Picks a channel,
// optionally pulls subject/body from a MessageTemplate, and POSTs to the
// per-student messages endpoint. Server returns 202 immediately and the
// log-provider stamps SENT/FAILED in the background.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api, ApiError } from '@/lib/api';
import { TEMPLATES_QK } from '@/features/io/util';
import { FormDialog } from '../sectionShared';
import type { MessageChannel } from './MessagesSection';
import LabeledField from '@/components/LabeledField';

const CHANNELS: MessageChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP'];

type Template = {
  id: string;
  key: string;
  channel: MessageChannel;
  subject: string | null;
  body_md: string;
  is_active: boolean;
};

export type ComposeMessageDialogProps = {
  open: boolean;
  onClose: () => void;
  studentId: string;
};

export default function ComposeMessageDialog({
  open,
  onClose,
  studentId,
}: ComposeMessageDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [channel, setChannel] = useState<MessageChannel>('EMAIL');
  const [templateId, setTemplateId] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
  const [body, setBody] = useState<string>('');

  // Reset whenever the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setChannel('EMAIL');
      setTemplateId('');
      setSubject('');
      setBody('');
    }
  }, [open]);

  // Templates are filtered server-side by channel so we can show only the
  // relevant ones in the dropdown without extra client filtering.
  const templatesQuery = useQuery<Template[]>({
    queryKey: [...TEMPLATES_QK.list(), { channel }],
    queryFn: async () => {
      const res = await api.get<Template[] | { data: Template[] }>(
        '/message-templates',
        { params: { limit: 100, channel } },
      );
      const arr = Array.isArray(res.data)
        ? res.data
        : ((res.data as { data?: Template[] }).data ?? []);
      return arr.filter((t) => t.is_active);
    },
    enabled: open,
  });

  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);

  const [missing, setMissing] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);

  // SVT-WAVE18-PREVIEW-2026-05 — when a template is picked, ask the server to
  // render it against the student context so the user sees what will actually
  // be sent (not the raw {{var}} literal). Falls back to raw body_md on error.
  const onPickTemplate = async (id: string) => {
    setTemplateId(id);
    setMissing([]);
    if (!id) return;
    const t = templates.find((tt) => tt.id === id);
    if (!t) return;
    setPreviewing(true);
    try {
      const res = await api.post<{ subject: string | null; body: string; missing: string[] }>(
        `/students/${studentId}/messages/from-template/preview`,
        { template_id: id },
      );
      setSubject(res.data.subject ?? '');
      setBody(res.data.body);
      setMissing(res.data.missing ?? []);
    } catch {
      if (t.subject) setSubject(t.subject);
      setBody(t.body_md);
    } finally {
      setPreviewing(false);
    }
  };

  const mutation = useMutation<unknown, ApiError>({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        channel,
        body,
        // Stamp channel into metadata so the list view can render the chip
        // without joining back to the thread row.
        metadata: { channel },
      };
      if (channel === 'EMAIL' && subject.trim()) {
        payload['subject'] = subject.trim();
      }
      if (templateId) {
        payload['template_id'] = templateId;
      }
      const res = await api.post(`/students/${studentId}/messages`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Message queued.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['students', studentId, 'messages'] });
      onClose();
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || 'Could not send message', {
        variant: 'error',
      });
    },
  });

  const onSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    mutation.mutate();
  };

  const submitDisabled =
    mutation.isPending || !body.trim() || (channel === 'EMAIL' && !subject.trim());

  return (
    <FormDialog
      open={open}
      title="New message"
      formId="compose-message-form"
      isSubmitting={mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      submitLabel="Send"
      onClose={onClose}
    >
      <Box
        component="form"
        id="compose-message-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so channel/template selects and
          // the subject input line up vertically. Multiline (body) excluded
          // so it can grow.
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
            label="Channel"
            required
            htmlFor="cm-channel"
          >
            <TextField
              id="cm-channel"
              select
              fullWidth
              size="medium"
              hiddenLabel
              value={channel}
              onChange={(e) => {
                const next = e.target.value as MessageChannel;
                setChannel(next);
                // Clear the template — its channel may no longer match.
                setTemplateId('');
              }}
            >
              {CHANNELS.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>

          <LabeledField
            label="Template (optional)"
            helperText={
              templatesQuery.isLoading
                ? 'Loading templates…'
                : templates.length === 0
                  ? `No active ${channel} templates available.`
                  : 'Selecting a template pre-fills subject and body.'
            }
            htmlFor="cm-template"
          >
            <TextField
              id="cm-template"
              select
              fullWidth
              size="medium"
              hiddenLabel
              value={templateId}
              onChange={(e) => onPickTemplate(e.target.value)}
              disabled={templatesQuery.isLoading || templates.length === 0}
            >
              <MenuItem value="">
                <em>None — write from scratch</em>
              </MenuItem>
              {templates.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.key}
                  {t.subject ? ` — ${t.subject}` : ''}
                </MenuItem>
              ))}
            </TextField>
            {previewing && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                Rendering preview…
              </Typography>
            )}
            {!previewing && missing.length > 0 && (
              <Typography variant="caption" color="warning.main" sx={{ mt: 0.5 }}>
                Missing context: {missing.join(', ')}. Edit body to fill before sending.
              </Typography>
            )}
          </LabeledField>

          {channel === 'EMAIL' ? (
            <LabeledField
              label="Subject"
              required
              htmlFor="cm-subject"
            >
              <TextField
                id="cm-subject"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Brief summary"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                inputProps={{ maxLength: 200 }}
              />
            </LabeledField>
          ) : null}

          <LabeledField
            label="Body (Markdown)"
            required
            helperText="Plain markdown. Rendered server-side; for now the preview is plain text."
            htmlFor="cm-body"
          >
            <TextField
              id="cm-body"
              fullWidth
              hiddenLabel
              multiline
              minRows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              inputProps={{ maxLength: 20000 }}
            />
          </LabeledField>

          <Typography variant="caption" color="text.secondary">
            The message is queued, then dispatched in the background. Status
            updates appear in the list once the provider responds.
          </Typography>
        </Stack>
      </Box>
    </FormDialog>
  );
}
