'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useAuth, ApiError } from '@/lib/auth';
import { api } from '@/lib/api';

// SVT-WAVE17-TENANT-SETTINGS-2026-05 — admin-only card for tenant FROM
// address. Hidden for non-admin users. Edit-in-place text field with save
// button; clearing the field POSTs null (falls back to env.EMAIL_FROM).
export default function TenantSettingsSection() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'ADMIN';

  type TenantSettings = {
    id: string; name: string;
    default_locale: string; default_timezone: string; default_currency: string;
    email_from: string | null;
  };
  const q = useQuery({
    queryKey: ['tenants', 'me'],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await api.get<TenantSettings>('/tenants/me');
      return res.data;
    },
  });

  const [draft, setDraft] = useState<string>('');
  const [locale, setLocale] = useState<string>('');
  const [timezone, setTimezone] = useState<string>('');
  const [currency, setCurrency] = useState<string>('');
  // Sync local draft when server data loads.
  useEffect(() => {
    if (q.data) {
      setDraft(q.data.email_from ?? '');
      setLocale(q.data.default_locale);
      setTimezone(q.data.default_timezone);
      setCurrency(q.data.default_currency);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await api.patch('/tenants/me', patch);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Tenant settings updated.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['tenants', 'me'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Save failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // Non-admins never see this card.
  if (!isAdmin) return null;

  // SVT-AUDIT-FE-POLISH-2026-05 — render a skeleton while /tenants/me is in
  // flight so admins don't see the section silently appear; this card sits
  // mid-page and surprise-rendering pushes everything below it down.
  if (q.isPending || !q.data) {
    return (
      <Card variant="outlined" aria-busy="true" aria-label="Loading tenant settings">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Skeleton variant="text" width={260} height={28} />
              <Skeleton variant="text" width={420} />
            </Box>
            <Divider />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <Skeleton variant="rounded" height={56} sx={{ flex: 1 }} />
              <Skeleton variant="rounded" height={56} sx={{ flex: 1 }} />
              <Skeleton variant="rounded" height={56} sx={{ flex: 1 }} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <Skeleton variant="rounded" height={56} sx={{ flex: 1 }} />
              <Skeleton variant="rounded" height={40} width={120} />
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  const trimmed = draft.trim();
  const emailDirty = trimmed !== (q.data.email_from ?? '');
  const localeDirty = locale !== q.data.default_locale;
  const tzDirty = timezone !== q.data.default_timezone;
  const currencyDirty = currency.toUpperCase() !== q.data.default_currency;
  const dirty = emailDirty || localeDirty || tzDirty || currencyDirty;

  function buildPatch(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (emailDirty) p['email_from'] = trimmed === '' ? null : trimmed;
    if (localeDirty) p['default_locale'] = locale;
    if (tzDirty) p['default_timezone'] = timezone;
    if (currencyDirty) p['default_currency'] = currency.toUpperCase();
    return p;
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Tenant settings · {q.data.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Admin-only. Defaults applied to new students + outbound emails.
              Leave email blank to fall back to the platform default.
            </Typography>
          </Box>
          <Divider />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              label="Default locale"
              fullWidth
              size="small"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              helperText="BCP-47 tag, e.g. en, en-GB, fr-CA."
            />
            <TextField
              label="Default timezone"
              fullWidth
              size="small"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              helperText="IANA TZ, e.g. UTC, Europe/London."
            />
            <TextField
              label="Default currency"
              fullWidth
              size="small"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              inputProps={{ maxLength: 3 }}
              helperText="ISO 4217 (3 letters)."
            />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-end' }}>
            <TextField
              label="Sender email (FROM)"
              type="email"
              fullWidth
              size="small"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="alerts@yourdomain.example"
              helperText="Must be a sender domain you've verified with your email provider (e.g. Resend)."
            />
            <Button
              variant="contained"
              onClick={() => save.mutate(buildPatch())}
              disabled={!dirty || save.isPending}
              sx={{ minWidth: 120 }}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
