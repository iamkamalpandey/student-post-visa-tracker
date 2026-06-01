'use client';

// SVT-WAVE-TENANT-ADMIN-2026-05 — minimal admin tenant-management UI.
//
// Design note (push-back recorded): the original brief asked for a
// `GET /tenants/all` cross-tenant list. The platform is RLS-isolated by
// design — every authenticated request is bound to req.user.tid via a
// transactional `SELECT set_config('app.tenant_id', ...)` (see
// middlewares/tenantContext.ts) and there is no super-admin role/claim
// (UserRole enum = ADMIN | COUNSELLOR | VIEWER, all tenant-scoped). Exposing
// a cross-tenant list would require either bypassing RLS at the service
// layer or inventing a super-admin claim that doesn't exist — both punch
// holes in the GDPR-aligned isolation model the onboarding script's closing
// log explicitly calls out. For the single-tenant beta, this page just
// surfaces the caller's own tenant + deep-links to the editable settings
// sections that already exist. Adding more tenants stays in the onboard
// script (which is itself idempotent + transactional).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import TenantSettingsSection from '../../settings/sections/TenantSettingsSection';
import BillingModuleSection from '../../settings/sections/BillingModuleSection';

type TenantRow = {
  id: string;
  name: string;
  legal_name: string | null;
  default_locale: string;
  default_timezone: string;
  default_currency: string;
  data_residency_region: string;
  email_from: string | null;
  billing_enabled: boolean;
};

// Shell template surfaced in the "Add tenant" help dialog. Kept in sync with
// scripts/onboard-tenant.ts. If you change the script's required flags, update
// this string too.
const ONBOARD_COMMAND_TEMPLATE = `pnpm --filter backend tsx scripts/onboard-tenant.ts \\
  --name "Acme Education" \\
  --legal-name "Acme Education Ltd." \\
  --admin-email founder@acme.com \\
  --admin-password "$(< /tmp/admin-pass)" \\
  --locale en \\
  --timezone Europe/London \\
  --currency GBP \\
  --region eu-west-1`;

export default function TenantsAdminClient() {
  const router = useRouter();
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const isAdmin = user?.role === 'ADMIN';

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const q = useQuery({
    queryKey: ['tenants', 'me'],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await api.get<TenantRow>('/tenants/me');
      return res.data;
    },
  });

  if (!user) return null;
  if (!isAdmin) {
    return (
      <Stack spacing={2}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>Tenants</Typography>
        <Alert severity="info">Admin-only surface. Ask your tenant admin if you need access.</Alert>
      </Stack>
    );
  }

  const rows: TenantRow[] = q.data ? [q.data] : [];

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(ONBOARD_COMMAND_TEMPLATE);
      enqueueSnackbar('Command copied.', { variant: 'success' });
    } catch {
      enqueueSnackbar('Copy failed — select the text manually.', { variant: 'warning' });
    }
  }

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-end' }} justifyContent="space-between">
        <Stack spacing={1}>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            Tenants
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Tenants you administer. New tenants are provisioned via the onboarding script.
          </Typography>
        </Stack>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setHelpOpen(true)}
        >
          Add tenant
        </Button>
      </Stack>

      <Alert severity="info" variant="outlined">
        Cross-tenant browsing is intentionally not exposed. Each authenticated session is bound to one
        tenant by Postgres RLS (see <code>middlewares/tenantContext.ts</code>); breaking that boundary
        would weaken the isolation guarantees we publish in the privacy policy. To administer a
        different tenant, sign in with that tenant&apos;s admin account.
      </Alert>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Tenants">
          <TableHead>
            <TableRow>
              <TableCell>Legal name</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Billing</TableCell>
              <TableCell>Default currency</TableCell>
              <TableCell>Data residency</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {q.isLoading && (
              <TableRow><TableCell colSpan={6}>Loading…</TableCell></TableRow>
            )}
            {q.isError && (
              <TableRow><TableCell colSpan={6}><Alert severity="error">Failed to load tenant.</Alert></TableCell></TableRow>
            )}
            {!q.isLoading && !q.isError && rows.length === 0 && (
              <TableRow><TableCell colSpan={6}>No tenants.</TableCell></TableRow>
            )}
            {rows.map((t) => (
              <TableRow key={t.id} hover>
                <TableCell>
                  <Stack spacing={0.25}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {t.legal_name ?? t.name}
                    </Typography>
                    {t.legal_name && t.legal_name !== t.name && (
                      <Typography variant="caption" color="text.secondary">
                        Display: {t.name}
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip size="small" label="Active" color="success" variant="outlined" />
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={t.billing_enabled ? 'Enabled' : 'Disabled'}
                    color={t.billing_enabled ? 'success' : 'default'}
                    variant="outlined"
                  />
                </TableCell>
                <TableCell>{t.default_currency}</TableCell>
                <TableCell>{t.data_residency_region}</TableCell>
                <TableCell align="right">
                  <Tooltip title="View settings">
                    <IconButton size="small" onClick={() => setDrawerOpen(true)} aria-label="View tenant settings">
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Settings drawer — composes the same sections rendered at /settings. */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 560 }, p: 2 } }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Tenant settings
          </Typography>
          <IconButton onClick={() => setDrawerOpen(false)} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </Stack>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Editing your own tenant. The full surface lives at{' '}
            <Box
              component="a"
              href="/settings"
              onClick={(e: React.MouseEvent) => { e.preventDefault(); router.push('/settings'); }}
              sx={{ color: 'primary.main', textDecoration: 'none', cursor: 'pointer' }}
            >
              /settings
            </Box>.
          </Typography>
          <TenantSettingsSection />
          <BillingModuleSection />
        </Stack>
      </Drawer>

      {/* Add-tenant help dialog. We deliberately do NOT expose a creation form
          because building an auth-less tenant creation surface would expand the
          attack surface (anon POST → new tenant + admin user → free tier abuse). */}
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Add a new tenant</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Stack spacing={2}>
              <Typography variant="body2">
                Tenant provisioning is intentionally a server-side script (no public creation endpoint).
                Run the command below on a machine with access to the backend database, replacing the
                placeholder values:
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5, position: 'relative', bgcolor: 'action.hover' }}>
                <IconButton
                  size="small"
                  onClick={copyCommand}
                  aria-label="Copy command"
                  sx={{ position: 'absolute', top: 4, right: 4 }}
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
{ONBOARD_COMMAND_TEMPLATE}
                </Box>
              </Paper>
              <Alert severity="warning" variant="outlined">
                Never pass <code>--admin-password</code> as a literal — shells log it to history. Read
                from a file (<code>$(&lt; /tmp/admin-pass)</code>) or a CI secret.
              </Alert>
              <Typography variant="body2" color="text.secondary">
                The script is idempotent on <code>legal_name</code>: re-running with the same value
                aborts with exit code 2 instead of creating a duplicate.
              </Typography>
            </Stack>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHelpOpen(false)}>Close</Button>
          <Button onClick={copyCommand} variant="contained" startIcon={<ContentCopyIcon />}>
            Copy command
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
