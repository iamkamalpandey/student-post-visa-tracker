// SVT-LEGAL-2026-05 — Minimal layout for legal / policy pages.
//
// Intentionally does NOT mount the AppShell because these pages must be
// reachable while logged out (e.g. from the login footer's "Terms" /
// "Privacy" links). Keep this lean: a small brand header with a "Back"
// link, and a constrained content column.
//
// Client component: the header/footer use `sx` callbacks (theme functions)
// which Next.js cannot serialize across the Server -> Client boundary that
// MUI components require. Marking the layout 'use client' is the cheapest
// fix; these are static stub pages with no SEO/data-fetching needs.

'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Box, Container, Stack, Typography } from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Student Post-Visa Tracker';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <Box
        component="header"
        sx={{
          borderBottom: (t) => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.paper',
        }}
      >
        <Container maxWidth="md">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ py: 1.5 }}
          >
            <Stack
              component={Link}
              href="/"
              direction="row"
              spacing={1.25}
              alignItems="center"
              sx={{ textDecoration: 'none', color: 'inherit' }}
            >
              <Box
                sx={{
                  width: 32,
                  height: 32,
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, #1A73E8 0%, #7E57C2 100%)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: 0.5,
                }}
                aria-hidden
              >
                SP
              </Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {APP_NAME}
              </Typography>
            </Stack>

            <Stack
              component={Link}
              href="/login"
              direction="row"
              spacing={0.5}
              alignItems="center"
              sx={{
                textDecoration: 'none',
                color: 'primary.main',
                fontWeight: 500,
                fontSize: 14,
                '&:hover': { textDecoration: 'underline' },
              }}
            >
              <ArrowBackOutlinedIcon fontSize="small" />
              <span>Back to sign in</span>
            </Stack>
          </Stack>
        </Container>
      </Box>

      <Container component="main" maxWidth="md" sx={{ flexGrow: 1, py: { xs: 4, md: 6 } }}>
        {children}
      </Container>

      <Box
        component="footer"
        sx={{
          borderTop: (t) => `1px solid ${t.palette.divider}`,
          py: 2,
          mt: 4,
        }}
      >
        <Container maxWidth="md">
          {/* SVT-QA-2026-08 — this is a client component on a PUBLIC route, so
              it is server-rendered too. If the year ticks over between the SSR
              render and hydration (New Year's Eve, or a server in a different
              zone), the text differs and React logs a hydration mismatch.
              `suppressHydrationWarning` is the sanctioned escape hatch for
              exactly this case — a value that is legitimately time-dependent
              and cosmetic. The client value wins, which is the correct one. */}
          <Typography variant="caption" color="text.secondary" suppressHydrationWarning>
            &copy; {new Date().getFullYear()} {APP_NAME}
          </Typography>
        </Container>
      </Box>
    </Box>
  );
}
