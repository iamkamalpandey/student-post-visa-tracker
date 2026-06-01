'use client';

import { type ReactNode, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
} from '@mui/material';
import EmptyState from './EmptyState';

export type DataTableColumn<R> = {
  /** Unique column key — used as React key and for aria attributes. */
  key: string;
  label: ReactNode;
  /** Renders the cell contents. Receives the row and its index. */
  render: (row: R, index: number) => ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  /** Hide on small screens. */
  hideOnMobile?: boolean;
};

export type DataTableProps<R> = {
  columns: DataTableColumn<R>[];
  rows: R[];
  /** Total number of rows on the server (for paginated lists). Defaults to rows.length. */
  rowCount?: number;
  loading?: boolean;
  /** Stable identifier for each row, used as React key. */
  getRowId?: (row: R, index: number) => string | number;
  /** Click target for an entire row — string href, or imperative callback. */
  onRowClick?: ((row: R) => void) | ((row: R) => string);
  /** Customisable empty-state. */
  emptyTitle?: string;
  emptyDescription?: string;

  // Pagination -------------------------------------------------------------
  page?: number;
  pageSize?: number;
  rowsPerPageOptions?: number[];
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;

  /** Accessible name for the rendered <Table>. Defaults to "Data table". */
  ariaLabel?: string;
};

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

/**
 * Thin wrapper over MUI Table providing loading skeletons, an empty-state, an
 * optional sticky header, and built-in pagination via TablePagination.
 *
 * No new dependencies — pure MUI primitives. Intended as the single list-view
 * primitive for Students / Users / Institutions / Programs / etc.
 */
export default function DataTable<R>({
  columns,
  rows,
  rowCount,
  loading = false,
  getRowId,
  onRowClick,
  emptyTitle = 'Nothing to show',
  emptyDescription = 'No records match the current filters.',
  page = 0,
  pageSize = 25,
  rowsPerPageOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  ariaLabel = 'Data table',
}: DataTableProps<R>) {
  const router = useRouter();
  const total = rowCount ?? rows.length;
  const showPagination =
    Boolean(onPageChange || onPageSizeChange) || total > pageSize;

  const skeletonRowCount = useMemo(() => Math.min(pageSize || 5, 8), [pageSize]);

  function handleRowClick(row: R): void {
    if (!onRowClick) return;
    const result = (onRowClick as (r: R) => unknown)(row);
    if (isString(result)) router.push(result);
  }

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', borderRadius: 2 }}>
      <TableContainer sx={{ maxHeight: { md: 'calc(100vh - 280px)' } }}>
        <Table stickyHeader size="small" aria-label={ariaLabel}>
          <TableHead>
            <TableRow
              sx={{
                '& .MuiTableCell-head': {
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                  borderTop: (t) => `1px solid ${t.palette.divider}`,
                  borderBottom: (t) => `1px solid ${t.palette.divider}`,
                  bgcolor: (t) => t.palette.action.hover,
                },
              }}
            >
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  align={c.align ?? 'left'}
                  sx={{
                    width: c.width,
                    whiteSpace: 'nowrap',
                    display: c.hideOnMobile ? { xs: 'none', md: 'table-cell' } : undefined,
                  }}
                >
                  {c.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              Array.from({ length: skeletonRowCount }).map((_, r) => (
                <TableRow key={`s-${r}`}>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      align={c.align ?? 'left'}
                      sx={{
                        display: c.hideOnMobile ? { xs: 'none', md: 'table-cell' } : undefined,
                      }}
                    >
                      <Skeleton variant="text" width={c.width ? undefined : '70%'} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} sx={{ borderBottom: 0, p: 0 }}>
                  <Box sx={{ p: 2 }}>
                    <EmptyState title={emptyTitle} description={emptyDescription} />
                  </Box>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => {
                const id = getRowId ? getRowId(row, index) : index;
                const clickable = Boolean(onRowClick);
                return (
                  <TableRow
                    key={id}
                    hover={clickable}
                    onClick={clickable ? () => handleRowClick(row) : undefined}
                    sx={{
                      cursor: clickable ? 'pointer' : 'default',
                    }}
                  >
                    {columns.map((c) => (
                      <TableCell
                        key={c.key}
                        align={c.align ?? 'left'}
                        sx={{
                          width: c.width,
                          display: c.hideOnMobile
                            ? { xs: 'none', md: 'table-cell' }
                            : undefined,
                        }}
                      >
                        {c.render(row, index)}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {showPagination ? (
        <TablePagination
          component="div"
          count={total}
          page={page}
          rowsPerPage={pageSize}
          onPageChange={(_, p) => onPageChange?.(p)}
          onRowsPerPageChange={(e) => onPageSizeChange?.(parseInt(e.target.value, 10))}
          rowsPerPageOptions={rowsPerPageOptions}
        />
      ) : null}
    </Paper>
  );
}
