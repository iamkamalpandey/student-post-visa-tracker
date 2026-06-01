'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

export default function SignOutEverywhereSection() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);

  const handleSignOut = async () => {
    setBusy(true);
    try {
      // Admins can revoke ALL of their refresh tokens at once via the user-management
      // endpoint; otherwise we fall back to the standard logout which only invalidates
      // the current refresh cookie. Either way we always run logout() so local state
      // is cleared and we redirect to /login.
      if (user?.role === 'ADMIN' && user.id) {
        try {
          await api.post(`/users/${user.id}/sessions/revoke`);
        } catch {
          /* fall through to logout — the user still wants to be signed out locally */
        }
      }
      await logout();
      enqueueSnackbar('Signed out.', { variant: 'success' });
      router.replace('/login');
    } catch {
      enqueueSnackbar('Sign-out failed. Try again.', { variant: 'error' });
      setBusy(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Sessions
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Sign out of this device. Admins also revoke every active session on every
              device — others should ask an admin to do that for them.
            </Typography>
          </Box>
          <Divider />
          <Box>
            <Button
              variant="outlined"
              color="error"
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <LogoutIcon />}
              onClick={handleSignOut}
              disabled={busy}
            >
              {busy ? 'Signing out…' : 'Sign out everywhere'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
