'use client';

// Refactored to SVT form-pattern per design pass.
// Sections live in ./sections/* — this file is a thin orchestrator only.

import { Stack, Typography } from '@mui/material';
import ProfileSection from './sections/ProfileSection';
import ChangePasswordSection from './sections/ChangePasswordSection';
import MfaSection from './sections/MfaSection';
import NotificationPreferencesSection from './sections/NotificationPreferencesSection';
import TenantSettingsSection from './sections/TenantSettingsSection';
import BillingModuleSection from './sections/BillingModuleSection';
import ThemeSection from './sections/ThemeSection';
import ComplianceSection from './sections/ComplianceSection';
import CustomFieldsSection from './sections/CustomFieldsSection';
import SignOutEverywhereSection from './sections/SignOutEverywhereSection';

export default function SettingsPage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          Settings
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Profile, password, and appearance preferences.
        </Typography>
      </Stack>

      <ProfileSection />
      <ChangePasswordSection />
      <MfaSection />
      <NotificationPreferencesSection />
      <TenantSettingsSection />
      <BillingModuleSection />
      <ThemeSection />
      <CustomFieldsSection />
      <ComplianceSection />
      <SignOutEverywhereSection />
    </Stack>
  );
}
