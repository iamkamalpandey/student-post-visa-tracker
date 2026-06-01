'use client';

// SVT-WAVE-POLISH-2026-05 — Circular completeness indicator.
// Renders an SVG ring with the percentage centered. Color shifts by band:
//   < 40%   warning  (orange)
//   40–80%  primary  (brand blue)
//   >= 80%  success  (green)
// Lightweight (no Recharts dep): inline SVG with two stroke arcs.

import { Box, Typography, useTheme } from '@mui/material';

export type CompletenessRingProps = {
  value: number; // 0–100
  size?: number;
  thickness?: number;
  label?: string;
};

export default function CompletenessRing({
  value,
  size = 64,
  thickness = 6,
  label,
}: CompletenessRingProps) {
  const theme = useTheme();
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - safe / 100);

  const color =
    safe >= 80
      ? theme.palette.success.main
      : safe < 40
        ? theme.palette.warning.main
        : theme.palette.primary.main;
  const trackColor = theme.palette.action.hover;

  return (
    <Box
      sx={{
        position: 'relative',
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      role="img"
      aria-label={label ? `${label}: ${safe}%` : `${safe}% complete`}
    >
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={thickness}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={thickness}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 300ms ease' }}
        />
      </svg>
      <Box sx={{ position: 'absolute', textAlign: 'center' }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 700,
            color,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {safe}%
        </Typography>
      </Box>
    </Box>
  );
}
