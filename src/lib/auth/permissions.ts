// Matriz de permissões por papel. Aplicada SEMPRE no backend.
// ADMIN > MANAGER > RECEPTIONIST > BARBER

export type Role = "ADMIN" | "MANAGER" | "BARBER" | "RECEPTIONIST";

export const PERMISSIONS = {
  "org:manage": ["ADMIN"],
  "team:manage": ["ADMIN", "MANAGER"],
  "customers:read": ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"],
  "customers:write": ["ADMIN", "MANAGER", "RECEPTIONIST"],
  "customers:delete": ["ADMIN"],
  "services:manage": ["ADMIN", "MANAGER"],
  "schedule:manage": ["ADMIN", "MANAGER", "RECEPTIONIST"],
  "appointments:read": ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"],
  "appointments:write": ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"],
  "dashboard:view": ["ADMIN", "MANAGER", "RECEPTIONIST"],
  "opportunities:view": ["ADMIN", "MANAGER"],
  "automations:manage": ["ADMIN", "MANAGER"],
  "whatsapp:manage": ["ADMIN"],
  "reports:view": ["ADMIN", "MANAGER"],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: string | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

export function assertCan(role: string | undefined, permission: Permission): void {
  if (!can(role, permission)) {
    const err = new Error("SEM_PERMISSAO") as Error & { status?: number };
    err.status = 403;
    throw err;
  }
}
