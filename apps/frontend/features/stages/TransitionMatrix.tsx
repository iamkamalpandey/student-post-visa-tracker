'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Checkbox,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { ApiError, api } from '@/lib/api';
import type { Stage, StageTransition } from './types';

type Props = {
  stages: Stage[];
  /** When false, the matrix renders read-only. */
  canEdit: boolean;
};

type ApiList<T> = { data: T[] };

export default function TransitionMatrix({ stages, canEdit }: Props) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const transitionsQuery = useQuery({
    queryKey: ['stages', 'transitions'],
    queryFn: async () => {
      const res = await api.get<ApiList<StageTransition>>('/stages/transitions');
      return res.data.data;
    },
  });

  // Index transitions by `${from}|${to}` → row, so each cell is O(1).
  const byKey = useMemo(() => {
    const map = new Map<string, StageTransition>();
    for (const t of transitionsQuery.data ?? []) {
      map.set(`${t.from_stage_id}|${t.to_stage_id}`, t);
    }
    return map;
  }, [transitionsQuery.data]);

  const toggle = useMutation({
    mutationFn: async (vars: { from: Stage; to: Stage; existing: StageTransition | undefined }) => {
      if (vars.existing) {
        await api.delete(`/stages/transitions/${vars.existing.id}`);
        return { mode: 'deleted' as const };
      }
      const res = await api.post<StageTransition>('/stages/transitions', {
        from_stage_id: vars.from.id,
        to_stage_id: vars.to.id,
      });
      return { mode: 'created' as const, created: res.data };
    },
    // Optimistic update: flip the cell immediately, rollback on error.
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['stages', 'transitions'] });
      const prev = qc.getQueryData<StageTransition[]>(['stages', 'transitions']);
      const key = `${vars.from.id}|${vars.to.id}`;
      const next = vars.existing
        ? (prev ?? []).filter((t) => `${t.from_stage_id}|${t.to_stage_id}` !== key)
        : [
            ...(prev ?? []),
            {
              id: `optimistic-${key}`,
              tenant_id: '',
              from_stage_id: vars.from.id,
              to_stage_id: vars.to.id,
              requires_role: null,
            } satisfies StageTransition,
          ];
      qc.setQueryData(['stages', 'transitions'], next);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stages', 'transitions'], ctx.prev);
      const message = err instanceof ApiError ? err.detail || err.title : 'Failed to update transition';
      enqueueSnackbar(message, { variant: 'error' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['stages', 'transitions'] });
    },
  });

  if (transitionsQuery.isLoading) {
    return <Skeleton variant="rectangular" height={240} sx={{ borderRadius: 1 }} />;
  }
  if (transitionsQuery.isError) {
    const err = transitionsQuery.error;
    const msg = err instanceof ApiError ? err.detail || err.title : 'Failed to load transitions';
    return <Alert severity="error">{msg}</Alert>;
  }

  if (stages.length === 0) {
    return <Alert severity="info">Create some stages above to build the transition matrix.</Alert>;
  }

  // Sort along both axes by sequence (matches backend ordering).
  const ordered = [...stages].sort((a, b) => a.sequence - b.sequence);

  return (
    <Box>
      <Stack spacing={1} sx={{ mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Allowed transitions
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Empty matrix = free movement allowed. Add rows to lock down which transitions counsellors
          can perform. Rows are <em>from</em>; columns are <em>to</em>.
        </Typography>
      </Stack>

      <TableContainer sx={{ border: (t) => `1px solid ${t.palette.divider}`, borderRadius: 1 }}>
        <Table size="small" sx={{ '& td, & th': { borderColor: 'divider' } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ bgcolor: 'background.default', minWidth: 160 }}>
                <Typography variant="caption" color="text.secondary">
                  From ↓ / To →
                </Typography>
              </TableCell>
              {ordered.map((s) => (
                <TableCell
                  key={s.id}
                  align="center"
                  sx={{ bgcolor: 'background.default', whiteSpace: 'nowrap' }}
                >
                  <Tooltip title={s.key} placement="top">
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>
                      {s.label}
                    </Typography>
                  </Tooltip>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {ordered.map((from) => (
              <TableRow key={from.id}>
                <TableCell sx={{ bgcolor: 'background.default' }}>
                  <Tooltip title={from.key} placement="right">
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>
                      {from.label}
                    </Typography>
                  </Tooltip>
                </TableCell>
                {ordered.map((to) => {
                  const sameStage = from.id === to.id;
                  const existing = byKey.get(`${from.id}|${to.id}`);
                  return (
                    <TableCell key={to.id} align="center" padding="checkbox">
                      {sameStage ? (
                        <Box
                          sx={{
                            width: 16,
                            height: 16,
                            mx: 'auto',
                            borderRadius: '2px',
                            bgcolor: 'action.disabledBackground',
                          }}
                          aria-hidden
                        />
                      ) : (
                        <Checkbox
                          size="small"
                          checked={Boolean(existing)}
                          disabled={!canEdit || toggle.isPending}
                          onChange={() => toggle.mutate({ from, to, existing })}
                          inputProps={{
                            'aria-label': `Allow transition from ${from.label} to ${to.label}`,
                          }}
                        />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
