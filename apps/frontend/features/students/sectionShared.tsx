'use client';

// Shared building-blocks reused by all student detail nested-resource sections
// (Identifications, Visas, RegulatorIds, Contacts, …). Keeps each section file
// short and consistent.

import { type ReactNode, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useAuth } from '@/lib/auth';
import { canWriteStudents } from '@/lib/auth-helpers';
import { ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';

/** Returns true when the current user is allowed to mutate student-scoped data. */
export function useCanWrite(): boolean {
  const { user } = useAuth();
  return canWriteStudents(user?.role);
}

export type SectionHeaderProps = {
  title: string;
  description?: string;
  onAdd?: () => void;
  addLabel?: string;
  /** Disables / hides the Add button regardless of role. */
  canAdd?: boolean;
};

/**
 * A compact heading for one of the detail-tab sub-sections, with an optional
 * "Add …" button on the right. The button is hidden entirely when the caller
 * sets `canAdd={false}` (e.g. VIEWER role).
 */
export function SectionHeader({
  title,
  description,
  onAdd,
  addLabel = 'Add',
  canAdd = true,
}: SectionHeaderProps) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      alignItems={{ xs: 'flex-start', sm: 'center' }}
      justifyContent="space-between"
      sx={{ mb: 1.5 }}
    >
      <Stack spacing={0.25}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        ) : null}
      </Stack>
      {onAdd && canAdd ? (
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={onAdd}
        >
          {addLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

export type RowActionsProps = {
  onEdit?: () => void;
  onDelete?: () => void;
  canWrite: boolean;
};

/** Inline edit / delete icon-buttons rendered in the trailing cell of each row. */
export function RowActions({ onEdit, onDelete, canWrite }: RowActionsProps) {
  if (!canWrite) return <span aria-hidden>—</span>;
  return (
    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
      {onEdit ? (
        <Tooltip title="Edit">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
      {onDelete ? (
        <Tooltip title="Delete">
          <IconButton
            size="small"
            color="error"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
    </Stack>
  );
}

export type FormDialogProps = {
  open: boolean;
  title: string;
  /** Form id — pair with the inner <form> so the dialog footer can submit it. */
  formId: string;
  isSubmitting?: boolean;
  errorText?: string | null;
  submitLabel?: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Reusable Dialog scaffold for create/edit forms. Caller renders the actual
 * <form id={formId} onSubmit=…> inside `children`; the dialog footer submits it
 * via the matching `form` attribute.
 *
 * Thin wrapper over the canonical `AppDialog` so every section dialog inherits
 * the same title weight, divider, padding and button styling as the rest of
 * the app.
 */
export function FormDialog({
  open,
  title,
  formId,
  isSubmitting,
  errorText,
  submitLabel = 'Save',
  onClose,
  children,
}: FormDialogProps) {
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={title}
      maxWidth="md"
      errorText={errorText ?? null}
      primaryAction={{
        label: submitLabel,
        loadingLabel: 'Saving…',
        loading: isSubmitting,
        formId,
      }}
    >
      {children}
    </AppDialog>
  );
}

/**
 * `axios` REST helpers shaped to match the SPV response convention:
 * - Nested-resource list endpoints often return a bare array (no envelope).
 * - Collection endpoints like `/institutions` return `{ data, page }`.
 *
 * Callers normalise via this helper rather than sprinkling `?.data?.data`
 * everywhere.
 */
export function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    const inner = (payload as { data: unknown }).data;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/** Hook helper that holds dialog state for both create and edit flows. */
export function useDialogState<T = unknown>() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  return {
    open,
    editing,
    openCreate: () => {
      setEditing(null);
      setOpen(true);
    },
    openEdit: (row: T) => {
      setEditing(row);
      setOpen(true);
    },
    close: () => {
      setOpen(false);
      setEditing(null);
    },
  };
}

/** Best-effort masking of free-text document numbers for display. */
export function maskDocNumber(value: string | null | undefined): string {
  if (!value) return '—';
  const v = value.toString();
  if (v.length <= 4) return '••••';
  return `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}

/** Strip empty strings / nulls from a record before submitting to the API. */
export function compactPayload<T extends Record<string, unknown>>(payload: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === '' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// Inline state helpers (loading / error / empty) for nested-resource sections.
// These are intentionally smaller than the page-level <EmptyState>/<ErrorState>
// primitives so they fit inside a tab without dwarfing the rest of the layout.
// ---------------------------------------------------------------------------

/** A handful of stacked Skeleton bars — used while a section's list is loading. */
export function SectionLoading({ rows = 3 }: { rows?: number }) {
  return (
    <Stack spacing={1} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="rectangular" height={36} sx={{ borderRadius: 1 }} />
      ))}
    </Stack>
  );
}

export type SectionErrorProps = {
  /** Resource label, e.g. "visas". Rendered in the default copy. */
  resource?: string;
  error?: unknown;
  onRetry?: () => void;
};

/** Compact inline error block with a retry button. */
export function SectionError({ resource, error, onRetry }: SectionErrorProps) {
  const detail =
    error instanceof ApiError ? error.detail || error.title : null;
  return (
    <Alert
      severity="error"
      variant="outlined"
      action={
        onRetry ? (
          <Button
            size="small"
            color="inherit"
            startIcon={<RefreshOutlinedIcon fontSize="small" />}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : undefined
      }
      role="alert"
      aria-live="assertive"
    >
      {detail || `Could not load ${resource ?? 'this section'}.`}
    </Alert>
  );
}

export type SectionEmptyProps = {
  /** Singular resource label, e.g. "visa", "qualification". */
  resource: string;
  /** Render an "Add" button when the user can write. */
  onAdd?: () => void;
  addLabel?: string;
  canAdd?: boolean;
};

/**
 * Single-line muted "No <resource> recorded yet." with an optional small Add
 * button. Designed to sit inline inside a tab section without taking the
 * vertical real-estate that the full <EmptyState> would.
 */
export function SectionEmpty({
  resource,
  onAdd,
  addLabel = 'Add',
  canAdd = true,
}: SectionEmptyProps) {
  return (
    <Box
      sx={{
        py: 2.5,
        px: 2,
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        gap: 1.5,
        alignItems: { xs: 'flex-start', sm: 'center' },
        justifyContent: 'space-between',
        borderRadius: 2,
        border: (t) => `1px dashed ${t.palette.divider}`,
        bgcolor: 'background.paper',
      }}
      role="status"
    >
      <Typography variant="body2" color="text.secondary">
        No {resource} recorded yet.
      </Typography>
      {onAdd && canAdd ? (
        <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={onAdd}>
          {addLabel}
        </Button>
      ) : null}
    </Box>
  );
}

export type SectionStatesProps<T> = {
  query: {
    isLoading: boolean;
    isError: boolean;
    error?: unknown;
    refetch: () => void;
    data?: T[] | undefined;
  };
  resource: string;
  /** Optional Add button wiring for the empty state. */
  onAdd?: () => void;
  addLabel?: string;
  canAdd?: boolean;
  /** Render the list when data is non-empty. */
  children: (rows: T[]) => ReactNode;
  /** Skeleton row count (defaults to 3). */
  loadingRows?: number;
};

/**
 * Drop-in wrapper that handles loading / error / empty for a section's list
 * query and renders the supplied content when data exists.
 */
export function SectionStates<T>({
  query,
  resource,
  onAdd,
  addLabel,
  canAdd,
  children,
  loadingRows = 3,
}: SectionStatesProps<T>) {
  if (query.isLoading) return <SectionLoading rows={loadingRows} />;
  if (query.isError) {
    return (
      <SectionError
        resource={resource}
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );
  }
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return (
      <SectionEmpty
        resource={resource}
        onAdd={onAdd}
        addLabel={addLabel}
        canAdd={canAdd}
      />
    );
  }
  return <>{children(rows)}</>;
}
