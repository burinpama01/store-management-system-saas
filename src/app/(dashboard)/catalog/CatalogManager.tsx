"use client";

import { useActionState, useTransition, useState } from "react";
import type {
  Category,
  Product,
  VariantTemplate,
  ModifierGroupTemplate,
  ModifierGroup,
} from "@/modules/catalog/types";
import type { BillingPlan } from "@/modules/billing/types";
import type { Role } from "@/modules/tenants/types";
import { ModalDialog, ImageUpload } from "@/shared/components/ui";
import {
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
  createProductAction,
  updateProductAction,
  deleteProductAction,
  createVariantTemplateAction,
  deleteVariantTemplateAction,
  applyVariantTemplateAction,
  createModifierGroupTemplateAction,
  deleteModifierGroupTemplateAction,
  addModifierOptionTemplateAction,
  deleteModifierOptionTemplateAction,
  applyModifierGroupTemplateAction,
  deleteVariantAction,
  deleteModifierGroupAction,
  addModifierOptionAction,
  deleteModifierOptionAction,
} from "./actions";

type PanelMode =
  | "closed"
  | "add-category"
  | "edit-category"
  | "add-product"
  | "edit-product";

interface Props {
  categories: Category[];
  products: Product[];
  variantTemplates: VariantTemplate[];
  modifierGroupTemplates: ModifierGroupTemplate[];
  role: Role;
  storeName: string;
  storeId: string;
  organizationId: string;
  planName: BillingPlan;
  canManageCatalog: boolean;
  canUseQrOrdering: boolean;
  canUseStock: boolean;
}

function priceStr(n: number) {
  return `฿${n.toLocaleString("th-TH")}`;
}

function priceDeltaStr(n: number) {
  if (n === 0) return "±0";
  return n > 0 ? `+${n}` : `${n}`;
}

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  staff: "Staff",
};

const PLAN_LABELS: Record<BillingPlan, string> = {
  free: "Free",
  starter: "Starter",
  standard: "Standard",
  premium: "Premium",
  enterprise: "Enterprise",
};

function productInitials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "OS";
}

function productImageAlt(product: Product) {
  return `รูปเมนู ${product.name}`;
}

function RoleCapabilityBar({
  role,
  planName,
  canManageCatalog,
  canUseQrOrdering,
  canUseStock,
}: {
  role: Role;
  planName: BillingPlan;
  canManageCatalog: boolean;
  canUseQrOrdering: boolean;
  canUseStock: boolean;
}) {
  const items = [
    { label: "แก้เมนู", on: canManageCatalog, reason: "ต้องมีสิทธิ์ catalog.manage" },
    { label: "เปิด QR", on: canUseQrOrdering, reason: "ต้องใช้แพ็กเกจ Premium ขึ้นไป" },
    { label: "สต็อก", on: canUseStock, reason: "ต้องใช้แพ็กเกจ Standard ขึ้นไป" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-md border border-teal-200 bg-teal-50 px-2.5 py-1 font-bold text-teal-800">
        Role: {ROLE_LABELS[role]}
      </span>
      <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1 font-bold text-slate-700">
        Plan: {PLAN_LABELS[planName]}
      </span>
      {items.map((item) => (
        <span
          key={item.label}
          title={item.on ? "พร้อมใช้งาน" : item.reason}
          className={`rounded-md border px-2.5 py-1 font-medium ${
            item.on
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-100 text-slate-500"
          }`}
        >
          {item.on ? "เปิด" : "ล็อก"} {item.label}
        </span>
      ))}
    </div>
  );
}

function ProductImage({ product }: { product: Product }) {
  if (product.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={product.imageUrl}
        alt={productImageAlt(product)}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-100 text-sm font-bold text-slate-500">
      {productInitials(product.name)}
    </div>
  );
}

// ─── Small reusable pieces ────────────────────────────────────────

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
      {message}
    </p>
  );
}

function NoticeBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700" aria-live="polite">
      {message}
    </p>
  );
}

function InputField({
  label,
  name,
  defaultValue,
  required,
  type = "text",
  placeholder,
  min,
  step,
}: {
  label: string;
  name: string;
  defaultValue?: string | number;
  required?: boolean;
  type?: string;
  placeholder?: string;
  min?: string;
  step?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        min={min}
        step={step}
        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
      />
    </div>
  );
}

// ─── Category panel forms ─────────────────────────────────────────

function AddCategoryForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const res = await createCategoryAction(prev, fd);
      if (!res.error) onDone();
      return res;
    },
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-3">
      <ErrorBanner message={state.error} />
      <InputField label="ชื่อหมวดหมู่" name="name" required />
      <InputField label="คำอธิบาย" name="description" placeholder="ไม่บังคับ" />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 py-1.5 text-sm font-medium text-white bg-gray-900 rounded hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "กำลังบันทึก..." : "บันทึก"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
}

function EditCategoryForm({
  category,
  onDone,
  onCancel,
}: {
  category: Category;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, formAction, isPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const res = await updateCategoryAction(category.id, prev, fd);
      if (!res.error) onDone();
      return res;
    },
    { error: null },
  );

  return (
    <form action={formAction} className="space-y-3">
      <ErrorBanner message={state.error} />
      <InputField label="ชื่อหมวดหมู่" name="name" defaultValue={category.name} required />
      <InputField
        label="คำอธิบาย"
        name="description"
        defaultValue={category.description}
        placeholder="ไม่บังคับ"
      />
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 py-1.5 text-sm font-medium text-white bg-gray-900 rounded hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "กำลังบันทึก..." : "บันทึก"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
}

// ─── Product panel form ───────────────────────────────────────────

function ProductForm({
  product,
  categories,
  defaultCategoryId,
  canUseQrOrdering,
  storeId,
  organizationId,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  product?: Product;
  categories: Category[];
  defaultCategoryId?: string;
  canUseQrOrdering: boolean;
  storeId: string;
  organizationId: string;
  onSubmit: (fd: FormData) => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <form
      action={onSubmit}
      className="space-y-3"
    >
      <ErrorBanner message={error} />
      <InputField
        label="ชื่อสินค้า"
        name="name"
        defaultValue={product?.name}
        required
        placeholder="เช่น กาแฟดำ"
      />
      <div className="space-y-1">
        <label className="block text-xs font-medium text-gray-700">
          หมวดหมู่<span className="text-red-500 ml-0.5">*</span>
        </label>
        <select
          name="categoryId"
          required
          defaultValue={product?.categoryId ?? defaultCategoryId ?? ""}
          className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
        >
          <option value="">— เลือกหมวดหมู่ —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <InputField
        label="ราคาตั้งต้น (บาท)"
        name="basePrice"
        type="number"
        defaultValue={product?.basePrice ?? 0}
        min="0"
        step="1"
        required
      />
      <ImageUpload
        label="รูปเมนู (อัปโหลด — ระบบย่อขนาดอัตโนมัติ — หรือวาง URL)"
        name="imageUrl"
        defaultValue={product?.imageUrl}
        organizationId={organizationId}
        storeId={storeId}
      />
      <div className="space-y-1">
        <label className="block text-xs font-medium text-gray-700">คำอธิบาย</label>
        <textarea
          name="description"
          rows={2}
          defaultValue={product?.description}
          className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
          placeholder="ไม่บังคับ"
        />
      </div>
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            name="availableForPos"
            defaultChecked={product?.availableForPos ?? true}
            className="rounded border-gray-300"
          />
          POS
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            name="availableForQr"
            defaultChecked={canUseQrOrdering ? (product?.availableForQr ?? false) : false}
            disabled={!canUseQrOrdering}
            className="rounded border-gray-300"
          />
          QR Order
          {!canUseQrOrdering && (
            <span className="text-xs text-amber-700">(ล็อกตามแพ็กเกจ)</span>
          )}
        </label>
        {product && (
          <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={product.isActive}
              className="rounded border-gray-300"
            />
            เปิดใช้งาน
          </label>
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 py-1.5 text-sm font-medium text-white bg-gray-900 rounded hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? "กำลังบันทึก..." : "บันทึก"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
        >
          ยกเลิก
        </button>
      </div>
    </form>
  );
}

// ─── Variants sub-section ─────────────────────────────────────────

function VariantTemplatesPanel({
  variantTemplates,
  canManageCatalog,
}: {
  variantTemplates: VariantTemplate[];
  canManageCatalog: boolean;
}) {
  const [addState, addAction, addPending] = useActionState(createVariantTemplateAction, {
    error: null,
  });
  const [variantTemplateMessage, setVariantTemplateMessage] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  async function handleDeleteVariantTemplate(template: VariantTemplate) {
    setVariantTemplateMessage(null);
    setDeletingTemplateId(template.id);
    const result = await deleteVariantTemplateAction(template.id);
    setDeletingTemplateId(null);
    if (result.error) {
      setVariantTemplateMessage(result.error);
      return;
    }
    setVariantTemplateMessage(`ลบตัวเลือก ${template.name} แล้ว`);
  }

  return (
    <section className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">คลังตัวเลือกสินค้า</h3>
          <p className="text-xs text-slate-500">
            เพิ่มตัวเลือกกลางก่อน แล้วเลือกใช้ในแต่ละเมนู ลดการพิมพ์ซ้ำเมื่อมีหลายสินค้า
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
          {variantTemplates.length} variants
        </span>
      </div>

      {variantTemplates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {variantTemplates.map((template) => (
            <div
              key={template.id}
              className="flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700"
            >
              <span className="font-semibold">{template.name}</span>
              <span className="text-slate-500">{priceDeltaStr(template.priceAdjustment)}</span>
              {canManageCatalog && (
                <button
                  type="button"
                  onClick={() => { void handleDeleteVariantTemplate(template); }}
                  disabled={deletingTemplateId === template.id}
                  className="text-red-500 hover:text-red-700"
                  aria-label={`ลบตัวเลือก ${template.name}`}
                >
                  {deletingTemplateId === template.id ? "..." : "ลบ"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManageCatalog ? (
        <form action={addAction} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
          <input
            name="variantName"
            placeholder="ชื่อตัวเลือกกลาง เช่น S, M, L, เย็น, ร้อน"
            className="min-h-10 rounded-md border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <input
            name="priceAdjustment"
            type="number"
            defaultValue={0}
            step="1"
            className="min-h-10 rounded-md border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            placeholder="+ราคา"
          />
          <button
            type="submit"
            disabled={addPending}
            className="min-h-10 rounded-md bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            เพิ่มตัวเลือก
          </button>
          <div className="sm:col-span-3">
            <ErrorBanner message={addState.error} />
          </div>
        </form>
      ) : (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          ต้องมีสิทธิ์ catalog.manage เพื่อจัดการคลังตัวเลือก
        </p>
      )}
      {variantTemplateMessage && (
        <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600" aria-live="polite">
          {variantTemplateMessage}
        </p>
      )}
    </section>
  );
}

function ModifierGroupTemplateCard({
  template,
  canManageCatalog,
}: {
  template: ModifierGroupTemplate;
  canManageCatalog: boolean;
}) {
  const [addOptionState, addOptionAction, addOptionPending] = useActionState(
    async (prev: { error: string | null; message?: string | null }, fd: FormData) =>
      addModifierOptionTemplateAction(template.id, prev, fd),
    { error: null, message: null },
  );
  const [optionMessage, setOptionMessage] = useState<string | null>(null);
  const [optionError, setOptionError] = useState<string | null>(null);
  const [deletingOptionId, setDeletingOptionId] = useState<string | null>(null);

  async function handleDeleteOption(option: ModifierGroupTemplate["options"][number]) {
    setOptionMessage(null);
    setOptionError(null);
    setDeletingOptionId(option.id);
    const result = await deleteModifierOptionTemplateAction(option.id);
    setDeletingOptionId(null);
    if (result.error) {
      setOptionError(result.error);
      return;
    }
    setOptionMessage(`ลบตัวเลือก ${option.name} แล้ว`);
  }

  return (
    <article className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-sm font-bold text-slate-900">{template.name}</h4>
          <p className="text-xs text-slate-500">
            {template.selectionType === "single" ? "เลือกได้อันเดียว" : "เลือกได้หลายอัน"}
            {template.isRequired ? " · บังคับเลือก" : ""}
          </p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">
          {template.options.length} ตัวเลือก
        </span>
      </div>

      {template.options.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {template.options.map((option) => (
            <span
              key={option.id}
              className="inline-flex min-h-9 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-xs text-slate-700"
            >
              <span className="font-semibold">{option.name}</span>
              <span className="text-slate-500">{priceDeltaStr(option.priceAdjustment)}</span>
              {canManageCatalog && (
                <button
                  type="button"
                  onClick={() => { void handleDeleteOption(option); }}
                  disabled={deletingOptionId === option.id}
                  className="font-semibold text-red-500 hover:text-red-700 disabled:opacity-50"
                  aria-label={`ลบตัวเลือก ${option.name}`}
                >
                  {deletingOptionId === option.id ? "..." : "ลบ"}
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
          ยังไม่มีตัวเลือกในกลุ่มนี้
        </p>
      )}

      {canManageCatalog && (
        <form action={addOptionAction} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_auto]">
          <input
            name="optionName"
            placeholder="เช่น 0%, 25%, ธรรมดา, พิเศษ"
            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <input
            name="priceAdjustment"
            type="number"
            defaultValue={0}
            step="1"
            placeholder="+ราคา"
            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <button
            type="submit"
            disabled={addOptionPending}
            className="min-h-10 rounded-md bg-slate-700 px-4 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
          >
            เพิ่ม
          </button>
          <div className="space-y-2 sm:col-span-3">
            <ErrorBanner message={addOptionState.error || optionError} />
            <NoticeBanner message={optionMessage || addOptionState.message} />
          </div>
        </form>
      )}
    </article>
  );
}

function ModifierGroupTemplatesPanel({
  modifierGroupTemplates,
  canManageCatalog,
}: {
  modifierGroupTemplates: ModifierGroupTemplate[];
  canManageCatalog: boolean;
}) {
  const [addState, addAction, addPending] = useActionState(createModifierGroupTemplateAction, {
    error: null,
    message: null,
  });
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  async function handleDeleteGroupTemplate(template: ModifierGroupTemplate) {
    setTemplateMessage(null);
    setTemplateError(null);
    setDeletingTemplateId(template.id);
    const result = await deleteModifierGroupTemplateAction(template.id);
    setDeletingTemplateId(null);
    if (result.error) {
      setTemplateError(result.error);
      return;
    }
    setTemplateMessage(`ลบกลุ่มตัวเลือก ${template.name} แล้ว`);
  }

  return (
    <section className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-900">คลังกลุ่มตัวเลือก</h3>
          <p className="text-xs text-slate-500">
            สร้างกลุ่มก่อน เช่น ระดับความหวาน หรือ ขนาด แล้วเพิ่มตัวเลือกไว้ข้างในเพื่อเลือกใช้ในเมนู
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
          {modifierGroupTemplates.length} groups
        </span>
      </div>

      {modifierGroupTemplates.length > 0 ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {modifierGroupTemplates.map((template) => (
            <div key={template.id} className="space-y-2">
              <ModifierGroupTemplateCard
                template={template}
                canManageCatalog={canManageCatalog}
              />
              {canManageCatalog && (
                <button
                  type="button"
                  onClick={() => { void handleDeleteGroupTemplate(template); }}
                  disabled={deletingTemplateId === template.id}
                  className="min-h-10 rounded-md border border-red-200 px-3 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {deletingTemplateId === template.id ? "กำลังลบ..." : `ลบกลุ่ม ${template.name}`}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
          ยังไม่มีกลุ่มตัวเลือกกลาง
        </p>
      )}

      {canManageCatalog ? (
        <form action={addAction} className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
            <input
              name="groupName"
              placeholder="ชื่อกลุ่ม เช่น ระดับความหวาน, ขนาด"
              className="min-h-10 rounded-md border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
            <select
              name="selectionType"
              defaultValue="single"
              className="min-h-10 rounded-md border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
            >
              <option value="single">อันเดียว</option>
              <option value="multiple">หลายอัน</option>
            </select>
            <button
              type="submit"
              disabled={addPending}
              className="min-h-10 rounded-md bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              เพิ่มกลุ่ม
            </button>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" name="isRequired" className="rounded border-slate-300" />
            บังคับเลือกกลุ่มนี้เมื่อสั่งสินค้า
          </label>
          <ErrorBanner message={addState.error || templateError} />
          <NoticeBanner message={templateMessage || addState.message} />
        </form>
      ) : (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          ต้องมีสิทธิ์ catalog.manage เพื่อจัดการคลังกลุ่มตัวเลือก
        </p>
      )}
    </section>
  );
}

function VariantsSection({
  product,
  variantTemplates,
}: {
  product: Product;
  variantTemplates: VariantTemplate[];
}) {
  const [applyState, applyAction, applyPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      return applyVariantTemplateAction(product.id, prev, fd);
    },
    { error: null },
  );
  const [, startDelete] = useTransition();

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">ตัวเลือก (Variants)</p>
      {product.variants.length > 0 && (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded">
          {product.variants.map((v) => (
            <div key={v.id} className="flex items-center justify-between px-2.5 py-1.5">
              <span className="text-sm text-gray-800">{v.name}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{priceDeltaStr(v.priceAdjustment)}</span>
                <button
                  type="button"
                  onClick={() => startDelete(() => { deleteVariantAction(v.id); })}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  ลบ
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <form action={applyAction} className="flex gap-1.5">
        <select
          name="variantTemplateId"
          defaultValue=""
          disabled={variantTemplates.length === 0 || applyPending}
          className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:bg-gray-50"
        >
          <option value="">เลือกจากคลังตัวเลือก</option>
          {variantTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({priceDeltaStr(template.priceAdjustment)})
            </option>
          ))}
        </select>
        <input
          name="variantName"
          placeholder="ชื่อตัวเลือก (เช่น S, L)"
          className="hidden"
        />
        <input
          name="priceAdjustment"
          type="number"
          defaultValue={0}
          step="1"
          className="hidden"
          placeholder="±ราคา"
        />
        <button
          type="submit"
          disabled={applyPending || variantTemplates.length === 0}
          className="px-2 py-1 text-sm text-white bg-gray-700 rounded hover:bg-gray-900 disabled:opacity-50"
        >
          +
        </button>
      </form>
      {variantTemplates.length === 0 && (
        <p className="text-xs text-gray-500">เพิ่มตัวเลือกจากคลังด้านนอกก่อน แล้วค่อยเลือกใช้ในเมนูนี้</p>
      )}
      <ErrorBanner message={applyState.error} />
    </div>
  );
}

// ─── Modifier groups sub-section ──────────────────────────────────

function ModifierGroupSection({ group }: { group: ModifierGroup }) {
  const [addOptState, addOptAction, addOptPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) =>
      addModifierOptionAction(group.id, prev, fd),
    { error: null },
  );
  const [, startDelete] = useTransition();

  return (
    <div className="border border-gray-200 rounded p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700">
          {group.name}
          <span className="ml-1 text-gray-400 font-normal">
            ({group.selectionType === "single" ? "เลือกอันเดียว" : "หลายอัน"}
            {group.isRequired ? ", บังคับ" : ""})
          </span>
        </span>
        <button
          type="button"
          onClick={() => startDelete(() => { deleteModifierGroupAction(group.id); })}
          className="text-xs text-red-500 hover:text-red-700"
        >
          ลบกลุ่ม
        </button>
      </div>
      {group.options.map((opt) => (
        <div key={opt.id} className="flex items-center justify-between pl-2">
          <span className="text-xs text-gray-700">{opt.name}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{priceDeltaStr(opt.priceAdjustment)}</span>
            <button
              type="button"
              onClick={() => startDelete(() => { deleteModifierOptionAction(opt.id); })}
              className="text-xs text-red-400 hover:text-red-600"
            >
              ลบ
            </button>
          </div>
        </div>
      ))}
      <form action={addOptAction} className="flex gap-1.5 pt-0.5">
        <input
          name="optionName"
          placeholder="ชื่อตัวเลือก"
          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <input
          name="priceAdjustment"
          type="number"
          defaultValue={0}
          step="1"
          className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <button
          type="submit"
          disabled={addOptPending}
          className="px-2 py-1 text-xs text-white bg-gray-600 rounded hover:bg-gray-800 disabled:opacity-50"
        >
          +
        </button>
      </form>
      <ErrorBanner message={addOptState.error} />
    </div>
  );
}

function ModifierGroupsSection({
  product,
  modifierGroupTemplates,
}: {
  product: Product;
  modifierGroupTemplates: ModifierGroupTemplate[];
}) {
  const [selection, setSelection] = useState<{ productId: string; ids: string[] }>({
    productId: product.id,
    ids: [],
  });
  const selectedTemplateIds = selection.productId === product.id ? selection.ids : [];
  const [applyState, applyAction, applyPending] = useActionState(
    async (prev: { error: string | null; message?: string | null }, fd: FormData) => {
      const result = await applyModifierGroupTemplateAction(product.id, prev, fd);
      if (!result.error) setSelection({ productId: product.id, ids: [] });
      return result;
    },
    { error: null, message: null },
  );
  const existingGroupNames = new Set(
    product.modifierGroups.map((group) => group.name.trim().toLowerCase()),
  );
  const selectableTemplateIds = modifierGroupTemplates
    .filter((template) => template.options.length > 0)
    .filter((template) => !existingGroupNames.has(template.name.trim().toLowerCase()))
    .map((template) => template.id);
  const selectedCount = selectedTemplateIds.filter((id) => selectableTemplateIds.includes(id)).length;

  function toggleTemplateSelection(templateId: string) {
    setSelection((current) => {
      const currentIds = current.productId === product.id ? current.ids : [];
      return {
        productId: product.id,
        ids: currentIds.includes(templateId)
          ? currentIds.filter((id) => id !== templateId)
          : [...currentIds, templateId],
      };
    });
  }

  function clearTemplateSelection() {
    setSelection({ productId: product.id, ids: [] });
  }

  function selectAllTemplateOptions() {
    setSelection({ productId: product.id, ids: selectableTemplateIds });
  }

  function toggleAllTemplateOptions() {
    if (selectedCount === selectableTemplateIds.length) {
      clearTemplateSelection();
    } else {
      selectAllTemplateOptions();
    }
  }

  function handleTemplateSubmit() {
    if (selectedCount === 0) return;
    setSelection((current) =>
      current.productId === product.id
        ? current
        : { productId: product.id, ids: [] },
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">กลุ่มตัวเลือก</p>
      {product.modifierGroups.length > 0 ? (
        product.modifierGroups.map((g) => (
          <ModifierGroupSection key={g.id} group={g} />
        ))
      ) : (
        <p className="rounded border border-dashed border-gray-200 px-2.5 py-2 text-xs text-gray-500">
          ยังไม่มีกลุ่มตัวเลือกในเมนูนี้
        </p>
      )}
      <form action={applyAction} onSubmit={handleTemplateSubmit} className="space-y-2">
        <div className="rounded border border-gray-200 bg-white p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-600">เลือกกลุ่มตัวเลือกจากคลังได้หลายกลุ่ม</p>
            {selectableTemplateIds.length > 1 && (
              <button
                type="button"
                onClick={toggleAllTemplateOptions}
                disabled={applyPending}
                className="rounded border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {selectedCount === selectableTemplateIds.length ? "ล้าง" : "เลือกทั้งหมด"}
              </button>
            )}
          </div>
          {modifierGroupTemplates.length > 0 ? (
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
              {modifierGroupTemplates.map((template) => {
                const isAlreadyAdded = existingGroupNames.has(template.name.trim().toLowerCase());
                const isEmpty = template.options.length === 0;
                const isDisabled = applyPending || isAlreadyAdded || isEmpty;
                const checked = !isDisabled && selectedTemplateIds.includes(template.id);
                return (
                  <label
                    key={template.id}
                    className={`flex min-h-10 items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                      isDisabled
                        ? "border-gray-100 bg-gray-50 text-gray-400"
                        : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="modifierGroupTemplateId"
                      value={template.id}
                      checked={checked}
                      disabled={isDisabled}
                      onChange={() => toggleTemplateSelection(template.id)}
                      className="h-4 w-4 rounded border-gray-300 text-gray-800 focus:ring-gray-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-gray-800">{template.name}</span>
                      <span className="text-gray-500">
                        {template.options.length} ตัวเลือก
                        {isAlreadyAdded ? " · อยู่ในเมนูแล้ว" : ""}
                        {isEmpty ? " · เพิ่มตัวเลือกก่อน" : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-500">เพิ่มกลุ่มตัวเลือกจากคลังด้านนอกก่อน แล้วค่อยเลือกใช้ในเมนูนี้</p>
          )}
        </div>
        <button
          type="submit"
          disabled={applyPending || selectedCount === 0}
          title="เพิ่มกลุ่มที่เลือก"
          className="min-h-10 w-full rounded bg-gray-700 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-900 disabled:opacity-50"
        >
          {applyPending ? "กำลังเพิ่ม..." : `+ เพิ่มที่เลือก${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
        </button>
      </form>
      <ErrorBanner message={applyState.error} />
      <NoticeBanner message={applyState.message} />
    </div>
  );
}

// ─── Catalog dialog ────────────────────────────────────────────────

function CatalogDialog({
  mode,
  selectedCategory,
  selectedProduct,
  categories,
  variantTemplates,
  modifierGroupTemplates,
  canUseQrOrdering,
  storeId,
  organizationId,
  onClose,
}: {
  mode: PanelMode;
  selectedCategory: Category | null;
  selectedProduct: Product | null;
  categories: Category[];
  variantTemplates: VariantTemplate[];
  modifierGroupTemplates: ModifierGroupTemplate[];
  canUseQrOrdering: boolean;
  storeId: string;
  organizationId: string;
  onClose: () => void;
}) {
  const [addProductState, addProductAction, addProductPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const res = await createProductAction(prev, fd);
      if (!res.error) onClose();
      return res;
    },
    { error: null },
  );

  const [editProductState, editProductAction, editProductPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      if (!selectedProduct) return prev;
      const res = await updateProductAction(selectedProduct.id, prev, fd);
      if (!res.error) onClose();
      return res;
    },
    { error: null },
  );

  const titles: Record<PanelMode, string> = {
    closed: "",
    "add-category": "เพิ่มหมวดหมู่",
    "edit-category": "แก้ไขหมวดหมู่",
    "add-product": "เพิ่มสินค้า",
    "edit-product": "แก้ไขสินค้า",
  };

  const isProductDialog = mode === "add-product" || mode === "edit-product";

  return (
    <ModalDialog
      open={mode !== "closed"}
      title={titles[mode]}
      onClose={onClose}
      size={isProductDialog ? "lg" : "sm"}
    >
      {mode === "add-category" && (
        <AddCategoryForm onDone={onClose} onCancel={onClose} />
      )}
      {mode === "edit-category" && selectedCategory && (
        <EditCategoryForm category={selectedCategory} onDone={onClose} onCancel={onClose} />
      )}
      {mode === "add-product" && (
        <ProductForm
          categories={categories}
          defaultCategoryId={selectedCategory?.id}
          canUseQrOrdering={canUseQrOrdering}
          storeId={storeId}
          organizationId={organizationId}
          onSubmit={addProductAction}
          onCancel={onClose}
          isPending={addProductPending}
          error={addProductState.error}
        />
      )}
      {mode === "edit-product" && selectedProduct && (
        <>
          <ProductForm
            product={selectedProduct}
            categories={categories}
            canUseQrOrdering={canUseQrOrdering}
            storeId={storeId}
            organizationId={organizationId}
            onSubmit={editProductAction}
            onCancel={onClose}
            isPending={editProductPending}
            error={editProductState.error}
          />
          <hr className="border-gray-100" />
          <VariantsSection product={selectedProduct} variantTemplates={variantTemplates} />
          <hr className="border-gray-100" />
          <ModifierGroupsSection
            product={selectedProduct}
            modifierGroupTemplates={modifierGroupTemplates}
          />
        </>
      )}
    </ModalDialog>
  );
}

// ─── Main component ───────────────────────────────────────────────

export function CatalogManager({
  categories,
  products,
  variantTemplates,
  modifierGroupTemplates,
  role,
  storeName,
  storeId,
  organizationId,
  planName,
  canManageCatalog,
  canUseQrOrdering,
  canUseStock,
}: Props) {
  const [panelMode, setPanelMode] = useState<PanelMode>("closed");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    categories[0]?.id ?? null,
  );
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedCategoryForPanel, setSelectedCategoryForPanel] = useState<Category | null>(null);
  const [, startDelete] = useTransition();

  const filteredProducts = selectedCategoryId
    ? products.filter((p) => p.categoryId === selectedCategoryId)
    : products;

  const currentCategory = categories.find((c) => c.id === selectedCategoryId) ?? null;
  // Derive from latest props so edit panel reflects server-rendered data after mutations
  const selectedProduct = selectedProductId ? (products.find((p) => p.id === selectedProductId) ?? null) : null;
  const activeProducts = products.filter((p) => p.isActive).length;
  const qrProducts = products.filter((p) => p.availableForQr).length;
  const posProducts = products.filter((p) => p.availableForPos).length;

  function categoryCount(categoryId: string) {
    return products.filter((p) => p.categoryId === categoryId).length;
  }

  function openAddCategory() {
    if (!canManageCatalog) return;
    setSelectedCategoryForPanel(null);
    setSelectedProductId(null);
    setPanelMode("add-category");
  }

  function openEditCategory(cat: Category) {
    if (!canManageCatalog) return;
    setSelectedCategoryForPanel(cat);
    setSelectedProductId(null);
    setPanelMode("edit-category");
  }

  function openAddProduct() {
    if (!canManageCatalog) return;
    setSelectedCategoryForPanel(currentCategory);
    setSelectedProductId(null);
    setPanelMode("add-product");
  }

  function openEditProduct(p: Product) {
    if (!canManageCatalog) return;
    setSelectedCategoryForPanel(null);
    setSelectedProductId(p.id);
    setPanelMode("edit-product");
  }

  function closePanel() {
    setPanelMode("closed");
    setSelectedProductId(null);
    setSelectedCategoryForPanel(null);
  }

  function handleDeleteCategory(id: string) {
    if (!canManageCatalog) return;
    if (!confirm("ลบหมวดหมู่นี้? สินค้าในหมวดจะต้องย้ายหมวดก่อน")) return;
    startDelete(() => { deleteCategoryAction(id); });
  }

  function handleDeleteProduct(id: string) {
    if (!canManageCatalog) return;
    if (!confirm("ลบสินค้านี้?")) return;
    startDelete(() => { deleteProductAction(id); });
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Catalog Workbench</p>
            <h1 className="mt-1 text-xl font-bold text-slate-950">เมนูสินค้า</h1>
            <p className="mt-1 text-sm text-slate-500">
              {storeName} · {categories.length} หมวดหมู่ · {products.length} สินค้า
            </p>
          </div>
          <RoleCapabilityBar
            role={role}
            planName={planName}
            canManageCatalog={canManageCatalog}
            canUseQrOrdering={canUseQrOrdering}
            canUseStock={canUseStock}
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            ["สินค้าใช้งาน", activeProducts],
            ["เปิดขาย POS", posProducts],
            ["เปิด QR", qrProducts],
            ["หมวดที่เลือก", filteredProducts.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid flex-1 gap-0 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-white lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">หมวดหมู่</span>
            <button
              onClick={openAddCategory}
              disabled={!canManageCatalog}
              title={canManageCatalog ? "เพิ่มหมวดหมู่" : "ต้องมีสิทธิ์แก้เมนู"}
              className="min-h-9 rounded-md border border-slate-200 px-3 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              เพิ่ม
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto px-3 pb-3 lg:block lg:space-y-1 lg:overflow-visible">
            <button
              type="button"
              onClick={() => setSelectedCategoryId(null)}
              className={`min-h-11 shrink-0 rounded-md px-3 text-left text-sm lg:w-full ${
                selectedCategoryId === null
                  ? "bg-teal-50 font-bold text-teal-800"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              ทั้งหมด <span className="text-xs text-slate-400">({products.length})</span>
            </button>
            {categories.map((cat) => (
              <div
                key={cat.id}
                className={`group flex min-h-11 shrink-0 items-center justify-between gap-3 rounded-md px-3 lg:w-full ${
                  cat.id === selectedCategoryId ? "bg-teal-50" : "hover:bg-slate-50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-slate-800">{cat.name}</span>
                  <span className="text-xs text-slate-400">{categoryCount(cat.id)} สินค้า</span>
                </button>
                {canManageCatalog && (
                  <div className="flex gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => openEditCategory(cat)}
                      className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-white hover:text-slate-900"
                    >
                      แก้
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteCategory(cat.id)}
                      className="rounded px-1.5 py-1 text-xs text-red-500 hover:bg-red-50"
                    >
                      ลบ
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 bg-slate-50 p-4">
          <VariantTemplatesPanel
            variantTemplates={variantTemplates}
            canManageCatalog={canManageCatalog}
          />
          <ModifierGroupTemplatesPanel
            modifierGroupTemplates={modifierGroupTemplates}
            canManageCatalog={canManageCatalog}
          />
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-950">
                {currentCategory?.name ?? "สินค้าทั้งหมด"}
              </h2>
              <p className="text-xs text-slate-500">
                รูปสินค้าในหน้านี้จะถูกใช้ต่อใน POS และ QR ordering
              </p>
            </div>
            <button
              onClick={openAddProduct}
              disabled={!canManageCatalog}
              title={canManageCatalog ? "เพิ่มสินค้า" : "ต้องมีสิทธิ์ catalog.manage"}
              className="min-h-11 rounded-md bg-slate-950 px-4 text-sm font-bold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              เพิ่มสินค้า
            </button>
          </div>

          {filteredProducts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              ยังไม่มีสินค้าในหมวดนี้
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filteredProducts.map((p) => (
                <article key={p.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <div className="aspect-[4/3] overflow-hidden border-b border-slate-100">
                    <ProductImage product={p} />
                  </div>
                  <div className="space-y-3 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="line-clamp-2 text-sm font-bold text-slate-950">{p.name}</h3>
                        <p className="mt-1 text-sm font-bold tabular-nums text-slate-800">
                          {priceStr(p.basePrice)}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold ${
                        p.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                      }`}>
                        {p.isActive ? "เปิด" : "ปิด"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <span className={`rounded border px-2 py-1 ${
                        p.availableForPos ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-400"
                      }`}>
                        POS {p.availableForPos ? "เปิด" : "ปิด"}
                      </span>
                      <span
                        title={canUseQrOrdering ? undefined : "QR Ordering ถูกล็อกตามแพ็กเกจ"}
                        className={`rounded border px-2 py-1 ${
                          p.availableForQr && canUseQrOrdering
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 text-slate-400"
                        }`}
                      >
                        QR {p.availableForQr && canUseQrOrdering ? "เปิด" : "ปิด/ล็อก"}
                      </span>
                      <span className="rounded border border-slate-200 px-2 py-1 text-slate-500">
                        {p.variants.length} size
                      </span>
                      <span className="rounded border border-slate-200 px-2 py-1 text-slate-500">
                        {p.modifierGroups.length} opt
                      </span>
                    </div>
                    {canManageCatalog ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => openEditProduct(p)}
                          className="min-h-10 flex-1 rounded-md border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50"
                        >
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteProduct(p.id)}
                          className="min-h-10 rounded-md border border-red-200 px-3 text-sm font-bold text-red-600 hover:bg-red-50"
                        >
                          ลบ
                        </button>
                      </div>
                    ) : (
                      <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        โหมดอ่านอย่างเดียวสำหรับ role นี้
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <CatalogDialog
        mode={panelMode}
        selectedCategory={selectedCategoryForPanel}
        selectedProduct={selectedProduct}
        categories={categories}
        variantTemplates={variantTemplates}
        modifierGroupTemplates={modifierGroupTemplates}
        canUseQrOrdering={canUseQrOrdering}
        storeId={storeId}
        organizationId={organizationId}
        onClose={closePanel}
      />
    </div>
  );
}
