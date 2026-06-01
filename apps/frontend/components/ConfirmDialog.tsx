'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

export type ConfirmDialogProps = {
  open: boolean;
  /** Headline rendered in the title bar. */
  title: string;
  /** Body explaining what will happen — usually a single sentence. */
  description?: ReactNode;
  /**
   * The exact label the user must type to enable the confirm button. Use the
   * resource's natural identifier (e.g. its name or code). Set to null/undefined
   * to skip the typed-confirmation requirement.
   */
  confirmLabel?: string | null;
  /** Text on the confirm button (default: "Delete"). */
  confirmText?: string;
  /** Text on the cancel button (default: "Cancel"). */
  cancelText?: string;
  /** When true, displays an inline error returned from the mutation. */
  errorText?: string | null;
  /** Disables the confirm button and shows a spinner. */
  loading?: boolean;
  /** "error" → red confirm button (default). "primary" for non-destructive flows. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
};

/**
 * Typed-confirmation dialog. The user must enter `confirmLabel` verbatim before
 * the destructive button is enabled; for non-destructive confirmations omit
 * `confirmLabel`.
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  errorText,
  loading = false,
  destructive = true,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  // Reset the input whenever the dialog opens.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const requiresTyping = Boolean(confirmLabel);
  const matches = !requiresTyping || typed.trim() === confirmLabel;
  const disabled = loading || !matches;

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="confirm-dialog-title"
    >
      <DialogTitle id="confirm-dialog-title" sx={{ fontWeight: 700 }}>
        {title}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {description ? (
            typeof description === 'string' ? (
              <DialogContentText>{description}</DialogContentText>
            ) : (
              description
            )
          ) : null}
          {requiresTyping ? (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                To confirm, type{' '}
                <Typography component="span" sx={{ fontWeight: 700 }}>
                  {confirmLabel}
                </Typography>{' '}
                below.
              </Typography>
              <TextField
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                size="small"
                autoFocus
                fullWidth
                placeholder={confirmLabel ?? ''}
                disabled={loading}
                inputProps={{ 'aria-label': 'Confirmation text' }}
              />
            </Stack>
          ) : null}
          {errorText ? <Alert severity="error">{errorText}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={loading} color="inherit">
          {cancelText}
        </Button>
        <Button
          onClick={() => void onConfirm()}
          disabled={disabled}
          color={destructive ? 'error' : 'primary'}
          variant="contained"
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
