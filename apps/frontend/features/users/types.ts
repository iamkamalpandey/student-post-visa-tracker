import type { Role } from '@spv/api-types';

// Mirrors the PUBLIC_FIELDS shape returned by the backend `/users` endpoints.
export type UserRow = {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  display_name: string | null;
  role: Role;
  locale: string;
  timezone: string;
  is_active: boolean;
  last_login_at: string | null;
  mfa_enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type UsersListResponse = {
  data: UserRow[];
  page: { hasMore: boolean; nextCursor: string | null };
};
