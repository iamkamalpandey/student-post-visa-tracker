'use client';

// DocumentsSection
// ---------------------------------------------------------------------------
// The Records-tab "Documents" sub-section. Renders the student's documents in
// a DataTable with:
//   - file_name (clickable → triggers an authenticated blob download)
//   - document_type label chip (resolved via /lookups/document-types)
//   - size_bytes (formatted)
//   - issued_on / expires_on (warning chip when within 30 days)
//   - av_status chip with severity colors
//   - verification chip + admin quick actions (Verify / Reject)
//   - sha256 chip (truncated, full hash in tooltip)
//   - uploaded_at (relative)
//   - actions menu (Verify / Delete for admins)
//
// Download flow:
//   1. GET /documents/:id/download → { url, expiresAt, sha256 }
//   2. axios.get(url, responseType: 'blob') with Bearer token still applied
//   3. Read Content-Disposition → filenameFromDisposition() → trigger blob save
//
// All admin-only buttons are gated by useAuth().user.role === 'ADMIN'. The
// VIEWER role hides Upload + actions entirely (canWriteStudents check).

import { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canWriteStudents, isAdmin } from '@/lib/auth-helpers';
import { useDocumentTypes } from '@/lib/queries';
import { formatBytes, formatDate, useFormat } from '@/lib/format';
import { filenameFromDisposition } from '@/lib/download';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import { SectionHeader, SectionStates } from '../sectionShared';
import UploadDocumentDialog from './UploadDocumentDialog';
import VerifyDocumentDialog from './VerifyDocumentDialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
type Verification = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

type DocumentRow = {
  id: string;
  student_id: string;
  document_type_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  av_status: AvStatus;
  av_scanned_at?: string | null;
  issued_on?: string | null;
  expires_on?: string | null;
  verification: Verification;
  verified_at?: string | null;
  verified_by_id?: string | null;
  retention_until?: string | null;
  created_at: string;
  created_by_id: string;
  deleted_at?: string | null;
};

type DocumentTypeRow = { id: string; key: string; label: string; category?: string | null };

type DownloadEnvelope = {
  url: string;
  expiresAt: string;
  sha256: string;
  mime_type?: string;
  file_name?: string;
  size_bytes?: number;
};

type ListResponse = { items: DocumentRow[]; next_cursor?: string | null };

// ---------------------------------------------------------------------------
// Chip helpers
// ---------------------------------------------------------------------------

const AV_COLOR: Record<AvStatus, 'default' | 'success' | 'error' | 'warning'> = {
  PENDING: 'default',
  CLEAN: 'success',
  INFECTED: 'error',
  // MUI doesn't ship an "orange" Chip color out of the box; warning is the
  // closest semantic match for an AV scanner failure.
  ERROR: 'warning',
};

const VERIFICATION_COLOR: Record<Verification, 'default' | 'success' | 'error' | 'warning'> = {
  PENDING: 'default',
  VERIFIED: 'success',
  REJECTED: 'error',
  EXPIRED: 'warning',
};

const EXPIRY_WARN_DAYS = 30;

function isExpiringSoon(iso?: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const diffDays = (t - Date.now()) / (24 * 60 * 60 * 1000);
  return diffDays >= 0 && diffDays <= EXPIRY_WARN_DAYS;
}

function isExpired(iso?: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

// ---------------------------------------------------------------------------
// DocumentsSection
// ---------------------------------------------------------------------------

export type DocumentsSectionProps = { studentId: string };

export default function DocumentsSection({ studentId }: DocumentsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const fmt = useFormat();
  const admin = isAdmin(user?.role);
  const canWrite = canWriteStudents(user?.role);

  const queryKey = useMemo(() => ['students', studentId, 'documents'], [studentId]);

  const listQuery = useQuery<DocumentRow[], ApiError>({
    queryKey,
    queryFn: async () => {
      const res = await api.get<ListResponse>(`/students/${studentId}/documents`);
      return res.data?.items ?? [];
    },
  });

  const docTypesQuery = useDocumentTypes();
  const docTypeMap = useMemo(() => {
    const map = new Map<string, DocumentTypeRow>();
    for (const t of (docTypesQuery.data as unknown as DocumentTypeRow[] | undefined) ?? []) {
      map.set(t.id, t);
    }
    return map;
  }, [docTypesQuery.data]);

  // Dialog state -----------------------------------------------------------
  const [uploadOpen, setUploadOpen] = useState(false);
  const [verifyDoc, setVerifyDoc] = useState<DocumentRow | null>(null);
  const [deleteDoc, setDeleteDoc] = useState<DocumentRow | null>(null);

  // Per-row "downloading" guard so we can show feedback and prevent double-clicks.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleDownload(row: DocumentRow): Promise<void> {
    if (row.av_status !== 'CLEAN') {
      enqueueSnackbar('Download blocked — file is not marked CLEAN.', {
        variant: 'warning',
      });
      return;
    }
    setDownloadingId(row.id);
    try {
      // 1. Mint a single-use signed URL.
      const mint = await api.get<DownloadEnvelope>(`/documents/${row.id}/download`);
      const envelope = mint.data;

      // The backend hands us an absolute path that already includes /api/v1
      // (the same prefix as our axios baseURL). Strip the duplicated prefix
      // so axios concatenates correctly. Fall back to the raw URL if the
      // shape ever changes.
      const baseURL = api.defaults.baseURL ?? '';
      let relative = envelope.url;
      try {
        const baseIsAbsolute = /^https?:\/\//i.test(baseURL);
        if (baseIsAbsolute) {
          const basePath = new URL(baseURL).pathname.replace(/\/$/, '');
          if (basePath && relative.startsWith(basePath + '/')) {
            relative = relative.slice(basePath.length);
          }
        } else if (baseURL && relative.startsWith(baseURL)) {
          relative = relative.slice(baseURL.length);
        }
      } catch {
        /* leave relative as-is */
      }

      // 2. Fetch the stream — Bearer header is auto-attached by the axios
      //    interceptor. Read the Content-Disposition header to derive the
      //    filename the user sees in the save dialog.
      const streamRes = await api.get(relative, { responseType: 'blob' });
      const disposition =
        (streamRes.headers as Record<string, string | undefined>)['content-disposition'] ??
        (streamRes.headers as Record<string, string | undefined>)['Content-Disposition'];
      const filename = filenameFromDisposition(disposition, row.file_name);

      const blob =
        streamRes.data instanceof Blob
          ? streamRes.data
          : new Blob([streamRes.data as unknown as BlobPart]);
      const objectUrl = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    } catch (err) {
      // The api error type carries title/detail; everything else falls back to
      // the generic downloadAuthed contract.
      const detail =
        err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(detail, { variant: 'error' });
    } finally {
      setDownloadingId(null);
    }
  }

  const verifyMutation = useMutation<
    unknown,
    ApiError,
    { id: string; verification: 'VERIFIED' | 'REJECTED' | 'EXPIRED' }
  >({
    mutationFn: async ({ id, verification }) => {
      const res = await api.patch(`/documents/${id}/verification`, { verification });
      return res.data;
    },
    onSuccess: (_d, vars) => {
      enqueueSnackbar(
        vars.verification === 'VERIFIED'
          ? 'Document verified'
          : vars.verification === 'REJECTED'
            ? 'Document rejected'
            : 'Document marked expired',
        { variant: 'success' },
      );
      qc.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || 'Update failed', { variant: 'error' }),
  });

  const deleteMutation = useMutation<unknown, ApiError, DocumentRow>({
    mutationFn: async (row) => {
      const res = await api.delete(`/documents/${row.id}`);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Document deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      setDeleteDoc(null);
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || 'Delete failed', { variant: 'error' }),
  });

  // -----------------------------------------------------------------------
  // Columns
  // -----------------------------------------------------------------------

  const columns: DataTableColumn<DocumentRow>[] = [
    {
      key: 'file_name',
      label: 'File',
      render: (r) => {
        const blocked = r.av_status === 'INFECTED';
        return (
          <Stack spacing={0.25}>
            <Link
              component="button"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (blocked || downloadingId === r.id) return;
                void handleDownload(r);
              }}
              underline="hover"
              sx={{
                textAlign: 'left',
                fontWeight: 500,
                color: blocked ? 'text.disabled' : 'primary.main',
                cursor: blocked ? 'not-allowed' : 'pointer',
                background: 'none',
                border: 0,
                p: 0,
              }}
            >
              {r.file_name}
            </Link>
            <Tooltip title={r.sha256}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: 'monospace', cursor: 'help' }}
              >
                sha256:{r.sha256.slice(0, 8)}
              </Typography>
            </Tooltip>
          </Stack>
        );
      },
    },
    {
      key: 'type',
      label: 'Type',
      render: (r) => {
        const t = docTypeMap.get(r.document_type_id);
        return (
          <Chip
            size="small"
            variant="outlined"
            label={t?.label ?? r.document_type_id.slice(0, 8)}
          />
        );
      },
    },
    {
      key: 'size',
      label: 'Size',
      align: 'right',
      render: (r) => formatBytes(r.size_bytes),
      hideOnMobile: true,
    },
    {
      key: 'issued',
      label: 'Issued',
      hideOnMobile: true,
      render: (r) => (r.issued_on ? formatDate(r.issued_on) : '—'),
    },
    {
      key: 'expires',
      label: 'Expires',
      render: (r) => {
        if (!r.expires_on) return '—';
        const expired = isExpired(r.expires_on);
        const soon = !expired && isExpiringSoon(r.expires_on);
        return (
          <Stack direction="row" spacing={0.75} alignItems="center">
            <span>{formatDate(r.expires_on)}</span>
            {expired ? (
              <Chip size="small" color="error" label="Expired" />
            ) : soon ? (
              <Chip size="small" color="warning" label="Soon" />
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: 'av',
      label: 'AV',
      render: (r) => (
        <Chip
          size="small"
          color={AV_COLOR[r.av_status]}
          label={r.av_status}
          variant={r.av_status === 'PENDING' ? 'outlined' : 'filled'}
        />
      ),
    },
    {
      key: 'verification',
      label: 'Verification',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Chip
            size="small"
            color={VERIFICATION_COLOR[r.verification]}
            label={r.verification}
            variant={r.verification === 'PENDING' ? 'outlined' : 'filled'}
          />
          {admin && r.verification === 'PENDING' ? (
            <>
              <Tooltip title="Verify">
                <IconButton
                  aria-label="Verify"
                  size="small"
                  color="success"
                  onClick={(e) => {
                    e.stopPropagation();
                    verifyMutation.mutate({ id: r.id, verification: 'VERIFIED' });
                  }}
                  disabled={verifyMutation.isPending}
                >
                  <VerifiedOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Reject">
                <IconButton
                  aria-label="Reject"
                  size="small"
                  color="error"
                  onClick={(e) => {
                    e.stopPropagation();
                    verifyMutation.mutate({ id: r.id, verification: 'REJECTED' });
                  }}
                  disabled={verifyMutation.isPending}
                >
                  <BlockOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'uploaded',
      label: 'Uploaded',
      hideOnMobile: true,
      render: (r) => (
        <Tooltip title={fmt.dateTime(r.created_at)}>
          <span>{fmt.relative(r.created_at)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) =>
        canWrite ? (
          <RowMenu
            isAdmin={admin}
            blockedDownload={r.av_status === 'INFECTED'}
            downloading={downloadingId === r.id}
            onDownload={() => void handleDownload(r)}
            onVerify={() => setVerifyDoc(r)}
            onDelete={() => setDeleteDoc(r)}
          />
        ) : (
          <span aria-hidden>—</span>
        ),
    },
  ];

  return (
    <Box>
      <SectionHeader
        title="Documents"
        description="Identification, transcripts, financial proofs, and other student documents."
        onAdd={() => setUploadOpen(true)}
        addLabel="Upload document"
        canAdd={canWrite}
      />

      <SectionStates
        query={listQuery}
        resource="documents"
        onAdd={() => setUploadOpen(true)}
        addLabel="Upload document"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>

      {/* Upload */}
      <UploadDocumentDialog
        open={uploadOpen}
        studentId={studentId}
        onClose={() => setUploadOpen(false)}
      />

      {/* Verify (admin only — dialog body itself is harmless if rendered) */}
      <VerifyDocumentDialog
        open={Boolean(verifyDoc) && admin}
        studentId={studentId}
        documentId={verifyDoc?.id ?? null}
        initialVerification={verifyDoc?.verification ?? null}
        onClose={() => setVerifyDoc(null)}
      />

      {/* Soft-delete confirm */}
      <ConfirmDialog
        open={Boolean(deleteDoc) && admin}
        title="Delete document?"
        description={
          deleteDoc ? (
            <span>
              This soft-deletes <strong>{deleteDoc.file_name}</strong>. The underlying object stays
              in storage but the row is hidden from this list.
            </span>
          ) : null
        }
        confirmText="Delete"
        loading={deleteMutation.isPending}
        errorText={deleteMutation.error?.detail ?? null}
        onClose={() => setDeleteDoc(null)}
        onConfirm={() => {
          if (deleteDoc) deleteMutation.mutate(deleteDoc);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Per-row overflow menu (Download · Verify · Delete)
// ---------------------------------------------------------------------------

function RowMenu({
  isAdmin: admin,
  blockedDownload,
  downloading,
  onDownload,
  onVerify,
  onDelete,
}: {
  isAdmin: boolean;
  blockedDownload: boolean;
  downloading: boolean;
  onDownload: () => void;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);

  return (
    <>
      <Tooltip title="Actions">
        <IconButton
          aria-label="Actions"
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            setAnchor(e.currentTarget);
          }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        MenuListProps={{ dense: true }}
      >
        <MenuItem
          disabled={blockedDownload || downloading}
          onClick={() => {
            setAnchor(null);
            onDownload();
          }}
        >
          <ListItemIcon>
            <DownloadOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={blockedDownload ? 'Download blocked (infected)' : 'Download'}
          />
        </MenuItem>
        {admin ? (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onVerify();
            }}
          >
            <ListItemIcon>
              <VerifiedOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Verify…" />
          </MenuItem>
        ) : null}
        {admin ? (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onDelete();
            }}
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText primary="Delete" sx={{ color: 'error.main' }} />
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}
