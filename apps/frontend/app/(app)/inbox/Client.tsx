// Refactored to SVT form-pattern
// Consolidated Inbox: Tasks (Reminders) + Expiring (Expiries) + Messages (Comms). Replaces 3 separate sidebar entries.
//
// This shell has no form inputs — it's a KPI strip + <Tabs> + the active
// tab body. The form-pattern compliance work lives inside the three
// tabs/* files (filter toolbars wrapped in <LabeledField srOnly>). The
// active tab is driven entirely from `?tab=` so deep-links like
// `/inbox?tab=tasks&status=PENDING` mount the right child + carry filter
// state through to it via `useSearchParams()`.

'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
  alpha,
} from '@mui/material';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import EventBusyOutlinedIcon from '@mui/icons-material/EventBusyOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import HourglassBottomOutlinedIcon from '@mui/icons-material/HourglassBottomOutlined';

import { api } from '@/lib/api';
import { useReminders } from '@/lib/queries';
import RemindersTab from './tabs/RemindersTab';
import ExpiriesTab from './tabs/ExpiriesTab';
import MessagesTab from './tabs/MessagesTab';
import ThreadsTab from './tabs/ThreadsTab';

// Tab keys are part of the public URL contract (`/inbox?tab=tasks|expiring|messages|threads`).
// Keep them stable — bookmarks and the `/reminders` + `/expiries` redirects rely on them.
type TabKey = 'tasks' | 'expiring' | 'messages' | 'threads';
const TAB_KEYS: TabKey[] = ['tasks', 'expiring', 'messages', 'threads'];
const DEFAULT_TAB: TabKey = 'tasks';

function isTabKey(v: string | null | undefined): v is TabKey {
  return v != null && (TAB_KEYS as string[]).includes(v);
}

// --- KPI tile -------------------------------------------------------------
// Local-only component — keeps the inbox surface self-contained without
// adding another shared component file. Uses tonal background when the
// matching tab is active, plus a "warning" accent when overdue.
type KpiSeverity = 'default' | 'warning';

function KpiTile({
  icon,
  label,
  count,
  loading,
  active,
  severity = 'default',
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count: number | null;
  loading?: boolean;
  active?: boolean;
  severity?: KpiSeverity;
  onClick?: () => void;
}) {
  const display = loading ? '—' : count == null ? '—' : count.toLocaleString();
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        p: 2,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 120ms ease, background-color 120ms ease, border-color 120ms ease',
        bgcolor: (theme) =>
          active ? alpha(theme.palette.primary.main, 0.06) : 'background.paper',
        borderColor: (theme) =>
          severity === 'warning'
            ? theme.palette.warning.main
            : active
              ? theme.palette.primary.main
              : theme.palette.divider,
        '&:hover': onClick
          ? {
              boxShadow: 1,
              borderColor: (theme) =>
                severity === 'warning'
                  ? theme.palette.warning.dark
                  : theme.palette.primary.main,
            }
          : undefined,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1.5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: (theme) =>
              severity === 'warning'
                ? alpha(theme.palette.warning.main, 0.12)
                : alpha(theme.palette.primary.main, 0.1),
            color: (theme) =>
              severity === 'warning' ? theme.palette.warning.dark : theme.palette.primary.main,
            '& svg': { fontSize: 22 },
          }}
        >
          {icon}
        </Box>
        <Stack spacing={0.25} sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }} noWrap>
            {label}
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
            {display}
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

// --- Inbox shell ----------------------------------------------------------

type ExpiriesCountResponse = {
  data: Array<{ severity: 'overdue' | 'critical' | 'warning' | 'ok' }>;
};

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tabParam = searchParams?.get('tab') ?? null;
  const activeTab: TabKey = isTabKey(tabParam) ? tabParam : DEFAULT_TAB;

  function handleTabChange(_e: unknown, value: TabKey) {
    // Switching tabs throws away the previous tab's filter params on
    // purpose — they're tab-specific (e.g. ?status=PENDING means nothing
    // to /expiring) and would otherwise leak into the next tab's URL sync.
    router.replace(`/inbox?tab=${value}`);
  }

  // ---- Cheap KPI counts ------------------------------------------------
  // Each query asks the backend for at most 1 row and reads `total` from
  // the page envelope. Reuses existing endpoints + query keys so the
  // TanStack cache stays shared with the tab bodies (no extra fetches).
  const tasksKpi = useReminders({ status: 'PENDING', limit: 1 });
  const tasksCount = tasksKpi.data?.page.total ?? null;

  // Expiries has no `?limit=1` server-side, but the response is small
  // (the dashboard already pulls 60d windows). We reuse the same query
  // key the tab uses so the data is shared across tab + KPI.
  const expiriesKpi = useQuery<ExpiriesCountResponse>({
    queryKey: ['expiries', { withinDays: 60 }],
    queryFn: async () => {
      const res = await api.get('/expiries', { params: { within_days: 60 } });
      return res.data as ExpiriesCountResponse;
    },
    placeholderData: (prev) => prev,
  });
  const expiriesRows = expiriesKpi.data?.data ?? [];
  const expiriesCount = expiriesKpi.data ? expiriesRows.length : null;
  const overdueCount = useMemo(
    () => expiriesRows.filter((r) => r.severity === 'overdue').length,
    [expiriesRows],
  );

  // Messages "unread": until /comms/threads ships there's no real unread
  // counter. Mirror the recent-students fetch the tab uses (cheap, shared
  // query key) and surface its size as a "recent activity" hint.
  const messagesKpi = useQuery<{ data: unknown[] }>({
    queryKey: ['inbox', 'recent-students'],
    queryFn: async () => {
      const res = await api.get('/students', { params: { limit: 10 } });
      return res.data as { data: unknown[] };
    },
  });
  const unreadCount = messagesKpi.data ? messagesKpi.data.data.length : null;

  // SVT-WAVE38-SLA-KPI-2026-05 — reuses /dashboard/sla-breaches (already
  // cached by the dashboard widget when the user lands here from there).
  // limit=1 because we only care about page.total. Tile click-through goes
  // to /students filtered to the current breach — but no such filter exists
  // yet, so we route to /students for now and surface the count.
  const slaKpi = useQuery<{ data: unknown[]; page: { total: number } }>({
    queryKey: ['dashboard', 'sla-breaches', { limit: 1 }],
    queryFn: async () => {
      const res = await api.get('/dashboard/sla-breaches', { params: { limit: 1 } });
      return res.data as { data: unknown[]; page: { total: number } };
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const slaCount = slaKpi.data?.page.total ?? null;

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          Inbox
        </Typography>
        <Typography variant="body1" color="text.secondary">
          One place for tasks, expiring documents and student conversations.
        </Typography>
      </Stack>

      {/* KPI strip — clickable tiles double as quick tab switchers. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <KpiTile
          icon={<TaskAltOutlinedIcon />}
          label="Tasks (pending)"
          count={tasksCount}
          loading={tasksKpi.isLoading}
          active={activeTab === 'tasks'}
          onClick={() => handleTabChange(null, 'tasks')}
        />
        <KpiTile
          icon={<EventBusyOutlinedIcon />}
          label="Expiring (60d)"
          count={expiriesCount}
          loading={expiriesKpi.isLoading}
          active={activeTab === 'expiring'}
          severity={overdueCount > 0 ? 'warning' : 'default'}
          onClick={() => handleTabChange(null, 'expiring')}
        />
        <KpiTile
          icon={<ForumOutlinedIcon />}
          label="Recent threads"
          count={unreadCount}
          loading={messagesKpi.isLoading}
          active={activeTab === 'messages'}
          onClick={() => handleTabChange(null, 'messages')}
        />
        {/* SVT-WAVE38-SLA-KPI-2026-05 + SVT-WAVE39-STUDENT-SLA-FILTER-2026-05
            — clicking opens the students list pre-filtered to breaches. */}
        <KpiTile
          icon={<HourglassBottomOutlinedIcon />}
          label="SLA breaches"
          count={slaCount}
          loading={slaKpi.isLoading}
          severity={(slaCount ?? 0) > 0 ? 'warning' : 'default'}
          onClick={() => router.push('/students?sla_breached=true')}
        />
      </Box>

      <Box sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
        <Tabs
          value={activeTab}
          onChange={(_, v) => handleTabChange(_, v as TabKey)}
          aria-label="Inbox sections"
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab
            value="tasks"
            label="Tasks"
            icon={<TaskAltOutlinedIcon fontSize="small" />}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
          />
          <Tab
            value="expiring"
            label="Expiring"
            icon={<EventBusyOutlinedIcon fontSize="small" />}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
          />
          <Tab
            value="messages"
            label="Messages"
            icon={<ForumOutlinedIcon fontSize="small" />}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
          />
          <Tab
            value="threads"
            label="Threads"
            icon={<ChatBubbleOutlineOutlinedIcon fontSize="small" />}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
          />
        </Tabs>
      </Box>

      {/* Tab body — only the active panel mounts so each tab's queries
          fire just-in-time and per-tab state (filters, dialogs) resets
          cleanly when the user navigates away. */}
      <Box role="tabpanel">
        {activeTab === 'tasks' ? <RemindersTab /> : null}
        {activeTab === 'expiring' ? <ExpiriesTab /> : null}
        {activeTab === 'messages' ? <MessagesTab /> : null}
        {activeTab === 'threads' ? <ThreadsTab /> : null}
      </Box>
    </Stack>
  );
}
