'use client';

// SVT-WAVE21-THREAD-DRILL-2026-05 — modal that shows a thread + its messages
// and exposes a reply box. Open from /inbox?tab=threads. Mounts on demand to
// keep the bell-fetch + threads-list queries fresh.
//
// Wire:
//   - GET /api/v1/comms/threads/:id auto-marks recipient_user_id=me messages
//     as read; the response carries `newly_read` so the bell badge can drop.
//   - POST /api/v1/students/:studentId/messages with thread_id queues the
//     reply on the existing thread (no thread fork).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import { formatRelative } from '@/lib/format';

type MessageRow = {
  id: string;
  subject: string | null;
  body: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: string;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
  recipient_user_id: string | null;
};
type ThreadDetail = {
  thread: {
    id: string;
    student_id: string | null;
    channel: string;
    subject: string | null;
    created_at: string;
    student: { id: string; given_name: string; family_name: string; student_code: string } | null;
  };
  messages: MessageRow[];
  newly_read: number;
};

export type ThreadDetailDialogProps = {
  open: boolean;
  threadId: string | null;
  onClose: () => void;
};

export default function ThreadDetailDialog({ open, threadId, onClose }: ThreadDetailDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [reply, setReply] = useState('');

  const q = useQuery({
    queryKey: ['comms', 'thread', threadId],
    enabled: open && Boolean(threadId),
    queryFn: async () => {
      const res = await api.get<{ data: ThreadDetail }>(`/comms/threads/${threadId}`);
      return res.data.data;
    },
  });

  // Bell badge drops as soon as the auto-mark-read fires.
  useEffect(() => {
    if (q.data && q.data.newly_read > 0) {
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['comms', 'threads'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'summary'] });
    }
  }, [q.data, qc]);

  useEffect(() => {
    if (!open) setReply('');
  }, [open]);

  const send = useMutation({
    mutationFn: async () => {
      const t = q.data?.thread;
      if (!t || !t.student_id) throw new Error('System threads cannot accept replies.');
      const res = await api.post(`/students/${t.student_id}/messages`, {
        channel: t.channel,
        body: reply.trim(),
        thread_id: t.id,
        metadata: { channel: t.channel },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Reply queued.', { variant: 'success' });
      setReply('');
      void qc.invalidateQueries({ queryKey: ['comms', 'thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['comms', 'threads'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Could not send reply';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const studentName = q.data?.thread.student
    ? `${q.data.thread.student.given_name} ${q.data.thread.student.family_name}`
    : 'System notifications';
  const title = q.data?.thread.subject ?? studentName;
  const canReply = Boolean(q.data?.thread.student_id);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={title}
      subtitle={`${studentName} · ${q.data?.thread.channel ?? ''}`}
      maxWidth="md"
      primaryAction={
        canReply
          ? {
              label: 'Send reply',
              onClick: () => void send.mutate(),
              loading: send.isPending,
              loadingLabel: 'Sending…',
              disabled: !reply.trim() || send.isPending,
            }
          : {
              label: 'Close',
              onClick: onClose,
              color: 'inherit',
            }
      }
      secondaryAction={canReply ? { label: 'Close', onClick: onClose } : undefined}
    >
      {q.isLoading && <CircularProgress size={20} />}
      {q.isError && (
        <Typography color="error" variant="body2">
          Couldn't load thread. Try again shortly.
        </Typography>
      )}
      {q.data && (
        <Stack spacing={2}>
          <Stack spacing={1.5} sx={{ maxHeight: 360, overflowY: 'auto' }}>
            {q.data.messages.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No messages yet.
              </Typography>
            )}
            {q.data.messages.map((m) => (
              <Box
                key={m.id}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1.5,
                  p: 1.5,
                  bgcolor: m.direction === 'OUTBOUND' ? 'action.hover' : 'background.paper',
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Chip
                    size="small"
                    label={m.direction === 'OUTBOUND' ? 'Sent' : 'Received'}
                    variant="outlined"
                  />
                  <Chip size="small" label={m.status} variant="outlined" />
                  <Typography variant="caption" color="text.secondary">
                    {formatRelative(m.sent_at ?? m.created_at)}
                  </Typography>
                </Stack>
                {m.subject && (
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                    {m.subject}
                  </Typography>
                )}
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {m.body}
                </Typography>
              </Box>
            ))}
          </Stack>
          {canReply ? (
            <>
              <Divider />
              <Stack spacing={1}>
                <Typography variant="caption" color="text.secondary">
                  Reply on this thread ({q.data.thread.channel})
                </Typography>
                <TextField
                  multiline
                  minRows={3}
                  fullWidth
                  size="small"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Type your reply…"
                  inputProps={{ maxLength: 20000 }}
                />
              </Stack>
            </>
          ) : (
            <Typography variant="caption" color="text.secondary">
              System-notification threads are read-only.
            </Typography>
          )}
        </Stack>
      )}
    </AppDialog>
  );
}
