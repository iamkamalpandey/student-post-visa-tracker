// SVT-AUDIT-OPS-2026-05 — route-segment loading boundary for the (app) group.
// Server-rendered skeleton shown during route transitions before client data
// queries land. Keeps the layout stable so the header + sidebar don't pop in.

import { Skeleton, Stack } from '@mui/material';

export default function AppGroupLoading() {
  return (
    <Stack spacing={2} sx={{ p: 3 }} role="status" aria-label="Loading content">
      <Skeleton variant="rounded" height={48} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={320} />
    </Stack>
  );
}
