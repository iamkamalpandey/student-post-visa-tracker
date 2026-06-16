'use client';

import { useState } from 'react';
import NextLink from 'next/link';
import { Box, Chip, Link as MuiLink, Stack, Tab, Tabs, Typography } from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';

import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import {
  useInstitutionsReport, useCoursesReport,
  type InstitutionReportRow, type CourseReportRow,
} from '@/lib/queries';

const instColumns: DataTableColumn<InstitutionReportRow>[] = [
  { key: 'name', label: 'Institution', render: (r) => <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.name}</Typography> },
  { key: 'country', label: 'Country', render: (r) => r.country_name ?? '—' },
  { key: 'leads', label: 'Leads', align: 'right', render: (r) => r.leads },
  { key: 'va', label: 'Visa-accepted', align: 'right', render: (r) => <Chip size="small" color="success" label={r.visa_accepted} sx={{ fontWeight: 700 }} /> },
];

const courseColumns: DataTableColumn<CourseReportRow>[] = [
  { key: 'course', label: 'Course', render: (r) => <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.course_name}</Typography> },
  { key: 'inst', label: 'Institution', render: (r) => r.institution_name ?? '—' },
  { key: 'country', label: 'Country', render: (r) => r.country_name ?? '—' },
  { key: 'va', label: 'Visa-accepted', align: 'right', render: (r) => <Chip size="small" color="success" label={r.visa_accepted} sx={{ fontWeight: 700 }} /> },
];

export default function Client() {
  const [tab, setTab] = useState(0);
  const inst = useInstitutionsReport();
  const courses = useCoursesReport();
  const instRows = inst.data ?? [];
  const courseRows = courses.data ?? [];

  return (
    <Stack spacing={2.5}>
      <MuiLink component={NextLink} href="/leads" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 14 }}>
        <ArrowBackOutlinedIcon fontSize="small" /> Applications
      </MuiLink>

      <Box>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>CRM catalog report</Typography>
        <Typography variant="body2" color="text.secondary">
          Institutions + courses of visa-accepted leads (read-only, mirrored from V2).
        </Typography>
      </Box>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
        <Tab label={`Institutions (${instRows.length})`} sx={{ textTransform: 'none', fontWeight: 600 }} />
        <Tab label={`Courses (${courseRows.length})`} sx={{ textTransform: 'none', fontWeight: 600 }} />
      </Tabs>

      {tab === 0 ? (
        inst.isError ? (
          <ErrorState onRetry={() => void inst.refetch()} />
        ) : (
          <DataTable<InstitutionReportRow>
            columns={instColumns}
            rows={instRows}
            rowCount={instRows.length}
            loading={inst.isLoading}
            getRowId={(r) => r.institution_id ?? r.name}
            emptyTitle="No institutions"
            emptyDescription="Sync visa-accepted leads to populate this report."
            ariaLabel="Institutions report"
            pageSize={100}
          />
        )
      ) : courses.isError ? (
        <ErrorState onRetry={() => void courses.refetch()} />
      ) : (
        <DataTable<CourseReportRow>
          columns={courseColumns}
          rows={courseRows}
          rowCount={courseRows.length}
          loading={courses.isLoading}
          getRowId={(r) => `${r.course_name}|${r.institution_name ?? ''}`}
          emptyTitle="No courses"
          emptyDescription="Sync visa-accepted leads to populate this report."
          ariaLabel="Courses report"
          pageSize={100}
        />
      )}
    </Stack>
  );
}
