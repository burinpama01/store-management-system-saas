"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isRoleLockedPermission } from "@/modules/auth/permission-resolver";
import type { MemberWithEmail } from "@/modules/settings/repository";
import type { PermissionKey, Role } from "@/modules/tenants/types";
import { ROLE_DEFAULT_PERMISSIONS } from "@/modules/tenants/types";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import {
  updateMemberRoleAction,
  upsertPermissionOverrideAction,
  removePermissionOverrideAction,
  removeMemberAction,
} from "./actions";

const ALL_PERMISSIONS: Array<{ key: PermissionKey; label: string }> = [
  { key: "dashboard.view", label: "ดู Dashboard" },
  { key: "pos.use", label: "ใช้ POS" },
  { key: "pos.discount", label: "ส่วนลด" },
  { key: "pos.refund", label: "คืนเงิน" },
  { key: "pos.delete_bill", label: "ลบบิล" },
  { key: "orders.manage_qr", label: "จัดการ QR Orders" },
  { key: "catalog.view", label: "ดูเมนู" },
  { key: "catalog.manage", label: "แก้ไขเมนู" },
  { key: "cashflow.view", label: "ดูบัญชี" },
  { key: "cashflow.record", label: "บันทึกรายรับ-จ่าย" },
  { key: "cashflow.manage", label: "แก้ไขบัญชี" },
  { key: "reports.view", label: "ดูรายงาน" },
  { key: "attendance.clock", label: "ลงชื่อเข้า-ออกงาน" },
  { key: "attendance.manage", label: "จัดการการเข้างาน" },
  { key: "settings.view", label: "ดูตั้งค่า" },
  { key: "settings.manage_printer", label: "ตั้งค่าเครื่องพิมพ์" },
  { key: "settings.manage_store", label: "แก้ไขตั้งค่าร้าน" },
  { key: "users.manage", label: "จัดการทีมงาน" },
  { key: "permissions.manage", label: "จัดการสิทธิ์" },
  { key: "notifications.manage", label: "แจ้งเตือน" },
  { key: "organizations.manage", label: "จัดการองค์กร" },
  { key: "billing.manage", label: "จัดการ Billing" },
  { key: "system.manage", label: "จัดการระบบ SaaS" },
];

const ROLES: Role[] = ["super_admin", "owner", "admin", "manager", "cashier", "staff"];
const PLATFORM_ROLES: Role[] = ["super_admin"];
const PLATFORM_PERMISSIONS: PermissionKey[] = ["organizations.manage", "system.manage"];

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  staff: "Staff",
};

function getEffectivePermissions(member: MemberWithEmail): Set<PermissionKey> {
  const effective = new Set<PermissionKey>(ROLE_DEFAULT_PERMISSIONS[member.role]);
  for (const o of member.overrides) {
    if (o.granted) effective.add(o.permissionKey);
    else effective.delete(o.permissionKey);
  }
  return effective;
}

interface Props {
  members: MemberWithEmail[];
  currentUserId: string;
  canManageUsers: boolean;
  canManagePermissions: boolean;
  /** Set when the user holds permissions.manage but the plan lacks advancedPermissions. */
  permissionsLockedMessage?: string | null;
  canManagePlatform: boolean;
}

export function TeamSettings({
  members,
  currentUserId,
  canManageUsers,
  canManagePermissions,
  permissionsLockedMessage = null,
  canManagePlatform,
}: Props) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<MemberWithEmail | null>(null);

  async function withLoading(id: string, fn: () => Promise<{ error: string | null }>) {
    setLoadingId(id);
    setActionError(null);
    const result = await fn();
    setLoadingId(null);
    if (result.error) { setActionError(result.error); return; }
    router.refresh();
  }

  function handleRoleChange(member: MemberWithEmail, newRole: string) {
    withLoading(member.membershipId + "-role", () =>
      updateMemberRoleAction(member.membershipId, newRole as Role),
    );
  }

  function handlePermissionToggle(member: MemberWithEmail, permKey: PermissionKey, currentlyGranted: boolean) {
    const hasOverride = member.overrides.find((o) => o.permissionKey === permKey);
    if (hasOverride) {
      if (hasOverride.granted === !currentlyGranted) {
        // Override is currently flipping; just remove it to reset to role default
        withLoading(member.membershipId + "-" + permKey, () =>
          removePermissionOverrideAction(member.membershipId, member.userId, permKey),
        );
      } else {
        // Toggle: set override to flip current state
        withLoading(member.membershipId + "-" + permKey, () =>
          upsertPermissionOverrideAction(member.membershipId, member.userId, member.role, permKey, !currentlyGranted),
        );
      }
    } else {
      withLoading(member.membershipId + "-" + permKey, () =>
        upsertPermissionOverrideAction(member.membershipId, member.userId, member.role, permKey, !currentlyGranted),
      );
    }
  }

  function handleRemoveMember(member: MemberWithEmail) {
    setConfirmTarget(member);
  }

  const availableRoles = canManagePlatform
    ? ROLES
    : ROLES.filter((role) => !PLATFORM_ROLES.includes(role));
  const platformPermissions = new Set<PermissionKey>(PLATFORM_PERMISSIONS);
  const visiblePermissions = canManagePlatform
    ? ALL_PERMISSIONS
    : ALL_PERMISSIONS.filter((permission) => !platformPermissions.has(permission.key));

  function handleConfirmRemove() {
    if (!confirmTarget) return;
    const member = confirmTarget;
    setConfirmTarget(null);
    withLoading(member.membershipId + "-remove", () =>
      removeMemberAction(member.membershipId, member.userId),
    );
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={!!confirmTarget}
        title="ลบสมาชิก"
        message={`ลบ ${confirmTarget?.email ?? ""} ออกจากทีมงาน?`}
        confirmLabel="ลบ"
        danger
        onConfirm={handleConfirmRemove}
        onCancel={() => setConfirmTarget(null)}
      />
      {actionError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {actionError}
        </p>
      )}
      {permissionsLockedMessage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          {permissionsLockedMessage} — อัปเกรดเป็นแพ็กเกจ Premium ขึ้นไปเพื่อกำหนดสิทธิ์รายบุคคล
        </p>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {members.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">ไม่พบสมาชิก</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const isExpanded = expandedId === member.membershipId;
              const effective = getEffectivePermissions(member);
              const busy = loadingId?.startsWith(member.membershipId);
              const memberVisiblePermissions = visiblePermissions.filter(
                (permission) => !isRoleLockedPermission(member.role, permission.key),
              );

              return (
                <div key={member.membershipId} className={busy ? "opacity-60" : ""}>
                  <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {member.email}
                        {isSelf && (
                          <span className="ml-1 text-xs text-gray-400">(คุณ)</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-400">
                        {member.storeId ? "เฉพาะร้านนี้" : "ทุกร้านในองค์กร"}
                        {member.joinedAt ? ` · เข้าร่วม ${member.joinedAt.slice(0, 10)}` : ""}
                      </p>
                    </div>

                    {canManageUsers && !isSelf ? (
                      <select
                        value={member.role}
                        onChange={(e) => handleRoleChange(member, e.target.value)}
                        disabled={!!busy}
                        className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                         {availableRoles.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-gray-600 bg-gray-100 rounded px-2 py-0.5">
                        {ROLE_LABELS[member.role]}
                      </span>
                    )}

                    {(canManagePermissions || member.overrides.length > 0) && (
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : member.membershipId)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {isExpanded ? "ซ่อนสิทธิ์" : "สิทธิ์"}
                        {member.overrides.length > 0 && ` (${member.overrides.length} override)`}
                      </button>
                    )}

                    {canManageUsers && !isSelf && member.role !== "owner" && member.role !== "super_admin" && (
                      <button
                        onClick={() => handleRemoveMember(member)}
                        disabled={!!busy}
                        className="text-xs text-red-600 hover:underline disabled:opacity-40"
                      >
                        ลบ
                      </button>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-3 bg-gray-50 border-t border-gray-100">
                      <p className="text-xs text-gray-500 mb-2 pt-2">สิทธิ์ที่มีผล</p>
                      <div className="grid grid-cols-2 gap-1">
                        {memberVisiblePermissions.map((p) => {
                          const isGranted = effective.has(p.key);
                          const override = member.overrides.find((o) => o.permissionKey === p.key);
                          const hasOverride = !!override;
                          const key = `${member.membershipId}-${p.key}`;
                          const permBusy = loadingId === key;

                          return (
                            <div key={p.key} className="flex items-center gap-1.5">
                              {canManagePermissions && !isSelf ? (
                                <button
                                  onClick={() => handlePermissionToggle(member, p.key, isGranted)}
                                  disabled={permBusy}
                                  className={`w-4 h-4 rounded border flex-shrink-0 transition-colors ${
                                    isGranted
                                      ? "bg-green-500 border-green-500"
                                      : "bg-white border-gray-300"
                                  } disabled:opacity-40`}
                                  title={isGranted ? "คลิกเพื่อถอน" : "คลิกเพื่อมอบ"}
                                />
                              ) : (
                                <div
                                  className={`w-4 h-4 rounded border flex-shrink-0 ${
                                    isGranted
                                      ? "bg-green-500 border-green-500"
                                      : "bg-white border-gray-300"
                                  }`}
                                />
                              )}
                              <span className={`text-xs ${isGranted ? "text-gray-700" : "text-gray-400"}`}>
                                {p.label}
                                {hasOverride && (
                                  <span className={`ml-1 text-xs ${override!.granted ? "text-green-600" : "text-red-500"}`}>
                                    {override!.granted ? "★" : "✕"}
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {canManagePermissions && !isSelf && member.overrides.length > 0 && (
                        <button
                          onClick={() => {
                            for (const o of member.overrides) {
                              withLoading(`${member.membershipId}-${o.permissionKey}`, () =>
                                removePermissionOverrideAction(member.membershipId, member.userId, o.permissionKey),
                              );
                            }
                          }}
                          className="mt-2 text-xs text-orange-600 hover:underline"
                        >
                          รีเซ็ตสิทธิ์ทั้งหมดให้ตรง role
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400">
        ★ = override เพิ่มสิทธิ์ · ✕ = override ถอนสิทธิ์
      </p>
    </div>
  );
}
