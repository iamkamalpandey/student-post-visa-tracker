'use client';

import { Fragment, type ReactNode } from 'react';
import {
  Box,
  Breadcrumbs,
  Link as MuiLink,
  Stack,
  Typography,
} from '@mui/material';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import NextLink from 'next/link';

export type Crumb = {
  label: string;
  /** Omit href on the last crumb for a non-clickable current page. */
  href?: string;
};

export type PageHeaderProps = {
  title: string;
  subtitle?: ReactNode;
  /** Breadcrumb trail rendered above the title. */
  breadcrumbs?: Crumb[];
  /** Right-aligned actions (buttons, menus). */
  actions?: ReactNode;
};

/**
 * Consistent page header used by every (app) route. Slots into a Stack-based
 * layout: title left, action cluster right, optional breadcrumbs on top.
 */
export default function PageHeader({ title, subtitle, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <Stack spacing={1.25} sx={{ mb: { xs: 2, md: 3 } }}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <Breadcrumbs
          separator={<NavigateNextIcon fontSize="small" />}
          aria-label="breadcrumb"
        >
          {breadcrumbs.map((c, i) => {
            const isLast = i === breadcrumbs.length - 1;
            if (isLast || !c.href) {
              return (
                <Typography
                  key={`${c.label}-${i}`}
                  variant="body2"
                  color="text.primary"
                  sx={{ fontWeight: 500 }}
                >
                  {c.label}
                </Typography>
              );
            }
            return (
              <MuiLink
                key={`${c.label}-${i}`}
                component={NextLink}
                href={c.href}
                underline="hover"
                color="text.secondary"
                variant="body2"
              >
                {c.label}
              </MuiLink>
            );
          })}
        </Breadcrumbs>
      ) : null}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {title}
          </Typography>
          {subtitle ? (
            typeof subtitle === 'string' ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {subtitle}
              </Typography>
            ) : (
              <Box sx={{ mt: 0.5 }}>{subtitle}</Box>
            )
          ) : null}
        </Box>
        {actions ? (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ flexShrink: 0, flexWrap: 'wrap', rowGap: 1 }}
          >
            <Fragment>{actions}</Fragment>
          </Stack>
        ) : null}
      </Stack>
    </Stack>
  );
}
