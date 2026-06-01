'use client';

import { useState, type ChangeEvent } from 'react';
import { useSnackbar } from 'notistack';
import {
  Box,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useAuth, ApiError } from '@/lib/auth';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useTenant, useUpdateTenantSettings } from '@/lib/queries';

// SVT-BILLING-TOGGLE-2026-05 — admin-only billing module gate. Reads
// tenant.billing_enabled and toggles it via PATCH /tenants/me through the
// shared useUpdateTenantSettings hook (TanStack optimistic update). Disabling
// pops a ConfirmDialog because hiding the tab + blocking new payments is the
// kind of footgun we want to make explicit. Existing FeePlans/Payments rows
// stay in the database — the flag is purely a UI + middleware gate.
export default function BillingModuleSection() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const isAdmin = user?.role === 'ADMIN';
  const tenantQuery = useTenant(isAdmin);
  const update = useUpdateTenantSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!isAdmin || !tenantQuery.data) return null;

  const billingEnabled = tenantQuery.data.billing_enabled ?? false;
  // While the mutation is in-flight, lock the switch so a frantic admin can't
  // queue a flap. The optimistic cache update means `billingEnabled` already
  // reflects the pending value, so the toggle visually tracks intent.
  const busy = update.isPending;

  const applyToggle = (next: boolean) => {
    update.mutate(
      { billing_enabled: next },
      {
        onSuccess: () => {
          enqueueSnackbar(
            next ? 'Billing module enabled.' : 'Billing module disabled.',
            { variant: 'success' },
          );
        },
        onError: (err: unknown) => {
          const msg = err instanceof ApiError
            ? (err.detail || err.title)
            : err instanceof Error
              ? err.message
              : 'Could not update billing module.';
          enqueueSnackbar(msg, { variant: 'error' });
        },
      },
    );
  };

  const handleSwitchChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    if (!next) {
      // Disabling is destructive-ish — surface the consequences before flipping.
      setConfirmOpen(true);
      return;
    }
    applyToggle(true);
  };

  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Billing module
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Admin-only. Enables the Billing tab, FeePlans, payments, and refunds across
                the workspace. Existing data is never deleted — disabling only hides the UI
                and blocks new payment entries.
              </Typography>
            </Box>
            <Divider />
            <FormControlLabel
              control={
                <Switch
                  checked={billingEnabled}
                  onChange={handleSwitchChange}
                  disabled={busy}
                  inputProps={{ 'aria-label': 'Billing module' }}
                />
              }
              label={
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {billingEnabled ? 'Enabled' : 'Disabled'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {billingEnabled
                      ? 'Counsellors can record payments and manage FeePlans.'
                      : 'Billing tab hidden; the API rejects new payments with 404.'}
                  </Typography>
                </Box>
              }
            />
          </Stack>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        title="Disable billing module?"
        description="Disabling billing hides the Billing tab + blocks new payments. Existing plans remain in the database."
        confirmText={busy ? 'Disabling…' : 'Disable billing'}
        cancelText="Keep enabled"
        destructive
        loading={busy}
        onConfirm={() => {
          setConfirmOpen(false);
          applyToggle(false);
        }}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
      />
    </>
  );
}
