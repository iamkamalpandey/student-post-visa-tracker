// Centralised Express Request augmentation.
//
// Previously each middleware (auth.ts, requestId.ts, audit.ts, tenantContext.ts,
// requireMfa.ts) declared its own `declare module 'express-serve-static-core'`
// block. Under NodeNext module resolution `@types/express-serve-static-core` is
// only a transitive dep of `@types/express` and cannot be augmented as a module
// directly — every such block emitted TS2664 and cascaded ~400 TS2339 errors on
// `req.user` / `req.db` / `req.requestId` across every controller.
//
// The canonical augmentation pattern for @types/express is to extend the
// `Express.Request` global interface. That works regardless of whether the
// underlying `express-serve-static-core` module can be resolved as a module
// specifier, and `@types/express` re-exports the namespace so Express's own
// runtime types pick it up automatically.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { AccessTokenClaims } from '../shared/jwt.js';

// Structural shape; the source of truth lives on `AuditContext` exported from
// `src/middlewares/audit.ts`. Keeping it inline here avoids a cross-module
// dependency in a .d.ts file.
interface AuditContextLike {
  ip?: string;
  ua?: string;
  requestId?: string;
  actorId?: string;
  tenantId?: string;
}

declare global {
  namespace Express {
    interface Request {
      /** Populated by `authenticate` middleware after verifying the access token. */
      user?: AccessTokenClaims;
      /** Per-request RLS-scoped Prisma client, populated by `tenantContext` middleware. */
      db?: PrismaClient | Prisma.TransactionClient;
      /** Convenience copy of `user.tid`, populated by `tenantContext`. */
      tenantId?: string;
      /** Stable id assigned by `requestId` middleware (echoed in `x-request-id`). */
      requestId: string;
      /** Lightweight audit context, populated by `auditContext` middleware. */
      audit?: AuditContextLike;
      /** Timestamp of a successful MFA step-up, set by `requireMfa` middleware. */
      mfaVerifiedAt?: Date;
      /**
       * Raw request body bytes, captured by the global `express.json({ verify })`
       * so webhook signature checks (Resend HMAC) can hash exactly what the
       * sender signed — the parsed `req.body` object cannot be re-serialised
       * byte-identically. See app.ts + modules/comms/webhooks.routes.ts.
       */
      rawBody?: Buffer;
    }
  }
}

// Required so this file is treated as a module and `declare global` works.
export {};
