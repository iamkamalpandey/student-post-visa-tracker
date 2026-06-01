'use client';

import { useId, type ReactNode } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  Typography,
  type DialogProps,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

export type AppDialogPrimaryAction = {
  label: string;
  /** Imperative click — provide this for non-form actions. */
  onClick?: () => void | Promise<void>;
  /** Submit the form whose `id` matches; takes precedence over onClick when both are set. */
  formId?: string;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  /** "primary" (default) for create/save, "error" for destructive flows. */
  color?: 'primary' | 'error' | 'warning' | 'success' | 'inherit';
};

export type AppDialogSecondaryAction = {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
};

export type AppDialogProps = {
  open: boolean;
  /** Headline rendered in the title bar. */
  title: string;
  /** Optional 1-line description rendered below the title in the same DialogTitle. */
  subtitle?: ReactNode;
  /** Inline error banner above the children — used for non-field server errors. */
  errorText?: string | null;
  /** Body content (typically a <form>). */
  children: ReactNode;
  primaryAction: AppDialogPrimaryAction;
  /** Cancel button. Defaults to label "Cancel" + onClick={onClose}. */
  secondaryAction?: AppDialogSecondaryAction;
  onClose: () => void;
  /** MUI maxWidth — defaults to "sm". Use "md" for forms with two columns. */
  maxWidth?: DialogProps['maxWidth'];
  /** Hide the top-right close icon. Defaults to false (icon shown). */
  hideCloseIcon?: boolean;
  /** Render fullscreen — used by dedicated edit-page routes. */
  fullScreen?: boolean;
};

/**
 * Canonical wrapper for simple form modals. Standardises:
 *
 * - DialogTitle: title + subtitle, h6 weight 600, top-right Close icon.
 * - Divider beneath the title bar.
 * - DialogContent: 24px padding, optional inline error Alert.
 * - DialogActions: Cancel (outlined, color="inherit") + Primary (contained).
 *
 * For destructive confirmations prefer `<ConfirmDialog>` (which adds a typed
 * confirmation gate). For complex multi-step wizards keep using a raw
 * `<Dialog>` — this wrapper deliberately doesn't try to cover everything.
 */
export default function AppDialog({
  open,
  title,
  subtitle,
  errorText,
  children,
  primaryAction,
  secondaryAction,
  onClose,
  maxWidth = 'sm',
  hideCloseIcon = false,
  fullScreen = false,
}: AppDialogProps) {
  const loading = Boolean(primaryAction.loading);
  const dismiss = loading ? undefined : onClose;
  const cancelDisabled = secondaryAction?.disabled ?? loading;
  const titleId = useId();

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      fullWidth
      maxWidth={maxWidth}
      fullScreen={fullScreen}
      scroll="paper"
      aria-labelledby={titleId}
      slotProps={{
        // Stronger backdrop scrim + paper shadow so the modal edges don't blend
        // into a near-identical page background.
        backdrop: { sx: { backgroundColor: 'rgba(15, 17, 21, 0.55)' } },
      }}
      PaperProps={fullScreen ? undefined : { elevation: 8 }}
    >
      <DialogTitle sx={{ pr: hideCloseIcon ? 3 : 6 }}>
        <Stack spacing={subtitle ? 0.5 : 0}>
          <Typography
            id={titleId}
            variant="h6"
            component="span"
            // 1.05rem (~16.8px) is denser than the default h6 (1.125rem) and
            // matches the enterprise-SaaS dialog feel.
            sx={{ fontWeight: 600, fontSize: '1.05rem', lineHeight: 1.3 }}
          >
            {title}
          </Typography>
          {subtitle ? (
            typeof subtitle === 'string' ? (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            ) : (
              subtitle
            )
          ) : null}
        </Stack>
        {hideCloseIcon ? null : (
          <IconButton
            aria-label="Close dialog"
            onClick={onClose}
            disabled={loading}
            size="small"
            // Use the logical `insetInlineEnd` so the close icon lands on the
            // inline-end edge in both LTR (right) and RTL (left) without us
            // having to read the locale here.
            sx={{ position: 'absolute', insetInlineEnd: 12, top: 12 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ px: 3, py: 2.5 }}>
        {errorText ? (
          <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
            {errorText}
          </Alert>
        ) : null}
        {children}
      </DialogContent>
      <DialogActions
        sx={{
          px: 3,
          py: 2,
          gap: 1,
          borderTop: (t) => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.paper',
        }}
      >
        <Button
          onClick={secondaryAction?.onClick ?? onClose}
          disabled={cancelDisabled}
          variant="outlined"
          color="inherit"
        >
          {secondaryAction?.label ?? 'Cancel'}
        </Button>
        <Button
          type={primaryAction.formId ? 'submit' : 'button'}
          form={primaryAction.formId}
          onClick={primaryAction.formId ? undefined : () => void primaryAction.onClick?.()}
          variant="contained"
          color={primaryAction.color ?? 'primary'}
          disabled={primaryAction.disabled || loading}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {loading ? primaryAction.loadingLabel ?? `${primaryAction.label}…` : primaryAction.label}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
