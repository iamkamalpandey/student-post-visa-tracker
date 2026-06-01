# Supervisory authority breach-notification template

> Required by GDPR Art. 33 within 72 hours of becoming aware of a personal data breach that is likely to result in a risk to the rights and freedoms of natural persons. The DPO is the responsible filer.

---

**To:** {{ supervisory_authority_name }}
**From:** {{ controller_legal_name }}, registered at {{ controller_address }}
**Date:** {{ filing_date_iso }}
**Reference:** internal `breach_incidents.id` = {{ breach_incident_id }}

## 1. Nature of the breach

- Categories of personal data: {{ data_categories }}.
- Approximate number of data subjects: {{ subjects_count }}.
- Approximate number of records: {{ records_count }}.

## 2. Likely consequences

{{ likely_consequences }}

## 3. Measures taken

- Containment: {{ containment_summary }}.
- Eradication: {{ eradication_summary }}.
- Recovery: {{ recovery_summary }}.

## 4. Communication to data subjects

- Required under Art. 34? Yes / no — justification.
- Method and timing if yes: {{ subject_comms_plan }}.

## 5. Contact

Data Protection Officer:
- Name: {{ dpo_name }}
- Email: {{ dpo_email }}
- Phone: {{ dpo_phone }}

## 6. Attachments

- Internal incident timeline.
- Forensic report (if available).
- Updated DPIA (if processing changed).
