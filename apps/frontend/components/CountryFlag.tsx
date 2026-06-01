'use client';

import { Chip, type ChipProps } from '@mui/material';

export type CountryFlagProps = {
  /** ISO-3166-1 alpha-2 code, e.g. "GB", "NP". */
  code: string | null | undefined;
  /** Optional human-readable country name to show alongside the code. */
  name?: string | null;
  size?: ChipProps['size'];
  /** When true, shows only the alpha-2 code, no name. */
  compact?: boolean;
};

/**
 * Text-only "flag" chip. We deliberately avoid pulling a flag library — the
 * alpha-2 code in a monospaced badge is faster to scan in dense tables.
 */
export default function CountryFlag({ code, name, size = 'small', compact }: CountryFlagProps) {
  const cc = (code ?? '').toUpperCase().slice(0, 2);
  if (!cc) {
    return <Chip size={size} label="—" variant="outlined" />;
  }
  const label = compact || !name ? cc : `${cc} · ${name}`;
  return (
    <Chip
      size={size}
      label={label}
      variant="outlined"
      sx={{
        fontWeight: 600,
        fontFamily:
          '"SF Mono", "JetBrains Mono", "Roboto Mono", ui-monospace, Menlo, monospace',
        letterSpacing: 0.5,
      }}
    />
  );
}
