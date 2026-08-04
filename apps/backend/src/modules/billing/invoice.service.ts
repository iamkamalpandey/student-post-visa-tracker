// SVT-WAVE-BILLING-2026-05 — Invoice generator (text + PDF).
//
// Two renderers live here:
//   - renderInvoiceText: legacy plain-text invoice. Retained for backward
//     compatibility with any tooling/curl scripts that already parse it.
//     Begins with a "%PDF-PLACEHOLDER-v1" marker line.
//   - renderInvoicePdf:  real PDF, generated with pdf-lib (pure JS, no native
//     deps). Used by GET /billing/plans/:id/invoice.pdf. Same content shape
//     as the text version — plan header + installment table + totals — plus a
//     footer with a SHA-256 of the rendered body for tamper detection.
//
// Ownership is enforced by reusing plan.service.getFeePlan, which already
// scopes by tenant_id (and the COUNSELLOR-vs-ADMIN scope is reapplied at
// the controller via the same auth chain as the JSON GET /plans/:id).

import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { getFeePlan } from './plan.service.js';
import { currencyMinorDigits } from '../../shared/money.js';

type Ctx = { user?: { tid: string; sub?: string; role?: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' } };

export type InvoiceArtifact = {
  body: string;
  etag: string;
  contentType: 'text/plain; charset=utf-8';
  filename: string;
};

export type InvoicePdfArtifact = {
  body: Buffer;
  etag: string;
  contentType: 'application/pdf';
  filename: string;
};

// Format a bigint minor-unit amount in its currency's own major units.
//
// SVT-FIN-2026-08 — the "!=2 decimals out of scope" caveat this carried was
// not harmless on an invoice: a ¥50,000 line printed as "500.00 JPY" on a
// document the student is asked to pay against. The exponent now comes from
// currencyMinorDigits (Intl-backed), and zero-decimal currencies print with no
// fractional part at all. Arithmetic stays in BigInt throughout.
function fmtMinor(minor: bigint, currency: string): string {
  const exp = currencyMinorDigits(currency);
  const scale = 10n ** BigInt(exp);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const major = abs / scale;
  const sign = neg ? '-' : '';
  if (exp === 0) return `${sign}${major.toString()} ${currency}`;
  const cents = (abs % scale).toString().padStart(exp, '0');
  return `${sign}${major.toString()}.${cents} ${currency}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function renderInvoiceText(
  ctx: Ctx,
  planId: string,
): Promise<InvoiceArtifact> {
  const plan = await getFeePlan(ctx as never, planId);
  const lines: string[] = [];

  // Marker line — lets consumers branch on stub-vs-real-PDF during rollout.
  lines.push('%PDF-PLACEHOLDER-v1');
  lines.push('================================================================');
  lines.push('  INVOICE / FEE PLAN STATEMENT');
  lines.push('================================================================');
  lines.push(`Plan ID        : ${plan.id}`);
  lines.push(`Enrollment ID  : ${plan.enrollment_id}`);
  lines.push(`Status         : ${plan.status}`);
  lines.push(`Cadence        : ${plan.cadence}`);
  lines.push(`Currency       : ${plan.currency}`);
  lines.push(`Starts On      : ${isoDate(plan.starts_on)}`);
  lines.push(`Generated At   : ${new Date().toISOString()}`);
  if (plan.notes) lines.push(`Notes          : ${plan.notes}`);
  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push('  INSTALLMENTS');
  lines.push('----------------------------------------------------------------');
  lines.push(
    `${pad('#', 4)}${pad('LABEL', 22)}${pad('DUE', 12)}${pad('GROSS', 16)}${pad('PAID', 16)}${pad('BALANCE', 16)}STATUS`,
  );

  let totalGross = 0n;
  let totalPaid = 0n;
  let totalBalance = 0n;
  for (const i of plan.installments) {
    totalGross += i.gross_minor;
    totalPaid += i.paid_minor;
    totalBalance += i.balance_minor;
    lines.push(
      `${pad(String(i.sequence_no), 4)}` +
        `${pad(i.label.slice(0, 21), 22)}` +
        `${pad(isoDate(i.due_on), 12)}` +
        `${pad(fmtMinor(i.gross_minor, plan.currency), 16)}` +
        `${pad(fmtMinor(i.paid_minor, plan.currency), 16)}` +
        `${pad(fmtMinor(i.balance_minor, plan.currency), 16)}` +
        i.status,
    );
  }

  lines.push('----------------------------------------------------------------');
  lines.push('  TOTALS');
  lines.push('----------------------------------------------------------------');
  lines.push(`Plan Total     : ${fmtMinor(plan.total_minor, plan.currency)}`);
  if (plan.scholarship_minor > 0n) {
    lines.push(`Scholarship    : ${fmtMinor(plan.scholarship_minor, plan.currency)}`);
  }
  lines.push(`Gross (sum)    : ${fmtMinor(totalGross, plan.currency)}`);
  lines.push(`Paid           : ${fmtMinor(totalPaid, plan.currency)}`);
  lines.push(`Outstanding    : ${fmtMinor(totalBalance, plan.currency)}`);
  lines.push('================================================================');
  lines.push('  This document is a system-generated draft. Not a tax invoice.');
  lines.push('================================================================');

  const body = lines.join('\n') + '\n';
  // Strong ETag — content hash, stable across requests for the same plan
  // snapshot. Plan.version + updated rows change the digest naturally.
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  return {
    body,
    etag,
    contentType: 'text/plain; charset=utf-8',
    filename: `invoice-${plan.id}.txt`,
  };
}

// ---------------------------------------------------------------------------
// PDF renderer (SVT-WAVE-BILLING-2026-05 PDF rollout)
// ---------------------------------------------------------------------------
//
// Layout: single-page A4 (595 x 842 pts), Helvetica family. The page is laid
// out with a fixed left margin, a header band, a key-value plan summary, an
// installment table with column rules, a totals block, and a footer carrying
// the generation timestamp + truncated content hash.
//
// Multi-page is intentionally out of scope for v1; plans with > ~28 installments
// will spill — we'll add pagination in a follow-up when a real customer hits it.

// A4 in points (1pt = 1/72in).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 56;
const LINE_HEIGHT = 14;

const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_MUTED = rgb(0.45, 0.45, 0.45);
const COLOR_RULE = rgb(0.75, 0.75, 0.75);

// Sanitise free-form text so pdf-lib's WinAnsi encoder doesn't throw on
// characters outside the standard font's glyph set (Helvetica is WinAnsi).
function sanitize(s: string): string {
  // Replace common smart punctuation, then drop anything still > 0xFF.
  const mapped = s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[…]/g, '...');
  let out = '';
  for (let i = 0; i < mapped.length; i += 1) {
    const code = mapped.charCodeAt(i);
    out += code <= 0xff ? mapped[i] : '?';
  }
  return out;
}

// Truncate to fit a given column width using the font's actual glyph widths.
function clip(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ell = '...';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (font.widthOfTextAtSize(text.slice(0, mid) + ell, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

function shortPlanRef(planId: string, planVersion?: number): string {
  // Plan UUID v7: take the first 8 chars + optional version suffix as a
  // human-stable invoice identifier. Not globally unique by design — paired
  // with the full plan id printed in the body.
  const head = planId.slice(0, 8).toUpperCase();
  const seq = typeof planVersion === 'number' ? planVersion : 1;
  return `INV-${head}-${String(seq).padStart(3, '0')}`;
}

type DrawCtx = {
  page: PDFPage;
  y: number;
  font: PDFFont;
  fontBold: PDFFont;
};

function drawText(ctx: DrawCtx, text: string, x: number, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
  const size = opts.size ?? 10;
  ctx.page.drawText(sanitize(text), {
    x,
    y: ctx.y,
    size,
    font: opts.bold ? ctx.fontBold : ctx.font,
    color: opts.color ?? COLOR_TEXT,
  });
}

function hr(ctx: DrawCtx, color = COLOR_RULE): void {
  ctx.page.drawLine({
    start: { x: MARGIN_X, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN_X, y: ctx.y },
    thickness: 0.5,
    color,
  });
}

export async function renderInvoicePdf(
  ctx: Ctx,
  planId: string,
): Promise<InvoicePdfArtifact> {
  const plan = await getFeePlan(ctx as never, planId);

  // Stable "snapshot" timestamp — derived from plan content so re-renders of
  // the same plan state produce byte-identical PDFs (and therefore a stable
  // ETag). We prefer an explicit updated_at when the schema exposes one;
  // otherwise we anchor to starts_on. Real wall-clock now() goes into the
  // HTTP headers, not the document body.
  const snapshot = ((): Date => {
    const p = plan as { updated_at?: Date; created_at?: Date };
    return p.updated_at ?? p.created_at ?? plan.starts_on ?? new Date(0);
  })();

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${plan.id}`);
  pdf.setProducer('Student Post Visa Tracker');
  pdf.setCreator('SPV Billing');
  // Pin metadata dates to the snapshot so the saved bytes don't drift with
  // wall-clock between requests — ETag stability depends on this.
  pdf.setCreationDate(snapshot);
  pdf.setModificationDate(snapshot);

  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const dctx: DrawCtx = { page, y: PAGE_HEIGHT - MARGIN_TOP, font, fontBold };

  // --- Header band ---------------------------------------------------------
  // Logo would go here in a future iteration — v1 ships text-only.
  drawText(dctx, 'INVOICE / FEE PLAN STATEMENT', MARGIN_X, { size: 16, bold: true });
  dctx.y -= 6;

  const invoiceRef = shortPlanRef(plan.id, (plan as { version?: number }).version);
  const refWidth = fontBold.widthOfTextAtSize(invoiceRef, 11);
  page.drawText(sanitize(invoiceRef), {
    x: PAGE_WIDTH - MARGIN_X - refWidth,
    y: dctx.y + 22,
    size: 11,
    font: fontBold,
    color: COLOR_TEXT,
  });
  const issued = `Issued: ${snapshot.toISOString().slice(0, 10)}`;
  const issuedWidth = font.widthOfTextAtSize(issued, 9);
  page.drawText(sanitize(issued), {
    x: PAGE_WIDTH - MARGIN_X - issuedWidth,
    y: dctx.y + 8,
    size: 9,
    font,
    color: COLOR_MUTED,
  });

  dctx.y -= 14;
  hr(dctx);
  dctx.y -= 18;

  // --- Plan key/value summary ---------------------------------------------
  const kvLabels = [
    ['Plan ID',        plan.id],
    ['Enrollment ID',  plan.enrollment_id],
    ['Status',         String(plan.status)],
    ['Cadence',        String(plan.cadence)],
    ['Currency',       plan.currency],
    ['Starts On',      isoDate(plan.starts_on)],
  ] as const;

  for (const [label, value] of kvLabels) {
    drawText(dctx, label, MARGIN_X, { bold: true });
    drawText(dctx, String(value), MARGIN_X + 110);
    dctx.y -= LINE_HEIGHT;
  }
  if (plan.notes) {
    drawText(dctx, 'Notes', MARGIN_X, { bold: true });
    drawText(
      dctx,
      clip(plan.notes, font, 10, PAGE_WIDTH - MARGIN_X - 110 - MARGIN_X),
      MARGIN_X + 110,
    );
    dctx.y -= LINE_HEIGHT;
  }

  dctx.y -= 6;
  hr(dctx);
  dctx.y -= 16;

  // --- Installment table ---------------------------------------------------
  drawText(dctx, 'INSTALLMENTS', MARGIN_X, { bold: true, size: 11 });
  dctx.y -= 14;

  // Column layout (x-offset from MARGIN_X, width).
  const cols = [
    { key: '#',       x: 0,   w: 22,  align: 'left'  as const },
    { key: 'Label',   x: 24,  w: 140, align: 'left'  as const },
    { key: 'Due',     x: 168, w: 70,  align: 'left'  as const },
    { key: 'Gross',   x: 244, w: 80,  align: 'right' as const },
    { key: 'Paid',    x: 330, w: 70,  align: 'right' as const },
    { key: 'Balance', x: 406, w: 70,  align: 'right' as const },
    { key: 'Status',  x: 482, w: 64,  align: 'left'  as const },
  ];

  const drawRow = (
    cells: string[],
    opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const size = 9;
    const f = opts.bold ? fontBold : font;
    for (let i = 0; i < cols.length; i += 1) {
      const col = cols[i]!;
      const txt = sanitize(clip(cells[i] ?? '', f, size, col.w));
      let x = MARGIN_X + col.x;
      if (col.align === 'right') {
        x += col.w - f.widthOfTextAtSize(txt, size);
      }
      page.drawText(txt, { x, y: dctx.y, size, font: f, color: opts.color ?? COLOR_TEXT });
    }
  };

  drawRow(cols.map((c) => c.key), { bold: true });
  dctx.y -= 4;
  hr(dctx);
  dctx.y -= 12;

  // SVT-FIN-2026-08 — TOTAL FIRST, THEN DRAW.
  //
  // The accumulators used to live inside the row loop, which ends in
  // `if (dctx.y < 140) break` once the page runs out of room. The break
  // truncated the totals along with the rows: only ~30-40 lines fit, the plan
  // wizard permits up to 240 installments, and a 48-month monthly plan already
  // overflows. The document then printed a "Gross (sum)" and "Outstanding"
  // covering just the visible rows, directly beneath a "Plan Total" taken from
  // the untruncated plan — three numbers that silently disagreed on an
  // invoice the student pays against. The text renderer has no such break, so
  // /invoice.txt and /invoice.pdf reported different amounts for one plan.
  //
  // Summing over the full set first makes the totals independent of how much
  // fits on the page.
  let totalGross = 0n;
  let totalPaid = 0n;
  let totalBalance = 0n;
  for (const i of plan.installments) {
    totalGross += i.gross_minor;
    totalPaid += i.paid_minor;
    totalBalance += i.balance_minor;
  }

  let rowsDrawn = 0;
  for (const i of plan.installments) {
    drawRow([
      String(i.sequence_no),
      i.label,
      isoDate(i.due_on),
      fmtMinor(i.gross_minor, plan.currency),
      fmtMinor(i.paid_minor, plan.currency),
      fmtMinor(i.balance_minor, plan.currency),
      i.status,
    ]);
    dctx.y -= LINE_HEIGHT;
    rowsDrawn += 1;
    if (dctx.y < 140) break; // pagination guard — see note above
  }

  // Never let a truncated table read as a complete one.
  if (rowsDrawn < plan.installments.length) {
    drawText(
      dctx,
      `… ${plan.installments.length - rowsDrawn} more installment(s) not shown — totals below cover all ${plan.installments.length}.`,
      MARGIN_X,
      { size: 9, color: COLOR_MUTED },
    );
    dctx.y -= LINE_HEIGHT;
  }

  dctx.y -= 4;
  hr(dctx);
  dctx.y -= 16;

  // --- Totals block --------------------------------------------------------
  drawText(dctx, 'TOTALS', MARGIN_X, { bold: true, size: 11 });
  dctx.y -= 14;

  const totals = [
    ['Plan Total',  fmtMinor(plan.total_minor, plan.currency)],
  ] as Array<[string, string]>;
  if (plan.scholarship_minor > 0n) {
    totals.push(['Scholarship', fmtMinor(plan.scholarship_minor, plan.currency)]);
  }
  totals.push(['Gross (sum)', fmtMinor(totalGross, plan.currency)]);
  totals.push(['Paid',        fmtMinor(totalPaid, plan.currency)]);
  totals.push(['Outstanding', fmtMinor(totalBalance, plan.currency)]);

  for (const [label, value] of totals) {
    drawText(dctx, label, MARGIN_X, { bold: true });
    const valWidth = font.widthOfTextAtSize(value, 10);
    page.drawText(sanitize(value), {
      x: PAGE_WIDTH - MARGIN_X - valWidth,
      y: dctx.y,
      size: 10,
      font,
      color: COLOR_TEXT,
    });
    dctx.y -= LINE_HEIGHT;
  }

  // --- Footer --------------------------------------------------------------
  // Draw at a fixed y near the bottom regardless of where the body landed.
  const footerY = 60;
  page.drawLine({
    start: { x: MARGIN_X, y: footerY + 28 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: footerY + 28 },
    thickness: 0.5,
    color: COLOR_RULE,
  });

  // Footer timestamp also tracks the snapshot — keeping the rendered bytes
  // deterministic for ETag round-trips.
  const generatedAt = snapshot.toISOString();
  page.drawText(sanitize(`Generated ${generatedAt}`), {
    x: MARGIN_X,
    y: footerY + 14,
    size: 8,
    font,
    color: COLOR_MUTED,
  });
  page.drawText('This document is a system-generated draft. Not a tax invoice.', {
    x: MARGIN_X,
    y: footerY,
    size: 8,
    font,
    color: COLOR_MUTED,
  });

  // Tamper-detection: SHA-256 of a deterministic representation of the body
  // (plan id + version + per-installment digest). Survives re-renders so the
  // same plan state always produces the same audit hash.
  const auditPayload = JSON.stringify({
    id: plan.id,
    version: (plan as { version?: number }).version ?? null,
    currency: plan.currency,
    total: plan.total_minor.toString(),
    installments: plan.installments.map((i) => ({
      seq: i.sequence_no,
      due: isoDate(i.due_on),
      gross: i.gross_minor.toString(),
      paid: i.paid_minor.toString(),
      status: i.status,
    })),
  });
  const auditHash = createHash('sha256').update(auditPayload).digest('hex').slice(0, 16);
  const auditLine = `Audit: ${auditHash}`;
  const auditWidth = font.widthOfTextAtSize(auditLine, 8);
  page.drawText(auditLine, {
    x: PAGE_WIDTH - MARGIN_X - auditWidth,
    y: footerY + 14,
    size: 8,
    font,
    color: COLOR_MUTED,
  });

  const bytes = await pdf.save();
  const body = Buffer.from(bytes);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;

  return {
    body,
    etag,
    contentType: 'application/pdf',
    filename: `invoice-${plan.id}.pdf`,
  };
}
