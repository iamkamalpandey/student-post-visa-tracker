'use client';

import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';
import {
  darkRoles,
  elevation,
  fontFamily,
  lightRoles,
  motion,
  shape,
  typography as scale,
  zIndex,
  type Mode,
  type SurfaceRoles,
} from './tokens';

declare module '@mui/material/styles' {
  interface Palette {
    surfaceContainerLowest: Palette['primary'];
    surfaceContainerLow: Palette['primary'];
    surfaceContainer: Palette['primary'];
    surfaceContainerHigh: Palette['primary'];
    surfaceContainerHighest: Palette['primary'];
  }
  interface PaletteOptions {
    surfaceContainerLowest?: PaletteOptions['primary'];
    surfaceContainerLow?: PaletteOptions['primary'];
    surfaceContainer?: PaletteOptions['primary'];
    surfaceContainerHigh?: PaletteOptions['primary'];
    surfaceContainerHighest?: PaletteOptions['primary'];
  }
}

const buildPalette = (mode: Mode, roles: SurfaceRoles): ThemeOptions['palette'] => ({
  mode,
  primary: {
    main: roles.primary,
    contrastText: roles.onPrimary,
    light: roles.primaryContainer,
    dark: roles.onPrimaryContainer,
  },
  secondary: {
    main: roles.secondary,
    contrastText: roles.onSecondary,
    light: roles.secondaryContainer,
    dark: roles.onSecondaryContainer,
  },
  error: {
    main: roles.error,
    contrastText: roles.onError,
    light: roles.errorContainer,
    dark: roles.onErrorContainer,
  },
  warning: { main: '#B26A00', contrastText: '#FFFFFF' },
  info: { main: '#0277BD', contrastText: '#FFFFFF' },
  success: { main: '#1E8E3E', contrastText: '#FFFFFF' },
  background: {
    default: roles.background,
    paper: roles.surface,
  },
  text: {
    primary: roles.onSurface,
    secondary: roles.onSurfaceVariant,
    disabled: mode === 'light' ? 'rgba(26,28,30,0.38)' : 'rgba(226,226,230,0.38)',
  },
  divider: roles.outlineVariant,
  surfaceContainerLowest: { main: roles.surfaceContainerLowest, contrastText: roles.onSurface },
  surfaceContainerLow: { main: roles.surfaceContainerLow, contrastText: roles.onSurface },
  surfaceContainer: { main: roles.surfaceContainer, contrastText: roles.onSurface },
  surfaceContainerHigh: { main: roles.surfaceContainerHigh, contrastText: roles.onSurface },
  surfaceContainerHighest: { main: roles.surfaceContainerHighest, contrastText: roles.onSurface },
});

export function createAppTheme(mode: Mode = 'light'): Theme {
  const roles = mode === 'light' ? lightRoles : darkRoles;
  const palette = buildPalette(mode, roles);

  const base = createTheme({
    palette,
    // Global default border radius — was shape.md (was 12, now 8). Tightened
    // to shape.sm (6) for an enterprise SaaS density. Components that need a
    // softer corner opt up via shape.md / shape.lg explicitly below.
    shape: { borderRadius: shape.sm },
    spacing: 8,
    zIndex,
    typography: {
      fontFamily: fontFamily.sans,
      // 14px body root for denser SaaS surfaces. htmlFontSize stays at 16 so
      // rem-based spacing (used by MUI internals) remains consistent.
      fontSize: 14,
      htmlFontSize: 16,
      fontWeightLight: 300,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 600,
      h1: { ...scale.display.small, letterSpacing: '-0.01em' },
      h2: { ...scale.headline.large, letterSpacing: '-0.01em' },
      h3: { ...scale.headline.medium, letterSpacing: '-0.01em' },
      h4: { ...scale.headline.small, letterSpacing: '-0.01em' },
      h5: scale.title.large,
      h6: scale.title.medium,
      subtitle1: scale.title.medium,
      subtitle2: scale.title.small,
      // body1 / body2 sit on the smaller end of the MD3 scale to match the
      // 14px root — scale.body.medium = 14, scale.body.small = 12.
      body1: scale.body.medium,
      body2: scale.body.small,
      button: { ...scale.label.large, textTransform: 'none' as const },
      caption: scale.body.small,
      overline: { ...scale.label.small, textTransform: 'uppercase' as const },
    },
    transitions: {
      easing: {
        easeInOut: motion.easing.standard,
        easeOut: motion.easing.standardDecelerate,
        easeIn: motion.easing.standardAccelerate,
        sharp: motion.easing.emphasized,
      },
      duration: {
        shortest: motion.duration.short1,
        shorter: motion.duration.short2,
        short: motion.duration.short4,
        standard: motion.duration.medium2,
        complex: motion.duration.medium4,
        enteringScreen: motion.duration.medium2,
        leavingScreen: motion.duration.short4,
      },
    },
  });

  base.shadows[1] = elevation.level1;
  base.shadows[2] = elevation.level2;
  base.shadows[3] = elevation.level3;
  base.shadows[4] = elevation.level4;
  base.shadows[6] = elevation.level5;

  return createTheme(base, {
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' },
          body: { backgroundColor: roles.background, color: roles.onSurface },
          '*::-webkit-scrollbar': { width: 10, height: 10 },
          '*::-webkit-scrollbar-track': { background: 'transparent' },
          '*::-webkit-scrollbar-thumb': {
            background: roles.outlineVariant,
            borderRadius: 999,
          },
          '*::-webkit-scrollbar-thumb:hover': { background: roles.outline },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, size: 'medium' },
        styleOverrides: {
          root: {
            textTransform: 'none' as const,
            fontWeight: 500,
            // Tightened from shape.lg (was 16) to 6 for enterprise density —
            // no more pill-shaped action buttons.
            borderRadius: 6,
            paddingInline: 16,
            paddingBlock: 8,
            minHeight: 36,
            letterSpacing: 0.1,
            transition: `background-color ${motion.duration.short4}ms ${motion.easing.standard}, box-shadow ${motion.duration.short4}ms ${motion.easing.standard}`,
            '&.Mui-focusVisible': {
              outline: `2px solid ${roles.primary}`,
              outlineOffset: 2,
            },
          },
          sizeSmall: { minHeight: 30, paddingInline: 12, paddingBlock: 5 },
          sizeLarge: { minHeight: 44, paddingInline: 22, paddingBlock: 10 },
          containedPrimary: {
            boxShadow: 'none',
            '&:hover': { boxShadow: elevation.level1 },
          },
          outlined: {
            borderColor: roles.outlineVariant,
            '&:hover': { borderColor: roles.outline, backgroundColor: 'transparent' },
          },
          text: {
            paddingInline: 12,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: shape.full,
            transition: `background-color ${motion.duration.short3}ms ${motion.easing.standard}`,
            '&.Mui-focusVisible': {
              outline: `2px solid ${roles.primary}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none' as const,
            fontWeight: 600,
            minHeight: 44,
            '&.Mui-focusVisible': {
              outline: `2px solid ${roles.primary}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiTextField: {
        defaultProps: {
          variant: 'outlined',
          // Denser SaaS default — was 'medium'. Pages that need a chunkier
          // field can opt back in via size="medium".
          size: 'small',
          fullWidth: true,
          // Always shrink the label. Otherwise the un-shrunk label sits on top of
          // the outlined fieldset border and looks struck-through (see screenshot).
          // With shrink=true the label moves into the notch and the placeholder
          // (rendered when the field is empty) gives the user the contextual hint.
          InputLabelProps: { shrink: true },
        },
      },
      MuiAutocomplete: {
        defaultProps: { size: 'small' },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            // shape.sm is now 6 — same crisp corner as buttons.
            borderRadius: shape.sm,
            backgroundColor: 'transparent',
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: roles.outlineVariant,
            },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: roles.outline,
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: 2,
            },
            // Browser default for <legend> applies padding and inherits font styles,
            // which produces a visual "strikethrough" through the floating label.
            // Lock the legend's font-size to a fraction so its width matches the
            // shrunk label and the notch cleanly cuts the outline.
            '& .MuiOutlinedInput-notchedOutline legend': {
              fontSize: '0.75em',
              padding: 0,
            },
          },
          input: {
            // Denser hit-target — small TextField default + 14px font for SaaS.
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 12,
            paddingRight: 12,
            fontSize: 14,
            lineHeight: 1.5,
          },
          inputSizeSmall: {
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
          },
          notchedOutline: { borderRadius: shape.sm },
          multiline: { padding: 0 },
        },
      },
      MuiInputBase: {
        styleOverrides: {
          inputMultiline: { padding: '10px 12px' },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: { fontSize: 14, fontWeight: 500 },
          // The shrunk label sits in the notch — give it a touch of horizontal
          // breathing room so it doesn't kiss the border.
          shrink: { paddingLeft: 2, paddingRight: 4 },
        },
      },
      MuiFormHelperText: {
        styleOverrides: {
          root: { marginLeft: 4, marginTop: 4, fontSize: 12 },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0, color: 'transparent' },
        styleOverrides: {
          root: {
            backgroundColor: roles.surface,
            color: roles.onSurface,
            borderBottom: `1px solid ${roles.outlineVariant}`,
            backgroundImage: 'none',
            boxShadow: 'none',
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: roles.surface,
            borderRight: `1px solid ${roles.outlineVariant}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            // shape.md is now 8 — flat enterprise card with a 1px border.
            borderRadius: shape.md,
            backgroundColor: roles.surface,
            border: `1px solid ${roles.outlineVariant}`,
            boxShadow: 'none',
            transition: `box-shadow ${motion.duration.short4}ms ${motion.easing.standard}, transform ${motion.duration.short4}ms ${motion.easing.standard}`,
            // No hover lift by default — cards are surfaces, not buttons. Keep
            // hover flat to feel like an enterprise SaaS list.
          },
        },
      },
      MuiCardContent: {
        // Denser content padding — 24px → 16px for SaaS rhythm.
        styleOverrides: { root: { padding: 16, '&:last-child': { paddingBottom: 16 } } },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: 'none' },
          rounded: { borderRadius: shape.md },
        },
      },
      MuiChip: {
        defaultProps: { size: 'small' },
        styleOverrides: {
          root: {
            // Was shape.sm (was 8) — tighter 4px corner reads as a label, not
            // a pill. StatusChip / StageChip override per their own designs.
            borderRadius: 4,
            fontWeight: 500,
            letterSpacing: 0.1,
          },
        },
      },
      MuiDialog: {
        defaultProps: { maxWidth: 'sm' },
        styleOverrides: {
          paper: {
            // Dialog used MD3 28px corner — way too soft. 10px gives the
            // dialog a clear surface edge without looking square.
            borderRadius: 10,
            border: `1px solid ${roles.outlineVariant}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontSize: '1.05rem',
            fontWeight: 600,
            paddingTop: 16,
            paddingBottom: 12,
            paddingInline: 24,
          },
        },
      },
      MuiDialogContent: {
        styleOverrides: {
          root: { paddingInline: 24, paddingTop: 20, paddingBottom: 20 },
        },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: { paddingInline: 24, paddingTop: 16, paddingBottom: 16, gap: 8 },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 6 },
        },
      },
      MuiTableCell: {
        defaultProps: { size: 'small' },
        styleOverrides: {
          root: {
            borderColor: roles.outlineVariant,
          },
          head: {
            fontWeight: 600,
            color: roles.onSurface,
            backgroundColor: roles.surfaceContainerLow,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: shape.full,
            margin: '2px 8px',
            paddingInline: 16,
            paddingBlock: 10,
            minHeight: 44,
            '&.Mui-selected': {
              backgroundColor: roles.secondaryContainer,
              color: roles.onSecondaryContainer,
              '& .MuiListItemIcon-root': { color: roles.onSecondaryContainer },
              '&:hover': { backgroundColor: roles.secondaryContainer },
            },
            '&.Mui-focusVisible': {
              outline: `2px solid ${roles.primary}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiListItemIcon: {
        styleOverrides: { root: { minWidth: 40, color: roles.onSurfaceVariant } },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: roles.inverseSurface,
            color: roles.inverseOnSurface,
            // shape.xs = 4 — already tight; explicit to lock it.
            borderRadius: 4,
            fontSize: 12,
            paddingBlock: 6,
            paddingInline: 10,
          },
        },
      },
      MuiDivider: {
        styleOverrides: { root: { borderColor: roles.outlineVariant } },
      },
      MuiSnackbar: {
        styleOverrides: { root: { '& .MuiSnackbarContent-root': { borderRadius: shape.sm } } },
      },
      MuiLink: {
        defaultProps: { underline: 'hover' },
      },
    },
  });
}

export const lightTheme = createAppTheme('light');
export const darkTheme = createAppTheme('dark');
