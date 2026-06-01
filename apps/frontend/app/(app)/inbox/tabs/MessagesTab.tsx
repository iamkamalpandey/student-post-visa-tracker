// Refactored to SVT form-pattern
// Lifted from the original /inbox Client.tsx — the templates list +
// preview pane + "Recent threads" student list. Page-level header is
// removed (parent /inbox renders the heading + tabs); the "New template"
// button moves into the tab's local action row.
//
// No filter inputs live here (the tab is two list pickers, not a search
// surface) so the LabeledField wrapper isn't needed yet. Aria labels on
// the action IconButtons and the two `<List aria-label=...>` regions
// already cover the AT surface.

import { useState } from 'react';
import NextLink from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Link as MuiLink,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canManageUsers } from '@/lib/auth-helpers';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ConfirmDialog from '@/components/ConfirmDialog';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import { TEMPLATES_QK } from '@/features/io/util';
import CreateMessageTemplateDialog, {
  type TemplateRecord,
} from '@/features/io/CreateMessageTemplateDialog';

type RecentStudentRow = {
  id: string;
  student_code: string;
  given_name: string;
  family_name: string;
};

type StudentsListResponse = {
  data: RecentStudentRow[];
  page?: { nextCursor: string | null; hasMore: boolean };
};

const CHANNEL_COLOR: Record<TemplateRecord['channel'], 'primary' | 'secondary' | 'success' | 'info'> = {
  EMAIL: 'primary',
  SMS: 'secondary',
  WHATSAPP: 'success',
  IN_APP: 'info',
};

export default function MessagesTab() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const { user } = useAuth();
  // Only ADMIN can create / edit / delete message-templates (see backend route).
  const canManageTemplates = canManageUsers(user?.role);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateRecord | null>(null);

  const templatesQuery = useQuery<TemplateRecord[]>({
    queryKey: TEMPLATES_QK.list(),
    queryFn: async () => {
      const res = await api.get<TemplateRecord[] | { data: TemplateRecord[] }>(
        '/message-templates',
        { params: { limit: 100 } },
      );
      return Array.isArray(res.data) ? res.data : res.data.data ?? [];
    },
  });

  const recentStudentsQuery = useQuery<RecentStudentRow[]>({
    queryKey: ['inbox', 'recent-students'],
    queryFn: async () => {
      const res = await api.get<unknown>('/students', { params: { limit: 10 } });
      // Defensive: backend list shape varies (some return bare array, some
      // {data,page}, some nested). Normalize to a guaranteed array.
      const body = res.data as unknown;
      if (Array.isArray(body)) return body as RecentStudentRow[];
      if (body && typeof body === 'object' && 'data' in body) {
        const inner = (body as { data: unknown }).data;
        if (Array.isArray(inner)) return inner as RecentStudentRow[];
      }
      return [];
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/message-templates/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Template deleted.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: TEMPLATES_QK.all });
      setSelectedId(null);
      setDeleteTarget(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Could not delete template';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const templates = templatesQuery.data ?? [];
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  return (
    <>
      <Stack spacing={2}>
        {/* Tab-local action row: refresh + new template. */}
        <Stack direction="row" justifyContent="flex-end" spacing={1}>
          <Tooltip title="Refresh">
            <span>
              <IconButton
                aria-label="Refresh inbox"
                onClick={() => {
                  void templatesQuery.refetch();
                  void recentStudentsQuery.refetch();
                }}
                disabled={templatesQuery.isFetching || recentStudentsQuery.isFetching}
              >
                <RefreshOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          {canManageTemplates ? (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              New template
            </Button>
          ) : null}
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: 'minmax(280px, 360px) 1fr' },
            minHeight: 480,
          }}
        >
          {/* LEFT — template list */}
          <Paper variant="outlined" sx={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ p: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
              <Typography variant="subtitle2">
                Templates ({templates.length})
              </Typography>
            </Box>
            {templatesQuery.isLoading ? (
              <Box sx={{ p: 2 }}>
                <LoadingSkeleton variant="list" rows={5} />
              </Box>
            ) : templatesQuery.isError ? (
              <Box sx={{ p: 2 }}>
                <ErrorState
                  title="Could not load templates"
                  description={
                    templatesQuery.error instanceof ApiError
                      ? templatesQuery.error.detail || templatesQuery.error.title
                      : 'Unexpected error'
                  }
                  onRetry={() => templatesQuery.refetch()}
                  requestId={
                    templatesQuery.error instanceof ApiError
                      ? templatesQuery.error.requestId
                      : undefined
                  }
                />
              </Box>
            ) : templates.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <EmptyState
                  title="No templates yet"
                  description="Create one to standardise outbound comms."
                  actions={
                    canManageTemplates ? (
                      <Button
                        variant="contained"
                        startIcon={<AddIcon />}
                        onClick={() => {
                          setEditing(null);
                          setOpen(true);
                        }}
                      >
                        New template
                      </Button>
                    ) : undefined
                  }
                />
              </Box>
            ) : (
              <List
                disablePadding
                sx={{ overflowY: 'auto', flexGrow: 1 }}
                aria-label="Message templates"
              >
                {templates.map((t) => (
                  <ListItem
                    key={t.id}
                    disablePadding
                    secondaryAction={
                      canManageTemplates ? (
                        <Stack direction="row" spacing={0.5}>
                          <Tooltip title="Edit template">
                            <IconButton
                              aria-label={`Edit template ${t.key}`}
                              size="small"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditing(t);
                                setOpen(true);
                              }}
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete template">
                            <span>
                              <IconButton
                                aria-label={`Delete template ${t.key}`}
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteTarget(t);
                                }}
                                disabled={deleteMut.isPending}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      ) : undefined
                    }
                  >
                    <ListItemButton
                      selected={selectedId === t.id}
                      onClick={() => setSelectedId(t.id)}
                      sx={{ pr: canManageTemplates ? 10 : 2 }}
                    >
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Chip
                              size="small"
                              label={t.channel}
                              color={CHANNEL_COLOR[t.channel] ?? 'default'}
                              variant="outlined"
                            />
                            <Typography
                              variant="body2"
                              sx={{ fontWeight: 600, fontFamily: 'monospace' }}
                              noWrap
                            >
                              {t.key}
                            </Typography>
                          </Stack>
                        }
                        secondary={
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {t.subject ?? '(no subject)'}
                          </Typography>
                        }
                      />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>

          {/* RIGHT — template preview / threads placeholder */}
          <Paper variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column' }}>
            {selected ? (
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    label={selected.channel}
                    color={CHANNEL_COLOR[selected.channel] ?? 'default'}
                  />
                  <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {selected.key}
                  </Typography>
                </Stack>
                {selected.subject ? (
                  <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                    Subject: {selected.subject}
                  </Typography>
                ) : null}
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {selected.destination_country ? (
                    <Chip size="small" label={`Country: ${selected.destination_country}`} variant="outlined" />
                  ) : null}
                  {selected.stage_id ? (
                    <Chip
                      size="small"
                      label={`Stage: ${selected.stage_id.slice(0, 8)}…`}
                      variant="outlined"
                    />
                  ) : null}
                  <Chip
                    size="small"
                    label={selected.is_active ? 'active' : 'inactive'}
                    color={selected.is_active ? 'success' : 'default'}
                    variant="outlined"
                  />
                </Stack>
                <Box
                  sx={{
                    bgcolor: 'action.hover',
                    borderRadius: 2,
                    p: 2,
                    fontFamily: 'monospace',
                    fontSize: 13,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 360,
                    overflow: 'auto',
                  }}
                >
                  {selected.body_md}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  To start a real thread, open a student profile and use their /messages tab.
                </Typography>
              </Stack>
            ) : (
              <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <EmptyState
                  icon={<ForumOutlinedIcon />}
                  title="Pick a student to start a thread"
                  description="Select a template on the left to preview, or open a student page (/students/{id}) to send a real message."
                />
              </Box>
            )}
          </Paper>
        </Box>

        {/* RECENT THREADS — v1 hop-into-conversation list. */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            sx={{ mb: 1.5 }}
          >
            <Stack spacing={0.25}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Recent threads
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Jump into a student conversation. v1 lists the most recent
                students; full thread index lands once /comms/threads ships.
              </Typography>
            </Stack>
          </Stack>

          {recentStudentsQuery.isLoading ? (
            <LoadingSkeleton variant="list" rows={4} />
          ) : recentStudentsQuery.isError ? (
            <ErrorState
              title="Could not load recent students"
              description={
                recentStudentsQuery.error instanceof ApiError
                  ? recentStudentsQuery.error.detail || recentStudentsQuery.error.title
                  : 'Unexpected error'
              }
              onRetry={() => recentStudentsQuery.refetch()}
              requestId={
                recentStudentsQuery.error instanceof ApiError
                  ? recentStudentsQuery.error.requestId
                  : undefined
              }
            />
          ) : (recentStudentsQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="No students yet"
              description="Once you have students, recent threads will surface here."
            />
          ) : (
            <List disablePadding aria-label="Recent threads">
              {(Array.isArray(recentStudentsQuery.data) ? recentStudentsQuery.data : []).map((s) => (
                <ListItem
                  key={s.id}
                  disablePadding
                  secondaryAction={
                    <Tooltip title="Open student inbox">
                      <IconButton
                        aria-label={`Open inbox for ${s.given_name} ${s.family_name}`}
                        size="small"
                        component={NextLink}
                        href={`/students/${s.id}?tab=records&section=messages`}
                      >
                        <OpenInNewOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  }
                >
                  <ListItemButton
                    component={NextLink}
                    href={`/students/${s.id}?tab=records&section=messages`}
                  >
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {s.given_name} {s.family_name}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{ fontFamily: 'monospace' }}
                            color="text.secondary"
                          >
                            {s.student_code}
                          </Typography>
                        </Stack>
                      }
                      secondary={
                        <MuiLink component="span" variant="caption" color="primary">
                          Open inbox →
                        </MuiLink>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
        </Paper>

        {/* Templates fetching indicator — pinned bottom-right while refetching. */}
        {templatesQuery.isFetching && !templatesQuery.isLoading ? (
          <Box sx={{ position: 'fixed', bottom: 16, right: 16 }}>
            <CircularProgress size={20} aria-label="Refreshing templates" />
          </Box>
        ) : null}
      </Stack>

      <CreateMessageTemplateDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        template={editing}
      />

      {deleteTarget ? (
        <ConfirmDialog
          open={Boolean(deleteTarget)}
          title="Delete template"
          description={
            <Typography variant="body2">
              Permanently delete the template{' '}
              <Typography component="span" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>
                {deleteTarget.key}
              </Typography>
              ? This cannot be undone.
            </Typography>
          }
          confirmLabel={deleteTarget.key}
          confirmText="Delete template"
          loading={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deleteTarget.id)}
          onClose={() => (deleteMut.isPending ? undefined : setDeleteTarget(null))}
        />
      ) : null}
    </>
  );
}
