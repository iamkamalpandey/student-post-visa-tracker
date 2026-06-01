'use client';

import { useId } from 'react';
import { FormControl, FormHelperText, FormLabel, useTheme } from '@mui/material';
import { PhoneInput } from 'react-international-phone';
import 'react-international-phone/style.css';

export type PhoneFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  defaultCountry?: string; // ISO alpha2 (lowercase expected by react-international-phone)
  error?: boolean;
  helperText?: string;
  required?: boolean;
  fullWidth?: boolean;
  disabled?: boolean;
  placeholder?: string;
};

/**
 * MUI-themed wrapper around react-international-phone's <PhoneInput>.
 * Emits an E.164 string ("+<country><subscriber>") via onChange.
 */
export default function PhoneField({
  label,
  value,
  onChange,
  defaultCountry = 'np',
  error = false,
  helperText,
  required = false,
  fullWidth = true,
  disabled = false,
  placeholder,
}: PhoneFieldProps) {
  const theme = useTheme();
  const id = useId();
  const helperId = `${id}-helper`;

  const borderColor = error
    ? theme.palette.error.main
    : theme.palette.mode === 'light'
      ? 'rgba(0, 0, 0, 0.23)'
      : 'rgba(255, 255, 255, 0.23)';
  const hoverBorderColor = error ? theme.palette.error.main : theme.palette.text.primary;
  const focusBorderColor = error ? theme.palette.error.main : theme.palette.primary.main;

  const country = (defaultCountry || 'np').toLowerCase();

  return (
    <FormControl
      fullWidth={fullWidth}
      error={error}
      required={required}
      disabled={disabled}
      sx={{
        '& .react-international-phone-input-container': {
          width: '100%',
          borderRadius: 1,
          border: `1px solid ${borderColor}`,
          transition: theme.transitions.create(['border-color', 'box-shadow']),
          '&:hover': {
            borderColor: hoverBorderColor,
          },
          '&:focus-within': {
            borderColor: focusBorderColor,
            boxShadow: `0 0 0 1px ${focusBorderColor}`,
          },
        },
        '& .react-international-phone-country-selector-button': {
          height: 40,
          border: 'none',
          borderRight: `1px solid ${borderColor}`,
          borderRadius: 0,
          backgroundColor: 'transparent',
          paddingLeft: 1,
          paddingRight: 1,
        },
        '& .react-international-phone-input': {
          height: 40,
          flex: 1,
          border: 'none',
          outline: 'none',
          fontSize: theme.typography.body1.fontSize,
          fontFamily: theme.typography.fontFamily,
          color: theme.palette.text.primary,
          backgroundColor: 'transparent',
          paddingLeft: theme.spacing(1.5),
          paddingRight: theme.spacing(1.5),
          borderRadius: 0,
          '&::placeholder': {
            color: theme.palette.text.secondary,
            opacity: 0.7,
          },
          '&:disabled': {
            color: theme.palette.text.disabled,
          },
        },
      }}
    >
      <FormLabel
        htmlFor={id}
        sx={{
          fontSize: 12,
          fontWeight: 500,
          mb: 0.5,
          color: error ? theme.palette.error.main : theme.palette.text.secondary,
        }}
      >
        {label}
        {required ? ' *' : ''}
      </FormLabel>
      <PhoneInput
        inputProps={{
          id,
          'aria-describedby': helperText ? helperId : undefined,
          'aria-invalid': error || undefined,
          'aria-required': required || undefined,
          placeholder,
        }}
        defaultCountry={country as Parameters<typeof PhoneInput>[0]['defaultCountry']}
        value={value ?? ''}
        onChange={(phone) => onChange(phone)}
        disabled={disabled}
      />
      <FormHelperText id={helperId} error={error}>
        {helperText ?? ' '}
      </FormHelperText>
    </FormControl>
  );
}
