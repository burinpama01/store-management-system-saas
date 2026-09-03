"use client";

// U14/U15 — Voice Tier A + B (R2) · ตัวเชื่อมเดียวระหว่างปุ่มเสียงกับ shell
// หน้าที่: รับผล parse → ถามตัวตัดสิน pure (navigation.ts / cart.ts) → ลงมือทำเฉพาะที่อนุญาต
// ห้ามมี logic ตัดสินใจอยู่ในไฟล์นี้ และห้ามแตะ server action/DB โดยตรง
//
// หมายเหตุ: component นี้ mount เฉพาะเมื่อ stores.voice_command_enabled = true เท่านั้น
// (useRouter จึงไม่ถูกเรียกในเส้นทาง legacy/flag ปิด)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { VoiceCommandButton } from "@/shared/components/VoiceCommandButton";
import { DASHBOARD_COMMANDS, type CommandItem } from "@/modules/assistant/command-index";
import {
  resolveVoiceNavigation,
  type VoiceNavigationAlias,
  type VoicePosFocusAction,
  type VoicePosTabId,
} from "@/modules/voice-pos/navigation";
import { applyVoiceCartIntent, isVoiceCartIntent, type VoiceProductAlias } from "@/modules/voice-pos/cart";
import {
  consumeVoiceUndoToken,
  createVoiceUndoToken,
  isVoiceUndoTokenValid,
  VOICE_UNDO_WINDOW_MS,
  type VoiceUndoToken,
} from "@/modules/voice-pos/undo";
import { createInMemoryVoiceTelemetrySink } from "@/modules/voice-pos/telemetry";
import type { VoiceSpeechAdapter } from "@/modules/voice-pos/speech-adapter";
import type { VoiceParseResult } from "@/modules/voice-pos/types";
import { useVoiceCartApi } from "./voice-cart-bridge";

const FOCUS_UNAVAILABLE: Record<VoicePosFocusAction, string> = {
  search: "หน้านี้ยังไม่มีช่องค้นหา — เลือกจากแท็บบนหน้าจอได้",
  cart: "ยังไม่พบตะกร้าบนหน้านี้ — เลือกจากแท็บบนหน้าจอได้",
};

const CART_UNAVAILABLE = "หน้าขายยังไม่พร้อม — ลองใหม่อีกครั้ง";

export interface VoicePosControllerProps {
  readonly voiceEnabled: boolean;
  /** command ที่ผู้ใช้คนนี้เข้าถึงได้ (server กรองสิทธิ์มาแล้ว) */
  readonly allowedCommands: readonly CommandItem[];
  readonly onSelectTab: (tabId: VoicePosTabId) => void;
  /** คำเรียกที่ร้านสร้างเอง (เฉพาะที่เปิดใช้งาน) — U16 */
  readonly aliases?: readonly VoiceNavigationAlias[];
  /** คำเรียกเมนูของร้าน ("มัจฉะลาเต้" → Matcha latte) — U22 */
  readonly productAliases?: readonly VoiceProductAlias[];
  /** ฉีด adapter สำหรับทดสอบ — ปกติปุ่มจะใช้ Web Speech ของเบราว์เซอร์เอง */
  readonly adapter?: VoiceSpeechAdapter;
  readonly className?: string;
  /** ฉีดนาฬิกาสำหรับทดสอบ Undo */
  readonly now?: () => number;
}

export function VoicePosController({
  voiceEnabled,
  allowedCommands,
  onSelectTab,
  aliases,
  productAliases,
  adapter,
  className,
  now,
}: VoicePosControllerProps) {
  const router = useRouter();
  const getCartApi = useVoiceCartApi();
  const [undoToken, setUndoToken] = useState<VoiceUndoToken | null>(null);
  const [undoNotice, setUndoNotice] = useState("");
  const undoSeqRef = useRef(0);
  // U16 — telemetry อยู่ในหน่วยความจำของ session นี้เท่านั้น (ไม่มี transcript, purge 30 วัน)
  const telemetry = useMemo(() => createInMemoryVoiceTelemetrySink(), []);
  const clock = useMemo(() => now ?? (() => Date.now()), [now]);

  // token หมดอายุเองเมื่อพ้นหน้าต่าง 6 วินาที (การเปลี่ยนแปลงใหม่จะแทนที่ token เดิมทันที)
  useEffect(() => {
    if (!undoToken) return;
    const remaining = Math.max(0, undoToken.expiresAt - clock());
    const timer = setTimeout(() => {
      setUndoToken((current) => (current && current.id === undoToken.id ? null : current));
    }, remaining);
    return () => clearTimeout(timer);
  }, [clock, undoToken]);

  const handleUndo = useCallback(() => {
    const outcome = consumeVoiceUndoToken(undoToken, clock());
    setUndoToken(null);
    if (outcome.status === "expired") {
      setUndoNotice(outcome.announcement);
      return;
    }
    const api = getCartApi();
    if (!api) {
      setUndoNotice(CART_UNAVAILABLE);
      return;
    }
    api.commit(outcome.cart);
    setUndoNotice(outcome.announcement);
  }, [clock, getCartApi, undoToken]);

  const handleResult = useCallback(
    (result: VoiceParseResult): string => {
      setUndoNotice("");

      // ── U21 — dialog ตัวเลือกของสินค้าเปิดอยู่: เลือก/ยืนยันด้วยเสียง ──────────
      if (result.intent.type === "pos.choose_option") {
        const api = getCartApi();
        const picker = api?.getPicker?.() ?? null;
        if (!api || !picker) return "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่ — พูดชื่อสินค้าก่อนได้เลย";
        if (result.decision !== "execute") return "ฟังไม่ชัด — ลองพูดชื่อตัวเลือกอีกครั้ง";
        const chosen = api.selectPickerChoice?.(result.intent.optionPhrase) ?? null;
        if (!chosen) {
          const list = picker.choices.slice(0, 6).join(" / ");
          return list ? `ไม่พบตัวเลือกที่พูด — มีให้เลือก: ${list}` : "ไม่พบตัวเลือกที่พูด";
        }
        const after = api.getPicker?.() ?? null;
        const remaining = after
          ? [...(after.needsVariant ? ["ตัวเลือกสินค้า"] : []), ...after.missingRequiredGroups]
          : [];
        return remaining.length > 0
          ? `เลือก ${chosen} แล้ว — ยังต้องเลือก ${remaining.join(" และ ")}`
          : `เลือก ${chosen} แล้ว — พูด "ยืนยัน" เพื่อเพิ่มลงตะกร้า`;
      }

      if (result.intent.type === "pos.confirm_selection") {
        const api = getCartApi();
        if (!api?.confirmPicker) return "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่";
        const outcome = api.confirmPicker();
        if (outcome.ok) onSelectTab("sell");
        return outcome.message;
      }

      // ── Tier B — ตะกร้าในเครื่อง (ย้อนกลับได้ 6 วินาที) ───────────────────────
      if (isVoiceCartIntent(result.intent)) {
        if (!voiceEnabled) return "ร้านนี้ยังไม่เปิดสั่งงานด้วยเสียง";
        if (result.decision !== "execute") {
          return result.resultCode === "invalid_quantity"
            ? "จำนวนไม่ถูกต้อง — ระบุจำนวนระหว่าง 1 ถึง 99"
            : "ฟังไม่ชัด — ยังไม่แก้ตะกร้าให้อัตโนมัติ ลองพูดใหม่อีกครั้ง";
        }
        const api = getCartApi();
        if (!api) return CART_UNAVAILABLE;
        const snapshot = api.getSnapshot();
        const resolution = applyVoiceCartIntent(result.intent, {
          cart: snapshot.cart,
          products: snapshot.products,
          productAliases,
          locked: snapshot.locked,
        });
        if (resolution.status === "blocked") {
          // U21 — สินค้าต้องเลือกตัวเลือก: เด้ง dialog ให้เลย แล้วรอคำสั่งเสียงเลือกต่อ
          if (resolution.reason === "needs_selection" && resolution.candidates?.length === 1) {
            const opened = api.openProduct?.(resolution.candidates[0].id) ?? false;
            if (opened) {
              onSelectTab("sell");
              const picker = api.getPicker?.() ?? null;
              if (!picker) {
                // สินค้าไม่มีตัวเลือกให้เลือกเลย → หน้าขายเพิ่มลงตะกร้าให้ตรง ๆ
                // (เกิดเมื่อพูดคำเกินมาแต่สินค้านั้นไม่มีตัวเลือก) — บอกตามจริง ไม่อ้างว่าต้องเลือก
                return `เพิ่ม ${resolution.candidates[0].name} แล้ว — ส่วนที่พูดเพิ่มไม่ตรงตัวเลือกใด ตรวจบนหน้าจออีกครั้ง`;
              }
              // บอกเฉพาะสิ่งที่ยังขาดจริง — กลุ่มที่มีค่าเริ่มต้นอยู่แล้ว (เช่น ความหวาน
              // 100%) ไม่ต้องสั่งให้เลือกซ้ำ ไม่งั้นพนักงานไม่รู้ว่าจริง ๆ ขาดอะไร
              const missing = picker.missingRequiredGroups.join(" / ");
              const list = picker.pendingChoices.slice(0, 6).join(" / ");
              if (!missing && !picker.needsVariant) {
                return `${picker.productName} เปิดหน้าต่างตัวเลือกให้แล้ว — กดเพิ่มในออร์เดอร์ได้เลย`;
              }
              const what = missing || "ตัวเลือก";
              return list
                ? `${picker.productName} ยังต้องเลือก ${what} — พูด "เลือก…" ได้เลย (${list})`
                : `${picker.productName} ยังต้องเลือก ${what} — เลือกบนหน้าจอได้เลย`;
            }
          }
          return resolution.announcement;
        }

        // การเปลี่ยนแปลงใหม่ทำให้ token เดิมใช้ไม่ได้ (แทนที่ทั้งใบ)
        undoSeqRef.current += 1;
        setUndoToken(
          createVoiceUndoToken({
            id: `voice-undo-${undoSeqRef.current}`,
            previousCart: snapshot.cart,
            label: resolution.announcement,
            now: clock(),
          }),
        );
        api.commit(resolution.cart);
        onSelectTab("sell");
        return `${resolution.announcement} — ย้อนกลับได้ใน 6 วินาที`;
      }

      if (result.intent.type === "pos.clear_search") {
        const api = getCartApi();
        if (!api?.clearSearch) return FOCUS_UNAVAILABLE.search;
        api.clearSearch();
        return "ล้างคำค้นหาแล้ว";
      }

      // ── Tier A — นำทาง ────────────────────────────────────────────────────────
      const outcome = resolveVoiceNavigation(result, {
        voiceEnabled,
        allowedCommands,
        allCommands: DASHBOARD_COMMANDS,
        aliases,
      });
      if (outcome.status === "blocked") return outcome.announcement;

      const target = outcome.target;
      if (target.kind === "tab") {
        onSelectTab(target.tabId);
        return outcome.announcement;
      }
      if (target.kind === "focus") {
        // ตะกร้าอยู่ในแท็บขายเสมอ — สลับแท็บก่อนแล้วค่อยโฟกัส
        if (target.action === "cart") {
          onSelectTab("sell");
          // U21 — "เปิดตะกร้า/เปิดออเดอร์" = กดปุ่มเปิดแผงออเดอร์เดียวกับที่พนักงานกด (ไม่แตะเงิน)
          const api = getCartApi();
          if (api?.openOrderPanel) {
            api.openOrderPanel();
            return "เปิดออเดอร์แล้ว";
          }
        }
        const element = document.querySelector<HTMLElement>(`[data-voice-focus="${target.action}"]`);
        if (!element) return FOCUS_UNAVAILABLE[target.action];
        element.scrollIntoView({ block: "nearest" });
        element.focus();
        return outcome.announcement;
      }
      // route มาจาก command index เท่านั้น (ตรวจแล้วใน resolveVoiceNavigation)
      router.push(target.href);
      return outcome.announcement;
    },
    [aliases, allowedCommands, clock, getCartApi, onSelectTab, productAliases, router, voiceEnabled],
  );

  if (!voiceEnabled) return null;

  const undoVisible = isVoiceUndoTokenValid(undoToken, clock());

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`.trim()}>
      <VoiceCommandButton
        adapter={adapter}
        onResult={handleResult}
        onTelemetry={(event) => telemetry.record(event)}
      />
      {undoVisible && undoToken ? (
        <button
          type="button"
          onClick={handleUndo}
          aria-label={`ย้อนกลับ: ${undoToken.label}`}
          className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
        >
          ↩︎ ย้อนกลับ ({VOICE_UNDO_WINDOW_MS / 1000} วินาที)
        </button>
      ) : null}
      {undoNotice ? (
        <p role="status" aria-live="polite" className="min-h-5 text-xs text-gray-600">
          {undoNotice}
        </p>
      ) : null}
    </div>
  );
}
