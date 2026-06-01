'use client';

// /visa-types — admin-only page that manages the per-(country × visa-type)
// catalogue introduced in v6. Lifecycle stages may optionally pin themselves
// to a row here via `visa_type_id`; rows marked `is_generic=true` act as
// the tenant default per country and are guarded from rename/delete.
//
// Refactored to SVT form-pattern per design pass: filter input wrapped in
// LabeledField srOnly so the small-sized country picker retains the toolbar
// look while still carrying an accessible label.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ConfirmDialog from '@/components/ConfirmDialog';
import ListPageShell from '@/components/ListPageShell';
import LabeledField from '@/components/LabeledField';
import VisaTypeEditDialog from '@/features/visa-types/VisaTypeEditDialog';
import type { VisaTypeRow, CountryLite } from '@/features/visa-types/types';

type ApiList<T> = { data: T[] };

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          Visa types
        </Typography>
      </Stack>
      <EmptyState
        icon={<LockOutlinedIcon fontSize="medium" />}
        title="Admin only"
        description="You need administrator access to view and manage the visa-type catalogue."
      />
    </Stack>
  );
}

type RowMenuState = { anchor: HTMLElement; row: VisaTypeRow } | null;

export default function VisaTypesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const tCommon = useTranslations('common');
  const tVisa = useTranslations('visaTypes');

  const [countryFilter, setCountryFilter] = useState<string>('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<VisaTypeRow | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<VisaTypeRow | null>(null);

  // Queries -----------------------------------------------------------------
  const visaTypesQuery = useQuery({
    queryKey: ['visa-types', countryFilter || null],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (countryFilter) params.country_code = countryFilter;
      const res = await api.get<ApiList<VisaTypeRow>>('/visa-types', { params });
      return res.data.data;
    },
    enabled: isAdmin,
  });

  const countriesQuery = useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async () => {
      const res = await api.get<ApiList<CountryLite>>('/lookups/countries');
      return res.data.data;
    },
    enabled: isAdmin,
  });

  // Group rows by country code so the table has clear country headers.
  const grouped = useMemo(() => {
    const rows = visaTypesQuery.data ?? [];
    const map = new Map<string, VisaTypeRow[]>();
    for (const r of rows) {
      const list = map.get(r.country_code) ?? [];
      list.push(r);
      map.set(r.country_code, list);
    }
    // Stable display order: country code asc.
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visaTypesQuery.data]);

  // Mutations ----------------------------------------------------------------
  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      await api.patch(`/visa-types/${id}`, { is_active });
    },
    onMutate: async ({ id, is_active }) => {
      await qc.cancelQueries({ queryKey: ['visa-types'] });
      const prev = qc.getQueryData<VisaTypeRow[]>(['visa-types', countryFilter || null]);
      if (prev) {
        qc.setQueryData<VisaTypeRow[]>(
          ['visa-types', countryFilter || null],
          prev.map((r) => (r.id === id ? { ...r, is_active } : r)),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(['visa-types', countryFilter || null], ctx.prev);
      }
      const msg = err instanceof ApiError ? err.detail || err.title : 'Update failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['visa-types'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/visa-types/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Visa type deleted', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['visa-types'] });
      setDeleteTarget(null);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Delete failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // Helpers ------------------------------------------------------------------
  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(row: VisaTypeRow) {
    setEditing(row);
    setEditorOpen(true);
    setRowMenu(null);
  }
  function closeEditor() {
    setEditorOpen(false);
    setEditing(null);
  }

  if (!isAdmin) return <ForbiddenState />;

  const isLoading = visaTypesQuery.isLoading;
  const isError = visaTypesQuery.isError;

  return (
    <ListPageShell
      title="Visa types"
      description="Per-country catalogue of visa workflows. Stages can be pinned to a visa type or stay generic."
      action={
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          New visa type
        </Button>
      }
      filters={
        <LabeledField label="Country" srOnly htmlFor="visa-types-filter-country">
          <TextField
            id="visa-types-filter-country"
            select
            size="small"
            hiddenLabel
            placeholder="All countries"
            value={countryFilter}
            onChange={(e) => setCountryFilter(e.target.value)}
            sx={{ minWidth: 220 }}
            SelectProps={{ native: false }}
          >
            <MenuItem value="">All countries</MenuItem>
            {(countriesQuery.data ?? []).map((c) => (
              <MenuItem key={c.code_alpha2} value={c.code_alpha2}>
                {c.name} ({c.code_alpha2})
              </MenuItem>
            ))}
          </TextField>
        </LabeledField>
      }
    >
      {isLoading ? (
        <Box sx={{ p: 3 }}>
          <Skeleton variant="rectangular" height={56} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={56} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={56} />
        </Box>
      ) : isError ? (
        <Box sx={{ p: 3 }}>
          <ErrorState
            title="Could not load visa types"
            description={
              visaTypesQuery.error instanceof ApiError
                ? visaTypesQuery.error.detail || visaTypesQuery.error.title
                : 'Please try again.'
            }
            onRetry={() => visaTypesQuery.refetch()}
          />
        </Box>
      ) : grouped.length === 0 ? (
        <Box sx={{ p: 3 }}>
          <EmptyState
            title="No visa types configured"
            description="Click “New visa type” to create the first one. Mark one per country as generic to make it the default."
            actions={
              <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
                New visa type
              </Button>
            }
          />
        </Box>
      ) : (
        <CardContent sx={{ p: 0 }}>
          {grouped.map(([country, rows]) => (
            <Box key={country}>
              <Box sx={{ px: 3, py: 1.25, bgcolor: (t) => t.palette.action.hover }}>
                <Typography variant="overline" sx={{ fontWeight: 600, letterSpacing: 0.6 }}>
                  {country}
                </Typography>
              </Box>
              <TableContainer>
                <Table size="small" aria-label={tVisa('aria.table', { country })}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Short name</TableCell>
                      <TableCell sx={{ width: 110 }}>Active</TableCell>
                      <TableCell sx={{ width: 110 }}>Generic</TableCell>
                      <TableCell align="right" sx={{ width: 60 }}>
                        {tCommon('actions')}
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell>
                          <Stack spacing={0.25}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {row.name}
                            </Typography>
                            {row.description ? (
                              <Typography variant="caption" color="text.secondary">
                                {row.description}
                              </Typography>
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                            {row.short_name ?? '—'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Tooltip
                            title={row.is_active ? 'Active — toggle to deactivate' : 'Inactive — toggle to activate'}
                          >
                            <Switch
                              size="small"
                              checked={row.is_active}
                              onChange={(_, v) =>
                                toggleActiveMutation.mutate({ id: row.id, is_active: v })
                              }
                              disabled={toggleActiveMutation.isPending}
                              inputProps={{ 'aria-label': `Toggle ${row.name} active` }}
                            />
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          {row.is_generic ? (
                            <Chip size="small" color="primary" label="generic" variant="outlined" />
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              —
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            aria-label={tVisa('aria.rowActions', { name: row.name })}
                            onClick={(e) => setRowMenu({ anchor: e.currentTarget, row })}
                          >
                            <MoreVertOutlinedIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          ))}
        </CardContent>
      )}

      {/* Row action menu */}
      <Menu
        anchorEl={rowMenu?.anchor ?? null}
        open={Boolean(rowMenu)}
        onClose={() => setRowMenu(null)}
      >
        <MenuItem onClick={() => rowMenu && openEdit(rowMenu.row)}>
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (rowMenu) {
              setDeleteTarget(rowMenu.row);
              setRowMenu(null);
            }
          }}
          disabled={Boolean(rowMenu?.row.is_generic)}
        >
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" color="error" />
          </ListItemIcon>
          <Typography color="error">Delete</Typography>
        </MenuItem>
      </Menu>

      {/* Create / edit dialog */}
      <VisaTypeEditDialog
        open={editorOpen}
        row={editing}
        countries={countriesQuery.data ?? []}
        onClose={closeEditor}
      />

      {/* Typed-confirmation delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete visa type"
        description={
          deleteTarget ? (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                This soft-deletes the visa type. Stages pinned to it will fall back to &quot;applies to
                any visa type&quot; via the SetNull FK.
              </Typography>
              {deleteTarget.is_generic ? (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  Generic visa types can&apos;t be deleted. Clear the &quot;generic&quot; flag first.
                </Alert>
              ) : null}
            </Stack>
          ) : null
        }
        confirmLabel={deleteTarget?.name ?? null}
        confirmText="Delete"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget && !deleteTarget.is_generic) {
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </ListPageShell>
  );
}
