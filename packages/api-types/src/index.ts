// Pure-type re-exports inferred from @spv/zod-schemas.
// Frontend imports from here to avoid pulling Zod into the browser bundle when only types are needed.
import type {
  LoginRequest,
  TokenResponse,
  AuthUserResponse,
  ProblemDetail,
  Role,
  CrmLeadListItem,
  CrmLeadFeeResponse,
  CrmNextFeeDue,
  CrmLeadStatus,
  CrmFeeStatus,
  CrmLeadCourseState,
  CrmLeadListQuery,
  CrmApplicationListItem,
  CrmApplicationListQuery,
} from '@spv/zod-schemas';

export type { LoginRequest, TokenResponse, AuthUserResponse, ProblemDetail, Role };
export type {
  CrmLeadListItem,
  CrmLeadFeeResponse,
  CrmNextFeeDue,
  CrmLeadStatus,
  CrmFeeStatus,
  CrmLeadCourseState,
  CrmLeadListQuery,
  CrmApplicationListItem,
  CrmApplicationListQuery,
};

export type ApiResponse<T> = { data: T };
export type ApiErrorResponse = ProblemDetail;

export type Page<T> = {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean; total?: number };
};
