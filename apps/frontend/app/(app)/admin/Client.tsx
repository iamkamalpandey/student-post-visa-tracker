'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Card, CardActionArea, CardContent, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import FlightTakeoffOutlinedIcon from '@mui/icons-material/FlightTakeoffOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import OutboxOutlinedIcon from '@mui/icons-material/OutboxOutlined';
import ApartmentOutlinedIcon from '@mui/icons-material/ApartmentOutlined';
import QuizOutlinedIcon from '@mui/icons-material/QuizOutlined';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useEffect, type ReactNode } from 'react';

type AdminLink = {
  href: string;
  label: string;
  description: string;
  icon: ReactNode;
};

const ADMIN_LINKS: AdminLink[] = [
  { href: '/stages', label: 'Stages', description: 'Lifecycle stages, transitions and per-stage checklists', icon: <TimelineOutlinedIcon /> },
  { href: '/visa-types', label: 'Visa types', description: 'Country × visa-type catalog driving stage scoping', icon: <FlightTakeoffOutlinedIcon /> },
  { href: '/users', label: 'Users', description: 'Counsellor + admin accounts, role assignment, password reset', icon: <GroupOutlinedIcon /> },
  { href: '/commissions', label: 'Commissions', description: 'Institution commission claims and lifecycle', icon: <PaymentsOutlinedIcon /> },
  { href: '/reports', label: 'Reports', description: 'Pre-built XLSX exports + ad-hoc query', icon: <AssessmentOutlinedIcon /> },
  { href: '/imports', label: 'Imports', description: 'Bulk-load students, programs, fees from CSV/XLSX', icon: <StorageOutlinedIcon /> },
  { href: '/exports', label: 'Exports', description: 'Export jobs history and downloadable artefacts', icon: <FileDownloadOutlinedIcon /> },
  { href: '/catalog', label: 'Catalog', description: 'Institutions and program offering hub', icon: <MenuBookOutlinedIcon /> },
  { href: '/super-agents', label: 'Super-agents', description: 'Aggregator/intermediary platforms (Adventus, Edvoy, IDP)', icon: <HubOutlinedIcon /> },
  { href: '/super-agent-types', label: 'Super-agent types', description: 'Categories used to classify super-agents', icon: <CategoryOutlinedIcon /> },
  { href: '/admin/outbox', label: 'Comms outbox', description: 'Email / SMS delivery queue + retry tooling for failed sends', icon: <OutboxOutlinedIcon /> },
  // SVT-WAVE-TENANT-ADMIN-2026-05 — admin-only view of the tenant the caller
  // administers, with a help dialog pointing at the onboarding script for new
  // tenants (no auth-less creation surface).
  { href: '/admin/tenants', label: 'Tenants', description: 'Your tenant + settings; onboarding command for new tenants', icon: <ApartmentOutlinedIcon /> },
  { href: '/interview-questions', label: 'Interview prep', description: 'Question bank for visa interview mock tests + attempt tracking', icon: <QuizOutlinedIcon /> },
];

// SVT-WAVE11-OUTBOX-HEALTH-2026-05 — compact health card surfaced above the
// admin tabs. Polls every 30s. Shows a warning Alert when terminal_failed > 0
// or retrying > 5, otherwise renders a quiet status line. Clicking jumps to
// the full outbox surface.
function OutboxHealthCard({ onClick }: { onClick: () => void }) {
  const q = useQuery({
    queryKey: ['admin', 'outbox', 'health'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await api.get<{ data: { queued: number; retrying: number; terminal_failed: number; sent_last_24h: number } }>(
        '/admin/comms/outbox/health',
      );
      return res.data.data;
    },
  });
  const h = q.data;
  if (!h) return null;
  const degraded = h.terminal_failed > 0 || h.retrying > 5;
  const severity: 'success' | 'info' | 'warning' | 'error' = h.terminal_failed > 0 ? 'error' : h.retrying > 5 ? 'warning' : 'success';
  return (
    <Alert
      severity={severity}
      onClick={onClick}
      sx={{ cursor: 'pointer', '&:hover': { boxShadow: 1 } }}
      action={<Chip size="small" label="Open outbox" onClick={onClick} />}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Comms outbox · {degraded ? 'attention needed' : 'healthy'}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Chip size="small" label={`Queued ${h.queued}`} />
          <Chip size="small" label={`Retrying ${h.retrying}`} color={h.retrying > 0 ? 'warning' : 'default'} />
          <Chip size="small" label={`Terminal ${h.terminal_failed}`} color={h.terminal_failed > 0 ? 'error' : 'default'} />
          <Chip size="small" label={`Sent 24h ${h.sent_last_24h}`} />
        </Stack>
      </Stack>
    </Alert>
  );
}

export default function AdminClient() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();

  useEffect(() => {
    if (user && user.role !== 'ADMIN') router.replace('/');
  }, [user, router]);

  if (!user) return null;
  if (user.role !== 'ADMIN') return null;

  // Active tab when one of the admin sub-routes is open. /admin landing → -1 (no tab).
  const activeIdx = ADMIN_LINKS.findIndex((l) => pathname === l.href || pathname.startsWith(`${l.href}/`));

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          Admin
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Configuration, catalogues, jobs, reports.
        </Typography>
      </Stack>

      <OutboxHealthCard onClick={() => router.push('/admin/outbox')} />

      <Tabs
        value={activeIdx === -1 ? false : activeIdx}
        onChange={(_, v) => {
          const target = ADMIN_LINKS[v as number];
          if (target) router.push(target.href);
        }}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Admin sections"
      >
        {ADMIN_LINKS.map((l) => (
          <Tab
            key={l.href}
            label={l.label}
            icon={<Box sx={{ display: 'inline-flex', '& svg': { fontSize: 18 } }}>{l.icon}</Box>}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
          />
        ))}
      </Tabs>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
          gap: 2,
        }}
      >
        {ADMIN_LINKS.map((l) => (
          <Card key={l.href} variant="outlined">
            <CardActionArea onClick={() => router.push(l.href)} sx={{ height: '100%' }}>
              <CardContent>
                <Stack direction="row" spacing={1.5} alignItems="flex-start">
                  <Box
                    sx={{
                      width: 36,
                      height: 36,
                      borderRadius: 1,
                      bgcolor: 'action.hover',
                      color: 'text.secondary',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {l.icon}
                  </Box>
                  <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {l.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {l.description}
                    </Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Stack>
  );
}
