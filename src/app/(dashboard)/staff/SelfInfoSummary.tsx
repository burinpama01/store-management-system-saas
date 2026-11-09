import type { StaffSelfInfo } from "./StaffManager";

interface OwnerValues {
  fullName?: string;
  bankName?: string;
  bankAccountName?: string;
  bankAccountMasked?: string;
}

const has = (v?: string) => !!v && v.trim() !== "";

/**
 * กล่อง "พนักงานกรอกเอง" ในฟอร์มแก้ข้อมูลพนักงาน
 * ช่องตัวตน/บัญชีที่ร้านตั้งแล้ว ใช้ค่าของร้าน (ค่าที่พนักงานกรอกไม่มีผล) — ช่องว่างของร้านจะใช้ค่าพนักงาน
 */
export function SelfInfoSummary({ info, owner }: { info: StaffSelfInfo; owner?: OwnerValues | null }) {
  const rows: Array<{ label: string; value?: string; overriddenByOwner?: boolean }> = [
    { label: "ชื่อ-สกุลจริง", value: info.fullName, overriddenByOwner: has(owner?.fullName) },
    { label: "ชื่อเล่น", value: info.nickname },
    { label: "เบอร์โทร", value: info.phone },
    { label: "วันเกิด", value: info.birthDate },
    { label: "ที่อยู่", value: info.address },
    {
      label: "ผู้ติดต่อฉุกเฉิน",
      value: [info.emergencyContactName, info.emergencyContactPhone].filter(Boolean).join(" · ") || undefined,
    },
    { label: "ธนาคาร", value: info.bankName, overriddenByOwner: has(owner?.bankName) },
    { label: "เลขบัญชี", value: info.bankAccountMasked || undefined, overriddenByOwner: has(owner?.bankAccountMasked) },
    { label: "ชื่อบัญชี", value: info.bankAccountName, overriddenByOwner: has(owner?.bankAccountName) },
  ].filter((r) => has(r.value));

  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-gray-700 sm:col-span-2 lg:col-span-3">
      <p className="font-bold text-sky-900">พนักงานกรอกเอง</p>
      <p className="mt-0.5 text-[11px] text-sky-800">
        ช่องชื่อจริง/บัญชีที่ร้านยังว่าง สลิปจะใช้ค่าที่พนักงานกรอก · กรอกในฟอร์มด้านล่าง = ล็อกไม่ให้พนักงานแก้
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-2">
            <dt className="shrink-0 text-gray-500">{r.label}</dt>
            <dd className={r.overriddenByOwner ? "text-gray-400 line-through" : "font-medium"}>
              {r.value}
              {r.overriddenByOwner && <span className="ml-1 no-underline">(ใช้ค่าของร้าน)</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
