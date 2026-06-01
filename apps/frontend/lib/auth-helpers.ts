import type { Role } from '@spv/api-types';

// Tiny pure-function role helpers. Kept framework-free so they can be used
// from server components, route handlers, or any feature module.

/** True when the user has the ADMIN role. */
export function isAdmin(role?: Role | null): boolean {
  return role === 'ADMIN';
}

/** True when the user has the COUNSELLOR role. */
export function isCounsellor(role?: Role | null): boolean {
  return role === 'COUNSELLOR';
}

/** True when the user can only read data (VIEWER, or no role). */
export function isReadOnly(role?: Role | null): boolean {
  return !role || role === 'VIEWER';
}

/** Admin and counsellors may create / edit student records. */
export function canWriteStudents(role?: Role | null): boolean {
  return role === 'ADMIN' || role === 'COUNSELLOR';
}

/** Only admins may add, reorder, rename, or delete pipeline stages. */
export function canManageStages(role?: Role | null): boolean {
  return role === 'ADMIN';
}

/** Only admins may invite, edit, or deactivate other users. */
export function canManageUsers(role?: Role | null): boolean {
  return role === 'ADMIN';
}
