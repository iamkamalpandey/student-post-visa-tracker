'use client';

import { Chip, type ChipProps } from '@mui/material';
import type { Role } from '@spv/api-types';

export type RoleChipProps = {
  role: Role | string | null | undefined;
  size?: ChipProps['size'];
};

const COLOR: Record<string, ChipProps['color']> = {
  ADMIN: 'error',
  COUNSELLOR: 'primary',
  VIEWER: 'default',
};

/** Coloured chip for the three SPV roles (ADMIN red, COUNSELLOR blue, VIEWER grey). */
export default function RoleChip({ role, size = 'small' }: RoleChipProps) {
  const value = (role ?? 'VIEWER').toString().toUpperCase();
  const color = COLOR[value] ?? 'default';
  return (
    <Chip
      size={size}
      label={value}
      color={color}
      variant={color === 'default' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600, letterSpacing: 0.3 }}
    />
  );
}
