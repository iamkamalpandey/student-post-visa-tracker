// Refactored to SVT form-pattern
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import TodayOutlinedIcon from '@mui/icons-material/TodayOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LabeledField from '@/components/LabeledField';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ListPageShell from '@/components/ListPageShell';
import StatusChip from '@/components/StatusChip';
import { DASHBOARD_QK } from '@/features/io/util';

type ExpiryKind = 'visa' | 'passport' | 'insurance' | 'document';

type ExpiryRow = {
  kind: ExpiryKind;
  entity_id: string;
  student_id: string;
  expires_on: string; // YYYY-MM-DD
  days_remaining: number;
};

const WINDOWS = [30, 60, 90, 180];
const KINDS: ExpiryKind[] = ['visa', 'passport', 'insurance', 'document'];

const KIND_COLOR: Record<ExpiryKind, 'default' | 'primary' | 'secondary' | 'info'> = {
  visa: 'primary',
  passport: 'secondary',
  insurance: 'info',
  document: 'default',
};

const KIND_DOT_COLOR: Record<ExpiryKind, string> = {
  visa: '#1A73E8',
  passport: '#7E57C2',
  insurance: '#0288D1',
  document: '#616161',
};

/** Map urgency window to a status enum understood by <StatusChip />. */
function urgencyStatus(days: number): 'OVERDUE' | 'URGENT' | 'ON_HOLD' | 'ACTIVE' {
  if (days < 0) return 'OVERDUE';
  if (days < 14) return 'URGENT';
  if (days < 30) return 'ON_HOLD';
  return 'ACTIVE';
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Build a 6-row × 7-col grid of dates beginning on the Monday of the week containing day-1. */
function monthGridDays(monthStart: Date): Date[] {
  const firstDow = monthStart.getUTCDay(); // 0=Sun
  const offset = (firstDow + 6) % 7; // shift so Monday=0
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(monthStart.getUTCDate() - offset);
  const out: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    out.push(d);
  }
  return out;
}

/** Group rows into ISO weeks keyed by `YYYY-Www`. */
function groupByWeek(rows: ExpiryRow[]): { label: string; rows: ExpiryRow[] }[] {
  const buckets = new Map<string, ExpiryRow[]>();
  for (const r of rows) {
    const d = new Date(`${r.expires_on}T00:00:00Z`);
    const utcDay = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((utcDay + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const label = `Week of ${ymd(monday)} – ${ymd(sunday)}`;
    const list = buckets.get(label) ?? [];
    list.push(r);
    buckets.set(label, list);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, rs]) => ({
      label,
      rows: rs.sort((a, b) => a.days_remaining - b.days_remaining),
    }));
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function CalendarPage() {
  const t = useTranslations('calendar');
  const fmt = useFormat();
  const [within, setWithin] = useState<number>(60);
  const [view, setView] = useState<'month' | 'list'>('month');
  const [enabledKinds, setEnabledKinds] = useState<Set<ExpiryKind>>(
    () => new Set<ExpiryKind>(KINDS),
  );
  // SVT-QA-2026-08 — see `todayKey` below: the month cursor also seeds from the
  // wall clock. Kept as a lazy initializer (it only affects WHICH month is
  // shown, not per-cell markup that must match a server render) but pinned to
  // UTC so it agrees with the UTC-keyed day cells it drives.
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));

  const expiriesQuery = useQuery<ExpiryRow[]>({
    queryKey: DASHBOARD_QK.expiries(within),
    queryFn: async () => {
      const res = await api.get<{ data: ExpiryRow[] }>(`/dashboard/expiries`, {
        params: { within_days: within },
      });
      return res.data.data;
    },
  });

  const allRows = expiriesQuery.data ?? [];
  const filteredRows = useMemo(
    () => allRows.filter((r) => enabledKinds.has(r.kind)),
    [allRows, enabledKinds],
  );
  const groups = useMemo(() => groupByWeek(filteredRows), [filteredRows]);

  // Month view: bucket filtered rows by YYYY-MM-DD for fast cell lookup.
  const byDay = useMemo(() => {
    const m = new Map<string, ExpiryRow[]>();
    for (const r of filteredRows) {
      const list = m.get(r.expires_on) ?? [];
      list.push(r);
      m.set(r.expires_on, list);
    }
    return m;
  }, [filteredRows]);

  const monthStart = startOfMonth(cursor);
  const days = monthGridDays(monthStart);
  // Locale-aware month title — falls back to the runtime Intl default when the
  // formatter can't produce a value (e.g. malformed ISO during hydration).
  const monthLabel =
    fmt.date(`${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}-01`) ||
    monthStart.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // SVT-QA-2026-08 — `todayKey` drives the "is today" cell border and font
  // weight, i.e. it renders into markup. Computing it during render means the
  // value can differ between the initial render and a subsequent one if the
  // clock crosses UTC midnight in between, producing a hydration mismatch of
  // exactly the kind that caused React #418 on the dashboard. Compute it once,
  // post-mount. Empty string until then simply means "no cell is today yet",
  // which is correct for a frame that hasn't resolved the clock.
  const [todayKey, setTodayKey] = useState('');
  useEffect(() => {
    const now = new Date();
    setTodayKey(
      ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))),
    );
  }, []);

  function toggleKind(k: ExpiryKind) {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Always keep at least one selected — toggling off the last is a no-op.
      return next.size === 0 ? prev : next;
    });
  }

  // Stable ids so LabeledField's `htmlFor=` can wire up to the real input nodes.
  const WITHIN_ID = 'calendar-within-select';

  const filters = (
    <>
      <LabeledField label="Event types" srOnly>
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          role="group"
          aria-label="Event types"
        >
          {KINDS.map((k) => {
            const on = enabledKinds.has(k);
            return (
              <Chip
                key={k}
                size="small"
                label={k}
                color={on ? KIND_COLOR[k] : 'default'}
                variant={on ? 'filled' : 'outlined'}
                onClick={() => toggleKind(k)}
                aria-pressed={on}
                aria-label={`${k} filter ${on ? 'on' : 'off'}`}
                sx={{ textTransform: 'capitalize', cursor: 'pointer' }}
              />
            );
          })}
        </Stack>
      </LabeledField>
      <LabeledField label="Window" srOnly htmlFor={WITHIN_ID}>
        <TextField
          select
          size="small"
          hiddenLabel
          id={WITHIN_ID}
          value={within}
          onChange={(e) => setWithin(Number(e.target.value))}
          sx={{ minWidth: 160 }}
          inputProps={{ 'aria-label': 'Window' }}
        >
          {WINDOWS.map((d) => (
            <MenuItem key={d} value={d}>
              Next {d} days
            </MenuItem>
          ))}
        </TextField>
      </LabeledField>
      <LabeledField label="View mode" srOnly>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          onChange={(_, v) => v && setView(v)}
          aria-label={t('aria.calendarView')}
        >
          <ToggleButton value="month" aria-label={t('aria.monthView')}>
            Month
          </ToggleButton>
          <ToggleButton value="list" aria-label={t('aria.listView')}>
            List
          </ToggleButton>
        </ToggleButtonGroup>
      </LabeledField>
      <LabeledField label="Refresh" srOnly>
        <Tooltip title="Refresh">
          <span>
            <IconButton
              size="small"
              aria-label={t('aria.refresh')}
              onClick={() => expiriesQuery.refetch()}
              disabled={expiriesQuery.isFetching}
            >
              <RefreshOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </LabeledField>
    </>
  );

  // Inline-state branches drive `bareContent` so the loading / error / empty
  // states aren't double-wrapped in the ListPageShell card.
  const isInlineState =
    expiriesQuery.isLoading ||
    expiriesQuery.isError ||
    (!expiriesQuery.isFetching && allRows.length === 0);

  return (
    <ListPageShell
      title="Calendar"
      description="Upcoming visa, passport, insurance and document expiries — pivot by month or week."
      filters={filters}
      bareContent={isInlineState || view === 'list'}
    >
      {expiriesQuery.isLoading ? (
        <LoadingSkeleton variant="card" />
      ) : expiriesQuery.isError ? (
        <ErrorState
          title="Could not load expiries"
          description={
            expiriesQuery.error instanceof ApiError
              ? expiriesQuery.error.detail || expiriesQuery.error.title
              : 'Unexpected error'
          }
          onRetry={() => expiriesQuery.refetch()}
          requestId={
            expiriesQuery.error instanceof ApiError ? expiriesQuery.error.requestId : undefined
          }
        />
      ) : allRows.length === 0 ? (
        <EmptyState
          icon={<EventAvailableOutlinedIcon />}
          title={`Nothing expiring in the next ${within} days`}
          description="All clear — try a longer window if you want a wider preview."
        />
      ) : view === 'month' ? (
        <Box sx={{ p: 2 }}>
          {/* Month nav */}
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1.5 }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {monthLabel}
            </Typography>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <IconButton
                aria-label={t('aria.prevMonth')}
                size="small"
                onClick={() => setCursor((d) => addMonths(d, -1))}
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              <Button
                size="small"
                aria-label="Jump to today"
                startIcon={<TodayOutlinedIcon />}
                onClick={() => setCursor(startOfMonth(new Date()))}
              >
                Today
              </Button>
              <IconButton
                aria-label={t('aria.nextMonth')}
                size="small"
                onClick={() => setCursor((d) => addMonths(d, 1))}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Stack>

          {/* Weekday header */}
          <Box
            role="grid"
            aria-label={`Calendar grid for ${monthLabel}`}
            sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.5 }}
          >
            <Box role="row" sx={{ display: 'contents' }}>
              {WEEKDAY_LABELS.map((w) => (
                <Box
                  key={w}
                  role="columnheader"
                  sx={{
                    py: 0.5,
                    textAlign: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'text.secondary',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {w}
                </Box>
              ))}
            </Box>
            {/* Render 6 week rows so AT users get row/cell semantics. */}
            {Array.from({ length: 6 }).map((_, weekIdx) => (
              <Box key={`row-${weekIdx}`} role="row" sx={{ display: 'contents' }}>
                {days.slice(weekIdx * 7, weekIdx * 7 + 7).map((d) => {
                  const key = ymd(d);
                  const inMonth = d.getUTCMonth() === monthStart.getUTCMonth();
                  const isToday = key === todayKey;
                  const events = byDay.get(key) ?? [];
                  const niceDate = fmt.date(key);
                  return (
                    <Box
                      key={key}
                      role="gridcell"
                      aria-label={`${niceDate}${events.length ? ` — ${events.length} expiries` : ''}`}
                      sx={{
                        minHeight: 96,
                        p: 0.75,
                        borderRadius: 1.5,
                        border: (theme) =>
                          `1px solid ${isToday ? theme.palette.primary.main : theme.palette.divider}`,
                        bgcolor: inMonth ? 'background.paper' : 'action.hover',
                        opacity: inMonth ? 1 : 0.6,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.5,
                      }}
                    >
                      <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            fontWeight: isToday ? 700 : 500,
                            color: isToday ? 'primary.main' : 'text.secondary',
                          }}
                        >
                          {d.getUTCDate()}
                        </Typography>
                        {events.length > 1 ? (
                          <Typography
                            variant="caption"
                            sx={{ color: 'text.secondary', fontSize: 10 }}
                          >
                            {events.length}
                          </Typography>
                        ) : null}
                      </Stack>
                      <Stack spacing={0.25}>
                        {events.slice(0, 3).map((ev) => {
                          const evDate = fmt.date(ev.expires_on);
                          const tip = `${ev.kind} · student ${ev.student_id.slice(0, 8)} · ${evDate} (${ev.days_remaining}d)`;
                          return (
                            <Tooltip key={`${ev.kind}-${ev.entity_id}`} title={tip}>
                              <Box
                                component={Link}
                                href={`/students/${ev.student_id}`}
                                aria-label={tip}
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 0.5,
                                  px: 0.5,
                                  py: 0.25,
                                  borderRadius: 0.75,
                                  bgcolor: 'action.hover',
                                  textDecoration: 'none',
                                  color: 'text.primary',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                <Box
                                  aria-hidden="true"
                                  sx={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 999,
                                    flexShrink: 0,
                                    bgcolor: KIND_DOT_COLOR[ev.kind],
                                  }}
                                />
                                <span style={{ textTransform: 'capitalize' }}>{ev.kind}</span>
                              </Box>
                            </Tooltip>
                          );
                        })}
                        {events.length > 3 ? (
                          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                            +{events.length - 3} more
                          </Typography>
                        ) : null}
                      </Stack>
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Stack spacing={2.5}>
          {groups.length === 0 ? (
            <EmptyState
              icon={<EventAvailableOutlinedIcon />}
              title="Nothing matches the active filters"
              description="Try selecting more event types above."
            />
          ) : (
            groups.map((g) => (
              <Card key={g.label} variant="outlined">
                <CardContent>
                  <Typography variant="subtitle2" sx={{ mb: 1.5, color: 'text.secondary' }}>
                    {g.label} · {g.rows.length} expir{g.rows.length === 1 ? 'y' : 'ies'}
                  </Typography>
                  <Stack spacing={1}>
                    {g.rows.map((r) => {
                      const evDate = fmt.date(r.expires_on);
                      const tip = `${r.kind} · student ${r.student_id.slice(0, 8)} · ${evDate} (${r.days_remaining}d)`;
                      return (
                        <Stack
                          key={`${r.kind}-${r.entity_id}`}
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={1.5}
                          alignItems={{ xs: 'flex-start', sm: 'center' }}
                          sx={{
                            p: 1.5,
                            borderRadius: 2,
                            border: (theme) => `1px solid ${theme.palette.divider}`,
                          }}
                        >
                          <Tooltip title={tip}>
                            <Chip
                              size="small"
                              label={r.kind}
                              color={KIND_COLOR[r.kind]}
                              variant="outlined"
                              aria-label={tip}
                              sx={{ minWidth: 88, justifyContent: 'center', textTransform: 'capitalize' }}
                            />
                          </Tooltip>
                          {/* StatusChip conveys urgency with an icon + color (WCAG 1.4.1). */}
                          <StatusChip status={urgencyStatus(r.days_remaining)} />
                          <Chip size="small" label={`${r.days_remaining}d`} variant="outlined" />
                          <Typography variant="body2" sx={{ flexGrow: 1 }}>
                            Expires <strong>{evDate}</strong>
                          </Typography>
                          <Link
                            href={`/students/${r.student_id}`}
                            style={{
                              color: 'inherit',
                              textDecoration: 'none',
                              fontWeight: 600,
                              fontSize: 13,
                            }}
                          >
                            View student →
                          </Link>
                        </Stack>
                      );
                    })}
                  </Stack>
                </CardContent>
              </Card>
            ))
          )}
        </Stack>
      )}
    </ListPageShell>
  );
}
