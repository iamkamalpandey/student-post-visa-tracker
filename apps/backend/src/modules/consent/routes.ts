import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { CreateConsentRequest, ConsentListQuery } from '@spv/zod-schemas';
import { consentController as c } from './controller.js';

export const consentRouter: Router = Router();
consentRouter.use(authenticate, tenantContext);
consentRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateConsentRequest), c.create);
// SVT-WAVE-PRIV-C4-2026-05 — consent reads are gated to ADMIN/COUNSELLOR/VIEWER
// explicitly. The list / get controllers further constrain VIEWER callers to
// their own subject rows (see service.list / service.get self-filter), so a
// VIEWER cannot enumerate other subjects' consents. Unknown roles (forged
// JWTs) 403 here before they can reach the service.
consentRouter.get('/', requireRole('ADMIN', 'COUNSELLOR', 'VIEWER'), validate(ConsentListQuery, 'query'), c.list);
consentRouter.get('/:id', requireRole('ADMIN', 'COUNSELLOR', 'VIEWER'), uuidParam('id'), c.get);
// SVT-CONSENT-2026-05: GDPR Art. 7(3) right-to-withdraw. Service's
// assertAuthorised allows ADMIN or the subject themself; this route also
// carries a defence-in-depth requireRole gate (SVT-SEC-AUDIT-2026-05) so
// a future "guest/roleless" claim cannot reach the controller even if a
// regression downgrades the service check.
consentRouter.post('/:id/revoke', requireRole('ADMIN', 'COUNSELLOR', 'VIEWER'), uuidParam('id'), c.revoke);
