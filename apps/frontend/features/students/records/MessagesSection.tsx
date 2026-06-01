'use client';

// Per-student messages feed for the Records tab. Lists outbound + inbound
// CommsMessage rows across every thread for this student (the backend joins
// on thread_id). Counsellors get the "New message" button; VIEWERs see the
// list read-only.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import ArrowOutwardOutlinedIcon from '@mui/icons-material/ArrowOutwardOutlined';
import CallReceivedOutlinedIcon from '@mui/icons-material/CallReceivedOutlined';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import { SectionHeader, unwrapList, useCanWrite } from '../sectionShared';
import ComposeMessageDialog from './ComposeMessageDialog';

export type MessageChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';
export type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export type StudentMessage = {
  id: string;
  thread_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: MessageStatus;
  body: string;
  template_id: string | null;
  provider_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const CHANNEL_COLOR: Record<MessageChannel, 'primary' | 'secondary' | 'success' | 'info'> = {
  EMAIL: 'primary',
  SMS: 'secondary',
  WHATSAPP: 'success',
  IN_APP: 'info',
};

const STATUS_COLOR: Record<
  MessageStatus,
  'default' | 'warning' | 'success' | 'info' | 'error'
> = {
  QUEUED: 'warning',
  SENT: 'info',
  DELIVERED: 'success',
  READ: 'success',
  FAILED: 'error',
};

const LIMIT = 20;

const STUDENT_MESSAGES_QK = (studentId: string) => ['students', studentId, 'messages'] as const;

function formatRelative(iso: string | null, fallbackDate: (iso: string) => string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  // Older than 30 days — fall back to a fully localized absolute date so
  // long-tail messages still render in the user's locale + timezone.
  return fallbackDate(iso);
}

function bodyPreview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

// The backend list payload doesn't include the channel (it lives on the
// thread). We attach it via the per-message metadata when we have it, falling
// back to "—" otherwise. The compose dialog records it in metadata.channel
// for new messages so freshly-sent rows render correctly without an extra
// backend round-trip.
function channelOf(m: StudentMessage): MessageChannel | null {
  const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : null;
  const ch = meta && typeof (meta as { channel?: unknown }).channel === 'string'
    ? ((meta as { channel: string }).channel as MessageChannel)
    : null;
  return ch && CHANNEL_COLOR[ch] ? ch : null;
}

export type MessagesSectionProps = { studentId: string };

export default function MessagesSection({ studentId }: MessagesSectionProps) {
  const canWrite = useCanWrite();
  const fmt = useFormat();
  const [composeOpen, setComposeOpen] = useState(false);

  const listQuery = useQuery<StudentMessage[], ApiError>({
    queryKey: STUDENT_MESSAGES_QK(studentId),
    queryFn: async () => {
      const res = await api.get<StudentMessage[] | { data: StudentMessage[] }>(
        `/students/${studentId}/messages`,
        { params: { limit: LIMIT } },
      );
      return unwrapList<StudentMessage>(res.data);
    },
  });

  const messages = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  return (
    <Box>
      <SectionHeader
        title="Messages"
        description="Outbound and inbound comms for this student. Threads are grouped per channel."
        onAdd={() => setComposeOpen(true)}
        addLabel="New message"
        canAdd={canWrite}
      />

      {listQuery.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : listQuery.isError ? (
        <ErrorState
          title="Could not load messages"
          description={listQuery.error.detail || listQuery.error.title}
          onRetry={() => listQuery.refetch()}
        />
      ) : messages.length === 0 ? (
        <EmptyState
          title="No messages yet"
          description={
            canWrite
              ? 'Send the first message to open a thread with this student.'
              : 'No comms have been recorded for this student yet.'
          }
        />
      ) : (
        <Stack spacing={1.5}>
          {messages.map((m) => {
            const ch = channelOf(m);
            const isOutbound = m.direction === 'OUTBOUND';
            return (
              <Box
                key={m.id}
                sx={{
                  border: (t) => `1px solid ${t.palette.divider}`,
                  borderRadius: 2,
                  p: 1.5,
                  display: 'grid',
                  gridTemplateColumns: '24px 1fr auto',
                  gap: 1.5,
                  alignItems: 'flex-start',
                }}
              >
                <Box sx={{ color: isOutbound ? 'primary.main' : 'text.secondary', pt: 0.25 }}>
                  {isOutbound ? (
                    <ArrowOutwardOutlinedIcon fontSize="small" titleAccess="Outbound" />
                  ) : (
                    <CallReceivedOutlinedIcon fontSize="small" titleAccess="Inbound" />
                  )}
                </Box>

                <Stack spacing={0.75} sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                    {ch ? (
                      <Chip
                        size="small"
                        label={ch}
                        color={CHANNEL_COLOR[ch]}
                        variant="outlined"
                      />
                    ) : null}
                    <Chip
                      size="small"
                      label={m.status}
                      color={STATUS_COLOR[m.status]}
                      variant="filled"
                    />
                    {m.template_id ? (
                      <Chip
                        size="small"
                        label="from template"
                        variant="outlined"
                      />
                    ) : null}
                  </Stack>
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      margin: 0,
                      fontFamily: 'inherit',
                      fontSize: 13.5,
                      lineHeight: 1.45,
                      wordBreak: 'break-word',
                    }}
                  >
                    {bodyPreview(m.body)}
                  </pre>
                </Stack>

                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ whiteSpace: 'nowrap', pt: 0.25 }}
                >
                  {formatRelative(m.sent_at ?? m.created_at, fmt.date)}
                </Typography>
              </Box>
            );
          })}
          {messages.length === LIMIT ? (
            <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
              Showing the {LIMIT} most recent messages.
            </Typography>
          ) : null}
        </Stack>
      )}

      <ComposeMessageDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        studentId={studentId}
      />
    </Box>
  );
}
