'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Chip,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';
import LabeledField from '@/components/LabeledField';
import AppDialog from '@/components/AppDialog';
import { INTERVIEW_QUESTION_CATEGORY_LABEL } from '@spv/zod-schemas';
import type { InterviewAttemptRow, InterviewAnswerRow } from '@/features/interview-prep/types';

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'default'> = {
  COMPLETED: 'success',
  IN_PROGRESS: 'warning',
  ABANDONED: 'default',
};

const CATEGORY_LABELS = INTERVIEW_QUESTION_CATEGORY_LABEL as Record<string, string>;

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600 }}>Interview attempts</Typography>
      </Stack>
      <EmptyState icon={<LockOutlinedIcon />} title="Admin only" description="Administrator access required." />
    </Stack>
  );
}

type AttemptDetail = InterviewAttemptRow & { answers: InterviewAnswerRow[] };

export default function InterviewAttemptsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [statusFilter, setStatusFilter] = useState<string>('');
  const [viewingId, setViewingId] = useState<string | null>(null);

  const attemptsQuery = useQuery({
    queryKey: ['interview-attempts', statusFilter || null],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.get<{ data: InterviewAttemptRow[]; next_cursor: string | null }>('/interview-attempts', { params });
      return res.data;
    },
    enabled: isAdmin,
  });

  const detailQuery = useQuery({
    queryKey: ['interview-attempts', viewingId],
    queryFn: async () => {
      const res = await api.get<AttemptDetail>(`/interview-attempts/${viewingId}`);
      return res.data;
    },
    enabled: Boolean(viewingId),
  });

  if (!isAdmin) return <ForbiddenState />;

  const isLoading = attemptsQuery.isLoading;
  const isError = attemptsQuery.isError;
  const rows = attemptsQuery.data?.data ?? [];

  return (
    <ListPageShell
      title="Interview attempts"
      description="Track student mock interview sessions and review their answers."
      filters={
        <LabeledField label="Status" srOnly htmlFor="ia-filter-status">
          <TextField
            id="ia-filter-status"
            select
            size="small"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="IN_PROGRESS">In progress</MenuItem>
            <MenuItem value="COMPLETED">Completed</MenuItem>
            <MenuItem value="ABANDONED">Abandoned</MenuItem>
          </TextField>
        </LabeledField>
      }
    >
      {isLoading ? (
        <Box sx={{ p: 3 }}>
          <Skeleton variant="rectangular" height={56} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={56} sx={{ mb: 1 }} />
          <Skeleton variant="rectangular" height={56} />
        </Box>
      ) : isError ? (
        <Box sx={{ p: 3 }}>
          <ErrorState
            title="Could not load attempts"
            description={attemptsQuery.error instanceof ApiError ? attemptsQuery.error.detail || attemptsQuery.error.title : 'Please try again.'}
            onRetry={() => attemptsQuery.refetch()}
          />
        </Box>
      ) : rows.length === 0 ? (
        <Box sx={{ p: 3 }}>
          <EmptyState title="No attempts yet" description="Students haven't taken any mock interviews yet. Share the prep link to get started." />
        </Box>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Candidate</TableCell>
                <TableCell>Country</TableCell>
                <TableCell>Institution</TableCell>
                <TableCell>Level</TableCell>
                <TableCell sx={{ width: 100 }}>Progress</TableCell>
                <TableCell sx={{ width: 120 }}>Status</TableCell>
                <TableCell sx={{ width: 160 }}>Started</TableCell>
                <TableCell align="right" sx={{ width: 60 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{row.candidate_name}</Typography>
                      <Typography variant="caption" color="text.secondary">{row.candidate_email}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>{row.country_code}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.institution_name}
                    </Typography>
                  </TableCell>
                  <TableCell>{row.academic_level}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {row.answered_count}/{row.question_count}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={row.status.replace('_', ' ')} color={STATUS_COLOR[row.status] ?? 'default'} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {new Date(row.started_at).toLocaleDateString()}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => setViewingId(row.id)} aria-label="View answers">
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <AppDialog
        open={viewingId !== null}
        onClose={() => setViewingId(null)}
        title={detailQuery.data ? `${detailQuery.data.candidate_name} — ${detailQuery.data.institution_name}` : 'Attempt detail'}
        subtitle={detailQuery.data ? `${detailQuery.data.course_name} · ${detailQuery.data.academic_level} · ${detailQuery.data.intake_label}` : ''}
        maxWidth="md"
        primaryAction={{ label: 'Close', onClick: () => setViewingId(null) }}
      >
        {detailQuery.isLoading ? (
          <Stack spacing={2} sx={{ p: 2 }}>
            <Skeleton height={80} />
            <Skeleton height={80} />
          </Stack>
        ) : detailQuery.data?.answers?.length ? (
          <Stack spacing={3} sx={{ p: 1 }}>
            {detailQuery.data.answers.map((ans, idx) => (
              <Box key={ans.id} sx={{ borderBottom: '1px solid', borderColor: 'divider', pb: 2 }}>
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="caption" sx={{ fontWeight: 700, color: 'primary.main' }}>
                      Q{idx + 1}
                    </Typography>
                    <Chip size="small" variant="outlined" label={CATEGORY_LABELS[ans.question.category] ?? ans.question.category} />
                  </Stack>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{ans.question.question_text}</Typography>
                  <Box sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'info.main' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Student answer:</Typography>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{ans.answer_text}</Typography>
                  </Box>
                  {ans.question.model_answer ? (
                    <Box sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'success.main' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Model answer:</Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{ans.question.model_answer}</Typography>
                    </Box>
                  ) : null}
                  {ans.question.tips ? (
                    <Typography variant="caption" color="text.secondary">Tip: {ans.question.tips}</Typography>
                  ) : null}
                </Stack>
              </Box>
            ))}
          </Stack>
        ) : (
          <EmptyState title="No answers yet" description="The student hasn't submitted any answers for this attempt." />
        )}
      </AppDialog>
    </ListPageShell>
  );
}
