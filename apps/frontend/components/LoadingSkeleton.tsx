'use client';

import { Box, Card, CardContent, Skeleton, Stack } from '@mui/material';

export type LoadingSkeletonProps = {
  /** Number of skeleton rows. */
  rows?: number;
  /** Pre-baked layouts for common shapes. */
  variant?: 'list' | 'card' | 'stat-grid' | 'page';
};

export default function LoadingSkeleton({ rows = 6, variant = 'list' }: LoadingSkeletonProps) {
  if (variant === 'stat-grid') {
    return (
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' },
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent>
              <Skeleton variant="text" width="40%" height={18} />
              <Skeleton variant="text" width="60%" height={36} sx={{ mt: 1 }} />
              <Skeleton variant="text" width="80%" height={14} />
            </CardContent>
          </Card>
        ))}
      </Box>
    );
  }

  if (variant === 'card') {
    return (
      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Skeleton variant="text" width="40%" height={28} />
            <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 2 }} />
            <Skeleton variant="text" width="80%" />
            <Skeleton variant="text" width="60%" />
          </Stack>
        </CardContent>
      </Card>
    );
  }

  if (variant === 'page') {
    return (
      <Stack spacing={3}>
        <Skeleton variant="text" width={280} height={36} />
        <Skeleton variant="text" width={200} height={20} />
        <LoadingSkeleton variant="stat-grid" />
        <LoadingSkeleton variant="card" />
      </Stack>
    );
  }

  return (
    <Stack spacing={1.25}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="rectangular" height={56} sx={{ borderRadius: 2 }} />
      ))}
    </Stack>
  );
}
