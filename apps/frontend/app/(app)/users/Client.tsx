'use client';

// Refactored to SVT form-pattern per design pass.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
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
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import PersonAddAlt1OutlinedIcon from '@mui/icons-material/PersonAddAlt1Outlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LockResetOutlinedIcon from '@mui/icons-material/LockResetOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PhonelinkEraseOutlinedIcon from '@mui/icons-material/PhonelinkEraseOutlined';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import CreateUserDialog from '@/features/users/CreateUserDialog';
import EditUserDialog from '@/features/users/EditUserDialog';
import ResetPasswordDialog from '@/features/users/ResetPasswordDialog';
import LabeledField from '@/components/LabeledField';
import type { UserRow, UsersListResponse } from '@/features/users/types';

const ROLE_COLORS: Record<UserRow['role'], 'primary' | 'secondary' | 'default'> = {
  ADMIN: 'primary',
  COUNSELLOR: 'secondary',
  VIEWER: 'default',
};

function ForbiddenState() {
  const t = useTranslations('users.list');
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          {t('title')}
        </Typography>
      </Stack>
      <EmptyState
        icon={<LockOutlinedIcon fontSize="medium" />}
        title={t('forbiddenTitle')}
        description={t('forbiddenDescription')}
      />
    </Stack>
  );
}

type RelTranslator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function relativeTime(iso: string | null, t: RelTranslator, never: string): string {
  if (!iso) return never;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return t('justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('minAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('hrAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('dayAgo', { count: day });
  const mo = Math.floor(day / 30);
  if (mo < 12) return t('moAgo', { count: mo });
  const yr = Math.floor(day / 365);
  return t('yrAgo', { count: yr });
}

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

type RowMenuState = { anchor: HTMLElement; user: UserRow } | null;

export default function UsersPage() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('users.list');
  const tRel = useTranslations('users.list.relative');
  const tCommon = useTranslations('common');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserRow | null>(null);
  // SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven unbrick when a customer
  // admin loses BOTH TOTP device AND recovery codes. Captures a free-form
  // reason that is persisted in the audit row for compliance review.
  const [forceMfaTarget, setForceMfaTarget] = useState<UserRow | null>(null);
  const [forceMfaReason, setForceMfaReason] = useState('');
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);

  const isAdmin = me?.role === 'ADMIN';

  const usersQuery = useQuery<UsersListResponse>({
    queryKey: ['users', { search: debouncedSearch }],
    queryFn: async ({ signal }) => {
      const res = await api.get<UsersListResponse>('/users', {
        params: { limit: 50, ...(debouncedSearch ? { search: debouncedSearch } : {}) },
        signal,
      });
      return res.data;
    },
    enabled: isAdmin,
    placeholderData: (prev) => prev,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/users/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar(t('deleteSuccess'), { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setDeleteTarget(null);
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError ? err.detail || err.title || t('deleteError') : t('deleteError');
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.post(`/users/${id}/sessions/revoke`);
      return res.data as { data: { revoked: number } };
    },
    onSuccess: (data) => {
      const n = data?.data?.revoked ?? 0;
      enqueueSnackbar(t('revokeSuccess', { count: n }), {
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setRevokeTarget(null);
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError ? err.detail || err.title || t('revokeError') : t('revokeError');
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const forceMfaMut = useMutation({
    mutationFn: async (vars: { id: string; reason: string }) => {
      // SVT-SEC-MFA-FORCE-DISABLE-2026-05 — backend route is requireMfa-gated.
      // The shared `api` helper attaches the X-MFA-Code header from the inline
      // TOTP prompt when the server replies 401 mfa_required, so callers do
      // not need to plumb the header explicitly here.
      await api.post(`/users/${vars.id}/mfa/disable`, { reason: vars.reason });
    },
    onSuccess: () => {
      enqueueSnackbar('MFA force-disabled. The user must re-login and re-enrol MFA.', {
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setForceMfaTarget(null);
      setForceMfaReason('');
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError ? err.detail || err.title || 'Failed to disable MFA' : 'Failed to disable MFA';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const toggleActiveMut = useMutation({
    mutationFn: async (vars: { id: string; is_active: boolean }) => {
      const res = await api.patch(`/users/${vars.id}`, { is_active: vars.is_active });
      return res.data;
    },
    // Optimistic update so the switch reflects immediately.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['users'] });
      const snapshots = queryClient.getQueriesData<UsersListResponse>({ queryKey: ['users'] });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        queryClient.setQueryData<UsersListResponse>(key, {
          ...data,
          data: data.data.map((u) =>
            u.id === vars.id ? { ...u, is_active: vars.is_active } : u,
          ),
        });
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      // Roll back.
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) {
          queryClient.setQueryData(key, data);
        }
      }
      const msg =
        err instanceof ApiError ? err.detail || err.title || t('updateError') : t('updateError');
      enqueueSnackbar(msg, { variant: 'error' });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const rows: UserRow[] = useMemo(() => usersQuery.data?.data ?? [], [usersQuery.data]);

  if (!isAdmin) return <ForbiddenState />;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Stack spacing={1}>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            {t('title')}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t('description')}
          </Typography>
        </Stack>
        <Button
          variant="contained"
          startIcon={<PersonAddAlt1OutlinedIcon />}
          onClick={() => setCreateOpen(true)}
        >
          {t('newUser')}
        </Button>
      </Stack>

      <Stack direction="row" spacing={2} alignItems="center">
        {/* Filter toolbar: keeps size="small" so it reads as a search affordance
            rather than a form field; LabeledField provides the (hidden) label
            for screen readers via htmlFor → id. */}
        <LabeledField label={t('searchPlaceholder')} srOnly htmlFor="users-filter-search">
          <TextField
            id="users-filter-search"
            hiddenLabel
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="small"
            sx={{ minWidth: 320, maxWidth: 480, flexGrow: 1 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: usersQuery.isFetching ? (
                <InputAdornment position="end">
                  <CircularProgress size={16} />
                </InputAdornment>
              ) : null,
            }}
          />
        </LabeledField>
      </Stack>

      {usersQuery.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : usersQuery.isError ? (
        <ErrorState
          title={t('couldNotLoad')}
          description={
            usersQuery.error instanceof ApiError
              ? usersQuery.error.detail || usersQuery.error.title
              : t('tryAgain')
          }
          onRetry={() => usersQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={debouncedSearch ? t('noMatchTitle') : t('emptyTitle')}
          description={
            debouncedSearch
              ? t('noMatchDescription')
              : t('emptyDescription')
          }
          actions={
            debouncedSearch ? null : (
              <Button
                variant="contained"
                startIcon={<PersonAddAlt1OutlinedIcon />}
                onClick={() => setCreateOpen(true)}
              >
                {t('newUser')}
              </Button>
            )
          }
        />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" sx={{ minWidth: 720 }} aria-label={t('ariaLabel')}>
            <TableHead>
              <TableRow>
                <TableCell>{t('columns.email')}</TableCell>
                <TableCell>{t('columns.name')}</TableCell>
                <TableCell>{t('columns.role')}</TableCell>
                <TableCell>{t('columns.active')}</TableCell>
                <TableCell>{t('columns.lastSignIn')}</TableCell>
                <TableCell align="right">{t('columns.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((u) => {
                const isSelf = me?.id === u.id;
                const fullName = `${u.given_name} ${u.family_name}`.trim();
                return (
                  <TableRow key={u.id} hover>
                    <TableCell sx={{ fontWeight: 500 }}>{u.email}</TableCell>
                    <TableCell>{fullName || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={u.role}
                        color={ROLE_COLORS[u.role]}
                        variant={u.role === 'VIEWER' ? 'outlined' : 'filled'}
                      />
                    </TableCell>
                    <TableCell>
                      <Tooltip
                        title={isSelf ? t('selfDeactivateTooltip') : ''}
                        disableHoverListener={!isSelf}
                      >
                        <span>
                          <Switch
                            checked={u.is_active}
                            disabled={isSelf || toggleActiveMut.isPending}
                            onChange={(_, checked) =>
                              toggleActiveMut.mutate({ id: u.id, is_active: checked })
                            }
                            inputProps={{ 'aria-label': t('activeStateAria', { email: u.email }) }}
                          />
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>
                      {relativeTime(u.last_login_at, tRel, t('lastSignInNever'))}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        aria-label={t('actionsForUser', { email: u.email })}
                        onClick={(e) => setRowMenu({ anchor: e.currentTarget, user: u })}
                      >
                        <MoreVertOutlinedIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Row action menu */}
      <Menu
        anchorEl={rowMenu?.anchor ?? null}
        open={Boolean(rowMenu)}
        onClose={() => setRowMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          onClick={() => {
            if (rowMenu) setEditTarget(rowMenu.user);
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t('actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (rowMenu) setResetTarget(rowMenu.user);
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <LockResetOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t('actions.resetPassword')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (rowMenu) setRevokeTarget(rowMenu.user);
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <LogoutOutlinedIcon fontSize="small" />
          </ListItemIcon>
          {t('actions.revokeAllSessions')}
        </MenuItem>
        {/* SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick for
            customer admins who have lost their TOTP device AND every recovery
            code. Disabled on the current user (must use the password-stepped
            self flow at Settings → Security → Disable MFA) and on users who
            have no MFA enrolled (nothing to clear). */}
        {(() => {
          const target = rowMenu?.user;
          const isSelf = !!target && me?.id === target.id;
          const noMfa = !!target && !target.mfa_enabled;
          const disabled = isSelf || noMfa;
          const tip = isSelf
            ? 'You cannot force-disable your own MFA — use Settings → Security with your password.'
            : noMfa
              ? 'This user does not have MFA enabled.'
              : '';
          const item = (
            <MenuItem
              key="force-mfa-disable"
              disabled={disabled}
              onClick={() => {
                if (target) {
                  setForceMfaTarget(target);
                  setForceMfaReason('');
                }
                setRowMenu(null);
              }}
            >
              <ListItemIcon>
                <PhonelinkEraseOutlinedIcon fontSize="small" />
              </ListItemIcon>
              Force disable MFA
            </MenuItem>
          );
          return disabled ? (
            <Tooltip title={tip} placement="left">
              <span>{item}</span>
            </Tooltip>
          ) : (
            item
          );
        })()}
        {(() => {
          const target = rowMenu?.user;
          const isSelf = !!target && me?.id === target.id;
          const item = (
            <MenuItem
              key="delete"
              disabled={isSelf}
              onClick={() => {
                if (target) setDeleteTarget(target);
                setRowMenu(null);
              }}
              sx={{ color: isSelf ? undefined : 'error.main' }}
            >
              <ListItemIcon>
                <DeleteOutlineOutlinedIcon
                  fontSize="small"
                  color={isSelf ? 'inherit' : 'error'}
                />
              </ListItemIcon>
              {t('actions.delete')}
            </MenuItem>
          );
          return isSelf ? (
            <Tooltip title={t('selfDeleteTooltip')} placement="left">
              <span>{item}</span>
            </Tooltip>
          ) : (
            item
          );
        })()}
      </Menu>

      {/* Dialogs */}
      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <EditUserDialog
        open={Boolean(editTarget)}
        user={editTarget}
        onClose={() => setEditTarget(null)}
      />
      <ResetPasswordDialog
        open={Boolean(resetTarget)}
        user={resetTarget}
        onClose={() => setResetTarget(null)}
      />

      {/* Delete confirm */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => (deleteMut.isPending ? null : setDeleteTarget(null))}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('deleteDescription', { email: deleteTarget?.email ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteMut.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteMut.isPending}
            startIcon={
              deleteMut.isPending ? <CircularProgress size={16} color="inherit" /> : null
            }
            onClick={() => {
              if (deleteTarget) deleteMut.mutate(deleteTarget.id);
            }}
          >
            {t('actions.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Revoke sessions confirm */}
      <Dialog
        open={Boolean(revokeTarget)}
        onClose={() => (revokeMut.isPending ? null : setRevokeTarget(null))}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('revokeTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('revokeDescription', { email: revokeTarget?.email ?? '' })}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setRevokeTarget(null)} disabled={revokeMut.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button
            color="warning"
            variant="contained"
            disabled={revokeMut.isPending}
            startIcon={
              revokeMut.isPending ? <CircularProgress size={16} color="inherit" /> : null
            }
            onClick={() => {
              if (revokeTarget) revokeMut.mutate(revokeTarget.id);
            }}
          >
            {t('revokeConfirm')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* SVT-SEC-MFA-FORCE-DISABLE-2026-05 — Force-disable MFA confirm dialog.
          Reason field is required (backend enforces min 3 / max 500 chars,
          trimmed) and is persisted verbatim in the audit row for compliance
          review. Operator should reference a support ticket and how they
          verified the requester's identity. */}
      <Dialog
        open={Boolean(forceMfaTarget)}
        onClose={() => (forceMfaMut.isPending ? null : setForceMfaTarget(null))}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Force disable MFA</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            This clears all MFA secrets and recovery codes for{' '}
            <Box component="span" sx={{ fontWeight: 600 }}>
              {forceMfaTarget?.email ?? ''}
            </Box>{' '}
            and revokes all of their active sessions. Use only when the user has lost BOTH
            their authenticator device AND their recovery codes. Verify the requester&apos;s
            identity through your support process before proceeding.
          </DialogContentText>
          <TextField
            autoFocus
            label="Reason (required, audited)"
            placeholder="Customer lost TOTP + recovery codes; ticket SUP-1234; verified via signed billing-contact email"
            multiline
            minRows={3}
            fullWidth
            value={forceMfaReason}
            onChange={(e) => setForceMfaReason(e.target.value)}
            inputProps={{ maxLength: 500 }}
            helperText={`${forceMfaReason.trim().length}/500 — minimum 3 characters`}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            onClick={() => setForceMfaTarget(null)}
            disabled={forceMfaMut.isPending}
          >
            {tCommon('cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={
              forceMfaMut.isPending ||
              forceMfaReason.trim().length < 3 ||
              !forceMfaTarget
            }
            startIcon={
              forceMfaMut.isPending ? <CircularProgress size={16} color="inherit" /> : null
            }
            onClick={() => {
              if (forceMfaTarget) {
                forceMfaMut.mutate({
                  id: forceMfaTarget.id,
                  reason: forceMfaReason.trim(),
                });
              }
            }}
          >
            Force disable MFA
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
