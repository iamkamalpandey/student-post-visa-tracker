// SVT-UX-2026-08 — pagination must never be decorative again.
//
// DataTable rendered a fully styled TablePagination footer whenever
// `total > pageSize`, but its handler was the optional call
// `onPageChange?.(p)`. 26 of 31 call sites pass no handler, so those tables
// advertised an accurate "1–25 of 340" and did nothing at all when clicked —
// row 26 was unreachable on every one of them.
//
// The component now owns pagination when the caller does not. These tests pin
// both modes, because the failure was invisible: the footer looked correct, so
// only clicking it revealed the bug.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const DataTable = (await import('../components/DataTable')).default;

afterEach(() => cleanup());

type Row = { id: number; name: string };

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }));

const columns = [
  { key: 'name', label: 'Name', render: (r: Row) => r.name },
];

const bodyText = () => {
  const table = screen.getByRole('table');
  return table.querySelector('tbody')!.textContent ?? '';
};

describe('DataTable — uncontrolled pagination (no onPageChange)', () => {
  it('renders only the first page of a large row set', () => {
    render(<DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />);
    expect(bodyText()).toContain('Row 1');
    expect(bodyText()).toContain('Row 25');
    expect(bodyText()).not.toContain('Row 26');
  });

  it('actually advances to page 2 when the next-page button is clicked', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />);

    await user.click(screen.getByRole('button', { name: /next page/i }));

    // This is the assertion the old implementation could never satisfy.
    expect(bodyText()).toContain('Row 26');
    expect(bodyText()).not.toContain('Row 25');
  });

  it('reports the true total, not just the visible slice', () => {
    render(<DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />);
    expect(screen.getByText(/1–25 of 60/)).toBeTruthy();
  });

  it('walks to the final page and shows the remainder rows', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />);
    const next = screen.getByRole('button', { name: /next page/i });
    await user.click(next);
    await user.click(next);
    expect(bodyText()).toContain('Row 51');
    expect(bodyText()).toContain('Row 60');
    expect(screen.getByText(/51–60 of 60/)).toBeTruthy();
  });

  it('changing rows-per-page re-slices and returns to the first page', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />);
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(bodyText()).toContain('Row 26');

    await user.click(screen.getByRole('combobox'));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: '10' }));

    expect(bodyText()).toContain('Row 1');
    expect(bodyText()).not.toContain('Row 11');
  });

  it('hides the footer when everything fits on one page', () => {
    render(<DataTable columns={columns} rows={rows(5)} getRowId={(r) => r.id} />);
    expect(screen.queryByRole('button', { name: /next page/i })).toBeNull();
  });
});

describe('DataTable — controlled pagination (server-side)', () => {
  it('delegates to onPageChange and does not slice the caller’s rows', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    // Caller supplies ONE page of rows plus the true server-side rowCount.
    render(
      <DataTable
        columns={columns}
        rows={rows(25)}
        rowCount={340}
        page={0}
        onPageChange={onPageChange}
        getRowId={(r) => r.id}
      />,
    );

    expect(screen.getByText(/1–25 of 340/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    // Controlled mode must not double-paginate the page it was handed.
    expect(bodyText()).toContain('Row 1');
  });

  it('shows the footer even when a single page is supplied', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows(10)}
        rowCount={10}
        page={0}
        onPageChange={vi.fn()}
        getRowId={(r) => r.id}
      />,
    );
    expect(screen.getByRole('button', { name: /next page/i })).toBeTruthy();
  });
});

describe('DataTable — page clamping', () => {
  it('does not strand the user on an out-of-range page when the set shrinks', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DataTable columns={columns} rows={rows(60)} getRowId={(r) => r.id} />,
    );
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(bodyText()).toContain('Row 26');

    // A filter is applied and the result set collapses to 5 rows.
    rerender(<DataTable columns={columns} rows={rows(5)} getRowId={(r) => r.id} />);

    // Body must show the surviving rows, not a blank page-2.
    expect(bodyText()).toContain('Row 1');
    expect(bodyText()).not.toBe('');
  });
});
