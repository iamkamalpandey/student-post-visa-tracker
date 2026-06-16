'use client';

import { useState } from 'react';
import {
  Alert, Autocomplete, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';

import { api, ApiError } from '@/lib/api';
import { useConvertLead, type CrmLeadDetail, type ConvertStudentPayload } from '@/lib/queries';

type ProgramOption = { id: string; label: string };

const GENDERS = ['NOT_KNOWN', 'MALE', 'FEMALE', 'NOT_APPLICABLE'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function mapGender(g: string | null): string {
  const v = (g ?? '').trim().toLowerCase();
  if (v.startsWith('m')) return 'MALE';
  if (v.startsWith('f')) return 'FEMALE';
  return 'NOT_KNOWN';
}

// Convert a CRM lead → a managed Student. The form is pre-filled from the lead;
// the admin confirms + supplies the fields V2 doesn't carry (nationality, DOB).
export default function ConvertToStudentDialog({
  lead, open, onClose, onConverted,
}: {
  lead: CrmLeadDetail;
  open: boolean;
  onClose: () => void;
  onConverted: (studentId: string, code: string) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const convert = useConvertLead(lead.id);
  // Reconciliation: search the CURATED app catalog (never the V2 mirror) for the
  // Program to enrol into. Optional — blank leaves enrolment for the Studies tab.
  // Suggest the lead's visa-accepted course as the initial catalog search term
  // (prefer the visa_accepted lead_course; fall back to legacy free-text, then first).
  const suggestedCourse = (() => {
    const lcs = lead.lead_courses ?? [];
    const va =
      lcs.find((lc) => lc.state_v2 === 'visa_accepted') ??
      lcs.find((lc) => /visa.*accept/i.test(lc.state ?? '')) ??
      lcs[0];
    return { name: va?.course?.name?.trim() ?? '', inst: va?.course?.institution?.name?.trim() ?? '' };
  })();
  const [programId, setProgramId] = useState<string | null>(null);
  const [programInput, setProgramInput] = useState(suggestedCourse.name);
  const programsQuery = useQuery({
    queryKey: ['convert-program-search', programInput],
    enabled: open && programInput.trim().length >= 2,
    queryFn: async () => {
      const res = await api.get('/programs', { params: { q: programInput.trim(), limit: 20 } });
      const raw = (res.data as { data?: unknown[] }).data ?? (res.data as unknown[]);
      return (Array.isArray(raw) ? raw : []).map((p) => {
        const row = p as { id: string; name?: string; code?: string; institution_name?: string; institution?: { display_name?: string } };
        const inst = row.institution_name ?? row.institution?.display_name;
        return { id: row.id, label: `${row.name ?? row.code ?? row.id}${inst ? ` · ${inst}` : ''}` };
      }) as ProgramOption[];
    },
  });
  const [f, setF] = useState({
    given_name: lead.first_name || '',
    family_name: lead.last_name || lead.first_name || '',
    name_in_passport: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
    date_of_birth: lead.dob && ISO_DATE.test(lead.dob) ? lead.dob : '',
    gender: mapGender(lead.gender),
    // Default to NP (V2 is a Nepal consultancy); editable. V2 carries no
    // reliable nationality, so this is a sensible starting value, not a guess.
    nationality_code: 'NP',
    primary_language: 'en',
    email_primary: lead.email ?? '',
    phone_primary_e164: lead.phone_number?.startsWith('+') ? lead.phone_number : '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const canSubmit =
    !!f.given_name.trim() && !!f.family_name.trim() && !!f.name_in_passport.trim() &&
    ISO_DATE.test(f.date_of_birth) && f.nationality_code.trim().length === 2;

  function submit() {
    const payload: ConvertStudentPayload = {
      given_name: f.given_name.trim(),
      family_name: f.family_name.trim(),
      name_in_passport: f.name_in_passport.trim(),
      date_of_birth: f.date_of_birth,
      gender: f.gender,
      nationality_code: f.nationality_code.trim().toUpperCase(),
      primary_language: f.primary_language.trim() || 'en',
      ...(f.email_primary.trim() ? { email_primary: f.email_primary.trim() } : {}),
      ...(f.phone_primary_e164.trim() ? { phone_primary_e164: f.phone_primary_e164.trim() } : {}),
      ...(programId ? { program_id: programId } : {}),
    };
    convert.mutate(payload, {
      onSuccess: (r) => {
        const feeNote = r.fees_migrated ? ` · ${r.fees_migrated} fee(s) migrated` : '';
        const enrolNote = r.enrollment_created ? ' · enrolled' : '';
        enqueueSnackbar(`Created student ${r.student_code}${feeNote}${enrolNote}.`, { variant: 'success' });
        onConverted(r.student_id, r.student_code);
        onClose();
      },
      onError: (err) =>
        enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Conversion failed', { variant: 'error' }),
    });
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Convert lead to managed student</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Creates a managed Student (with documents, enrollment + billing) linked to this lead. Confirm the
          details — some fields aren&apos;t carried in the CRM data.
        </Alert>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField fullWidth size="small" label="Given name" value={f.given_name} onChange={set('given_name')} required />
            <TextField fullWidth size="small" label="Family name" value={f.family_name} onChange={set('family_name')} required />
          </Stack>
          <TextField fullWidth size="small" label="Name in passport" value={f.name_in_passport} onChange={set('name_in_passport')} required />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField fullWidth size="small" type="date" label="Date of birth" InputLabelProps={{ shrink: true }} value={f.date_of_birth} onChange={set('date_of_birth')} required />
            <TextField fullWidth size="small" select label="Gender" value={f.gender} onChange={set('gender')}>
              {GENDERS.map((g) => <MenuItem key={g} value={g}>{g.replace(/_/g, ' ')}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField fullWidth size="small" label="Nationality (ISO-2)" placeholder="NP" value={f.nationality_code} onChange={set('nationality_code')} inputProps={{ maxLength: 2 }} required />
            <TextField fullWidth size="small" label="Language (ISO-2)" value={f.primary_language} onChange={set('primary_language')} inputProps={{ maxLength: 2 }} />
          </Stack>
          <TextField fullWidth size="small" label="Email" value={f.email_primary} onChange={set('email_primary')} />
          <TextField fullWidth size="small" label="Phone (E.164, +…)" value={f.phone_primary_e164} onChange={set('phone_primary_e164')} />
          <Autocomplete<ProgramOption>
            size="small"
            options={programsQuery.data ?? []}
            getOptionLabel={(o) => o.label}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            loading={programsQuery.isFetching}
            inputValue={programInput}
            onInputChange={(_, v) => setProgramInput(v)}
            onChange={(_, v) => setProgramId(v ? v.id : null)}
            noOptionsText={programInput.trim().length < 2 ? 'Type to search your catalog…' : 'No matching program'}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Enrol in program (optional)"
                helperText={
                  suggestedCourse.name
                    ? `From lead's course: “${suggestedCourse.name}”${suggestedCourse.inst ? ` · ${suggestedCourse.inst}` : ''} — pick the matching catalog program, or clear.`
                    : 'Search your curated catalog — leave blank to enrol later.'
                }
              />
            )}
          />
        </Stack>
        {!canSubmit ? (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1.5 }}>
            Enter date of birth and a 2-letter nationality code to enable Convert.
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">Cancel</Button>
        <Button onClick={submit} variant="contained" disabled={!canSubmit || convert.isPending}>
          {convert.isPending ? 'Converting…' : 'Convert'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
