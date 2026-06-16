'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import {
  INTERVIEW_QUESTION_CATEGORY_LABEL,
  ACADEMIC_LEVEL_LABEL,
} from '@spv/zod-schemas';

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1') +
  '/public';
const CATEGORY_LABELS = INTERVIEW_QUESTION_CATEGORY_LABEL as Record<string, string>;
const LEVEL_ENTRIES = Object.entries(ACADEMIC_LEVEL_LABEL as Record<string, string>);

type QuestionItem = { id: string; category: string; question_text: string };
type AnswerEntry = { question_id: string; answer_text: string; time_spent_seconds?: number };
type ResultAnswer = {
  id: string;
  answer_text: string;
  question: { question_text: string; model_answer: string | null; tips: string | null; category: string };
};

const COUNTRY_OPTIONS = [
  { code: 'US', label: 'United States' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'AU', label: 'Australia' },
  { code: 'CA', label: 'Canada' },
  { code: 'NZ', label: 'New Zealand' },
  { code: 'DE', label: 'Germany' },
  { code: 'IE', label: 'Ireland' },
  { code: 'FR', label: 'France' },
  { code: 'NL', label: 'Netherlands' },
  { code: 'JP', label: 'Japan' },
];

type Step0Form = {
  candidate_name: string;
  candidate_email: string;
  country_code: string;
  institution_name: string;
  course_name: string;
  academic_level: string;
  intake_label: string;
  has_i20: boolean;
};

function emptyForm(): Step0Form {
  return {
    candidate_name: '',
    candidate_email: '',
    country_code: '',
    institution_name: '',
    course_name: '',
    academic_level: '',
    intake_label: '',
    has_i20: false,
  };
}

export default function InterviewPrepClient() {
  const searchParams = useSearchParams();
  const token = searchParams.get('t');

  const [step, setStep] = useState<'loading' | 'invalid' | 'form' | 'test' | 'results'>('loading');
  const [tenantName, setTenantName] = useState('');
  const [form, setForm] = useState<Step0Form>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Test state
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());

  // Results
  const [resultAnswers, setResultAnswers] = useState<ResultAnswer[]>([]);

  // Focus management
  const answerRef = useRef<HTMLTextAreaElement>(null);

  // Validate token on mount
  useEffect(() => {
    if (!token) { setStep('invalid'); return; }
    axios.get(`${API_BASE}/interview-prep/validate`, { params: { t: token } })
      .then((res) => {
        setTenantName(res.data.tenant_name ?? '');
        setStep('form');
      })
      .catch(() => setStep('invalid'));
  }, [token]);

  const updateField = useCallback((field: keyof Step0Form, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFormErrors((prev) => { const n = { ...prev }; delete n[field]; return n; });
  }, []);

  const validateForm = useCallback((): boolean => {
    const errs: Record<string, string> = {};
    if (!form.candidate_name.trim()) errs.candidate_name = 'Name is required';
    if (!form.candidate_email.trim()) errs.candidate_email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.candidate_email)) errs.candidate_email = 'Invalid email';
    if (!form.country_code) errs.country_code = 'Select a country';
    if (!form.institution_name.trim()) errs.institution_name = 'University name is required';
    if (!form.course_name.trim()) errs.course_name = 'Course name is required';
    if (!form.academic_level) errs.academic_level = 'Select your level';
    if (!form.intake_label.trim()) errs.intake_label = 'Intake is required';
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }, [form]);

  const startTest = useCallback(async () => {
    if (!validateForm()) return;
    setSubmitting(true);
    try {
      const res = await axios.post(`${API_BASE}/interview-prep/start`, form, { params: { t: token } });
      if (!res.data.attempt_id) {
        setFormErrors({ _general: res.data.message || 'No questions available for this configuration.' });
        return;
      }
      setAttemptId(res.data.attempt_id);
      setQuestions(res.data.questions);
      setCurrentIdx(0);
      setAnswers(new Map());
      setQuestionStartTime(Date.now());
      setStep('test');
    } catch (err) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.detail || 'Failed to start test' : 'Failed to start test';
      setFormErrors({ _general: msg });
    } finally {
      setSubmitting(false);
    }
  }, [form, token, validateForm]);

  const currentQuestion = questions[currentIdx] ?? null;
  const currentAnswer = currentQuestion ? (answers.get(currentQuestion.id) ?? '') : '';
  const progress = questions.length ? Math.round(((currentIdx + (currentAnswer ? 1 : 0)) / questions.length) * 100) : 0;

  const goNext = useCallback(() => {
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
      setQuestionStartTime(Date.now());
      setTimeout(() => answerRef.current?.focus(), 50);
    }
  }, [currentIdx, questions.length]);

  const goPrev = useCallback(() => {
    if (currentIdx > 0) {
      setCurrentIdx((i) => i - 1);
      setQuestionStartTime(Date.now());
      setTimeout(() => answerRef.current?.focus(), 50);
    }
  }, [currentIdx]);

  const submitTest = useCallback(async () => {
    if (!attemptId) return;
    setSubmitting(true);
    try {
      const allAnswers: AnswerEntry[] = [];
      for (const q of questions) {
        const text = answers.get(q.id);
        if (text?.trim()) allAnswers.push({ question_id: q.id, answer_text: text.trim() });
      }
      if (allAnswers.length > 0) {
        await axios.post(`${API_BASE}/interview-prep/attempts/${attemptId}/answers`, { answers: allAnswers }, { params: { t: token } });
      }
      const res = await axios.post(`${API_BASE}/interview-prep/attempts/${attemptId}/complete`, {}, { params: { t: token } });
      setResultAnswers(res.data?.answers ?? []);
      setStep('results');
    } catch {
      setFormErrors({ _general: 'Failed to submit. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, questions, answers]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (step === 'loading') {
    return (
      <Container maxWidth="sm" sx={{ py: 8, textAlign: 'center' }}>
        <CircularProgress />
        <Typography sx={{ mt: 2 }}>Preparing your interview session...</Typography>
      </Container>
    );
  }

  if (step === 'invalid') {
    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>Invalid or expired link</Typography>
            <Typography color="text.secondary">
              This interview prep link is not valid. Please contact your counsellor for a new link.
            </Typography>
          </CardContent>
        </Card>
      </Container>
    );
  }

  if (step === 'form') {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', py: { xs: 4, md: 6 } }}>
        <Container maxWidth="sm">
          <Stack spacing={4}>
            <Stack spacing={1} sx={{ textAlign: 'center' }}>
              <Typography variant="h4" sx={{ fontWeight: 700 }}>Visa Interview Preparation</Typography>
              <Typography color="text.secondary">
                Practice with our proprietary question system tailored to your profile.
              </Typography>
              {tenantName ? (
                <Typography variant="caption" color="text.secondary">Provided by {tenantName}</Typography>
              ) : null}
            </Stack>

            <form onSubmit={(e) => { e.preventDefault(); startTest(); }}>
            <Card>
              <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
                <Stack spacing={2.5}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Your details</Typography>

                  {formErrors._general ? <Alert severity="error">{formErrors._general}</Alert> : null}

                  <TextField
                    label="Full name"
                    required
                    size="small"
                    fullWidth
                    value={form.candidate_name}
                    onChange={(e) => updateField('candidate_name', e.target.value)}
                    error={Boolean(formErrors.candidate_name)}
                    helperText={formErrors.candidate_name}
                  />
                  <TextField
                    label="Email"
                    required
                    size="small"
                    fullWidth
                    type="email"
                    value={form.candidate_email}
                    onChange={(e) => updateField('candidate_email', e.target.value)}
                    error={Boolean(formErrors.candidate_email)}
                    helperText={formErrors.candidate_email}
                  />
                  <TextField
                    label="Destination country"
                    required
                    select
                    size="small"
                    fullWidth
                    value={form.country_code}
                    onChange={(e) => updateField('country_code', e.target.value)}
                    error={Boolean(formErrors.country_code)}
                    helperText={formErrors.country_code}
                  >
                    <MenuItem value="">Select country</MenuItem>
                    {COUNTRY_OPTIONS.map((c) => <MenuItem key={c.code} value={c.code}>{c.label}</MenuItem>)}
                  </TextField>
                  <TextField
                    label="University / Institution name"
                    required
                    size="small"
                    fullWidth
                    value={form.institution_name}
                    onChange={(e) => updateField('institution_name', e.target.value)}
                    error={Boolean(formErrors.institution_name)}
                    helperText={formErrors.institution_name}
                    placeholder="e.g. University of California, Berkeley"
                  />
                  <TextField
                    label="Course / Program name"
                    required
                    size="small"
                    fullWidth
                    value={form.course_name}
                    onChange={(e) => updateField('course_name', e.target.value)}
                    error={Boolean(formErrors.course_name)}
                    helperText={formErrors.course_name}
                    placeholder="e.g. Master of Science in Computer Science"
                  />
                  <TextField
                    label="Academic level"
                    required
                    select
                    size="small"
                    fullWidth
                    value={form.academic_level}
                    onChange={(e) => updateField('academic_level', e.target.value)}
                    error={Boolean(formErrors.academic_level)}
                    helperText={formErrors.academic_level}
                  >
                    <MenuItem value="">Select level</MenuItem>
                    {LEVEL_ENTRIES.map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
                  </TextField>
                  <TextField
                    label="Intake"
                    required
                    size="small"
                    fullWidth
                    value={form.intake_label}
                    onChange={(e) => updateField('intake_label', e.target.value)}
                    error={Boolean(formErrors.intake_label)}
                    helperText={formErrors.intake_label}
                    placeholder="e.g. September 2026"
                  />
                  {form.country_code === 'US' ? (
                    <TextField
                      label="Include I-20 analysis questions?"
                      select
                      size="small"
                      fullWidth
                      value={form.has_i20 ? 'yes' : 'no'}
                      onChange={(e) => updateField('has_i20', e.target.value === 'yes')}
                    >
                      <MenuItem value="no">No</MenuItem>
                      <MenuItem value="yes">Yes — I have my I-20</MenuItem>
                    </TextField>
                  ) : null}
                </Stack>
              </CardContent>
            </Card>

            <Button
              variant="contained"
              size="large"
              fullWidth
              type="submit"
              startIcon={submitting ? <CircularProgress size={20} /> : <PlayArrowIcon />}
              disabled={submitting}
            >
              {submitting ? 'Preparing questions...' : 'Start mock interview'}
            </Button>
            </form>
          </Stack>
        </Container>
      </Box>
    );
  }

  if (step === 'test' && currentQuestion) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <LinearProgress variant="determinate" value={progress} sx={{ height: 4 }} />
        <Container maxWidth="md" sx={{ py: { xs: 3, md: 5 } }}>
          <Stack spacing={4}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="caption" color="text.secondary">
                Question {currentIdx + 1} of {questions.length}
              </Typography>
              <Chip size="small" label={CATEGORY_LABELS[currentQuestion.category] ?? currentQuestion.category} variant="outlined" />
            </Stack>

            <Card>
              <CardContent sx={{ p: { xs: 2, sm: 4 } }}>
                <Stack spacing={3}>
                  <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.5 }}>
                    {currentQuestion.question_text}
                  </Typography>
                  <TextField
                    inputRef={answerRef}
                    multiline
                    minRows={4}
                    maxRows={12}
                    fullWidth
                    placeholder="Type your answer here..."
                    aria-label={`Answer for question ${currentIdx + 1}`}
                    value={currentAnswer}
                    onChange={(e) => {
                      const val = e.target.value;
                      setAnswers((prev) => {
                        const next = new Map(prev);
                        next.set(currentQuestion.id, val);
                        return next;
                      });
                    }}
                  />
                </Stack>
              </CardContent>
            </Card>

            {formErrors._general ? <Alert severity="error">{formErrors._general}</Alert> : null}

            <Stack direction="row" justifyContent="space-between">
              <Button
                variant="outlined"
                startIcon={<ArrowBackIcon />}
                onClick={goPrev}
                disabled={currentIdx === 0}
              >
                Previous
              </Button>
              {currentIdx < questions.length - 1 ? (
                <Button
                  variant="contained"
                  endIcon={<ArrowForwardIcon />}
                  onClick={goNext}
                >
                  Next
                </Button>
              ) : (
                <Button
                  variant="contained"
                  color="success"
                  endIcon={submitting ? <CircularProgress size={20} /> : <CheckCircleOutlineIcon />}
                  onClick={submitTest}
                  disabled={submitting}
                >
                  {submitting ? 'Submitting...' : 'Finish & review'}
                </Button>
              )}
            </Stack>
          </Stack>
        </Container>
      </Box>
    );
  }

  if (step === 'results') {
    const answeredCount = resultAnswers.length;
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', py: { xs: 4, md: 6 } }}>
        <Container maxWidth="md">
          <Stack spacing={4}>
            <Stack spacing={1} sx={{ textAlign: 'center' }}>
              <CheckCircleOutlineIcon sx={{ fontSize: 48, color: 'success.main', mx: 'auto' }} />
              <Typography variant="h4" sx={{ fontWeight: 700 }}>Mock interview complete</Typography>
              <Typography color="text.secondary">
                You answered {answeredCount} question{answeredCount !== 1 ? 's' : ''}. Review the model answers below to improve your preparation.
              </Typography>
            </Stack>

            {resultAnswers.map((ans, idx) => (
              <Card key={ans.id}>
                <CardContent>
                  <Stack spacing={2}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" sx={{ fontWeight: 700, color: 'primary.main' }}>
                        Q{idx + 1}
                      </Typography>
                      <Chip size="small" variant="outlined" label={CATEGORY_LABELS[ans.question.category] ?? ans.question.category} />
                    </Stack>
                    <Typography variant="body1" sx={{ fontWeight: 600 }}>{ans.question.question_text}</Typography>
                    <Divider />
                    <Box>
                      <Typography variant="caption" sx={{ fontWeight: 600, color: 'info.main', display: 'block', mb: 0.5 }}>
                        Your answer
                      </Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', bgcolor: 'action.hover', p: 1.5, borderRadius: 1 }}>
                        {ans.answer_text}
                      </Typography>
                    </Box>
                    {ans.question.model_answer ? (
                      <Box>
                        <Typography variant="caption" sx={{ fontWeight: 600, color: 'success.main', display: 'block', mb: 0.5 }}>
                          Suggested answer
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', bgcolor: 'success.main', color: 'success.contrastText', p: 1.5, borderRadius: 1, opacity: 0.9 }}>
                          {ans.question.model_answer}
                        </Typography>
                      </Box>
                    ) : null}
                    {ans.question.tips ? (
                      <Alert severity="info" icon={false}>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>Tip: </Typography>
                        <Typography variant="caption">{ans.question.tips}</Typography>
                      </Alert>
                    ) : null}
                  </Stack>
                </CardContent>
              </Card>
            ))}

            <Stack spacing={2} sx={{ textAlign: 'center', pt: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Want to practice again? Go back to the beginning and try with different answers.
              </Typography>
              <Button
                variant="outlined"
                onClick={() => {
                  setStep('form');
                  setAnswers(new Map());
                  setQuestions([]);
                  setAttemptId(null);
                  setResultAnswers([]);
                }}
              >
                Start over
              </Button>
            </Stack>
          </Stack>
        </Container>
      </Box>
    );
  }

  return null;
}
