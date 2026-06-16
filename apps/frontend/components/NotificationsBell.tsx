'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Badge,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Link as MuiLink,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatRelative } from '@/lib/format';

const DRAWER_WIDTH = 380;
const REFRESH_MS = 60_000;

// Backend filter shape (kept here to avoid coupling to a not-yet-exported types
// module). Only the fields rendered are required; everything else stays optional
// so we tolerate schema growth on the API side.
type Reminder = {
  id: string;
  type?: string | null;
  title?: string | null;
  message?: string | null;
  status?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  // SVT-V2-CRM-MIRROR-2026-06 — deep-link target set by the reminder scanner.
  metadata?: { href?: string | null } | null;
};

// SVT-WAVE7-INBOX-2026-05 — IN_APP message rows fed by the transition-notify
// helper (super-agent FSM, commission claim FSM, enrollment FSM).
type InboxMessage = {
  id: string;
  body: string;
  sent_at: string | null;
  read_at: string | null;
  status: string;
  metadata: {
    title?: string;
    href?: string | null;
    source?: string | null;
    entity_id?: string | null;
    sender_label?: string | null;
  } | null;
};

// SVT-WAVE48-BELL-LABELS-2026-05 — humanize the source enum so the chip reads
// "Student message" instead of "assigned_student_activity". Unknown sources
// fall through with title-case so we don't lose context when new sources land.
function humanizeSource(src: string): string {
  switch (src) {
    case 'super_agent': return 'Super-agent';
    case 'enrollment': return 'Enrollment';
    case 'commission': return 'Commission';
    case 'stage': return 'Stage';
    case 'dsar': return 'DSAR';
    case 'assigned_student_activity': return 'Student message';
    default:
      return src.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

type InboxResponse = { data: InboxMessage[]; unread_count: number };

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function dueIso(r: Reminder): string {
  return r.due_at ?? r.due_on ?? '';
}

function reminderTitle(r: Reminder): string {
  return r.title || r.message || r.type || 'Reminder';
}

export default function NotificationsBell() {
  const { user } = useAuth();
  const router = useRouter();
  const locale = useLocale();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);

  const userId = user?.id ?? null;
  // Mirror the drawer anchor in RTL so the panel slides in from the natural
  // "end" edge of the screen for Arabic readers.
  const drawerAnchor: 'left' | 'right' = locale === 'ar' ? 'left' : 'right';

  // 7-day window as YYYY-MM-DD (backend ReminderListQuery expects ISO 8601 date,
  // not full datetime). Keyed by today's date so a tab left open overnight
  // still rolls the window forward instead of freezing on the day it mounted.
  // The refresh ticks every minute so the date check costs nothing.
  const todayKey = new Date().toISOString().slice(0, 10);
  const dueTo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }, [todayKey]);

  const remindersQuery = useQuery({
    queryKey: ['reminders', 'bell', userId, dueTo],
    enabled: Boolean(userId),
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const res = await api.get('/reminders', {
        params: {
          status: 'PENDING',
          ...(userId ? { assigned_to_id: userId } : {}),
          limit: 10,
          due_to: dueTo,
        },
      });
      const items = unwrap<Reminder[]>(res.data) ?? [];
      // SVT-AUDIT-UX-2026-06 (backlog rank 19) — the badge must reflect the TRUE
      // count of due-soon reminders, not the capped (limit:10) preview list
      // length, or a counsellor with 11+ sees a badge frozen below the real
      // number. Read page.total when the API supplies it; fall back to length.
      const total =
        (res.data as { page?: { total?: number } } | undefined)?.page?.total ?? items.length;
      return { items, total };
    },
  });

  const reminders = remindersQuery.data?.items ?? [];
  const reminderTotal = remindersQuery.data?.total ?? reminders.length;

  // SVT-WAVE7-INBOX-2026-05 — fetch IN_APP notifications alongside reminders.
  // Both feed the bell badge and the drawer. Refresh on the same cadence so a
  // single timer covers both.
  const inboxQuery = useQuery({
    queryKey: ['inbox', 'bell', userId],
    enabled: Boolean(userId),
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const res = await api.get<InboxResponse>('/inbox/messages', {
        params: { unread: 'true', limit: 10 },
      });
      return res.data ?? { data: [], unread_count: 0 };
    },
  });
  const inboxMessages = inboxQuery.data?.data ?? [];
  const inboxUnreadCount = inboxQuery.data?.unread_count ?? 0;
  const count = reminderTotal + inboxUnreadCount;

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/inbox/messages/${id}/read`, {});
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err: unknown) => {
      enqueueSnackbar(
        err instanceof Error ? `Could not mark read: ${err.message}` : 'Could not mark message read',
        { variant: 'error' },
      );
    },
  });

  // SVT-WAVE31-BELL-CLEAR-2026-05 — single-click bulk clear for the in-app
  // notification stack. Backend audits the bulk action via existing
  // inbox.message.read-all writeAudit hook.
  const markAllRead = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ updated: number }>('/inbox/messages/read-all', {});
      return res.data.updated ?? 0;
    },
    onSuccess: (count) => {
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      enqueueSnackbar(
        count === 0 ? 'Nothing to clear.' : `${count} notification${count === 1 ? '' : 's'} marked read.`,
        { variant: 'success' },
      );
    },
    onError: (err: unknown) => {
      enqueueSnackbar(
        err instanceof Error ? `Could not clear: ${err.message}` : 'Could not clear notifications',
        { variant: 'error' },
      );
    },
  });

  const openMessage = (m: InboxMessage) => {
    if (m.metadata?.href) {
      markRead.mutate(m.id);
      setOpen(false);
      router.push(m.metadata.href);
    } else {
      markRead.mutate(m.id);
    }
  };

  // SVT-V2-CRM-MIRROR-2026-06 — reminders deep-link to their concern (e.g.
  // /leads/:id). Navigating does NOT auto-acknowledge — that stays an explicit
  // action so a viewed-but-unresolved task isn't silently cleared.
  const openReminder = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const acknowledge = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/reminders/${id}/acknowledge`, {});
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reminders'] });
    },
    onError: (err: unknown) => {
      enqueueSnackbar(
        err instanceof Error ? `Could not acknowledge: ${err.message}` : 'Could not acknowledge reminder',
        { variant: 'error' },
      );
    },
  });

  const handleViewAll = () => {
    setOpen(false);
    // /reminders was folded into /inbox?tab=tasks. Go directly to the
    // tab to skip the redirect hop and keep the URL share-friendly.
    router.push('/inbox?tab=tasks');
  };

  return (
    <>
      <Tooltip title="Reminders">
        <IconButton
          aria-label={`Reminders${count ? ` (${count} pending)` : ''}`}
          onClick={() => setOpen(true)}
          size="medium"
        >
          <Badge color="primary" badgeContent={count} max={99} overlap="circular">
            <NotificationsOutlinedIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <Drawer
        anchor={drawerAnchor}
        open={open}
        onClose={() => setOpen(false)}
        // Modal=true (the default for temporary Drawer) gives us focus-trap +
        // backdrop-click-to-close. Explicit enforceFocus + autoFocus so the
        // Close IconButton receives focus on open and Tab stays inside the
        // drawer — WCAG 2.4.3 (Focus Order) + 2.1.2 (No Keyboard Trap).
        ModalProps={{
          keepMounted: false,
          disableEnforceFocus: false,
          disableAutoFocus: false,
          disableRestoreFocus: false,
        }}
        PaperProps={{
          role: 'dialog',
          'aria-label': 'Your reminders',
          sx: { width: DRAWER_WIDTH, maxWidth: '100vw' },
        }}
      >
        <Toolbar sx={{ px: 2.5, gap: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
            Your reminders
          </Typography>
          <IconButton
            edge="end"
            aria-label="Close reminders"
            onClick={() => setOpen(false)}
            size="small"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Toolbar>
        <Divider />

        <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
          {remindersQuery.isLoading && (
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          )}
          {!remindersQuery.isLoading && remindersQuery.isError && (
            <Typography variant="body2" color="error">
              Couldn’t load reminders. Try again shortly.
            </Typography>
          )}
          {!remindersQuery.isLoading && !remindersQuery.isError && reminders.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No reminders for the next 7 days. Stay on top of student dates from{' '}
              <MuiLink
                component="button"
                type="button"
                onClick={handleViewAll}
                sx={{ verticalAlign: 'baseline' }}
              >
                the Inbox
              </MuiLink>
              .
            </Typography>
          )}

          {inboxMessages.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mb: 1 }}
              >
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ letterSpacing: 0.5, flexGrow: 1 }}
                >
                  Notifications · {inboxUnreadCount}
                </Typography>
                <MuiLink
                  component="button"
                  type="button"
                  variant="caption"
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                  sx={{ cursor: 'pointer' }}
                  aria-label="Mark all notifications as read"
                >
                  {markAllRead.isPending ? 'Clearing…' : 'Mark all read'}
                </MuiLink>
              </Stack>
              <Stack spacing={1.25}>
                {inboxMessages.map((m) => (
                  <Box
                    key={m.id}
                    onClick={() => openMessage(m)}
                    role={m.metadata?.href ? 'button' : undefined}
                    tabIndex={m.metadata?.href ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (!m.metadata?.href) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openMessage(m);
                      }
                    }}
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1.5,
                      p: 1.5,
                      bgcolor: 'background.paper',
                      cursor: m.metadata?.href ? 'pointer' : 'default',
                      '&:hover': m.metadata?.href ? { borderColor: 'primary.main' } : undefined,
                    }}
                  >
                    {m.metadata?.source && (
                      <Chip
                        size="small"
                        label={humanizeSource(m.metadata.source)}
                        variant="outlined"
                        sx={{ fontWeight: 500, mb: 0.75 }}
                      />
                    )}
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {m.metadata?.title ?? m.body}
                    </Typography>
                    {/* SVT-WAVE52-SENDER-BYLINE-2026-05 — surface the sender
                        as a quiet byline when the IN_APP message carries one
                        but the title hasn't already absorbed it. Reads
                        "— Sarah K." under the title. */}
                    {m.metadata?.sender_label && !(m.metadata.title ?? '').includes(m.metadata.sender_label) && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                        — {m.metadata.sender_label}
                      </Typography>
                    )}
                    {m.sent_at && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {formatRelative(m.sent_at)}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
              <Divider sx={{ mt: 2 }} />
            </Box>
          )}

          <Stack spacing={1.25}>
            {reminders.map((r) => {
              const due = dueIso(r);
              const ackBusy =
                acknowledge.isPending && acknowledge.variables === r.id;
              const href = r.metadata?.href ?? null;
              return (
                <Box
                  key={r.id}
                  onClick={() => href && openReminder(href)}
                  role={href ? 'button' : undefined}
                  tabIndex={href ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (!href) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openReminder(href);
                    }
                  }}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    p: 1.5,
                    bgcolor: 'background.paper',
                    cursor: href ? 'pointer' : 'default',
                    '&:hover': href ? { borderColor: 'primary.main' } : undefined,
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
                    {r.type && (
                      <Chip
                        size="small"
                        label={r.type}
                        variant="outlined"
                        sx={{ fontWeight: 500 }}
                      />
                    )}
                    {due && (
                      <Typography variant="caption" color="text.secondary">
                        {formatRelative(due)}
                      </Typography>
                    )}
                  </Stack>
                  <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
                    {reminderTitle(r)}
                  </Typography>
                  <MuiLink
                    component="button"
                    type="button"
                    variant="caption"
                    onClick={(e) => {
                      e.stopPropagation();
                      acknowledge.mutate(r.id);
                    }}
                    disabled={ackBusy}
                    sx={{ cursor: 'pointer' }}
                  >
                    {ackBusy ? 'Acknowledging…' : 'Acknowledge'}
                  </MuiLink>
                </Box>
              );
            })}
          </Stack>
        </Box>

        <Divider />
        <Box sx={{ p: 1.5 }}>
          <Button fullWidth variant="text" onClick={handleViewAll}>
            View all
          </Button>
        </Box>
      </Drawer>
    </>
  );
}
