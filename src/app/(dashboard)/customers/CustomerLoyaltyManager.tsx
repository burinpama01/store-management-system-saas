"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CustomerProfile } from "@/modules/customers/types";
import type { LoyaltyReward, LoyaltySettingsSummary } from "@/modules/loyalty/repository";
import type { CouponPolicy } from "@/modules/promotions/types";
import {
  adjustCustomerPointsAction,
  deleteCouponAction,
  deleteCustomerAction,
  deleteRewardAction,
  generateMemberPortalQrAction,
  saveCouponAction,
  saveCustomerAction,
  saveLoyaltySettingsAction,
  saveRewardAction,
} from "./actions";
import { Button } from "@/shared/components/ui";
import { ImageUpload } from "@/shared/components/ui/ImageUpload";

export interface RewardProductOption {
  id: string;
  name: string;
  basePrice: number;
}

interface Props {
  customers: CustomerProfile[];
  coupons: CouponPolicy[];
  loyaltySettings: LoyaltySettingsSummary | null;
  rewards: LoyaltyReward[];
  memberPortalUrl: string | null;
  memberPortalQrDataUrl: string | null;
  organizationId: string;
  storeId: string;
  rewardProducts: RewardProductOption[];
  planName: string;
  loyaltyEnabled: boolean;
  couponEnabled: boolean;
  canManageCustomers: boolean;
  canManageCoupons: boolean;
  canManageLoyaltySettings: boolean;
  errors: string[];
}

type SectionKey = "rewards" | "customers" | "points" | "coupons";
type OpenSections = Record<SectionKey, boolean>;
type SimpleActionResult = { error: string | null };
type MemberPortalQrResult = SimpleActionResult & {
  memberPortalUrl?: string | null;
  memberPortalQrDataUrl?: string | null;
};

function StatusMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
      {message}
    </div>
  );
}

function LockNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted)]">
      {children}
    </div>
  );
}

function ToggleSection({
  sectionKey,
  title,
  description,
  summary,
  isOpen,
  onToggle,
  children,
}: {
  sectionKey: SectionKey;
  title: string;
  description: string;
  summary: string;
  isOpen: boolean;
  onToggle: (sectionKey: SectionKey) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">{title}</h2>
          <p className="text-sm text-[var(--muted)]">{description}</p>
        </div>
        <button
          className="btn-secondary"
          type="button"
          aria-expanded={isOpen}
          aria-controls={`${sectionKey}-form-panel`}
          onClick={() => onToggle(sectionKey)}
        >
          {isOpen ? "ปิดฟอร์ม" : "เปิดฟอร์ม"}
        </button>
      </div>
      {isOpen ? (
        <div id={`${sectionKey}-form-panel`} className="mt-4">
          {children}
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--muted)]">
          {summary}
        </p>
      )}
    </section>
  );
}

function formatPoints(value?: number) {
  return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(value ?? 0);
}

function toDateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function RewardForm({
  reward,
  organizationId,
  storeId,
  rewardProducts,
  isPending,
  canManage,
  onSubmit,
  onDelete,
}: {
  reward?: LoyaltyReward;
  organizationId: string;
  storeId: string;
  rewardProducts: RewardProductOption[];
  isPending: boolean;
  canManage: boolean;
  onSubmit: (formData: FormData) => void;
  onDelete?: () => void;
}) {
  const isEdit = Boolean(reward);
  const [rewardType, setRewardType] = useState<"discount" | "product">(reward?.rewardType ?? "product");
  const [codeMode, setCodeMode] = useState<"auto" | "manual">(reward?.codeMode ?? "auto");

  return (
    <form action={onSubmit} className="grid gap-3 rounded-lg border border-[var(--border)] p-4">
      {isEdit ? (
        <input type="hidden" name="id" value={reward!.id} />
      ) : (
        <input type="hidden" name="isActive" value="on" />
      )}

      <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อรางวัล</span>
          <input className="form-input" name="name" defaultValue={reward?.name ?? ""} maxLength={120} required placeholder="เครื่องดื่มฟรี" />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">แต้มที่ใช้</span>
          <input className="form-input" name="pointsCost" type="number" min="1" step="1" defaultValue={reward?.pointsCost ?? ""} required />
        </label>
      </div>

      <label className="space-y-1">
        <span className="text-xs font-semibold uppercase text-[var(--muted)]">รายละเอียด</span>
        <input className="form-input" name="description" defaultValue={reward?.description ?? ""} maxLength={240} placeholder="แลกได้ที่หน้าเคาน์เตอร์" />
      </label>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">ประเภทของรางวัล</span>
          <select
            className="form-input"
            name="rewardType"
            value={rewardType}
            onChange={(event) => setRewardType(event.target.value === "discount" ? "discount" : "product")}
          >
            <option value="product">สินค้า / ของรางวัล</option>
            <option value="discount">ส่วนลดเงินสด</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">สต็อก</span>
          <input className="form-input" name="stockQuantity" type="number" min="0" step="1" defaultValue={reward?.stockQuantity ?? ""} placeholder="ไม่จำกัด" />
        </label>
      </div>

      {rewardType === "discount" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชนิดส่วนลด</span>
            <select className="form-input" name="discountKind" defaultValue={reward?.discountKind ?? "amount"}>
              <option value="amount">บาท</option>
              <option value="percentage">%</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase text-[var(--muted)]">มูลค่าส่วนลด</span>
            <input
              className="form-input"
              name="discountValue"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={reward?.discountValue ?? ""}
              placeholder="เช่น 10"
            />
          </label>
        </div>
      ) : (
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">สินค้าที่ใช้แลก (จาก catalog)</span>
          <select className="form-input" name="rewardProductId" defaultValue={reward?.rewardProductId ?? ""}>
            <option value="" disabled>
              เลือกสินค้าในระบบ
            </option>
            {rewardProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} (฿{product.basePrice})
              </option>
            ))}
          </select>
          {rewardProducts.length === 0 && (
            <span className="text-xs text-amber-600">ยังไม่มีสินค้าในระบบ — เพิ่มสินค้าที่เมนูสินค้าก่อน</span>
          )}
        </label>
      )}

      <ImageUpload
        name="imageUrl"
        defaultValue={reward?.imageUrl ?? ""}
        organizationId={organizationId}
        storeId={storeId}
        label="รูปของรางวัล"
      />

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase text-[var(--muted)]">รหัสแลกรับ</span>
          <select
            className="form-input"
            name="codeMode"
            value={codeMode}
            onChange={(event) => setCodeMode(event.target.value === "manual" ? "manual" : "auto")}
          >
            <option value="auto">ระบบสร้างให้อัตโนมัติ</option>
            <option value="manual">กำหนดรหัสเอง</option>
          </select>
        </label>
        {codeMode === "manual" && (
          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase text-[var(--muted)]">รหัสที่กำหนด</span>
            <input className="form-input" name="manualCode" defaultValue={reward?.manualCode ?? ""} maxLength={24} placeholder="เช่น HAT" />
            <span className="text-xs text-[var(--muted)]">ระบบจะต่อท้ายอักษรสุ่มทุกครั้งที่แลก เพื่อกันโค้ดซ้ำ/ถูกเดา</span>
          </label>
        )}
      </div>

      {isEdit && (
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input name="isActive" type="checkbox" defaultChecked={reward!.isActive} />
          เปิดให้แลก
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant={isEdit ? "secondary" : "primary"} type="submit" loading={isPending} disabled={!canManage}>
          {isEdit ? "บันทึก" : "เพิ่มรางวัล"}
        </Button>
        {isEdit && onDelete && (
          <button
            className="btn-secondary"
            type="button"
            disabled={!canManage || isPending || !reward!.isActive}
            onClick={onDelete}
          >
            ปิดใช้
          </button>
        )}
      </div>
    </form>
  );
}

export function CustomerLoyaltyManager({
  customers,
  coupons,
  loyaltySettings,
  rewards,
  memberPortalUrl,
  memberPortalQrDataUrl,
  organizationId,
  storeId,
  rewardProducts,
  planName,
  loyaltyEnabled,
  couponEnabled,
  canManageCustomers,
  canManageCoupons,
  canManageLoyaltySettings,
  errors,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(errors[0] ?? null);
  const [memberPortalQr, setMemberPortalQr] = useState<{
    memberPortalUrl: string | null;
    memberPortalQrDataUrl: string | null;
  } | null>(null);
  const [openSections, setOpenSections] = useState<OpenSections>({
    rewards: false,
    customers: false,
    points: false,
    coupons: false,
  });
  const activeCustomers = useMemo(() => customers.filter((customer) => customer.isActive), [customers]);
  const activeCoupons = useMemo(() => coupons.filter((coupon) => coupon.isActive), [coupons]);
  const activeRewards = useMemo(() => rewards.filter((reward) => reward.isActive), [rewards]);
  const currentMemberPortalUrl = memberPortalQr?.memberPortalUrl ?? memberPortalUrl;
  const currentMemberPortalQrDataUrl = memberPortalQr?.memberPortalQrDataUrl ?? memberPortalQrDataUrl;

  function runFormAction(action: (formData: FormData) => Promise<{ error: string | null }>, formData: FormData) {
    startTransition(async () => {
      const result = await action(formData);
      setMessage(result.error ?? "บันทึกข้อมูลแล้ว");
      if (!result.error) router.refresh();
    });
  }

  function runIdAction(action: (id: string) => Promise<{ error: string | null }>, id: string) {
    startTransition(async () => {
      const result = await action(id);
      setMessage(result.error ?? "ปิดใช้งานข้อมูลแล้ว");
      if (!result.error) router.refresh();
    });
  }

  function runMemberPortalQrAction(action: () => Promise<MemberPortalQrResult>, successMessage: string) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.error ?? successMessage);
      if (!result.error) {
        setMemberPortalQr({
          memberPortalUrl: result.memberPortalUrl ?? null,
          memberPortalQrDataUrl: result.memberPortalQrDataUrl ?? null,
        });
        router.refresh();
      }
    });
  }

  function toggleSection(sectionKey: SectionKey) {
    setOpenSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  }

  return (
    <div className="space-y-6">
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="page-kicker">แพ็กเกจ {planName}</p>
            <h1 className="panel-title">ลูกค้า คูปอง และสะสมแต้ม</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={loyaltyEnabled ? "badge badge-success" : "badge badge-warning"}>สะสมแต้ม</span>
            <span className={couponEnabled ? "badge badge-success" : "badge badge-warning"}>คูปอง</span>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] p-4">
            <p className="text-sm text-[var(--muted)]">ลูกค้าที่ใช้งาน</p>
            <p className="text-2xl font-bold text-[var(--foreground)]">{activeCustomers.length}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4">
            <p className="text-sm text-[var(--muted)]">คูปองที่เปิดใช้</p>
            <p className="text-2xl font-bold text-[var(--foreground)]">{activeCoupons.length}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4">
            <p className="text-sm text-[var(--muted)]">อัตราแต้ม</p>
            <p className="text-2xl font-bold text-[var(--foreground)]">
              {loyaltySettings?.pointsPerCurrency ?? 0.01} / 1 บาท
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] p-4">
            <p className="text-sm text-[var(--muted)]">ของรางวัล</p>
            <p className="text-2xl font-bold text-[var(--foreground)]">{activeRewards.length}</p>
          </div>
        </div>
        <div className="mt-4">
          <StatusMessage message={message} />
        </div>
      </section>

      <ToggleSection
        sectionKey="rewards"
        title="ของรางวัลแลกแต้ม"
        description="เพิ่มรางวัลให้ลูกค้านำแต้มมาแลกผ่าน QR member portal"
        summary={`มีของรางวัล ${activeRewards.length} รายการ กดเปิดฟอร์มเพื่อเพิ่มหรือแก้ไข`}
        isOpen={openSections.rewards}
        onToggle={toggleSection}
      >
        {!loyaltyEnabled ? (
          <LockNotice>ต้องใช้แพ็กเกจที่รองรับสะสมแต้มเพื่อจัดการของรางวัล</LockNotice>
        ) : (
          <div className="space-y-4">
            <RewardForm
              organizationId={organizationId}
              storeId={storeId}
              rewardProducts={rewardProducts}
              isPending={isPending}
              canManage={canManageLoyaltySettings}
              onSubmit={(formData) => runFormAction(saveRewardAction, formData)}
            />

            <div className="grid gap-3">
              {rewards.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted)]">
                  ยังไม่มีของรางวัลสำหรับแลกแต้ม
                </p>
              ) : (
                rewards.map((reward) => (
                  <RewardForm
                    key={reward.id}
                    reward={reward}
                    organizationId={organizationId}
                    storeId={storeId}
                    rewardProducts={rewardProducts}
                    isPending={isPending}
                    canManage={canManageLoyaltySettings}
                    onSubmit={(formData) => runFormAction(saveRewardAction, formData)}
                    onDelete={() => runIdAction(deleteRewardAction, reward.id)}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </ToggleSection>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">QR สมัครสมาชิก</h2>
            <p className="text-sm text-[var(--muted)]">QR ถาวรของร้าน ลูกค้าสแกนซ้ำเพื่อกลับมาดูแต้มได้</p>
          </div>
          <button
            className="btn-secondary"
            type="button"
            disabled={!canManageLoyaltySettings || isPending || !loyaltyEnabled}
            onClick={() => runMemberPortalQrAction(generateMemberPortalQrAction, "พร้อมใช้ QR สมัครสมาชิกถาวรแล้ว")}
          >
            สร้าง/แสดง QR ถาวร
          </button>
        </div>
        {!loyaltyEnabled ? (
          <LockNotice>ต้องใช้แพ็กเกจที่รองรับสะสมแต้มจึงจะสร้าง QR สมาชิกได้</LockNotice>
        ) : currentMemberPortalUrl ? (
          <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
            <div className="rounded-lg border border-[var(--border)] bg-white p-3">
              {currentMemberPortalQrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={currentMemberPortalQrDataUrl}
                  alt="QR สมัครสมาชิก"
                  width={220}
                  height={220}
                  className="mx-auto rounded-md bg-white"
                />
              ) : (
                <div className="grid aspect-square place-items-center rounded-md bg-[var(--surface-muted)] text-sm text-[var(--muted)]">
                  สร้างรูป QR ไม่สำเร็จ
                </div>
              )}
            </div>
            <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
              <div>
                <p className="text-xs font-semibold uppercase text-[var(--muted)]">ลิงก์สำหรับ QR ของร้านนี้เท่านั้น</p>
                <p className="break-all text-sm font-semibold text-[var(--foreground)]">{currentMemberPortalUrl}</p>
              </div>
              <p className="text-sm text-[var(--muted)]">
                กรณีลูกค้าใช้หลายร้าน ระบบจะแยก session และแต้มตามร้านจาก QR ที่สแกน ไม่ให้ดูแต้มข้ามร้านจาก URL สาธารณะ
              </p>
            </div>
          </div>
        ) : (
          <LockNotice>ยังไม่มี QR สมัครสมาชิก กด “สร้าง/แสดง QR ถาวร” เพื่อเริ่มใช้งาน member portal ของร้านนี้</LockNotice>
        )}
      </section>

      <ToggleSection
        sectionKey="customers"
        title="ลูกค้า"
        description="เพิ่ม แก้ไข หรือปิดใช้งานลูกค้าที่ใช้กับ POS"
        summary={`มีลูกค้าใช้งาน ${activeCustomers.length} ราย กดเปิดฟอร์มเพื่อเพิ่มหรือแก้ไข`}
        isOpen={openSections.customers}
        onToggle={toggleSection}
      >
        {!loyaltyEnabled ? (
          <LockNotice>แพ็กเกจนี้ยังไม่รองรับสะสมแต้มและฐานลูกค้า</LockNotice>
        ) : (
          <div className="space-y-4">
            <form
              action={(formData) => runFormAction(saveCustomerAction, formData)}
              className="grid gap-3 rounded-lg border border-[var(--border)] p-4 md:grid-cols-4"
            >
              <input type="hidden" name="isActive" value="on" />
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อลูกค้า</span>
                <input className="form-input" name="name" maxLength={120} required placeholder="คุณสมชาย" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">โทรศัพท์</span>
                <input className="form-input" name="phone" placeholder="0812345678" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">อีเมล</span>
                <input className="form-input" name="email" type="email" placeholder="customer@example.com" />
              </label>
              <div className="flex items-end">
                <Button variant="primary" className="w-full" type="submit" loading={isPending} disabled={!canManageCustomers}>
                  เพิ่มลูกค้า
                </Button>
              </div>
            </form>
            <div className="grid gap-3">
              {customers.map((customer) => (
                <form
                  action={(formData) => runFormAction(saveCustomerAction, formData)}
                  className="grid gap-3 rounded-lg border border-[var(--border)] p-4 lg:grid-cols-[1.4fr_1fr_1fr_0.8fr_auto]"
                  key={customer.id}
                >
                  <input type="hidden" name="id" value={customer.id} />
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อ</span>
                    <input className="form-input" name="name" defaultValue={customer.name} maxLength={120} required />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">โทรศัพท์</span>
                    <input className="form-input" name="phone" defaultValue={customer.phone ?? ""} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">อีเมล</span>
                    <input className="form-input" name="email" type="email" defaultValue={customer.email ?? ""} />
                  </label>
                  <div className="flex items-end justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                      <input name="isActive" type="checkbox" defaultChecked={customer.isActive} />
                      ใช้งาน
                    </label>
                    <span className="text-sm font-semibold text-[var(--foreground)]">
                      {formatPoints(customer.pointsBalance)} แต้ม
                    </span>
                  </div>
                  <div className="flex items-end gap-2">
                    <Button variant="secondary" type="submit" loading={isPending} disabled={!canManageCustomers}>
                      บันทึก
                    </Button>
                    <button
                      className="btn-secondary"
                      type="button"
                      disabled={!canManageCustomers || isPending || !customer.isActive}
                      onClick={() => runIdAction(deleteCustomerAction, customer.id)}
                    >
                      ปิดใช้
                    </button>
                  </div>
                </form>
              ))}
            </div>
          </div>
        )}
      </ToggleSection>

      <ToggleSection
        sectionKey="points"
        title="สะสมแต้ม"
        description="ตั้งค่าอัตราแต้มพื้นฐานของร้าน"
        summary={`อัตราปัจจุบัน ${loyaltySettings?.pointsPerCurrency ?? 0.01} แต้ม / 1 บาท กดเปิดฟอร์มเพื่อปรับแต้ม`}
        isOpen={openSections.points}
        onToggle={toggleSection}
      >
        {!loyaltyEnabled ? (
          <LockNotice>ต้องใช้แพ็กเกจที่รองรับสะสมแต้ม</LockNotice>
        ) : (
          <div className="space-y-4">
            <form
              action={(formData) => runFormAction(saveLoyaltySettingsAction, formData)}
              className="grid gap-3 rounded-lg border border-[var(--border)] p-4 md:grid-cols-4"
            >
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">แต้มต่อ 1 บาท</span>
                <input
                  className="form-input"
                  name="pointsPerCurrency"
                  type="number"
                  min="0.0001"
                  max="10"
                  step="0.0001"
                  defaultValue={loyaltySettings?.pointsPerCurrency ?? 0.01}
                  required
                />
              </label>
              <label className="flex items-end gap-2 text-sm text-[var(--muted)]">
                <input name="earnEnabled" type="checkbox" defaultChecked={loyaltySettings?.earnEnabled ?? true} />
                เปิดรับแต้ม
              </label>
              <label className="flex items-end gap-2 text-sm text-[var(--muted)]">
                <input name="redeemEnabled" type="checkbox" defaultChecked={loyaltySettings?.redeemEnabled ?? false} />
                เปิดแลกแต้ม
              </label>
              <div className="flex items-end">
                <Button variant="primary" className="w-full" type="submit" loading={isPending} disabled={!canManageLoyaltySettings}>
                  บันทึกแต้ม
                </Button>
              </div>
            </form>

            <form
              action={(formData) => runFormAction(adjustCustomerPointsAction, formData)}
              className="grid gap-3 rounded-lg border border-[var(--border)] p-4 lg:grid-cols-[1.4fr_0.7fr_1.6fr_auto]"
            >
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ปรับแต้มลูกค้า</span>
                <select className="form-input" name="customerId" required defaultValue="">
                  <option value="" disabled>เลือกลูกค้า</option>
                  {activeCustomers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} ({formatPoints(customer.pointsBalance)} แต้ม)
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">เพิ่ม/ลดแต้ม</span>
                <input className="form-input" name="pointsDelta" type="number" step="1" placeholder="100 หรือ -50" required />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">เหตุผล</span>
                <input className="form-input" name="reason" maxLength={200} placeholder="ปรับแต้มจากแคมเปญ / แก้ไขรายการ" />
              </label>
              <div className="flex items-end">
                <Button variant="primary" className="w-full" type="submit" loading={isPending} disabled={!canManageLoyaltySettings}>
                  ปรับแต้ม
                </Button>
              </div>
            </form>
          </div>
        )}
      </ToggleSection>

      <ToggleSection
        sectionKey="coupons"
        title="คูปอง"
        description="สร้างและควบคุมคูปองส่วนลดสำหรับ POS"
        summary={`มีคูปองเปิดใช้ ${activeCoupons.length} รายการ กดเปิดฟอร์มเพื่อเพิ่มหรือแก้ไข`}
        isOpen={openSections.coupons}
        onToggle={toggleSection}
      >
        {!couponEnabled ? (
          <LockNotice>แพ็กเกจนี้ยังไม่รองรับคูปอง</LockNotice>
        ) : (
          <div className="space-y-4">
            <form
              action={(formData) => runFormAction(saveCouponAction, formData)}
              className="grid gap-3 rounded-lg border border-[var(--border)] p-4 md:grid-cols-8"
            >
              <input type="hidden" name="isActive" value="on" />
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">รหัส</span>
                <input className="form-input" name="code" required placeholder="SAVE10" />
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อ</span>
                <input className="form-input" name="name" required placeholder="ส่วนลดสมาชิก" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ประเภท</span>
                <select className="form-input" name="discountType" defaultValue="amount">
                  <option value="amount">บาท</option>
                  <option value="percentage">%</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ส่วนลด</span>
                <input className="form-input" name="discountValue" type="number" min="0.01" step="0.01" required />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">ใช้ได้รวม</span>
                <input className="form-input" name="maxRedemptions" type="number" min="1" step="1" placeholder="ไม่จำกัด" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase text-[var(--muted)]">1 user ใช้ได้</span>
                <input
                  className="form-input"
                  name="maxRedemptionsPerCustomer"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="ไม่จำกัด"
                />
              </label>
              <div className="flex items-end">
                <Button variant="primary" className="w-full" type="submit" loading={isPending} disabled={!canManageCoupons}>
                  เพิ่มคูปอง
                </Button>
              </div>
            </form>
            <div className="grid gap-3">
              {coupons.map((coupon) => (
                <form
                  action={(formData) => runFormAction(saveCouponAction, formData)}
                  className="grid gap-3 rounded-lg border border-[var(--border)] p-4 xl:grid-cols-[0.8fr_1.2fr_0.7fr_0.7fr_0.7fr_0.7fr_0.7fr_0.7fr_auto]"
                  key={coupon.id}
                >
                  <input type="hidden" name="id" value={coupon.id} />
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">รหัส</span>
                    <input className="form-input" name="code" defaultValue={coupon.code} required />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ชื่อ</span>
                    <input className="form-input" name="name" defaultValue={coupon.name} required />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ประเภท</span>
                    <select className="form-input" name="discountType" defaultValue={coupon.discountType}>
                      <option value="amount">บาท</option>
                      <option value="percentage">%</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ส่วนลด</span>
                    <input
                      className="form-input"
                      name="discountValue"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={coupon.discountValue}
                      required
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ขั้นต่ำ</span>
                    <input className="form-input" name="minSubtotal" type="number" min="0" step="0.01" defaultValue={coupon.minSubtotal} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">หมดเขต</span>
                    <input className="form-input" name="endsAt" type="datetime-local" defaultValue={toDateTimeInput(coupon.endsAt)} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">ใช้ได้รวม</span>
                    <input
                      className="form-input"
                      name="maxRedemptions"
                      type="number"
                      min="1"
                      step="1"
                      defaultValue={coupon.maxRedemptions ?? ""}
                      placeholder="ไม่จำกัด"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase text-[var(--muted)]">1 user ใช้ได้</span>
                    <input
                      className="form-input"
                      name="maxRedemptionsPerCustomer"
                      type="number"
                      min="1"
                      step="1"
                      defaultValue={coupon.maxRedemptionsPerCustomer ?? ""}
                      placeholder="ไม่จำกัด"
                    />
                  </label>
                  <div className="grid gap-2">
                    <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                      <input name="isActive" type="checkbox" defaultChecked={coupon.isActive} />
                      ใช้งาน
                    </label>
                    <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                      <input name="stackableWithManualDiscount" type="checkbox" defaultChecked={coupon.stackableWithManualDiscount} />
                      รวมส่วนลดมือ
                    </label>
                    <div className="flex gap-2">
                      <Button variant="secondary" type="submit" loading={isPending} disabled={!canManageCoupons}>
                        บันทึก
                      </Button>
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={!canManageCoupons || isPending || !coupon.isActive}
                        onClick={() => runIdAction(deleteCouponAction, coupon.id)}
                      >
                        ปิดใช้
                      </button>
                    </div>
                    <p className="text-xs text-[var(--muted)]">ใช้แล้ว {coupon.redeemedCount} ครั้ง</p>
                  </div>
                </form>
              ))}
            </div>
          </div>
        )}
      </ToggleSection>
    </div>
  );
}
