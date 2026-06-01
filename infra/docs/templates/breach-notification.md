# Subject breach-notification template

> Use only after the DPO has confirmed scope and severity. Tailor the placeholders. Send via the same channel the subject ordinarily uses (email primarily; SMS where mandated by jurisdiction).

---

**Subject:** Important security notification regarding your account

Dear {{ subject_name }},

We are writing to inform you of a security incident that may have affected information you hold with {{ controller_legal_name }}.

**What happened.** On {{ incident_date_iso }} we detected {{ short_description }}. Our investigation, completed on {{ investigation_completed_iso }}, concluded that {{ root_cause_summary }}.

**What information was involved.** The incident may have exposed the following information you provided to us: {{ data_categories }}. Where applicable, this includes {{ specific_examples }}. Information such as full payment instruments, government-issued biometric identifiers, and your password were **not** affected.

**What we are doing.** We have:

- {{ containment_step_1 }}
- {{ containment_step_2 }}
- Engaged independent specialists to verify our remediation.
- Notified the relevant supervisory authority within the statutory window.

**What you can do.** As a precaution we recommend that you:

1. Review recent activity in your account at <{{ account_url }}>.
2. Reset your password and enable two-factor authentication if you have not already.
3. Be cautious of unsolicited messages referencing your studies or visa, particularly those requesting payment.

**Your rights.** You have the right to lodge a complaint with the supervisory authority in your jurisdiction. You may also contact our Data Protection Officer at <{{ dpo_email }}> for any questions.

We are sorry for any concern this causes. Protecting the information you entrust to us is our highest priority, and we are committed to doing better.

Sincerely,
{{ signatory_name }}
{{ signatory_title }}
{{ controller_legal_name }}
