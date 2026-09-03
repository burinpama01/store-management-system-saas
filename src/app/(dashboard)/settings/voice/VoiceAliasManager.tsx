"use client";

// U16 — จัดการคำเรียกด้วยเสียงของร้าน (owner-authored เท่านั้น)
// ทุกแถวแสดง "ใครสร้าง/เมื่อไร/สถานะ" เพื่อให้ตรวจย้อนหลังได้ และปิดใช้งานแทนการลบ

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { VoiceAlias } from "@/modules/voice-pos/alias-repository";
import type { VoiceAliasSuggestion } from "@/modules/voice-pos/alias-suggest";
import { createVoiceAliasAction, saveProductAliasesAction, setVoiceAliasActiveAction } from "./actions";
import { Button } from "@/shared/components/ui";

interface Props {
  readonly aliases: readonly VoiceAlias[];
  /** คำเรียกเมนูที่ระบบวิเคราะห์จากชื่อเมนูให้ (ยังไม่บันทึกจนกว่าผู้ใช้จะติ๊ก) */
  readonly suggestions: readonly VoiceAliasSuggestion[];
  readonly productNameById: Readonly<Record<string, string>>;
  readonly voiceEnabled: boolean;
  readonly loadError?: string | null;
  readonly memberEmails: Readonly<Record<string, string>>;
}

export function VoiceAliasManager({
  aliases,
  suggestions,
  productNameById,
  voiceEnabled,
  loadError,
  memberEmails,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(loadError ?? null);
  // ค่าเริ่มต้น: ติ๊กไว้ให้หมด (ผู้ใช้แค่เอาที่ไม่เอาออก) — ลดขั้นตอนตามที่หน้าร้านขอ
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const suggestionKey = (item: VoiceAliasSuggestion) => `${item.productId}|${item.aliasText}`;
  const isPicked = (item: VoiceAliasSuggestion) => picked[suggestionKey(item)] ?? true;
  const pickedCount = useMemo(
    () => suggestions.filter((item) => picked[`${item.productId}|${item.aliasText}`] ?? true).length,
    [suggestions, picked],
  );

  const productAliases = aliases.filter((alias) => alias.intentType === "product");
  const navigateAliases = aliases.filter((alias) => alias.intentType === "navigate");

  function onSaveSuggestions() {
    const selected = suggestions
      .filter((item) => isPicked(item))
      .map((item) => ({ aliasText: item.aliasText, productId: item.productId }));
    startTransition(async () => {
      const result = await saveProductAliasesAction(selected);
      setMessage(result.error ?? `บันทึกคำเรียกเมนูแล้ว ${result.saved} คำ`);
      if (!result.error) router.refresh();
    });
  }

  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createVoiceAliasAction({ error: null, success: null }, formData);
      setMessage(result.error ?? result.success);
      if (!result.error) router.refresh();
    });
  }

  function onToggle(alias: VoiceAlias) {
    startTransition(async () => {
      const result = await setVoiceAliasActiveAction(alias.id, !alias.isActive);
      setMessage(result.error ?? (alias.isActive ? "ปิดใช้งานคำเรียกแล้ว" : "เปิดใช้งานคำเรียกแล้ว"));
      if (!result.error) router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <section className="panel p-4">
        <h2 className="text-base font-bold text-[var(--color-text-primary)]">สั่งงานด้วยเสียง</h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {voiceEnabled
            ? "ร้านนี้เปิดใช้งานปุ่มสั่งงานด้วยเสียงใน POS รวมแล้ว"
            : "ร้านนี้ยังไม่เปิดใช้งานสั่งงานด้วยเสียง — ปุ่มไมค์จะไม่แสดงในหน้า POS"}
        </p>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">ความเป็นส่วนตัวที่ระบบรับประกัน</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px]">
            <li>ไม่มีการบันทึกเสียง คำพูด หรือข้อความที่ถอดได้ ลงฐานข้อมูลหรือ log</li>
            <li>ระบบเก็บได้เฉพาะ ชนิดคำสั่ง ผลลัพธ์ ภาษา ระดับความมั่นใจ และเวลา (เก็บไม่เกิน 30 วัน)</li>
            <li>คำเรียกด้านล่างมาจากที่ร้านพิมพ์เองเท่านั้น ระบบไม่เรียนรู้คำจากเสียงที่ได้ยิน</li>
            <li>เบราว์เซอร์อาจส่งเสียงไปประมวลผลบนบริการของผู้ผลิตเบราว์เซอร์ — แจ้งพนักงานก่อนใช้งาน</li>
          </ul>
        </div>
      </section>

      <section className="panel p-4">
        <h3 className="text-sm font-bold text-[var(--color-text-primary)]">เพิ่มคำเรียกใหม่</h3>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          ใช้เปิดหน้าในระบบเท่านั้น (ยังไม่รองรับผูกกับคำสั่งเงินหรือตะกร้า)
        </p>
        <form action={onSubmit} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm">
            <span className="block font-semibold">คำที่พนักงานพูด</span>
            <input
              name="aliasText"
              required
              maxLength={60}
              placeholder="เช่น ยอดวันนี้"
              className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="block font-semibold">ให้เปิดหน้า</span>
            <input
              name="targetQuery"
              required
              maxLength={60}
              placeholder="เช่น รายงาน"
              className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <input type="hidden" name="intentType" value="navigate" />
          <div className="flex items-end">
            <Button type="submit" disabled={isPending}>
              เพิ่มคำเรียก
            </Button>
          </div>
        </form>
      </section>

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-secondary)]">
          {message}
        </p>
      ) : null}

      <section className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-[var(--color-text-primary)]">คำเรียกเมนู (วิเคราะห์อัตโนมัติ)</h3>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              ระบบอ่านชื่อเมนูของร้านแล้วเสนอคำที่พนักงานน่าจะพูด — ตรวจแล้วติ๊กบันทึกได้เลย
              (เมนูที่เพิ่มใหม่หรือมาจาก AI สแกน จะขึ้นที่นี่เองในครั้งถัดไป)
            </p>
          </div>
          {suggestions.length > 0 ? (
            <Button type="button" onClick={onSaveSuggestions} disabled={isPending || pickedCount === 0}>
              บันทึกที่เลือก ({pickedCount})
            </Button>
          ) : null}
        </div>

        {suggestions.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
            ไม่มีคำเรียกใหม่ให้เสนอ — เมนูทั้งหมดพูดชื่อตรง ๆ ได้อยู่แล้ว หรือบันทึกคำเรียกไว้ครบแล้ว
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-125 text-left text-sm">
              <thead>
                <tr className="text-xs text-[var(--color-text-secondary)]">
                  <th className="py-2">บันทึก</th>
                  <th className="py-2">พนักงานพูดว่า</th>
                  <th className="py-2">หมายถึงเมนู</th>
                  <th className="py-2">ที่มา</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((item) => (
                  <tr key={suggestionKey(item)} className="border-t border-gray-100">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`บันทึกคำเรียก ${item.aliasText}`}
                        checked={isPicked(item)}
                        onChange={(event) =>
                          setPicked((current) => ({ ...current, [suggestionKey(item)]: event.target.checked }))
                        }
                        className="size-5"
                      />
                    </td>
                    <td className="py-2 font-semibold">{item.aliasText}</td>
                    <td className="py-2">{item.productName}</td>
                    <td className="py-2 text-xs text-[var(--color-text-secondary)]">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {productAliases.length > 0 ? (
          <div className="mt-5">
            <h4 className="text-xs font-bold text-[var(--color-text-secondary)]">
              คำเรียกเมนูที่บันทึกไว้แล้ว ({productAliases.length})
            </h4>
            <ul className="mt-2 flex flex-wrap gap-2">
              {productAliases.map((alias) => (
                <li
                  key={alias.id}
                  className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs"
                >
                  <span className={alias.isActive ? "font-semibold" : "font-semibold text-gray-400 line-through"}>
                    {alias.aliasText}
                  </span>
                  <span className="text-[var(--color-text-secondary)]">
                    → {productNameById[alias.slots.product_id ?? ""] ?? "เมนูที่ถูกลบไปแล้ว"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggle(alias)}
                    disabled={isPending}
                    className="rounded-md border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {alias.isActive ? "ปิด" : "เปิด"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="panel p-4">
        <h3 className="text-sm font-bold text-[var(--color-text-primary)]">คำเรียกของร้าน</h3>
        {navigateAliases.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">ยังไม่มีคำเรียกที่ร้านสร้างไว้</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-125 text-left text-sm">
              <thead>
                <tr className="text-xs text-[var(--color-text-secondary)]">
                  <th className="py-2">คำที่พูด</th>
                  <th className="py-2">เปิดหน้า</th>
                  <th className="py-2">สถานะ</th>
                  <th className="py-2">สร้างโดย</th>
                  <th className="py-2">เมื่อ</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {navigateAliases.map((alias) => (
                  <tr key={alias.id} className="border-t border-gray-100">
                    <td className="py-2 font-semibold">{alias.aliasText}</td>
                    <td className="py-2">{alias.slots.query ?? "-"}</td>
                    <td className="py-2">
                      <span
                        className={
                          alias.isActive
                            ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800"
                            : "rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600"
                        }
                      >
                        {alias.isActive ? "ใช้งาน" : "ปิดอยู่"}
                      </span>
                    </td>
                    <td className="py-2 text-xs text-[var(--color-text-secondary)]">
                      {memberEmails[alias.createdBy] ?? alias.createdBy}
                    </td>
                    <td className="py-2 text-xs text-[var(--color-text-secondary)]">
                      {new Date(alias.createdAt).toLocaleString("th-TH")}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onToggle(alias)}
                        disabled={isPending}
                        className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {alias.isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
