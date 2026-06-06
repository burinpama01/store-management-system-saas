export type SubscriptionPlan = "free" | "starter" | "standard" | "premium" | "enterprise";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "paused";

export type Role = "super_admin" | "owner" | "admin" | "manager" | "cashier" | "staff";

export type PermissionKey =
  | "dashboard.view"
  | "pos.use"
  | "pos.discount"
  | "pos.refund"
  | "pos.delete_bill"
  | "orders.manage_qr"
  | "catalog.view"
  | "catalog.manage"
  | "stock.manage"
  | "cashflow.view"
  | "cashflow.manage"
  | "reports.view"
  | "attendance.clock"
  | "attendance.manage"
  | "settings.view"
  | "settings.manage_store"
  | "users.manage"
  | "permissions.manage"
  | "notifications.manage"
  | "organizations.manage"
  | "billing.manage"
  | "system.manage";

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, PermissionKey[]> = {
  super_admin: [
    "dashboard.view",
    "pos.use",
    "pos.discount",
    "pos.refund",
    "pos.delete_bill",
    "orders.manage_qr",
    "catalog.view",
    "catalog.manage",
    "stock.manage",
    "cashflow.view",
    "cashflow.manage",
    "reports.view",
    "attendance.clock",
    "attendance.manage",
    "settings.view",
    "settings.manage_store",
    "users.manage",
    "permissions.manage",
    "notifications.manage",
    "organizations.manage",
    "billing.manage",
    "system.manage",
  ],
  owner: [
    "dashboard.view",
    "pos.use",
    "pos.discount",
    "pos.refund",
    "pos.delete_bill",
    "orders.manage_qr",
    "catalog.view",
    "catalog.manage",
    "stock.manage",
    "cashflow.view",
    "cashflow.manage",
    "reports.view",
    "attendance.clock",
    "attendance.manage",
    "settings.view",
    "settings.manage_store",
    "users.manage",
    "permissions.manage",
    "notifications.manage",
    "billing.manage",
  ],
  admin: [
    "dashboard.view",
    "pos.use",
    "pos.discount",
    "pos.refund",
    "pos.delete_bill",
    "orders.manage_qr",
    "catalog.view",
    "catalog.manage",
    "stock.manage",
    "cashflow.view",
    "cashflow.manage",
    "reports.view",
    "attendance.clock",
    "attendance.manage",
    "settings.view",
    "settings.manage_store",
    "users.manage",
    "notifications.manage",
  ],
  manager: [
    "dashboard.view",
    "pos.use",
    "pos.discount",
    "pos.refund",
    "catalog.view",
    "catalog.manage",
    "stock.manage",
    "cashflow.view",
    "reports.view",
    "attendance.clock",
    "attendance.manage",
    "settings.view",
    "orders.manage_qr",
  ],
  cashier: [
    "dashboard.view",
    "pos.use",
    "pos.discount",
    "catalog.view",
    "attendance.clock",
    "orders.manage_qr",
  ],
  staff: ["pos.use", "catalog.view", "attendance.clock"],
};

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  id: string;
  organizationId: string;
  storeId: string | null;
  userId: string;
  role: Role;
  invitedAt: string;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  key: PermissionKey;
  description: string;
}

export interface MembershipPermissionOverride {
  id: string;
  membershipId: string;
  organizationId: string;
  storeId: string | null;
  permissionKey: PermissionKey;
  granted: boolean;
  reason: string;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  organizationId: string;
  storeId: string | null;
  actorUserId: string;
  targetUserId: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface Subscription {
  id: string;
  organizationId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPermissions {
  organizationId: string;
  storeId: string | null;
  role: Role;
  permissions: Set<PermissionKey>;
  can: (key: PermissionKey) => boolean;
}
