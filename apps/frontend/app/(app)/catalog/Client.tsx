'use client';

import NextLink from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import ClassOutlinedIcon from '@mui/icons-material/ClassOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';
import CreateInstitutionDialog from '@/features/institutions/CreateInstitutionDialog';
import CreateProgramDialog from '@/features/programs/CreateProgramDialog';

type CountResponse = {
  page: { total: number; hasMore: boolean; nextCursor: string | null };
};

/**
 * Catalog landing page — a hub that links to the two top-level catalog
 * surfaces (Institutions and Courses) and exposes their primary CTAs in one
 * place. Useful as an entry point from /students/[id]/enrollments and other
 * deep flows where the user needs both objects.
 */
export default function CatalogClient() {
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  const [createInstOpen, setCreateInstOpen] = useState(false);
  const [createProgOpen, setCreateProgOpen] = useState(false);

  // Cheap totals — limit=1 keeps the payload tiny while still returning page.total.
  const institutionsCountQ = useQuery({
    queryKey: ['institutions', 'list', { limit: '1' }],
    queryFn: async () => {
      const res = await api.get<CountResponse>('/institutions', {
        params: { limit: 1 },
      });
      return res.data.page.total;
    },
    staleTime: 60_000,
  });

  const programsCountQ = useQuery({
    queryKey: ['programs', 'list', { limit: '1' }],
    queryFn: async () => {
      const res = await api.get<CountResponse>('/programs', {
        params: { limit: 1 },
      });
      return res.data.page.total;
    },
    staleTime: 60_000,
  });

  const hasError = institutionsCountQ.isError || programsCountQ.isError;

  return (
    <>
      <ListPageShell
        title="Catalog"
        description="Manage the institutions you partner with and the courses they offer. Both lists are also reachable directly from the sidebar."
        bareContent
      >
        {hasError ? (
          <ErrorState
            title="Could not load catalog totals"
            description={
              institutionsCountQ.error instanceof ApiError
                ? institutionsCountQ.error.detail || institutionsCountQ.error.title
                : programsCountQ.error instanceof ApiError
                  ? programsCountQ.error.detail || programsCountQ.error.title
                  : 'Unexpected error'
            }
            onRetry={() => {
              void institutionsCountQ.refetch();
              void programsCountQ.refetch();
            }}
          />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <CatalogCard
              icon={<SchoolOutlinedIcon />}
              title="Institutions"
              href="/institutions"
              description="Universities, colleges, language schools and pathway providers — with their campuses, schools, contacts and accreditations."
              count={institutionsCountQ.data}
              loading={institutionsCountQ.isLoading}
              primaryCta={
                admin ? (
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setCreateInstOpen(true);
                    }}
                  >
                    New institution
                  </Button>
                ) : undefined
              }
            />
            <CatalogCard
              icon={<ClassOutlinedIcon />}
              title="Courses"
              href="/programs"
              description="Programs offered by partner institutions — with intakes, fees, requirements and module catalogs."
              count={programsCountQ.data}
              loading={programsCountQ.isLoading}
              primaryCta={
                admin ? (
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setCreateProgOpen(true);
                    }}
                  >
                    New course
                  </Button>
                ) : undefined
              }
            />
          </Box>
        )}
      </ListPageShell>

      <CreateInstitutionDialog
        open={createInstOpen}
        onClose={() => setCreateInstOpen(false)}
      />
      <CreateProgramDialog open={createProgOpen} onClose={() => setCreateProgOpen(false)} />
    </>
  );
}

function CatalogCard({
  icon,
  title,
  href,
  description,
  count,
  loading,
  primaryCta,
}: {
  icon: React.ReactNode;
  title: string;
  href: string;
  description: string;
  count: number | undefined;
  loading: boolean;
  primaryCta?: React.ReactNode;
}) {
  return (
    <Card variant="outlined">
      <CardActionArea
        component={NextLink}
        href={href}
        aria-label={`Open ${title}`}
        sx={{ p: 3, height: '100%' }}
      >
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <Box
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: 1.5,
                bgcolor: 'action.hover',
                color: 'primary.main',
              }}
            >
              {icon}
            </Box>
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  {title}
                </Typography>
                <Chip
                  size="small"
                  label={loading ? '…' : (count ?? 0).toString()}
                  variant="outlined"
                />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {description}
              </Typography>
            </Box>
          </Stack>
          {primaryCta ? <Box>{primaryCta}</Box> : null}
        </Stack>
      </CardActionArea>
    </Card>
  );
}
