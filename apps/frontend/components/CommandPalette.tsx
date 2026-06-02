'use client';

// SVT-WAVE45-CMDK-2026-05 — Minimal Cmd-K / Ctrl-K palette. Searches the
// primary routes plus recent students (server-side via useStudentsLite).
// Keyboard-first: arrows + Enter to navigate, Escape to close. Mounted once
// at the AppShell level so it's available on every page.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import {
  Box, Chip, Dialog, InputBase, List, ListItemButton, ListItemText, ListSubheader, Stack, Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useStudentsLite } from '@/lib/queries';

type CmdItem = {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: 'Navigation' | 'Students';
};

// Hard-coded labels so the palette doesn't depend on i18n hydration — it has
// to feel instant. Billing maps to /settings until a dedicated route lands.
const ROUTES: CmdItem[] = [
  { id: 'r-students', label: 'Students', href: '/students', group: 'Navigation' },
  { id: 'r-institutions', label: 'Institutions', href: '/institutions', group: 'Navigation' },
  { id: 'r-programs', label: 'Programs', href: '/programs', group: 'Navigation' },
  { id: 'r-reminders', label: 'Reminders', href: '/reminders', group: 'Navigation' },
  { id: 'r-commissions', label: 'Commissions', href: '/commissions', group: 'Navigation' },
  { id: 'r-billing', label: 'Billing', hint: 'Plan & invoices', href: '/settings', group: 'Navigation' },
  { id: 'r-reports', label: 'Reports', href: '/reports', group: 'Navigation' },
  { id: 'r-calendar', label: 'Calendar', href: '/calendar', group: 'Navigation' },
  { id: 'r-inbox', label: 'Inbox', href: '/inbox', group: 'Navigation' },
  { id: 'r-settings', label: 'Settings', href: '/settings', group: 'Navigation' },
];

type FormValues = { q: string };

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  // react-hook-form keeps the input fast (no re-render on every keystroke);
  // watch() drives the filter pipeline.
  const { register, watch, reset, setFocus } = useForm<FormValues>({ defaultValues: { q: '' } });
  const query = watch('q').trim();

  // useStudentsLite is already guarded by enabled:term.length>0; the >=2 floor
  // here just avoids single-character thrash on the wire.
  const { data: students } = useStudentsLite(query.length >= 2 ? query : undefined);

  // Global Cmd-K / Ctrl-K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // On open: clear state and focus the input after MUI's transition settles.
  useEffect(() => {
    if (!open) return;
    reset({ q: '' });
    setActive(0);
    const id = window.setTimeout(() => setFocus('q'), 30);
    return () => window.clearTimeout(id);
  }, [open, reset, setFocus]);

  const items = useMemo<CmdItem[]>(() => {
    const q = query.toLowerCase();
    const filteredRoutes = q ? ROUTES.filter((r) => r.label.toLowerCase().includes(q)) : ROUTES;
    const studentItems: CmdItem[] = (students ?? []).map((s) => ({
      id: `s-${s.id}`,
      label: `${s.given_name} ${s.family_name}`.trim() || s.student_code,
      hint: s.student_code,
      href: `/students/${s.id}`,
      group: 'Students',
    }));
    return [...filteredRoutes, ...studentItems];
  }, [query, students]);

  // Clamp the active index when the result set shrinks.
  useEffect(() => {
    if (active >= items.length) setActive(items.length > 0 ? items.length - 1 : 0);
  }, [items.length, active]);

  const close = useCallback(() => setOpen(false), []);
  const runItem = useCallback(
    (item: CmdItem | undefined) => {
      if (!item) return;
      close();
      router.push(item.href);
    },
    [close, router],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(items[active]);
      }
    },
    [active, close, items, runItem],
  );

  // Keep the active row visible when navigating via keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Group consecutive items by `group` for ListSubheader headings.
  const grouped = useMemo(() => {
    const out: Array<{ group: CmdItem['group']; items: Array<{ item: CmdItem; idx: number }> }> = [];
    items.forEach((item, idx) => {
      const last = out[out.length - 1];
      if (last && last.group === item.group) last.items.push({ item, idx });
      else out.push({ group: item.group, items: [{ item, idx }] });
    });
    return out;
  }, [items]);

  // SVT-AUDIT-A11Y-2026-06 (backlog rank 24) — ARIA 1.2 combobox/listbox ids so
  // the active result is conveyed to assistive tech via aria-activedescendant,
  // not visual highlight alone (WCAG 4.1.2).
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="sm"
      PaperProps={{ sx: { mt: '10vh', alignSelf: 'flex-start', borderRadius: 2 } }}
      onKeyDown={onKeyDown}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}
      >
        <SearchIcon fontSize="small" color="action" />
        <InputBase
          fullWidth
          placeholder="Search routes, students…"
          inputProps={{
            'aria-label': 'Command palette search',
            autoComplete: 'off',
            role: 'combobox',
            'aria-expanded': true,
            'aria-controls': listboxId,
            'aria-activedescendant': items.length ? optionId(active) : undefined,
          }}
          {...register('q')}
        />
        <Chip size="small" label="Esc" variant="outlined" />
      </Stack>
      <Box sx={{ maxHeight: '50vh', overflowY: 'auto' }}>
        {/* SVT-WAVE-POLISH-2026-05 — shortcut cheat sheet shown when the
            palette is empty so first-time users discover the keyboard nav. */}
        {query.length === 0 ? (
          <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Shortcuts
            </Typography>
            <Stack direction="row" spacing={1.5} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.75 }}>
              {[
                { keys: 'g s', label: 'Students' },
                { keys: 'g d', label: 'Dashboard' },
                { keys: 'g i', label: 'Inbox' },
                { keys: 'c', label: 'Create student' },
                { keys: '/', label: 'Search' },
              ].map((s) => (
                <Stack key={s.keys} direction="row" spacing={0.5} alignItems="center">
                  <Chip size="small" label={s.keys} variant="outlined" sx={{ fontFamily: 'monospace' }} />
                  <Typography variant="caption" color="text.secondary">{s.label}</Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
        ) : null}
        <List
          ref={listRef}
          dense
          disablePadding
          subheader={<li />}
          role="listbox"
          id={listboxId}
          aria-label="Command results"
        >
          {grouped.length === 0 && (
            <Box sx={{ px: 3, py: 4 }}>
              <Typography variant="body2" color="text.secondary">No matches.</Typography>
            </Box>
          )}
          {grouped.map((g) => (
            <li key={g.group} role="presentation">
              <ul style={{ padding: 0 }} role="group" aria-label={g.group}>
                <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '28px', fontSize: 11 }}>
                  {g.group}
                </ListSubheader>
                {g.items.map(({ item, idx }) => (
                  <ListItemButton
                    key={item.id}
                    data-cmd-idx={idx}
                    id={optionId(idx)}
                    role="option"
                    aria-selected={idx === active}
                    selected={idx === active}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => runItem(item)}
                  >
                    <ListItemText primary={item.label} secondary={item.hint} />
                  </ListItemButton>
                ))}
              </ul>
            </li>
          ))}
        </List>
      </Box>
    </Dialog>
  );
}
