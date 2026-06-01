// SVT-LEGAL-2026-05 — Privacy Policy (GDPR / UK DPA / AU Privacy Act / India DPDP aware).
//
// Server Component. Describes processing in plain English; the operative legal
// terms live in the Data Processing Agreement signed with each Tenant. The
// Sub-processor register at /admin/sub-processors is the canonical live list.
//
// SVT-AUDIT-FE-POLISH-2026-05 — page chrome (title, section headers, contact
// label) is translated via `getTranslations`. Substantive privacy copy stays
// inline in English: it must be reviewed by counsel before translation.

import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Box, Divider, Stack, Typography } from '@mui/material';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@example.com';
const EFFECTIVE_DATE = '2026-05-19';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal.privacy');
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

export default async function PrivacyPage() {
  const t = await getTranslations('legal.privacy');
  const tc = await getTranslations('legal.common');

  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
          {t('title')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {tc('effectiveDate')}: {EFFECTIVE_DATE}
        </Typography>
      </Box>

      <Divider />

      <Section id="who-we-are" title={t('sections.whoWeAre')}>
        <P>
          We provide a counsellor workspace for tracking international students through
          post-visa stages. Where a Tenant uploads student or applicant data, we act as a
          processor on the Tenant&apos;s behalf; the Tenant is the data controller.
        </P>
      </Section>

      <Section id="data-we-collect" title={t('sections.dataWeCollect')}>
        <P>
          <strong>Account data</strong> &mdash; name, work email, role, authentication
          factors, and login telemetry.
        </P>
        <P>
          <strong>Billing data</strong> &mdash; organisation, plan, invoices, payment
          method tokens (held by our payment processor; we never store full card numbers).
        </P>
        <P>
          <strong>Application / student data</strong> &mdash; personal details, documents,
          and case notes uploaded by Tenants for their applicants. Some of this data may
          relate to minors. We process this data only on the Tenant&apos;s instructions.
        </P>
      </Section>

      <Section id="lawful-basis" title={t('sections.lawfulBasis')}>
        <P>
          We rely on (a) <strong>contract</strong> to provide the service to subscribing
          Tenants and their Users; (b) <strong>legitimate interest</strong> for product
          security, fraud prevention, and aggregate analytics; and (c){' '}
          <strong>consent</strong> for any marketing communications, which you may withdraw
          at any time.
        </P>
      </Section>

      <Section id="how-we-use-data" title={t('sections.howWeUseData')}>
        <P>
          To operate the service, authenticate Users, route messages and notifications,
          generate reports requested by the Tenant, secure the platform, and meet legal
          obligations.
        </P>
      </Section>

      <Section id="sub-processors" title={t('sections.subProcessors')}>
        <P>
          We engage carefully vetted sub-processors (hosting, email delivery, error
          monitoring, malware scanning). The live register, including processor name,
          purpose, and processing location, is maintained at{' '}
          <Box
            component={Link}
            href="/admin/sub-processors"
            sx={{
              color: 'primary.main',
              fontWeight: 500,
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            /admin/sub-processors
          </Box>
          .
        </P>
      </Section>

      <Section id="data-residency" title={t('sections.dataResidency')}>
        <P>
          Customer Data is stored in EU-West-1 by default. Tenants on supported plans may
          configure an alternative region per tenant.
        </P>
      </Section>

      <Section id="retention" title={t('sections.retention')}>
        <P>
          Document and case data are retained per the <code>DocumentType.retention_days</code>{' '}
          schedule configured by the Tenant. On expiry or deletion request, records are
          removed via crypto-shred (destruction of the per-record data key), rendering any
          residual ciphertext irrecoverable.
        </P>
      </Section>

      <Section id="security" title={t('sections.security')}>
        <P>
          We apply envelope encryption at rest, row-level security (RLS) for tenant
          isolation, a hash-chained audit log for tamper evidence, and ClamAV scanning for
          all uploaded files. Access to production is restricted, logged, and reviewed.
        </P>
      </Section>

      <Section id="your-rights" title={t('sections.yourRights')}>
        <P>
          Depending on your jurisdiction (EU GDPR, UK DPA 2018, Australian Privacy Act,
          India DPDP Act, and similar regimes), you may have rights of <strong>access</strong>,{' '}
          <strong>portability</strong>, <strong>erasure</strong>,{' '}
          <strong>rectification</strong>, <strong>restriction</strong>, and{' '}
          <strong>objection</strong>. Requests are handled by the Tenant as controller; we
          will assist on the Tenant&apos;s instruction via our DSAR endpoint.
        </P>
      </Section>

      <Section id="international-transfers" title={t('sections.internationalTransfers')}>
        <P>
          Where personal data leaves the EEA, UK, or other regulated jurisdictions, we rely
          on Standard Contractual Clauses (SCCs) and supplementary measures as appropriate.
        </P>
      </Section>

      <Section id="cookies" title={t('sections.cookies')}>
        <P>
          We use a small number of strictly necessary cookies for session management and
          security (e.g. locale, theme, authentication). No advertising or third-party
          analytics cookies are set.
        </P>
      </Section>

      <Section id="contact-complaints" title={t('sections.contactComplaints')}>
        <P>
          {t('contactQueries')} <strong>{SUPPORT_EMAIL}</strong>.
        </P>
        <P>
          You also have the right to lodge a complaint with your supervisory authority
          &mdash; for example the UK Information Commissioner&apos;s Office (ICO), an EU
          Data Protection Authority (per the EDPB one-stop-shop), the Office of the
          Australian Information Commissioner (OAIC), or the Data Protection Board of India
          (under DPDP).
        </P>
      </Section>
    </Stack>
  );
}
