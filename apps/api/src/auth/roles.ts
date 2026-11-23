export const ROLES = ['seller', 'manager', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { seller: 1, manager: 2, admin: 3, owner: 4 };

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function rank(role: Role): number {
  return RANK[role];
}

export type PlatformRole = 'superadmin' | 'support';
