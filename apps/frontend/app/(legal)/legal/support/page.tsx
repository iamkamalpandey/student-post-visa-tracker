// SVT-LEGAL-2026-05 — Support landing page (public, reachable while logged out).
//
// SVT-AUDIT-FE-POLISH-2026-05 — section titles and intro copy now route
// through the `legal.support` i18n namespace. Operational fragments (response
// time SLAs, bug-report checklist) stay inline English because they reference
// product-specific commitments we don't want translated independently of the
// English source of truth.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Box, Divider, Stack, Typography } from '@mui/material';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@example.com';
// SVT-WAVE-STATUS-PUBLIC-2026-05 — default to the in-app /status route now
// that we ship a first-party status page. Operators can still override with
// NEXT_PUBLIC_STATUS_URL if they front the platform with a third-party
// status provider (Statuspage, Better Stack, etc.).
const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL || '/status';
// Same-origin /status renders inside the app shell, so don't force a new tab
// (which makes the link look like it leaves the product to an unknown host).
const STATUS_IS_EXTERNAL = /^https?:\/\//i.test(STATUS_URL);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.support');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="section" id={id}>
      <Typography variant="h5" component="h2" sx={{ fontWeight: 600, mb: 1.5 }}>
        {title}
      </Typography>
      <Stack spacing={1.5}>{children}</Stack>
    </Box>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary" component="p">
      {children}
    </Typography>
  );
}

export default async function SupportPage() {
  const t = await getTranslations('legal.support');

  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
          {t('title')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('intro')}
        </Typography>
      </Box>

      <Divider />

      <Section id="contact" title={t('sections.contact')}>
        <P>
          {t('emailLabel')} <strong>{SUPPORT_EMAIL}</strong>
        </P>
      </Section>

      <Section id="response-time" title={t('sections.responseTime')}>
        <P>
          <strong>Paid plans:</strong> within 24 hours on business days (Mon&ndash;Fri,
          excluding public holidays).
        </P>
        <P>
          <strong>Beta plans:</strong> within 72 hours on business days. Beta tenants do
          not have a contractual SLA.
        </P>
      </Section>

      <Section id="status" title={t('sections.status')}>
        <P>
          {t('statusIntro')}{' '}
          <Box
            component="a"
            href={STATUS_URL}
            {...(STATUS_IS_EXTERNAL
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
            sx={{
              color: 'primary.main',
              fontWeight: 500,
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            {STATUS_URL}
          </Box>
        </P>
      </Section>

      <Section id="incidents" title={t('sections.incidents')}>
        <P>{t('noIncidents')}</P>
      </Section>

      <Section id="bug-report" title={t('sections.bugReport')}>
        <P>{t('bugIntro', { email: SUPPORT_EMAIL })}</P>
        <Box component="ul" sx={{ pl: 3, m: 0, color: 'text.secondary', fontSize: 14 }}>
          <li>Your tenant name and the email you log in with.</li>
          <li>The URL of the page where the issue occurred.</li>
          <li>What you expected to happen, and what actually happened.</li>
          <li>A screenshot or screen recording, if possible.</li>
          <li>The approximate time (with timezone) the issue occurred.</li>
        </Box>
      </Section>
    </Stack>
  );
}
