'use client';

// SVT-SUPERAGENTS-2026-05: per-institution Super-agents tab body. List of
// linked super-agents as cards/chips, plus an admin-only Autocomplete picker
// to link a new one and an Unlink action gated by ConfirmDialog. Empty state
// reads "Direct only — no super-agents linked" so the absence is intentional,
// not a missing-data hint.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import StarIcon from '@mui/icons-material/Star';
import { ApiError, api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import LabeledField from '@/components/LabeledField';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { InstitutionSuperAgentLink, SuperAgentRow } from './types';

type ApiList<T> = { data: T[] };

export type InstitutionSuperAgentsSectionProps = {
  institutionId: string;
  isAdmin: boolean;
};

export default function InstitutionSuperAgentsSection({
  institutionId,
  isAdmin,
}: InstitutionSuperAgentsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [picked, setPicked] = useState<SuperAgentRow | null>(null);
  const [isPreferred, setIsPreferred] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<InstitutionSuperAgentLink | null>(null);

  const linksKey = ['institutions', institutionId, 'super-agents'];
  const linksQ = useQuery({
    queryKey: linksKey,
    queryFn: async () => {
      const res = await api.get<ApiList<InstitutionSuperAgentLink>>(
        `/institutions/${institutionId}/super-agents`,
      );
      return res.data.data;
    },
  });

  // Catalogue for the Autocomplete — admin-only fetch (counsellors don't get
  // the "link" UI). The cap of 200 mirrors the backend list page size.
  const catalogueQ = useQuery({
    queryKey: ['super-agents', 'list', 'all'],
    queryFn: async () => {
      const res = await api.get<ApiList<SuperAgentRow>>('/super-agents');
      return res.data.data;
    },
    enabled: isAdmin,
  });

  const links = linksQ.data ?? [];
  const linkedIds = useMemo(() => new Set(links.map((l) => l.super_agent_id)), [links]);
  // Hide already-linked rows + soft-deleted + non-ACTIVE (still allowed but
  // labelled so admins know what they're picking).
  const options = useMemo(
    () => (catalogueQ.data ?? []).filter((r) => !linkedIds.has(r.id)),
    [catalogueQ.data, linkedIds],
  );

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!picked) throw new Error('No super-agent selected');
      const body = { super_agent_id: picked.id, is_preferred: isPreferred };
      const res = await api.post(`/institutions/${institutionId}/super-agents`, body);
      return res.data as InstitutionSuperAgentLink;
    },
    onSuccess: () => {
      enqueueSnackbar('Super-agent linked', { variant: 'success' });
      setPicked(null);
      setIsPreferred(false);
      void qc.invalidateQueries({ queryKey: linksKey });
      // Bump the institution detail _count too.
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Link failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (linkId: string) => {
      await api.delete(`/institutions/${institutionId}/super-agents/${linkId}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Super-agent unlinked', { variant: 'success' });
      setUnlinkTarget(null);
      void qc.invalidateQueries({ queryKey: linksKey });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Unlink failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  if (linksQ.isLoading) {
    return (
      <Card variant="outlined">
        <Box sx={{ p: 2 }}>
          <LoadingSkeleton rows={3} />
        </Box>
      </Card>
    );
  }
  if (linksQ.isError) {
    return (
      <Card variant="outlined">
        <Box sx={{ p: 2 }}>
          <ErrorState
            title="Could not load super-agents"
            description={
              linksQ.error instanceof ApiError
                ? linksQ.error.detail || linksQ.error.title
                : 'Please try again.'
            }
            onRetry={() => void linksQ.refetch()}
          />
        </Box>
      </Card>
    );
  }

  return (
    <Card variant="outlined">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Super-agents
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {links.length === 0
            ? 'Direct only'
            : `${links.length} channel${links.length === 1 ? '' : 's'}`}
        </Typography>
      </Stack>

      <Box sx={{ p: 2 }}>
        {/* Linked super-agents — chip layout */}
        {links.length === 0 ? (
          <EmptyState
            icon={<HubOutlinedIcon fontSize="medium" />}
            title="Direct only — no super-agents linked"
            description={
              isAdmin
                ? 'Link a super-agent below to start brokering enrollments through them.'
                : 'This institution is reached directly. An admin can configure aggregator channels.'
            }
          />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
            }}
          >
            {links.map((link) => (
              <Card key={link.id} variant="outlined">
                <CardContent sx={{ pb: '16px !important' }}>
                  <Stack direction="row" spacing={1.5} alignItems="flex-start">
                    <Box
                      sx={{
                        width: 40,
                        height: 40,
                        borderRadius: 1,
                        bgcolor: 'primary.main',
                        color: 'primary.contrastText',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        fontWeight: 700,
                      }}
                    >
                      {(link.super_agent?.short_name ?? link.super_agent?.name ?? '?')
                        .slice(0, 2)
                        .toUpperCase()}
                    </Box>
                    <Stack sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <Typography
                          variant="subtitle2"
                          sx={{
                            fontWeight: 700,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {link.super_agent?.name ?? 'Unknown'}
                        </Typography>
                        {link.is_preferred ? (
                          <Tooltip title="Preferred channel">
                            <StarIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                          </Tooltip>
                        ) : null}
                      </Stack>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                        {link.super_agent?.status ? (
                          <Chip
                            size="small"
                            label={link.super_agent.status}
                            color={link.super_agent.status === 'ACTIVE' ? 'success' : 'default'}
                            variant={link.super_agent.status === 'ACTIVE' ? 'filled' : 'outlined'}
                          />
                        ) : null}
                      </Stack>
                    </Stack>
                    {isAdmin ? (
                      <Tooltip title="Unlink">
                        <IconButton
                          size="small"
                          aria-label={`Unlink ${link.super_agent?.name ?? 'super-agent'}`}
                          onClick={() => setUnlinkTarget(link)}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                  </Stack>
                  {link.notes ? (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      {link.notes}
                    </Typography>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </Box>
        )}

        {/* Admin-only link picker */}
        {isAdmin ? (
          <Box sx={{ mt: 3, pt: 2, borderTop: (t) => `1px solid ${t.palette.divider}` }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Link a super-agent
            </Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ sm: 'flex-end' }}
              sx={{
                // SVT-FORMPATTERN-2026-05: 44px input height (matches
                // EditCoreProfileDialog.tsx convention).
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
              <Box sx={{ flex: 2, minWidth: 0 }}>
                <LabeledField label="Super-agent" htmlFor="link-sa-pick">
                  <Autocomplete<SuperAgentRow>
                    options={options}
                    loading={catalogueQ.isLoading}
                    getOptionLabel={(o) =>
                      `${o.name}${o.short_name ? ` (${o.short_name})` : ''}`
                    }
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    value={picked}
                    onChange={(_, v) => setPicked(v)}
                    fullWidth
                    size="medium"
                    noOptionsText={
                      (catalogueQ.data?.length ?? 0) === 0
                        ? 'No super-agents in catalogue yet'
                        : 'All super-agents are already linked'
                    }
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        id="link-sa-pick"
                        hiddenLabel
                        placeholder="Search super-agents"
                      />
                    )}
                  />
                </LabeledField>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={isPreferred}
                      onChange={(_, v) => setIsPreferred(v)}
                      icon={<StarOutlineIcon fontSize="small" />}
                      checkedIcon={<StarIcon fontSize="small" />}
                    />
                  }
                  label="Preferred channel"
                />
              </Box>
              <Button
                variant="contained"
                startIcon={<AddOutlinedIcon />}
                disabled={!picked || linkMutation.isPending}
                onClick={() => linkMutation.mutate()}
              >
                {linkMutation.isPending ? 'Linking…' : 'Link'}
              </Button>
            </Stack>
          </Box>
        ) : null}
      </Box>

      <ConfirmDialog
        open={unlinkTarget !== null}
        title="Unlink super-agent"
        description={
          unlinkTarget ? (
            <Typography variant="body2" color="text.secondary">
              Removes this super-agent as a channel for this institution. Past enrollments that
              already attribute to it keep their reference. New enrollments won&rsquo;t be able to
              pick it for this institution unless it&rsquo;s re-linked.
            </Typography>
          ) : null
        }
        confirmLabel={unlinkTarget?.super_agent?.name ?? null}
        confirmText="Unlink"
        loading={unlinkMutation.isPending}
        onConfirm={() => {
          if (unlinkTarget) unlinkMutation.mutate(unlinkTarget.id);
        }}
        onClose={() => setUnlinkTarget(null)}
      />
    </Card>
  );
}
