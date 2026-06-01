'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, Chip, Stack, Tooltip, Typography } from '@mui/material';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ListPageShell from '@/components/ListPageShell';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import CreateConsentDialog from '@/features/privacy/CreateConsentDialog';

type LawfulBasis =
  | 'CONSENT'
  | 'CONTRACT'
  | 'LEGAL_OBLIGATION'
  | 'VITAL_INTEREST'
  | 'PUBLIC_TASK'
  | 'LEGITIMATE_INTEREST';

type ConsentRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  purpose: string;
  lawful_basis: LawfulBasis;
  granted: boolean;
  granted_at: string;
  revoked_at: string | null;
};

const BASIS_COLOR: Record<LawfulBasis, 'primary' | 'secondary' | 'success' | 'warning' | 'info' | 'default'> = {
  CONSENT: 'primary',
  CONTRACT: 'secondary',
  LEGAL_OBLIGATION: 'warning',
  VITAL_INTEREST: 'info',
  PUBLIC_TASK: 'default',
  LEGITIMATE_INTEREST: 'success',
};

function basisLabel(b: LawfulBasis): string {
  return b
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export default function ConsentsPage() {
  const { user } = useAuth();
  const admin = isAdmin(user?.role ?? null);

  const [createOpen, setCreateOpen] = useState(false);

  // Self filter for non-admins: backend allows non-admins to operate on
  // (subject_type = 'user', subject_id = own user id) only. Apply that filter
  // here so the list query succeeds with 200 instead of 403.
  const listQuery = useQuery<ConsentRow[]>({
    queryKey: ['consents', { admin, sub: user?.id }],
    queryFn: async ({ signal }) => {
      const params: Record<string, unknown> = { limit: 100 };
      if (!admin && user?.id) {
        params['subject_type'] = 'user';
        params['subject_id'] = user.id;
      }
      // Backend may return either the bare array (legacy) or `{ data: [...] }`
      // (current envelope). Tolerate both so older deployments still work.
      const res = await api.get<ConsentRow[] | { data: ConsentRow[] }>('/consents', {
        params,
        signal,
      });
      if (Array.isArray(res.data)) return res.data;
      return Array.isArray(res.data?.data) ? res.data.data : [];
    },
    enabled: Boolean(user),
  });

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const columns: DataTableColumn<ConsentRow>[] = useMemo(
    () => [
      {
        key: 'subject',
        label: 'Subject',
        render: (r) => (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="small" label={r.subject_type} variant="outlined" />
            {r.subject_type === 'student' ? (
              <Link
                href={`/students/${r.subject_id}`}
                style={{
                  color: 'inherit',
                  textDecoration: 'underline dotted',
                  fontFamily: 'monospace',
                  fontSize: 12,
                }}
              >
                {r.subject_id.slice(0, 8)}…
              </Link>
            ) : (
              <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                {r.subject_id.slice(0, 8)}…
              </Typography>
            )}
          </Stack>
        ),
      },
      {
        key: 'purpose',
        label: 'Purpose',
        render: (r) => <Typography variant="body2">{r.purpose}</Typography>,
      },
      {
        key: 'lawful_basis',
        label: 'Lawful basis',
        render: (r) => (
          <Chip size="small" label={basisLabel(r.lawful_basis)} color={BASIS_COLOR[r.lawful_basis]} />
        ),
      },
      {
        key: 'granted',
        label: 'Granted',
        render: (r) =>
          r.granted ? (
            <Chip size="small" label="Yes" color="success" />
          ) : (
            <Chip size="small" label="No" color="default" variant="outlined" />
          ),
      },
      {
        key: 'granted_at',
        label: 'Granted at',
        render: (r) => (
          <Tooltip title={formatDateTime(r.granted_at)}>
            <Typography component="span" variant="body2" color="text.secondary">
              {formatRelative(r.granted_at)}
            </Typography>
          </Tooltip>
        ),
      },
      {
        key: 'revoked_at',
        label: 'Revoked at',
        render: (r) => (
          <Typography component="span" variant="body2" color="text.secondary">
            {r.revoked_at ? formatDateTime(r.revoked_at) : '—'}
          </Typography>
        ),
        hideOnMobile: true,
      },
    ],
    [],
  );

  return (
    <ListPageShell
      title="Consent records"
      description="Article 6 / 7 evidence trail for processing personal data."
      action={
        admin ? (
          <Button
            variant="contained"
            startIcon={<AddOutlinedIcon />}
            onClick={() => setCreateOpen(true)}
          >
            Record consent
          </Button>
        ) : null
      }
      bareContent
    >
      {listQuery.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQuery.isError ? (
        <ErrorState
          title="Couldn’t load consent records"
          description={
            listQuery.error instanceof ApiError
              ? listQuery.error.detail || listQuery.error.title
              : 'Please try again.'
          }
          onRetry={() => listQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FactCheckOutlinedIcon fontSize="medium" />}
          title="No consent records"
          description={
            admin
              ? 'Record subject consent or another lawful basis to start the audit trail.'
              : 'No consent records have been logged for your account yet.'
          }
          actions={
            admin ? (
              <Button
                variant="contained"
                startIcon={<AddOutlinedIcon />}
                onClick={() => setCreateOpen(true)}
              >
                Record consent
              </Button>
            ) : null
          }
        />
      ) : (
        <DataTable<ConsentRow> columns={columns} rows={rows} getRowId={(r) => r.id} />
      )}

      <CreateConsentDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </ListPageShell>
  );
}
