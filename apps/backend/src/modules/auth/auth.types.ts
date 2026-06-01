// Re-export inferred Zod types from the shared schema package so module callers can
// `import type { LoginRequest } from './auth.types.js'` rather than reaching into the
// monorepo package every time. Single source of truth still lives in @spv/zod-schemas.

export type {
  LoginRequest,
  AuthUserResponse,
  TokenResponse,
  Role,
} from '@spv/zod-schemas';

import type { z } from 'zod';
import {
  ChangePasswordRequest as ChangePasswordRequestSchema,
  RefreshRequest as RefreshRequestSchema,
  Password as PasswordSchema,
} from '@spv/zod-schemas';

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type Password = z.infer<typeof PasswordSchema>;

/** Context passed from controllers into the service layer for device binding & audit. */
export interface AuthContext {
  ip?: string;
  ua?: string;
  deviceId?: string;
  requestId?: string;
}
