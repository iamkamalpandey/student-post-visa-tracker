'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  ButtonGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import dayjs from 'dayjs';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, useUserContext } from '@/lib/format';
import type { Reminder } from './types';

const QUICK_OPTIONS: { key: '1d' | '3d' | '1w'; labelKey: 'oneDay' | 'threeDays' | 'oneWeek'; days: number }[] = [
  { key: '1d', labelKey: 'oneDay', days: 1 },
  { key: '3d', labelKey: 'threeDays', days: 3 },
  { key: '1w', labelKey: 'oneWeek', days: 7 },
];

// Returns YYYY-MM-DDTHH:mm rendered in the *user's* configured timezone,
// suitable for input[type=datetime-local]. We snap to 09:00 because that's the
// bell-fire window the backend scanner uses (mirrors CreateReminderDialog).
function plusDaysLocalInput(days: number, userTz: string): string {
  return dayjs().tz(userTz).add(days, 'day').hour(9).minute(0).second(0).format('YYYY-MM-DDTHH:mm');
}

// Convert a wall-clock datetime-local string back to a UTC ISO 8601, treating
// the input as being in the user's configured timezone (not the browser's).
function localToIso(local: string, userTz: string): string | undefined {
  if (!local) return undefined;
  const dt = dayjs.tz(local, userTz);
  if (!dt.isValid()) return undefined;
  return dt.utc().toISOString();
}

export type SnoozeDialogProps = {
  open: boolean;
  onClose: () => void;
  reminder: Reminder;
};

export default function SnoozeDialog({ open, onClose, reminder }: SnoozeDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { timezone: userTz } = useUserContext();
  const t = useTranslations('reminders.dialogs.snooze');

  // Default to +1 day on every open so the dialog is always in a known state.
  const [snoozeUntil, setSnoozeUntil] = useState<string>(() => plusDaysLocalInput(1, userTz));
  const [activeQuick, setActiveQuick] = useState<'1d' | '3d' | '1w' | null>('1d');

  useEffect(() => {
    if (open) {
      setSnoozeUntil(plusDaysLocalInput(1, userTz));
      setActiveQuick('1d');
    }
  }, [open, userTz]);

  const snoozeMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (iso: string) => {
      const res = await api.post(`/reminders/${reminder.id}/snooze`, {
        snooze_until: iso,
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast', { when: formatDateTime(snoozeUntil) }), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['reminders'] });
      qc.invalidateQueries({ queryKey: ['reminder', reminder.id] });
      onClose();
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || t('errorToast'), {
        variant: 'error',
      });
    },
  });

  const handleQuick = (key: '1d' | '3d' | '1w', days: number) => {
    setSnoozeUntil(plusDaysLocalInput(days, userTz));
    setActiveQuick(key);
  };

  const onSubmit = () => {
    const iso = localToIso(snoozeUntil, userTz);
    if (!iso) {
      enqueueSnackbar(t('validDate'), { variant: 'warning' });
      return;
    }
    if (new Date(iso).getTime() <= Date.now()) {
      enqueueSnackbar(t('futureRequired'), { variant: 'warning' });
      return;
    }
    snoozeMutation.mutate(iso);
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={reminder.title}
      maxWidth="xs"
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: snoozeMutation.isPending,
        onClick: onSubmit,
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="datetime-local"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Stack spacing={2.5}>
          <Box>
            <Typography
              variant="overline"
              sx={{ color: 'text.secondary', fontWeight: 600, letterSpacing: 0.6, display: 'block', mb: 1 }}
            >
              {t('quickOptions')}
            </Typography>
            <ButtonGroup variant="outlined" fullWidth>
              {QUICK_OPTIONS.map((q) => (
                <Button
                  key={q.key}
                  onClick={() => handleQuick(q.key, q.days)}
                  variant={activeQuick === q.key ? 'contained' : 'outlined'}
                >
                  {t(`options.${q.labelKey}`)}
                </Button>
              ))}
            </ButtonGroup>
          </Box>
          <LabeledField
            label={t('snoozeUntil')}
            helperText={t('snoozeUntilHelp')}
            htmlFor="snooze-until-input"
          >
            <TextField
              id="snooze-until-input"
              type="datetime-local"
              fullWidth
              hiddenLabel
              size="medium"
              value={snoozeUntil}
              onChange={(e) => {
                setSnoozeUntil(e.target.value);
                setActiveQuick(null);
              }}
            />
          </LabeledField>
        </Stack>
      </Box>
    </AppDialog>
  );
}
