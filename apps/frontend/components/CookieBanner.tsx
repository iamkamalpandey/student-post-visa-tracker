'use client';

// SVT-WAVE-PRIV-C7-2026-05 — GDPR / UK PECR / India DPDP cookie consent
// banner. Renders a fixed bottom bar on first visit; persists the choice in
// localStorage at `spv:cookie-consent`. The banner only addresses
// non-essential cookies — essential auth cookies are out of scope of the
// consent regime (no banner needed for those, per ICO guidance).
//
// For authenticated users we ALSO write a ConsentRecord (lawful_basis=
// CONSENT, purpose=cookies_analytics) so the audit register has tamper-
// evident evidence of opt-in. Anonymous visitors only land in localStorage;
// the moment they authenticate we re-fire the consent write so the record
// catches up. The write is best-effort: a 4xx/5xx response never blocks
// the banner-dismissal UX (the localStorage choice is the user's contract,
// the consent row is regulator evidence).

import { useEffect, useState } from 'react';
import { Box, Button, Stack, Typography, useTheme } from '@mui/material';
import CookieOutlinedIcon from '@mui/icons-material/CookieOutlined';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

const STORAGE_KEY = 'spv:cookie-consent';

export type CookieConsentChoice = 'all' | 'essential';

type StoredChoice = {
  choice: CookieConsentChoice;
  decided_at: string;
};

/**
 * Read the persisted choice from localStorage. Returns null when the user
 * hasn't decided yet (banner shows) or when localStorage is unavailable
 * (privacy mode — also show the banner; their decision dies with the tab,
 * which is the privacy-friendly default).
 */
export function readStoredConsent(): StoredChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChoice>;
    if (parsed.choice === 'all' || parsed.choice === 'essential') {
      return { choice: parsed.choice, decided_at: parsed.decided_at ?? new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}

function persistChoice(choice: CookieConsentChoice): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ choice, decided_at: new Date().toISOString() } satisfies StoredChoice),
    );
  } catch {
    // Quota / privacy mode — silent: the banner re-appears next visit which
    // is the correct GDPR posture under "consent must be freely given".
  }
}

async function writeConsentRecord(authenticated: boolean, choice: CookieConsentChoice, userId: string | null): Promise<void> {
  if (!authenticated || !userId) return;
  try {
    await api.post('/consents', {
      subject_type: 'user',
      subject_id: userId,
      purpose: 'cookies_analytics',
      lawful_basis: 'CONSENT',
      granted: choice === 'all',
      evidence: {
        source: 'cookie_banner',
        choice,
        decided_at: new Date().toISOString(),
      },
    });
  } catch {
    // Non-fatal: localStorage is the user's contract, the audit row is
    // regulator-evidence and best-effort. A retry happens on next visit
    // if the user changes their mind via /privacy.
  }
}

export default function CookieBanner() {
  const theme = useTheme();
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);

  // Only check storage on the client after mount to avoid SSR/CSR mismatch.
  useEffect(() => {
    if (readStoredConsent() == null) {
      setVisible(true);
    }
  }, []);

  // If the user authenticates *after* dismissing as anonymous, mirror the
  // stored choice into a ConsentRecord so the audit register catches up.
  useEffect(() => {
    if (!user?.id) return;
    const stored = readStoredConsent();
    if (!stored) return;
    void writeConsentRecord(true, stored.choice, user.id);
    // We only attempt once per (user, choice) tuple this session; the
    // backend's POST /consents is idempotent on (subject_id, purpose,
    // granted) via the standard audit-chain logic but the FE side hand-
    // shake intentionally doesn't deduplicate — duplicate writes are a
    // backend concern, not a frontend one.
  }, [user?.id]);

  if (!visible) return null;

  const handleAccept = async (choice: CookieConsentChoice) => {
    persistChoice(choice);
    setVisible(false);
    // Fire the backend write *after* hiding the banner — UX must never
    // block on a network round-trip.
    await writeConsentRecord(Boolean(user?.id), choice, user?.id ?? null);
  };

  return (
    <Box
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      data-testid="cookie-banner"
      sx={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: theme.zIndex.snackbar + 5,
        bgcolor: 'background.paper',
        borderTop: (t) => `1px solid ${t.palette.divider}`,
        boxShadow: '0 -8px 24px rgba(0,0,0,0.08)',
        px: { xs: 2, sm: 4 },
        py: { xs: 2, sm: 2.5 },
      }}
    >
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', md: 'center' }}
        justifyContent="space-between"
        sx={{ maxWidth: 1200, mx: 'auto' }}
      >
        <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ flex: 1 }}>
          <CookieOutlinedIcon color="primary" sx={{ mt: 0.5 }} aria-hidden />
          <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
            We use essential cookies for authentication. Analytics/marketing
            cookies require your consent.
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ width: { xs: '100%', md: 'auto' } }}>
          <Button
            variant="outlined"
            size="small"
            data-testid="cookie-banner-essential"
            onClick={() => void handleAccept('essential')}
          >
            Essential only
          </Button>
          <Button
            variant="contained"
            size="small"
            data-testid="cookie-banner-accept-all"
            onClick={() => void handleAccept('all')}
          >
            Accept all
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
