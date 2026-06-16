'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
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
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { INTERVIEW_QUESTION_CATEGORY_LABEL } from '@spv/zod-schemas';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ConfirmDialog from '@/components/ConfirmDialog';
import ListPageShell from '@/components/ListPageShell';
import LabeledField from '@/components/LabeledField';
import InterviewQuestionEditDialog from '@/features/interview-prep/InterviewQuestionEditDialog';
import type { InterviewQuestionRow, CountryLite, InstitutionLite } from '@/features/interview-prep/types';

type ApiList<T> = { data: T[] };
type RowMenuState = { anchor: HTMLElement; row: InterviewQuestionRow } | null;

const CATEGORY_LABELS = INTERVIEW_QUESTION_CATEGORY_LABEL as Record<string, string>;

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>Interview questions</Typography>
      </Stack>
      <EmptyState
        icon={<LockOutlinedIcon fontSize="medium" />}
        title="Admin only"
        description="You need administrator access to manage the interview question bank."
      />
    </Stack>
  );
}

export default function InterviewQuestionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [countryFilter, setCountryFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<InterviewQuestionRow | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  const [deleteTarget, setDeleteTarget] = useState<InterviewQuestionRow | null>(null);

  const questionsQuery = useQuery({
    queryKey: ['interview-questions', countryFilter || null, categoryFilter || null],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (countryFilter) params.country_code = countryFilter;
      if (categoryFilter) params.category = categoryFilter;
      const res = await api.get<ApiList<InterviewQuestionRow>>('/interview-questions', { params });
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

  const institutionsQuery = useQuery({
    queryKey: ['lookups', 'institutions-lite'],
    queryFn: async () => {
      const res = await api.get<ApiList<InstitutionLite>>('/institutions', { params: { limit: 100 } });
      return res.data.data;
    },
    enabled: isAdmin,
  });

  const grouped = useMemo(() => {
    const rows = questionsQuery.data ?? [];
    const map = new Map<string, InterviewQuestionRow[]>();
    for (const r of rows) {
      const key = `${r.country_code}|${r.category}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [questionsQuery.data]);

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      await api.patch(`/interview-questions/${id}`, { is_active });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['interview-questions'] }),
    onError: (err) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Update failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/interview-questions/${id}`); },
    onSuccess: () => {
      enqueueSnackbar('Question deleted', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['interview-questions'] });
      setDeleteTarget(null);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Delete failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const generateLinkMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post<{ token: string; url: string }>('/interview-questions/generate-link');
      return res.data;
    },
    onSuccess: (data) => {
      const fullUrl = `${window.location.origin}${data.url}`;
      void navigator.clipboard.writeText(fullUrl);
      enqueueSnackbar('Interview prep link copied to clipboard', { variant: 'success' });
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Failed to generate link';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  function openCreate() { setEditing(null); setEditorOpen(true); }
  function openEdit(row: InterviewQuestionRow) { setEditing(row); setEditorOpen(true); setRowMenu(null); }
  function closeEditor() { setEditorOpen(false); setEditing(null); }

  if (!isAdmin) return <ForbiddenState />;

  const isLoading = questionsQuery.isLoading;
  const isError = questionsQuery.isError;
  const totalQuestions = questionsQuery.data?.length ?? 0;

  return (
    <ListPageShell
      title="Interview questions"
      description={`Question bank for visa interview mock tests. ${totalQuestions} question${totalQuestions !== 1 ? 's' : ''} configured.`}
      action={
        <Stack direction="row" spacing={1}>
          <Tooltip title="Generate a shareable link for students to access the mock test">
            <Button
              variant="outlined"
              startIcon={<LinkOutlinedIcon />}
              onClick={() => generateLinkMutation.mutate()}
              disabled={generateLinkMutation.isPending}
            >
              Copy prep link
            </Button>
          </Tooltip>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New question
          </Button>
        </Stack>
      }
      filters={
        <Stack direction="row" spacing={1.5}>
          <LabeledField label="Country" srOnly htmlFor="iq-filter-country">
            <TextField
              id="iq-filter-country"
              select
              size="small"
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">All countries</MenuItem>
              {(countriesQuery.data ?? []).map((c) => (
                <MenuItem key={c.code_alpha2} value={c.code_alpha2}>{c.name}</MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField label="Category" srOnly htmlFor="iq-filter-cat">
            <TextField
              id="iq-filter-cat"
              select
              size="small"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">All categories</MenuItem>
              {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                <MenuItem key={k} value={k}>{label}</MenuItem>
              ))}
            </TextField>
          </LabeledField>
        </Stack>
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
            title="Could not load questions"
            description={questionsQuery.error instanceof ApiError ? questionsQuery.error.detail || questionsQuery.error.title : 'Please try again.'}
            onRetry={() => questionsQuery.refetch()}
          />
        </Box>
      ) : grouped.length === 0 ? (
        <Box sx={{ p: 3 }}>
          <EmptyState
            title="No interview questions yet"
            description="Add questions to the bank. Students will see them during their mock interview based on country, level, and institution."
            actions={
              <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>New question</Button>
            }
          />
        </Box>
      ) : (
        <CardContent sx={{ p: 0 }}>
          {grouped.map(([groupKey, rows]) => {
            const parts = groupKey.split('|');
            const country = parts[0];
            const category = parts[1] ?? '';
            return (
              <Box key={groupKey}>
                <Box sx={{ px: 3, py: 1.25, bgcolor: (t) => t.palette.action.hover }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="overline" sx={{ fontWeight: 600, letterSpacing: 0.6 }}>
                      {country}
                    </Typography>
                    <Chip size="small" label={CATEGORY_LABELS[category] ?? category} variant="outlined" />
                  </Stack>
                </Box>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Question</TableCell>
                        <TableCell sx={{ width: 140 }}>Level</TableCell>
                        <TableCell sx={{ width: 180 }}>Institution</TableCell>
                        <TableCell sx={{ width: 80 }}>Order</TableCell>
                        <TableCell sx={{ width: 90 }}>Active</TableCell>
                        <TableCell align="right" sx={{ width: 60 }} />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id} hover>
                          <TableCell>
                            <Typography variant="body2" sx={{ maxWidth: 500, whiteSpace: 'pre-wrap' }}>
                              {row.question_text.length > 120 ? `${row.question_text.slice(0, 120)}…` : row.question_text}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" color="text.secondary">
                              {row.academic_level ?? 'All'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" color="text.secondary">
                              {row.institution?.display_name ?? 'General'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{row.sort_order}</Typography>
                          </TableCell>
                          <TableCell>
                            <Switch
                              size="small"
                              checked={row.is_active}
                              onChange={(_, v) => toggleActiveMutation.mutate({ id: row.id, is_active: v })}
                              disabled={toggleActiveMutation.isPending}
                            />
                          </TableCell>
                          <TableCell align="right">
                            <IconButton size="small" onClick={(e) => setRowMenu({ anchor: e.currentTarget, row })}>
                              <MoreVertOutlinedIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            );
          })}
        </CardContent>
      )}

      <Menu anchorEl={rowMenu?.anchor ?? null} open={Boolean(rowMenu)} onClose={() => setRowMenu(null)}>
        <MenuItem onClick={() => rowMenu && openEdit(rowMenu.row)}>
          <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
          Edit
        </MenuItem>
        <MenuItem onClick={() => { if (rowMenu) { setDeleteTarget(rowMenu.row); setRowMenu(null); } }}>
          <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
          <Typography color="error">Delete</Typography>
        </MenuItem>
      </Menu>

      <InterviewQuestionEditDialog
        open={editorOpen}
        row={editing}
        countries={countriesQuery.data ?? []}
        institutions={institutionsQuery.data ?? []}
        onClose={closeEditor}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete question"
        description="This will soft-delete the question. It will no longer appear in new mock tests."
        confirmLabel={deleteTarget ? deleteTarget.question_text.slice(0, 30) : null}
        confirmText="Delete"
        loading={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
        onClose={() => setDeleteTarget(null)}
      />
    </ListPageShell>
  );
}
