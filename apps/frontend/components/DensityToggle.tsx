'use client';

// SVT-WAVE-POLISH-2026-05 — Comfortable/Compact toggle. Used by Dashboard
// (top-right) and Students list (toolbar). Shared so the preference persists
// across surfaces.

import { IconButton, Tooltip } from '@mui/material';
import DensityMediumOutlinedIcon from '@mui/icons-material/DensityMediumOutlined';
import DensitySmallOutlinedIcon from '@mui/icons-material/DensitySmallOutlined';
import { useDensity, type Density } from '@/lib/useDensity';

export type DensityToggleProps = {
  // Override styling when embedded inside other toolbars.
  size?: 'small' | 'medium';
};

export default function DensityToggle({ size = 'small' }: DensityToggleProps) {
  const [density, , toggle] = useDensity();
  const next: Density = density === 'compact' ? 'comfortable' : 'compact';
  const Icon = density === 'compact' ? DensitySmallOutlinedIcon : DensityMediumOutlinedIcon;
  return (
    <Tooltip title={`Switch to ${next} density`} arrow>
      <IconButton
        size={size}
        aria-label={`Switch to ${next} density`}
        onClick={toggle}
      >
        <Icon fontSize={size} />
      </IconButton>
    </Tooltip>
  );
}
