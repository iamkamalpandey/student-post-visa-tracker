'use client';

import type { ReactNode } from 'react';
import {
  Box,
  Card,
  CardContent,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import NextLink from 'next/link';
import { useAuth } from '@/lib/auth';

const COMPLIANCE_LINKS: { href: string; label: string; description: string; icon: ReactNode }[] = [
  { href: '/audit', label: 'Audit log', description: 'Tamper-evident hash-chained record of every mutation', icon: <PolicyOutlinedIcon /> },
  { href: '/dsar', label: 'Data Subject Access Requests', description: 'GDPR / UK DPA / DPDP Art. 20 access + erasure requests', icon: <PrivacyTipOutlinedIcon /> },
  { href: '/consents', label: 'Consents', description: 'Lawful basis register per data subject + purpose', icon: <FactCheckOutlinedIcon /> },
  { href: '/breach-incidents', label: 'Breach incidents', description: 'GDPR 72h notification clock + remediation log', icon: <WarningAmberOutlinedIcon /> },
  { href: '/sub-processors', label: 'Sub-processors', description: 'Art. 28 register of third-party data processors', icon: <GroupsOutlinedIcon /> },
];

export default function ComplianceSection() {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') return null;
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Compliance
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Regulatory tools for admins. Audit log, GDPR requests, breach incidents, sub-processor register.
            </Typography>
          </Stack>
          <Divider />
          <List disablePadding>
            {COMPLIANCE_LINKS.map((l) => (
              <ListItem
                key={l.href}
                component={NextLink}
                href={l.href}
                sx={{
                  borderRadius: 1,
                  px: 1.5,
                  py: 1,
                  color: 'inherit',
                  textDecoration: 'none',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
                secondaryAction={<ChevronRightIcon fontSize="small" sx={{ color: 'text.secondary' }} />}
              >
                <Box sx={{ mr: 2, display: 'inline-flex', color: 'text.secondary' }}>{l.icon}</Box>
                <ListItemText
                  primary={l.label}
                  secondary={l.description}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: 600 }}
                  secondaryTypographyProps={{ variant: 'caption' }}
                />
              </ListItem>
            ))}
          </List>
        </Stack>
      </CardContent>
    </Card>
  );
}
