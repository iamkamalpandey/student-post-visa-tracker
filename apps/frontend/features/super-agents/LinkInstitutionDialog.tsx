'use client';

// Dialog used on the super-agent detail page to link a new institution to the
// current super-agent. Inverse of the institution-side picker that already
// lives in InstitutionSuperAgentsSection.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Autocomplete,
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';

type InstitutionLite = {
  id: string;
  display_name: string;
  short_name?: string | null;
  country_code?: string | null;
};

type ApiList<T> = { data: T[] };

type Props = {
  open: boolean;
  superAgentId: string;
  /** Already-linked institution ids — excluded from the picker. */
  excludeIds: Set<string>;
  onClose: () => void;
};

export default function LinkInstitutionDialog({
  open,
  superAgentId,
  excludeIds,
  onClose,
}: Props) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [picked, setPicked] = useState<InstitutionLite | null>(null);
  const [isPreferred, setIsPreferred] = useState(false);
  const [notes, setNotes] = useState('');

  // Reset on open so a previous close doesn't leak state.
  useEffect(() => {
    if (open) {
      setPicked(null);
      setIsPreferred(false);
      setNotes('');
    }
  }, [open]);

  const institutionsQ = useQuery({
    queryKey: ['institutions', 'all-for-link-picker'],
    queryFn: async () => {
      const res = await api.get<ApiList<InstitutionLite>>('/institutions', {
        // SVT-CONTRACT-2026-08 — PaginationQuery caps `limit` at 100 and the
        // list schema is .strict(), so `limit: 200` was rejected with a 400 and
        // this picker rendered "No options" forever — the dialog could not be
        // completed at all. 100 is the maximum the API will accept.
        params: { limit: 100 },
      });
      return res.data.data;
    },
    enabled: open,
  });

  const options = useMemo(
    () => (institutionsQ.data ?? []).filter((i) => !excludeIds.has(i.id)),
    [institutionsQ.data, excludeIds],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!picked) throw new Error('No institution selected');
      const body: Record<string, unknown> = {
        super_agent_id: superAgentId,
        is_preferred: isPreferred,
      };
      if (notes.trim()) body['notes'] = notes.trim();
      const res = await api.post(
        `/institutions/${picked.id}/super-agents`,
        body,
      );
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Institution linked', { variant: 'success' });
      // Invalidate both directions of the m:n.
      void qc.invalidateQueries({ queryKey: ['super-agent', superAgentId, 'institutions'] });
      void qc.invalidateQueries({ queryKey: ['super-agent-metrics', superAgentId] });
      if (picked) {
        void qc.invalidateQueries({ queryKey: ['institutions', picked.id, 'super-agents'] });
        void qc.invalidateQueries({ queryKey: ['institutions', 'detail', picked.id] });
      }
      void qc.invalidateQueries({ queryKey: ['institutions', 'list'] });
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Link failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const topLevelError =
    mutation.isError && mutation.error instanceof ApiError
      ? mutation.error.detail || mutation.error.title
      : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Link institution"
      subtitle="Add this super-agent as a channel for an institution."
      maxWidth="sm"
      errorText={topLevelError ?? null}
      primaryAction={{
        label: 'Link institution',
        loadingLabel: 'Linking…',
        loading: mutation.isPending,
        disabled: !picked || mutation.isPending,
        onClick: () => mutation.mutate(),
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': {
            paddingTop: 0,
            paddingBottom: 0,
            height: '100%',
          },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': {
            paddingTop: '0 !important',
            paddingBottom: '0 !important',
          },
        }}
      >
        <Stack spacing={2.5}>
          <LabeledField label="Institution" required htmlFor="link-inst-pick">
            <Autocomplete<InstitutionLite>
              options={options}
              loading={institutionsQ.isLoading}
              value={picked}
              onChange={(_, v) => setPicked(v)}
              getOptionLabel={(o) =>
                `${o.display_name}${o.short_name ? ` (${o.short_name})` : ''}`
              }
              isOptionEqualToValue={(a, b) => a.id === b.id}
              fullWidth
              size="medium"
              noOptionsText={
                (institutionsQ.data?.length ?? 0) === 0
                  ? 'No institutions in catalogue yet'
                  : 'All institutions are already linked'
              }
              renderInput={(p) => (
                <TextField
                  {...p}
                  id="link-inst-pick"
                  hiddenLabel
                  placeholder="Search institutions"
                />
              )}
            />
          </LabeledField>
          <FormControlLabel
            control={
              <Switch
                checked={isPreferred}
                onChange={(_, v) => setIsPreferred(v)}
                icon={<StarOutlineIcon fontSize="small" />}
                checkedIcon={<StarIcon fontSize="small" />}
              />
            }
            label="Preferred channel for this institution"
          />
          <LabeledField
            label="Notes"
            helperText="Optional context about the partnership."
            htmlFor="link-inst-notes"
          >
            <TextField
              id="link-inst-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </LabeledField>
          {!picked && (institutionsQ.data?.length ?? 0) > 0 ? (
            <Alert severity="info" variant="outlined">
              Pick an institution to enable linking.
            </Alert>
          ) : null}
        </Stack>
      </Box>
    </AppDialog>
  );
}
