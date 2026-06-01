'use client';

import Link from 'next/link';
import { Button, CardContent, Stack } from '@mui/material';
import EmptyState from '@/components/EmptyState';
import ListPageShell from '@/components/ListPageShell';

export type PlaceholderPageProps = {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
};

export default function PlaceholderPage({
  title,
  description,
  emptyTitle,
  emptyDescription,
  primary,
  secondary,
}: PlaceholderPageProps) {
  const actions =
    primary || secondary ? (
      <Stack direction="row" spacing={1.5}>
        {primary ? (
          <Button component={Link} href={primary.href} variant="contained">
            {primary.label}
          </Button>
        ) : null}
        {secondary ? (
          <Button component={Link} href={secondary.href} variant="outlined">
            {secondary.label}
          </Button>
        ) : null}
      </Stack>
    ) : null;

  return (
    <ListPageShell title={title} description={description}>
      <CardContent>
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          {...(actions ? { actions } : {})}
        />
      </CardContent>
    </ListPageShell>
  );
}
