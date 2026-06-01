'use client';

import { Chip, Tooltip, type ChipProps } from '@mui/material';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import CampaignIcon from '@mui/icons-material/Campaign';
import FlightTakeoffIcon from '@mui/icons-material/FlightTakeoff';
import FlightIcon from '@mui/icons-material/Flight';
import FlightLandIcon from '@mui/icons-material/FlightLand';
import HomeIcon from '@mui/icons-material/Home';
import SchoolIcon from '@mui/icons-material/School';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { ComponentType, ReactElement } from 'react';
import type { StageLookup } from '@/lib/queries';

export type StageChipProps = {
  stage: Pick<StageLookup, 'label' | 'color_hex' | 'icon'> & {
    sla_hours?: number | null;
  };
  /** When true, surfaces the SLA warning icon on the chip. */
  slaBreached?: boolean;
  size?: ChipProps['size'];
};

// Lookup of MUI icon names that the seed/stage table may emit. Kept small —
// only the icons currently shipped in default-stages.json. Falls back to null
// (label-only) for unknown names so the chip still renders cleanly.
const STAGE_ICON_MAP: Record<string, ComponentType<{ fontSize?: 'small' | 'medium' | 'large' }>> = {
  VerifiedUser: VerifiedUserIcon,
  Campaign: CampaignIcon,
  FlightTakeoff: FlightTakeoffIcon,
  Flight: FlightIcon,
  FlightLand: FlightLandIcon,
  Home: HomeIcon,
  School: SchoolIcon,
  CheckCircle: CheckCircleIcon,
};

function stageIconFor(name: string | null | undefined): ReactElement | undefined {
  if (!name) return undefined;
  const Icon = STAGE_ICON_MAP[name];
  return Icon ? <Icon fontSize="small" /> : undefined;
}

/** Picks a readable foreground for the supplied background hex. */
function readableForeground(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const v = parseInt(m[1]!, 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  // sRGB relative luminance.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 160 ? 'rgba(0,0,0,0.87)' : '#fff';
}

/**
 * Compact chip for a pipeline stage. Background colour is taken from the
 * stage's color_hex; a per-stage icon (when available) gives a non-color cue
 * that satisfies WCAG 1.4.1. Falls back to the MUI default outlined look when
 * no color_hex is set, and to label-only when no icon is set.
 */
export default function StageChip({ stage, slaBreached, size = 'small' }: StageChipProps) {
  const bg = stage.color_hex && /^#?[0-9a-f]{6}$/i.test(stage.color_hex)
    ? (stage.color_hex.startsWith('#') ? stage.color_hex : `#${stage.color_hex}`)
    : null;

  // SLA breach takes visual priority over the stage's own icon — the warning
  // signal is the more urgent piece of information.
  const icon = slaBreached
    ? <WarningAmberOutlinedIcon fontSize="small" />
    : stageIconFor(stage.icon);

  const chip = (
    <Chip
      size={size}
      label={stage.label}
      icon={icon}
      variant={bg ? 'filled' : 'outlined'}
      sx={
        bg
          ? {
              bgcolor: bg,
              color: readableForeground(bg),
              fontWeight: 600,
              borderRadius: '999px',
              '& .MuiChip-icon': { color: readableForeground(bg) },
            }
          : { fontWeight: 600, borderRadius: '999px' }
      }
    />
  );

  if (slaBreached && stage.sla_hours != null) {
    return <Tooltip title={`SLA: ${stage.sla_hours}h breached`}>{chip}</Tooltip>;
  }
  return chip;
}
