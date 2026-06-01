'use client';

// CurrencyAutocomplete
// ---------------------------------------------------------------------------
// Lightweight ISO-4217 currency picker backed by `useCurrencies()`. Renders a
// MUI <Autocomplete> showing "USD — US Dollar"-style labels and emits the
// bare currency code string via onChange so callers can wire it straight into
// react-hook-form Controllers (or any other "string in, string out" field)
// without changing their existing zod schemas.
//
// Designed as a drop-in replacement for the bare <TextField select>/<TextField>
// patterns used by FeeListDialog, SponsorshipsSection, FinanceSection, and
// AccommodationsSection.

import type { ReactNode } from 'react';
import {
  Autocomplete,
  CircularProgress,
  TextField,
  type AutocompleteProps,
} from '@mui/material';
import { useCurrencies, type CurrencyLookup } from '@/lib/queries';

export type CurrencyAutocompleteProps = {
  /** Currency code (e.g. "GBP") or empty string when unset. */
  value: string;
  onChange: (next: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  error?: boolean;
  helperText?: ReactNode;
  /** Allow clearing back to "" — defaults to true. */
  clearable?: boolean;
  /** Forward HTML name so RHF can pick it up if the caller wants. */
  name?: string;
  /** Pass-through for additional Autocomplete props (e.g. size). */
  size?: AutocompleteProps<CurrencyLookup, false, false, false>['size'];
};

const labelOf = (option: CurrencyLookup): string =>
  `${option.code}${option.name ? ` — ${option.name}` : ''}`;

export default function CurrencyAutocomplete({
  value,
  onChange,
  label = 'Currency',
  placeholder,
  required = false,
  disabled = false,
  fullWidth = true,
  error = false,
  helperText,
  clearable = true,
  name,
  size,
}: CurrencyAutocompleteProps) {
  const { data, isLoading } = useCurrencies();
  const options = data ?? [];
  // Resolve the controlled currency code back to an option object so the
  // Autocomplete shows the rich label rather than a bare 3-letter code.
  const selected = options.find((c) => c.code === value) ?? null;

  return (
    <Autocomplete<CurrencyLookup, false, false, false>
      options={options}
      value={selected}
      loading={isLoading}
      disabled={disabled}
      fullWidth={fullWidth}
      size={size}
      disableClearable={(!clearable) as false}
      isOptionEqualToValue={(opt, val) => opt.code === val.code}
      getOptionLabel={(opt) => (typeof opt === 'string' ? opt : labelOf(opt))}
      onChange={(_, next) => onChange(next ? next.code : '')}
      renderOption={(props, option) => (
        <li {...props} key={option.code}>
          {labelOf(option)}
        </li>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          name={name}
          label={label}
          placeholder={placeholder ?? 'GBP'}
          required={required}
          error={error}
          helperText={helperText}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {isLoading ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}
