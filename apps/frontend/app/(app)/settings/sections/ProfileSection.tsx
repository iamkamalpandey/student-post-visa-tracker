'use client';

import {
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';

export default function ProfileSection() {
  const { user } = useAuth();
  const t = useTranslations('settings');
  if (!user) return null;
  const fullName = `${user.given_name} ${user.family_name}`.trim() || user.display_name || '—';
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Profile
              </Typography>
              <Typography variant="body2" color="text.secondary">
                These details come from your account record. Ask an admin to change them.
              </Typography>
            </Box>
            <Chip label={user.role} size="small" color="primary" variant="outlined" />
          </Stack>
          <Divider />
          {/*
            Use a definition-list semantic via MUI List/ListItemText so screen
            readers announce the caption (primary) as the label for the value
            (secondary). Previously a CSS grid of plain Typography pairs left
            label↔value association implicit and unreadable to AT (WCAG 1.3.1).
          */}
          <List dense disablePadding aria-label="Profile details">
            <ListItem disableGutters>
              <ListItemText
                primary="Name"
                secondary={fullName}
                primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                secondaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText
                primary={t('email')}
                secondary={user.email}
                primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                secondaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText
                primary={t('role')}
                secondary={user.role}
                primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                secondaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText
                primary={t('locale')}
                secondary={user.locale}
                primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                secondaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
              />
            </ListItem>
            <ListItem disableGutters>
              <ListItemText
                primary={t('timezone')}
                secondary={user.timezone}
                primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
                secondaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
              />
            </ListItem>
          </List>
        </Stack>
      </CardContent>
    </Card>
  );
}
