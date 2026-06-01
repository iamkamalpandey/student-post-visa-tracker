'use client';

import {
  Box,
  Card,
  CardContent,
  Divider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import { useThemeMode } from '@/app/providers';

export default function ThemeSection() {
  const { mode, setMode } = useThemeMode();
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Appearance
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Choose how the app looks. “System” follows your operating-system preference.
            </Typography>
          </Box>
          <Divider />
          <ToggleButtonGroup
            value={mode}
            exclusive
            onChange={(_, val) => {
              if (val === 'light' || val === 'dark' || val === 'system') setMode(val);
            }}
            aria-label="Theme"
          >
            <ToggleButton value="light" aria-label="Light theme">
              <LightModeOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Light
            </ToggleButton>
            <ToggleButton value="dark" aria-label="Dark theme">
              <DarkModeOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Dark
            </ToggleButton>
            <ToggleButton value="system" aria-label="System theme">
              <SettingsBrightnessIcon fontSize="small" sx={{ mr: 1 }} />
              System
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </CardContent>
    </Card>
  );
}
