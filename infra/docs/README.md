# Operations docs

| Doc | Purpose |
|---|---|
| [QUICKSTART](./QUICKSTART.md) | 15-minute clone-to-dev path. |
| [ENVIRONMENTS](./ENVIRONMENTS.md) | dev / staging / prod matrix and promotion model. |
| [THREAT_MODEL](./THREAT_MODEL.md) | STRIDE pass and asset inventory. |
| [architecture-decisions](./architecture-decisions.md) | Lightweight ADRs. |
| [runbooks/](./runbooks/) | Operational playbooks. |
| [templates/](./templates/) | Breach notification, DPIA, regulator letter. |

## Runbooks

- [DB restore](./runbooks/db-restore.md)
- [Hash-chain verification](./runbooks/hash-chain-verify.md)
- [KMS rotation](./runbooks/kms-rotation.md)
- [DSAR fulfilment](./runbooks/dsar.md)
- [Bulk import stuck](./runbooks/bulk-import-stuck.md)
- [Provider outage / degrade](./runbooks/provider-degrade.md)
- [Refresh staging from prod (scrubbed)](./runbooks/restore-staging-from-prod.md)
- [Incident response](./runbooks/incident-response.md)
