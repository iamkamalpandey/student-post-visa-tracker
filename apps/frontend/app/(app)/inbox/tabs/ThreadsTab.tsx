'use client';

// SVT-WAVE19-THREADS-2026-05 — per-tenant comms thread browser tab on /inbox.
//
// Fetches /api/v1/comms/threads (tenant-scoped, last_message embedded, per-user
// unread_count). Clicking a thread navigates to the student detail with the
// Records tab pre-selected. Channel filter chip strip lets the user narrow.

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import SmsOutlinedIcon from '@mui/icons-material/SmsOutlined';
import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import { api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import { formatRelative } from '@/lib/format';
import ThreadDetailDialog from '@/features/comms/ThreadDetailDialog';

type ChannelFilter = 'ALL' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';

type ThreadRow = {
  id: string;
  student_id: string | null;
  channel: string;
  subject: string | null;
  created_at: string;
  student: { id: string; given_name: string; family_name: string; student_code: string } | null;
  last_message: {
    id: string;
    subject: string | null;
    body: string;
    created_at: string;
    status: string;
    direction: 'INBOUND' | 'OUTBOUND';
  } | null;
  unread_count: number;
};

function channelIcon(c: string) {
  if (c === 'EMAIL') return <EmailOutlinedIcon fontSize="small" />;
  if (c === 'SMS') return <SmsOutlinedIcon fontSize="small" />;
  if (c === 'WHATSAPP') return <WhatsAppIcon fontSize="small" />;
  if (c === 'IN_APP') return <NotificationsActiveOutlinedIcon fontSize="small" />;
  return <ForumOutlinedIcon fontSize="small" />;
}

export default function ThreadsTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [channel, setChannel] = useState<ChannelFilter>('ALL');
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  // SVT-WAVE29-THREAD-SEARCH-2026-05 — local text input + 250ms debounced
  // value the query depends on. Keystrokes stay snappy; the wire call is
  // throttled.
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // SVT-WAVE30-DEEPLINK-2026-05 — `?open=<threadId>` auto-opens the detail
  // dialog. We strip the param after picking it up so a tab refresh doesn't
  // re-open the dialog on every reload (and so the back button after closing
  // doesn't re-trigger it). Bell notifications + share-this-thread links both
  // funnel through this entry point.
  useEffect(() => {
    const want = searchParams?.get('open');
    if (!want) return;
    setOpenThreadId(want);
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.delete('open');
    const qs = next.toString();
    router.replace(qs ? `/inbox?${qs}` : '/inbox?tab=threads');
    // searchParams is stable per Next render — only run when its serialized
    // form actually changes (i.e. the user lands on a new URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams?.toString()]);

  const q = useQuery({
    queryKey: ['comms', 'threads', channel, debouncedSearch],
    refetchInterval: 60_000,
    queryFn: async () => {
      const params: Record<string, string | number> = { limit: 50 };
      if (channel !== 'ALL') params['channel'] = channel;
      if (debouncedSearch) params['q'] = debouncedSearch;
      const res = await api.get<{ data: ThreadRow[] }>('/comms/threads', { params });
      return res.data.data;
    },
  });

  const rows = q.data ?? [];

  return (
    <Stack spacing={2} sx={{ pt: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {(['ALL', 'EMAIL', 'SMS', 'WHATSAPP', 'IN_APP'] as ChannelFilter[]).map((c) => (
          <Chip
            key={c}
            label={c === 'ALL' ? 'All channels' : c}
            variant={channel === c ? 'filled' : 'outlined'}
            color={channel === c ? 'primary' : 'default'}
            onClick={() => setChannel(c)}
            size="small"
          />
        ))}
        <TextField
          size="small"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search subject or student…"
          sx={{ minWidth: 240, flexGrow: 1 }}
          inputProps={{ 'aria-label': 'Search threads', maxLength: 80 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlinedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Tooltip title="Refresh">
          <Button size="small" startIcon={<RefreshOutlinedIcon />} onClick={() => void q.refetch()}>
            Refresh
          </Button>
        </Tooltip>
      </Stack>

      {q.isLoading ? (
        <LoadingSkeleton variant="page" />
      ) : q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ForumOutlinedIcon />}
          title={debouncedSearch ? 'No matching threads' : 'No threads'}
          description={
            debouncedSearch
              ? `Nothing matched "${debouncedSearch}". Clear the search or pick a different channel.`
              : 'Send a message from a student detail page — threads appear here grouped by channel.'
          }
        />
      ) : (
        <Stack spacing={1}>
          {rows.map((t) => {
            const subjectLine =
              t.subject ??
              t.last_message?.subject ??
              (t.last_message?.body ? t.last_message.body.slice(0, 80) : 'Thread');
            return (
              <Card key={t.id} variant="outlined">
                <CardActionArea onClick={() => setOpenThreadId(t.id)}>
                  <CardContent sx={{ py: 1.5 }}>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Box sx={{ color: 'text.secondary' }}>{channelIcon(t.channel)}</Box>
                      <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                            {subjectLine}
                          </Typography>
                          {t.unread_count > 0 && (
                            <Chip size="small" color="primary" label={`${t.unread_count} unread`} />
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {t.student
                            ? `${t.student.given_name} ${t.student.family_name} · ${t.student.student_code}`
                            : 'System notifications'}
                          {t.last_message ? ` · ${formatRelative(t.last_message.created_at)}` : ''}
                        </Typography>
                      </Stack>
                      <Chip size="small" label={t.channel} variant="outlined" />
                    </Stack>
                  </CardContent>
                </CardActionArea>
              </Card>
            );
          })}
        </Stack>
      )}
      <ThreadDetailDialog
        open={openThreadId !== null}
        threadId={openThreadId}
        onClose={() => setOpenThreadId(null)}
      />
    </Stack>
  );
}
