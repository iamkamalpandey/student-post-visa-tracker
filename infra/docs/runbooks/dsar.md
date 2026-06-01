# Runbook: Data Subject Access Request (DSAR)

**Owner:** Data Protection Officer.
**Trigger:** Subject (student or staff) submits a request via `POST /api/v1/dsar` or via email forwarded by support.
**Statutory deadline:** 30 calendar days from receipt (GDPR Art. 12). Mark calendar.

## Request types we handle

| Type | What we deliver |
|---|---|
| `ACCESS` | Machine-readable export of all data we hold about the subject. |
| `PORTABILITY` | Same as ACCESS, structured JSON suitable for re-import elsewhere. |
| `RECTIFICATION` | Update incorrect fields; subject provides correction in writing. |
| `ERASURE` | Crypto-shred encrypted fields and tombstone rows. Some records may be retained where legal obligation overrides (audit log, finance ledger). |
| `RESTRICTION` | Mark the subject as restricted; processing limited to storage. |
| `OBJECTION` | Stop processing for marketing or other legitimate-interest purposes. |

## Workflow

1. **Verify identity** — match against the email on file, request government-ID proof for high-risk requests, document the verification step.
2. **Open a `DSARRequest` row** — `due_by = requested_at + 30d`, status `PENDING`.
3. **Bound the scope** — confirm the subject's `subject_id` (Student or User row).
4. **Collect** — for ACCESS / PORTABILITY, run the export pipeline with `subject_id` filter:

    ```bash
    curl -X POST "$API/exports" \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{ "resource": "students", "format": "json", "filter": { "id": "<uuid>" }, "redact_pii": false }'
    ```

5. **Review** — DPO checks the export contains nothing that legitimately belongs to a different subject (siblings on the same sponsor, etc.).
6. **Deliver** — encrypted ZIP via secure channel; record delivery timestamp on the DSAR row; status `COMPLETED`.
7. **For ERASURE** — run the erasure script (TODO: `infra/scripts/dsar-erasure.ts`) which:
   - Tombstones `Student` (sets `deleted_at`).
   - Crypto-shreds `_enc` columns by deleting rows / overwriting with random bytes after detaching DEKs.
   - Retains rows required for legal obligation (audit_logs, finance_items past retention horizon) and notes the retention basis on the `DSARRequest` row.
   - Confirms via `GET /api/v1/students/:id` that the row is no longer accessible.
8. **Close the loop** — confirmation email to subject; close the `DSARRequest` row; archive evidence for 6 years.

## SLA monitoring

A daily job (TODO: `infra/scripts/dsar-sla.ts`) flags any `DSARRequest` rows where `due_by - now() < 7 days` and status is not `COMPLETED`. The DPO is paged.

## Edge cases

- **Subject of a multi-tenant deployment** — only the tenant that holds their record can fulfil the request. Reject DSARs that lack a tenant context with a referral to the correct controller.
- **Mass DSAR** — automate via `infra/scripts/dsar-batch.ts` which iterates a CSV of subject IDs and stages an export per subject. Rate-limit to one job at a time to avoid swamping the export worker.
