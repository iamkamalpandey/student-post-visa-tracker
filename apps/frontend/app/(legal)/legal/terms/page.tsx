// SVT-LEGAL-2026-05 — Terms of Service (DRAFT placeholder).
//
// Server Component. Boilerplate-friendly placeholders only — every clause is
// flagged DRAFT - REVIEW WITH COUNSEL. Not a substitute for a signed Data
// Processing Agreement or Master Services Agreement.
//
// SVT-AUDIT-FE-POLISH-2026-05 — section titles and chrome strings now come
// from the `legal` i18n namespace via `getTranslations` (server-side).
// The long-form clause copy is intentionally kept inline-English and gated
// behind <Draft> — it must not ship translated without counsel review.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Alert, Box, Divider, Stack, Typography } from '@mui/material';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@example.com';
const EFFECTIVE_DATE = '2026-05-19';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.terms');
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

function Draft({ flag, children }: { flag: string; children: React.ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary" component="p">
      <Box component="span" sx={{ color: 'warning.main', fontWeight: 700, mr: 0.5 }}>
        {flag}
      </Box>
      {children}
    </Typography>
  );
}

export default async function TermsPage() {
  const t = await getTranslations('legal.terms');
  const tc = await getTranslations('legal.common');
  const flag = tc('draftFlag');

  return (
    <Stack spacing={4}>
      <Alert severity="warning" variant="outlined">
        {tc('draftBanner')}
      </Alert>

      <Box>
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
          {t('title')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {tc('effectiveDate')}: {EFFECTIVE_DATE}
        </Typography>
      </Box>

      <Divider />

      <Section id="acceptance" title={t('sections.acceptance')}>
        <Draft flag={flag}>
          By creating an account or accessing the service you agree to be bound by these
          Terms. If you are accepting on behalf of an organisation, you represent that you
          have authority to bind that organisation.
        </Draft>
      </Section>

      <Section id="definitions" title={t('sections.definitions')}>
        <Draft flag={flag}>
          <strong>&quot;User&quot;</strong> means a natural person authorised to access the
          service under a Tenant&apos;s subscription. <strong>&quot;Tenant&quot;</strong>{' '}
          means the organisation that has subscribed to the service.{' '}
          <strong>&quot;Subscription&quot;</strong> means the commercial agreement under
          which the Tenant is entitled to use the service.
        </Draft>
      </Section>

      <Section id="permitted-use" title={t('sections.permittedUse')}>
        <Draft flag={flag}>
          The service is licensed for the Tenant&apos;s internal business operations.
          Sub-licensing, resale, or providing the service to third parties without prior
          written consent is prohibited.
        </Draft>
      </Section>

      <Section id="account-responsibilities" title={t('sections.accountResponsibilities')}>
        <Draft flag={flag}>
          Tenants and Users are responsible for safeguarding credentials, enrolling
          multi-factor authentication where offered, and notifying us promptly of suspected
          unauthorised access.
        </Draft>
      </Section>

      <Section id="payment-terms" title={t('sections.paymentTerms')}>
        <Draft flag={flag}>
          Subscriptions are billed in arrears at the end of each billing period. Invoices
          are due on receipt. Accounts more than thirty (30) days past due may be suspended
          until payment is received.
        </Draft>
      </Section>

      <Section id="acceptable-use" title={t('sections.acceptableUse')}>
        <Draft flag={flag}>
          You agree not to: (a) abuse, harass, or threaten any User or third party; (b)
          scrape, crawl, or extract data via automated means outside documented APIs; (c)
          attempt to reverse-engineer, decompile, or circumvent technical controls; or (d)
          misuse personally identifiable information for purposes incompatible with the
          Tenant&apos;s lawful basis.
        </Draft>
      </Section>

      <Section id="data-ownership" title={t('sections.dataOwnership')}>
        <Draft flag={flag}>
          The Tenant retains all rights, title, and interest in Customer Data. We act as a
          processor on the Tenant&apos;s behalf and only process Customer Data per the
          Tenant&apos;s documented instructions (see the Data Processing Agreement).
        </Draft>
      </Section>

      <Section id="service-availability" title={t('sections.serviceAvailability')}>
        <Draft flag={flag}>
          The service is provided on an &quot;as available&quot; basis. No service-level
          agreement (SLA) is offered during the beta period. Production SLAs, when
          published, will supersede this section for paying tenants.
        </Draft>
      </Section>

      <Section id="limitation-of-liability" title={t('sections.limitationOfLiability')}>
        <Draft flag={flag}>
          To the maximum extent permitted by applicable law, our aggregate liability
          arising out of or related to these Terms shall not exceed the total fees paid by
          the Tenant during the twelve (12) months preceding the event giving rise to the
          claim.
        </Draft>
      </Section>

      <Section id="termination" title={t('sections.termination')}>
        <Draft flag={flag}>
          Either party may terminate the Subscription for material breach not cured within
          thirty (30) days of written notice. On termination, Customer Data will be
          exported on request and deleted per the published retention schedule.
        </Draft>
      </Section>

      <Section id="governing-law" title={t('sections.governingLaw')}>
        <Draft flag={flag}>
          Governing law and forum to be set by the tenant agreement.
        </Draft>
      </Section>

      <Section id="contact" title={t('sections.contact')}>
        <Typography variant="body2" color="text.secondary">
          {t('contactQuestions')} <strong>{SUPPORT_EMAIL}</strong>
        </Typography>
      </Section>
    </Stack>
  );
}
