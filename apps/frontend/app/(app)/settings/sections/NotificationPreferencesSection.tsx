'use client';

import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Skeleton,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useAuth, ApiError } from '@/lib/auth';
import { api } from '@/lib/api';

// SVT-WAVE9-PREFS-2026-05 — self-service notification preferences.
export default function NotificationPreferencesSection() {
  const { user, isLoading, refresh } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const emailEnabled = user?.notifications_email_enabled ?? true;
  const digest = user?.notifications_digest ?? 'PER_EVENT';

  const updatePrefs = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await api.patch('/auth/me', patch);
      return res.data;
    },
    onSuccess: async () => {
      await refresh();
      enqueueSnackbar('Notification preferences updated.', { variant: 'success' });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Could not update preferences';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // SVT-AUDIT-FE-POLISH-2026-05 — skeleton card while auth bootstraps so
  // the section reserves visual space and avoids layout shift when the
  // toggles snap in.
  if (isLoading) {
    return (
      <Card variant="outlined" aria-busy="true" aria-label="Loading notification preferences">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Skeleton variant="text" width={140} height={28} />
              <Skeleton variant="text" width={360} />
            </Box>
            <Divider />
            <Skeleton variant="rounded" height={48} />
            <Skeleton variant="rounded" height={40} width={260} />
          </Stack>
        </CardContent>
      </Card>
    );
  }

  if (!user) return null;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Notifications
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Control which alerts reach your inbox. In-app notifications are always on.
            </Typography>
          </Box>
          <Divider />
          <FormControlLabel
            control={
              <Switch
                checked={emailEnabled}
                onChange={(e) => updatePrefs.mutate({ notifications_email_enabled: e.target.checked })}
                disabled={updatePrefs.isPending}
                inputProps={{ 'aria-label': 'Email notifications' }}
              />
            }
            label={
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Email alerts
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Reminders, commission status changes, and system alerts delivered to {user.email}.
                </Typography>
              </Box>
            }
          />
          {/* SVT-WAVE14-DIGEST-2026-05 — cadence picker. */}
          <Stack spacing={0.5}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              Email cadence
            </Typography>
            <Typography variant="caption" color="text.secondary">
              How often outbound emails fire. Daily collapses a day&apos;s events into one summary at 08:00 UTC.
            </Typography>
            <ToggleButtonGroup
              value={digest}
              exclusive
              size="small"
              disabled={!emailEnabled || updatePrefs.isPending}
              onChange={(_, val) => {
                if (val === 'PER_EVENT' || val === 'DAILY' || val === 'OFF') {
                  updatePrefs.mutate({ notifications_digest: val });
                }
              }}
              aria-label="Email cadence"
              sx={{ alignSelf: 'flex-start', mt: 0.5 }}
            >
              <ToggleButton value="PER_EVENT">Per event</ToggleButton>
              <ToggleButton value="DAILY">Daily digest</ToggleButton>
              <ToggleButton value="OFF">Off</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
