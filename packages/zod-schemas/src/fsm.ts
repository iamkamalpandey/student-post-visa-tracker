// SVT-FSM-2026-05: response shape for GET /api/v1/fsm/:machineName/options.
//
// Pinned schema so the FE can validate the live machine response and drop the
// hand-mirrored transition tables (e.g. apps/frontend/features/students/
// studies/enrollment-fsm.ts).
import { z } from 'zod';

export const FsmOptionsResponse = z.object({
  from: z.string(),
  allowed: z.array(
    z.object({
      to: z.string(),
      requires_reason: z.boolean(),
      admin_override: z.boolean(),
    }),
  ),
});
export type FsmOptionsResponse = z.infer<typeof FsmOptionsResponse>;
