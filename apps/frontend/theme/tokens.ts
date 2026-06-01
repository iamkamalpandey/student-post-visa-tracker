/**
 * Material Design 3-inspired design tokens.
 *
 * These tokens drive the MUI theme but are also exportable so any non-MUI
 * surface (raw HTML, charts, third-party widgets) can speak the same visual
 * language. Keep this file framework-agnostic — no React, no MUI imports.
 */

// ---------------------------------------------------------------------------
// Brand seed
// ---------------------------------------------------------------------------

export const seed = {
  /** Primary brand seed — indigo-blue, MD3 friendly. */
  primary: '#1A73E8',
  /** Secondary accent. */
  secondary: '#5F6368',
  /** Tertiary accent for highlights / chips. */
  tertiary: '#7E57C2',
  /** Error / destructive. */
  error: '#B3261E',
  /** Warning. */
  warning: '#B26A00',
  /** Success. */
  success: '#1E8E3E',
  /** Info. */
  info: '#0277BD',
} as const;

// ---------------------------------------------------------------------------
// MD3 surface roles (light)
// ---------------------------------------------------------------------------

export const lightRoles = {
  primary: seed.primary,
  onPrimary: '#FFFFFF',
  primaryContainer: '#D3E3FD',
  onPrimaryContainer: '#001D36',

  secondary: '#535F70',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#D7E3F8',
  onSecondaryContainer: '#101C2B',

  tertiary: seed.tertiary,
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#EADDFF',
  onTertiaryContainer: '#21005D',

  error: seed.error,
  onError: '#FFFFFF',
  errorContainer: '#F9DEDC',
  onErrorContainer: '#410E0B',

  background: '#FAFBFC',
  onBackground: '#1A1C1E',

  surface: '#FFFFFF',
  onSurface: '#1A1C1E',
  surfaceVariant: '#E1E2EC',
  onSurfaceVariant: '#44474F',

  // Elevation tints (MD3 surface tonal elevation)
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F4F6FA',
  surfaceContainer: '#EEF1F6',
  surfaceContainerHigh: '#E8ECF2',
  surfaceContainerHighest: '#E2E6ED',

  outline: '#74777F',
  // Subtle 1px border / divider tint — closer to rgba(0,0,0,0.08) than the
  // previous saturated grey. Keeps card outlines from competing for attention
  // in dense list surfaces.
  outlineVariant: '#E4E6EB',
  scrim: '#000000',

  inverseSurface: '#2F3033',
  inverseOnSurface: '#F1F0F4',
  inversePrimary: '#A4C7FF',
} as const;

// ---------------------------------------------------------------------------
// MD3 surface roles (dark)
// ---------------------------------------------------------------------------

export const darkRoles = {
  primary: '#A4C7FF',
  onPrimary: '#003258',
  primaryContainer: '#00497D',
  onPrimaryContainer: '#D3E3FD',

  secondary: '#BBC7DB',
  onSecondary: '#253141',
  secondaryContainer: '#3B4858',
  onSecondaryContainer: '#D7E3F8',

  tertiary: '#D0BCFF',
  onTertiary: '#381E72',
  tertiaryContainer: '#4F378B',
  onTertiaryContainer: '#EADDFF',

  error: '#F2B8B5',
  onError: '#601410',
  errorContainer: '#8C1D18',
  onErrorContainer: '#F9DEDC',

  background: '#0F1115',
  onBackground: '#E2E2E6',

  surface: '#161A1F',
  onSurface: '#E2E2E6',
  surfaceVariant: '#44474F',
  onSurfaceVariant: '#C4C6CF',

  surfaceContainerLowest: '#0B0E11',
  surfaceContainerLow: '#181C1F',
  surfaceContainer: '#1C2024',
  surfaceContainerHigh: '#262A2E',
  surfaceContainerHighest: '#313539',

  outline: '#8E9099',
  // Subtle dark-mode divider — closer to rgba(255,255,255,0.08).
  outlineVariant: '#2A2E33',
  scrim: '#000000',

  inverseSurface: '#E2E2E6',
  inverseOnSurface: '#2F3033',
  inversePrimary: seed.primary,
} as const;

// ---------------------------------------------------------------------------
// Typography — MD3 type scale tuned for Roboto Flex
// ---------------------------------------------------------------------------

export const fontFamily = {
  sans: 'Roboto Flex, Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
} as const;

export const typography = {
  display: {
    large: { fontSize: '57px', lineHeight: '64px', letterSpacing: '-0.25px', fontWeight: 400 },
    medium: { fontSize: '45px', lineHeight: '52px', letterSpacing: '0px', fontWeight: 400 },
    small: { fontSize: '36px', lineHeight: '44px', letterSpacing: '0px', fontWeight: 400 },
  },
  headline: {
    large: { fontSize: '32px', lineHeight: '40px', letterSpacing: '0px', fontWeight: 500 },
    medium: { fontSize: '28px', lineHeight: '36px', letterSpacing: '0px', fontWeight: 500 },
    small: { fontSize: '24px', lineHeight: '32px', letterSpacing: '0px', fontWeight: 500 },
  },
  title: {
    large: { fontSize: '22px', lineHeight: '28px', letterSpacing: '0px', fontWeight: 500 },
    medium: { fontSize: '16px', lineHeight: '24px', letterSpacing: '0.15px', fontWeight: 500 },
    small: { fontSize: '14px', lineHeight: '20px', letterSpacing: '0.1px', fontWeight: 500 },
  },
  body: {
    large: { fontSize: '16px', lineHeight: '24px', letterSpacing: '0.5px', fontWeight: 400 },
    medium: { fontSize: '14px', lineHeight: '20px', letterSpacing: '0.25px', fontWeight: 400 },
    small: { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.4px', fontWeight: 400 },
  },
  label: {
    large: { fontSize: '14px', lineHeight: '20px', letterSpacing: '0.1px', fontWeight: 500 },
    medium: { fontSize: '12px', lineHeight: '16px', letterSpacing: '0.5px', fontWeight: 500 },
    small: { fontSize: '11px', lineHeight: '16px', letterSpacing: '0.5px', fontWeight: 500 },
  },
} as const;

// ---------------------------------------------------------------------------
// Shape — corner radii in pixels.
//
// Tightened from MD3 defaults toward an enterprise SaaS density. The previous
// scale (xs:4, sm:8, md:12, lg:16, xl:28) felt soft / blobby on dense list
// surfaces. New scale keeps semantic names but maps them to crisper values.
// ---------------------------------------------------------------------------

export const shape = {
  none: 0,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  full: 999,
} as const;

// ---------------------------------------------------------------------------
// Elevation — soft, low-contrast shadows. MD3 prefers tonal elevation,
// so we keep z-shadows subtle and let surfaceContainer tints carry depth.
// ---------------------------------------------------------------------------

export const elevation = {
  level0: 'none',
  level1:
    '0px 1px 2px rgba(16, 24, 40, 0.05), 0px 1px 3px rgba(16, 24, 40, 0.06)',
  level2:
    '0px 1px 2px rgba(16, 24, 40, 0.06), 0px 2px 6px rgba(16, 24, 40, 0.06)',
  level3:
    '0px 4px 8px rgba(16, 24, 40, 0.08), 0px 1px 3px rgba(16, 24, 40, 0.04)',
  level4:
    '0px 6px 12px rgba(16, 24, 40, 0.10), 0px 2px 4px rgba(16, 24, 40, 0.06)',
  level5:
    '0px 12px 24px rgba(16, 24, 40, 0.12), 0px 4px 8px rgba(16, 24, 40, 0.08)',
} as const;

// ---------------------------------------------------------------------------
// Motion — MD3 standard duration + easing
// ---------------------------------------------------------------------------

export const motion = {
  duration: {
    short1: 50,
    short2: 100,
    short3: 150,
    short4: 200,
    medium1: 250,
    medium2: 300,
    medium3: 350,
    medium4: 400,
    long1: 450,
    long2: 500,
    long3: 550,
    long4: 600,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    standardAccelerate: 'cubic-bezier(0.3, 0, 1, 1)',
    standardDecelerate: 'cubic-bezier(0, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasizedAccelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
    emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  },
} as const;

// ---------------------------------------------------------------------------
// Spacing scale (MUI default 8 with semantic helpers)
// ---------------------------------------------------------------------------

export const spacing = {
  base: 8,
  page: { x: 24, y: 24 },
  card: { x: 24, y: 20 },
  field: { x: 16, y: 12 },
} as const;

// ---------------------------------------------------------------------------
// Z-index scale
// ---------------------------------------------------------------------------

export const zIndex = {
  drawer: 1100,
  appBar: 1200,
  modal: 1300,
  snackbar: 1400,
  tooltip: 1500,
} as const;

// Both palettes share the same key shape but values are literal hex types per `as const`,
// so the two are structurally incompatible. Widen to `Record<keyof typeof lightRoles, string>`
// so consumers accept either palette without a literal-type mismatch.
export type SurfaceRoles = { [K in keyof typeof lightRoles]: string };
export type Mode = 'light' | 'dark';
