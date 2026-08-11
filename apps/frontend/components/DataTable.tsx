'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
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

  // SVT-UX-2026-08 — pagination is now REAL in both modes.
  //
  // The footer used to render whenever `total > pageSize`, but the handler was
  // `onPageChange?.(p)` — an optional call. 26 of 31 call sites pass no
  // handler, so those tables showed a fully styled pager, reported an accurate
  // "1–25 of 340", and did precisely nothing when clicked. Users could not
  // reach row 26 of any of them.
  //
  // Rather than patch 26 call sites, the component now owns pagination when the
  // caller does not:
  //
  //   controlled   — caller passes onPageChange (server-side paging). Caller
  //                  supplies one page of rows and the true `rowCount`.
  //                  Behaviour is unchanged.
  //   uncontrolled — caller passes the full row set and no handler. We hold the
  //                  page state and slice locally.
  //
  // The footer can therefore never again be decorative: either the caller
  // handles the change, or we do.
  const [internalPage, setInternalPage] = useState(0);
  const [internalPageSize, setInternalPageSize] = useState(pageSize);

  const paginationControlled = Boolean(onPageChange);
  const activePageSize = paginationControlled ? pageSize : internalPageSize;
  const total = rowCount ?? rows.length;
  const lastPage = Math.max(0, Math.ceil(total / activePageSize) - 1);
  // Clamp rather than trust: a filter that shrinks the result set below the
  // current page would otherwise leave MUI on an out-of-range page showing a
  // blank body.
  const activePage = Math.min(paginationControlled ? page : internalPage, lastPage);

  useEffect(() => {
    if (!paginationControlled && internalPage > lastPage) setInternalPage(lastPage);
  }, [paginationControlled, internalPage, lastPage]);

  const pageOffset = activePage * activePageSize;
  const visibleRows = paginationControlled
    ? rows
    : rows.slice(pageOffset, pageOffset + activePageSize);

  const showPagination =
    paginationControlled || Boolean(onPageSizeChange) || total > activePageSize;

  const skeletonRowCount = useMemo(
    () => Math.min(activePageSize || 5, 8),
    [activePageSize],
  );

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
                  // OPAQUE bg: a sticky header over a translucent color (action.hover)
                  // lets scrolled rows bleed through it. Solid grey fixes that.
                  bgcolor: (t) => (t.palette.mode === 'light' ? t.palette.grey[100] : t.palette.grey[900]),
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
              visibleRows.map((row, rowIndex) => {
                // Index within the whole result set, not within the visible
                // slice — so a column that renders a row number keeps counting
                // across pages instead of restarting at 1 on every page.
                const index = pageOffset + rowIndex;
                const id = getRowId ? getRowId(row, index) : index;
                const clickable = Boolean(onRowClick);
                return (
                  <TableRow
                    key={id}
                    hover={clickable}
                    onClick={clickable ? () => handleRowClick(row) : undefined}
                    // SVT-A11Y-2026-06 (WCAG 2.1.1) — a mouse-only clickable row
                    // is unreachable by keyboard/AT users, blocking the primary
                    // navigation path on list pages. Make it focusable + operable
                    // with Enter/Space (mirrors NotificationsBell's cards).
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleRowClick(row);
                            }
                          }
                        : undefined
                    }
                    // SVT-A11Y-2026-08 — role="button" deliberately NOT set here.
                    // ARIA 1.2 defines `button` as Children Presentational: True,
                    // so putting it on a <tr> removes the row from the table
                    // structure AND strips the semantics of every <td> inside it.
                    // Across 35 DataTable instances the grids announced as a flat
                    // list of unlabelled buttons — no "row 5 of 20", no column
                    // header association, no cell-by-cell navigation. The earlier
                    // change correctly fixed a 2.1.1 keyboard trap but traded it
                    // for a 1.3.1 failure. tabIndex + the keydown handler above
                    // keep the row operable by keyboard while it stays a row.
                    tabIndex={clickable ? 0 : undefined}
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
          page={activePage}
          rowsPerPage={activePageSize}
          onPageChange={(_, p) => {
            if (onPageChange) onPageChange(p);
            else setInternalPage(p);
          }}
          onRowsPerPageChange={(e) => {
            const size = parseInt(e.target.value, 10);
            onPageSizeChange?.(size);
            if (!paginationControlled) {
              setInternalPageSize(size);
              setInternalPage(0);
            }
          }}
          rowsPerPageOptions={rowsPerPageOptions}
        />
      ) : null}
    </Paper>
  );
}
