"use client";

// U14/U15 — Voice Tier A + B (R2) · ตัวเชื่อมเดียวระหว่างปุ่มเสียงกับ shell
// หน้าที่: รับผล parse → ถามตัวตัดสิน pure (navigation.ts / cart.ts) → ลงมือทำเฉพาะที่อนุญาต
// ห้ามมี logic ตัดสินใจอยู่ในไฟล์นี้ และห้ามแตะ server action/DB โดยตรง
//
// หมายเหตุ: component นี้ mount เฉพาะเมื่อ stores.voice_command_enabled = true เท่านั้น
// (useRouter จึงไม่ถูกเรียกในเส้นทาง legacy/flag ปิด)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  VoiceCommandButton,
  type VoiceResultContext,
  type VoiceResultResponse,
} from "@/shared/components/VoiceCommandButton";
import { DASHBOARD_COMMANDS, type CommandItem } from "@/modules/assistant/command-index";
import {
  resolveVoiceNavigation,
  type VoiceNavigationAlias,
  type VoicePosFocusAction,
  type VoicePosTabId,
} from "@/modules/voice-pos/navigation";
import {
  applyVoiceCartIntent,
  isVoiceCartIntent,
  resolveVoiceProductPhrase,
  type VoiceProductAlias,
} from "@/modules/voice-pos/cart";
import { buildMultiCommandBatch } from "@/modules/voice-pos/multi-command";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import {
  consumeVoiceUndoToken,
  createVoiceUndoToken,
  isVoiceUndoTokenValid,
  refreshVoiceUndoToken,
  VOICE_UNDO_WINDOW_MS,
  type VoiceUndoToken,
} from "@/modules/voice-pos/undo";
import { createInMemoryVoiceTelemetrySink } from "@/modules/voice-pos/telemetry";
import { recordVoiceTelemetryAction } from "./voice-telemetry-actions";
import type { VoiceSpeechAdapter } from "@/modules/voice-pos/speech-adapter";
import type { VoiceFeedback } from "@/modules/voice-pos/feedback";
import { createWindowsVoiceHost, type WindowsVoiceHostAdapter } from "@/modules/voice-pos/windows-host";
import type { VoiceActivationOrigin } from "@/modules/voice-pos/standby-policy";
import { decideStandbyAction, readVoiceUndoReply } from "@/modules/voice-pos/standby-policy";
import type { VoiceParseResult } from "@/modules/voice-pos/types";
import {
  AI_UNAVAILABLE_MESSAGE,
  parseVoiceCommandHybrid,
} from "@/modules/voice-pos/hybrid-parser";
import {
  createVoiceRequestId,
  requestAiVoiceIntent,
  type VoiceIntentClientResult,
} from "@/modules/voice-pos/ai-intent-client";
import {
  activeQueueItem,
  createVoiceQueue,
  isQueueComplete,
  reduceVoiceQueue,
  summarizeQueue,
  type VoiceCommandQueue as VoiceQueue,
} from "@/modules/voice-pos/command-queue";
import { resolveAiVoiceCommand } from "@/modules/voice-pos/intent-resolver";
import type { AiVoiceCommand } from "@/modules/voice-pos/ai-intent-schema";
import { useVoiceCartApi, type VoiceCartApi } from "./voice-cart-bridge";
import { VoiceCommandQueue } from "./VoiceCommandQueue";

/** เทียบชื่อสินค้าแบบไม่สนช่องว่าง/ตัวพิมพ์ — ใช้ยืนยันว่า "ตรงทั้งชื่อ" ไม่ใช่แค่ขึ้นต้นตรง */
function compactName(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

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
  /**
   * ฉีดตัวเล่นเสียงตอบรับได้ — ส่งต่อให้ปุ่มตรง ๆ
   * จังหวะที่ระบบ "พูดจบ" คือจังหวะที่ไมค์เปิดอีกครั้ง ซึ่งเป็นตัวกำหนดว่า
   * ผู้ใช้มีเวลาพูดว่า "ย้อนกลับ" จริงเท่าไร การทดสอบเรื่องเวลาจึงต้องคุมจุดนี้ได้
   */
  readonly feedback?: VoiceFeedback;
  /** ฉีด host ของ Launcher ได้ในเทสต์; ไม่ส่งมาจะตรวจ chrome.webview เองตอนรัน */
  readonly standbyHost?: WindowsVoiceHostAdapter;
  readonly className?: string;
  /** ฉีดนาฬิกาสำหรับทดสอบ Undo */
  readonly now?: () => number;
  /**
   * P5 — เปิดทางสำรอง AI สำหรับคำพูดที่ parser เดิมไม่เข้าใจ
   * ปิดอยู่ = พฤติกรรมเดิมทุกอย่าง (rollback ทำได้ด้วยการปิดค่านี้ค่าเดียว)
   */
  readonly aiFallbackEnabled?: boolean;
  /** ฉีดตัวเรียก AI สำหรับทดสอบ — ปกติยิงไปที่ /api/ai/voice-intent */
  readonly requestAiIntent?: (transcript: string) => Promise<VoiceIntentClientResult>;
}

/**
 * ข้อความหลังเลือกตัวเลือกได้หนึ่งค่า — ใช้ร่วมกันทั้งเส้นทาง "เลือก…" และเส้นทาง
 * พูดชื่อตัวเลือกลอย ๆ ยังอยู่กลางลำดับ "เลือก → ยืนยัน" จึงเปิดไมค์ต่อทุกครั้ง
 */
function describeChoice(api: VoiceCartApi, chosen: string): VoiceResultResponse {
  const after = api.getPicker?.() ?? null;
  const remaining = after
    ? [...(after.needsVariant ? ["ตัวเลือกสินค้า"] : []), ...after.missingRequiredGroups]
    : [];
  return {
    message:
      remaining.length > 0
        ? `เลือก ${chosen} แล้ว — ยังต้องเลือก ${remaining.join(" และ ")}`
        : `เลือก ${chosen} แล้ว — พูด "ยืนยัน" เพื่อเพิ่มลงตะกร้า`,
    listenAgain: true,
  };
}

export function VoicePosController({
  voiceEnabled,
  allowedCommands,
  onSelectTab,
  aliases,
  productAliases,
  adapter,
  feedback,
  standbyHost,
  className,
  now,
  aiFallbackEnabled = false,
  requestAiIntent,
}: VoicePosControllerProps) {
  const router = useRouter();
  const getCartApi = useVoiceCartApi();
  /**
   * W5 — สายคุยกับ StoreOS Launcher (คำปลุก)
   *
   * บนเบราว์เซอร์ปกติจะได้ตัวที่ available = false ซึ่งไม่ทำอะไรเลย
   * ปุ่มกดพูดจึงทำงานเหมือนเดิมทุกประการ ไม่มีเงื่อนไขเพิ่มบนเส้นทางเดิม
   */
  const resolvedStandbyHost = useMemo<WindowsVoiceHostAdapter>(
    () => standbyHost ?? createWindowsVoiceHost(),
    [standbyHost],
  );
  useEffect(() => () => resolvedStandbyHost.dispose(), [resolvedStandbyHost]);
  const [undoToken, setUndoToken] = useState<VoiceUndoToken | null>(null);
  /**
   * รอบการฟังที่เปิดค้างอยู่ถือ callback ของ render ก่อนหน้าไว้ — ค่าที่อ่านจาก state
   * ตรง ๆ จึงเป็นของเก่าเสมอเมื่อ token ถูกต่อเวลาระหว่างที่ไมค์เปิดอยู่
   * เส้นทางที่ทำงาน "ระหว่างรอบ" ต้องอ่านจาก ref นี้เท่านั้น
   */
  const undoTokenRef = useRef<VoiceUndoToken | null>(null);
  const [undoNotice, setUndoNotice] = useState("");
  const undoSeqRef = useRef(0);
  // U16 — telemetry ในหน่วยความจำของ session (ใช้ debug ในเครื่อง)
  const telemetry = useMemo(() => createInMemoryVoiceTelemetrySink(), []);
  /**
   * v0.44.10 — ส่ง telemetry ขึ้น server เพื่อตอบให้ได้ว่า "พูดกี่ครั้ง เข้าใจกี่ครั้ง"
   * ยิงแบบ fire-and-forget: การวัดผลต้องไม่หน่วงการขาย และพังก็ต้องไม่กระทบผู้ใช้
   *
   * ยิง 2 จังหวะต่อการพูด 1 ครั้ง:
   *   deterministic — ผลของ parser เดิม (ปุ่มเรียก onTelemetry ก่อน onResult เสมอ)
   *   ai            — ผลของทางสำรอง เฉพาะรอบที่ตกไปถึง AI จริง
   * แยกกันเพื่อให้ดูได้ว่า "AI ช่วยกู้คืนคำสั่งที่ระบบเดิมไม่เข้าใจได้กี่ครั้ง"
   */
  const reportVoiceTelemetry = useCallback(
    (event: {
      intentType: string;
      resultCode: string;
      locale: string;
      confidenceBucket: string;
      source: "deterministic" | "ai";
    }) => {
      void recordVoiceTelemetryAction(event);
    },
    [],
  );
  const clock = useMemo(() => now ?? (() => Date.now()), [now]);

  useEffect(() => {
    undoTokenRef.current = undoToken;
  }, [undoToken]);

  /** เปลี่ยน token พร้อมอัปเดต ref ทันที — ห้ามรอ effect ในเส้นทางที่ทำงานระหว่างรอบ */
  const applyUndoToken = useCallback(
    (next: VoiceUndoToken | null | ((current: VoiceUndoToken | null) => VoiceUndoToken | null)) => {
      const value = typeof next === "function" ? next(undoTokenRef.current) : next;
      undoTokenRef.current = value;
      setUndoToken(value);
    },
    [],
  );

  // token หมดอายุเองเมื่อพ้นหน้าต่าง 6 วินาที (การเปลี่ยนแปลงใหม่จะแทนที่ token เดิมทันที)
  useEffect(() => {
    if (!undoToken) return;
    const remaining = Math.max(0, undoToken.expiresAt - clock());
    const timer = setTimeout(() => {
      applyUndoToken((current) => (current && current.id === undoToken.id ? null : current));
    }, remaining);
    return () => clearTimeout(timer);
  }, [applyUndoToken, clock, undoToken]);

  /**
   * ไมค์เปิดรอบใหม่ = เริ่มนับหน้าต่างย้อนกลับใหม่ (ต่อได้ครั้งเดียว)
   *
   * ระบบพูดผลออกลำโพงก่อนแล้วค่อยเปิดไมค์ต่อ ถ้านับตั้งแต่ตอนแก้ตะกร้า
   * เวลาเกือบทั้งหมดจะหมดไปกับเสียงของระบบเอง แล้วพูดว่า "ย้อนกลับ" ไม่ทัน
   */
  const handleListeningStart = useCallback(() => {
    applyUndoToken((current) => refreshVoiceUndoToken(current, clock()));
  }, [applyUndoToken, clock]);

  const handleUndo = useCallback(() => {
    const outcome = consumeVoiceUndoToken(undoTokenRef.current, clock());
    applyUndoToken(null);
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
  }, [applyUndoToken, clock, getCartApi]);

  // ── P7 — คิวคำสั่งหลายรายการ ────────────────────────────────────────────────
  // ทำงานทีละรายการเสมอ และห้ามเปิด dialog ใหม่ขณะที่ยังมี dialog เปิดค้างอยู่
  const [queue, setQueue] = useState<VoiceQueue | null>(null);
  const queueRef = useRef<VoiceQueue | null>(null);
  const queueSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const publishQueue = useCallback((next: VoiceQueue | null) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  // ออกจากหน้า/unmount = บริบทและคิวต้องหายไปทั้งหมด (ห้ามค้างข้ามลูกค้า)
  useEffect(() => () => {
    abortRef.current?.abort();
    queueRef.current = null;
  }, []);

  const commitCart = useCallback(
    (api: VoiceCartApi, previousCart: Parameters<VoiceCartApi["commit"]>[0], nextCart: Parameters<VoiceCartApi["commit"]>[0], label: string) => {
      undoSeqRef.current += 1;
      applyUndoToken(
        createVoiceUndoToken({
          id: `voice-undo-${undoSeqRef.current}`,
          previousCart,
          label,
          now: clock(),
        }),
      );
      api.commit(nextCart);
    },
    [applyUndoToken, clock],
  );

  /**
   * เดินคิวไปจนกว่าจะจบ หรือจนกว่าจะเจอรายการที่ต้องรอคน
   * คืนข้อความสรุปให้ปุ่มเสียงประกาศ
   */
  const runQueue = useCallback(
    (startFrom: VoiceQueue): string | VoiceResultResponse => {
      let current = startFrom;
      // ตะกร้าที่ commit ไปแล้วในรอบนี้ยังไม่กลับมาที่ snapshot (setState เป็น async)
      // จึงต้องต่อยอดจากผลของรายการก่อนหน้า ไม่งั้นรายการที่ 2 จะทับรายการที่ 1
      let workingCart: Parameters<VoiceCartApi["commit"]>[0] | null = null;

      while (!isQueueComplete(current)) {
        const item = activeQueueItem(current);
        if (!item) break;

        const api = getCartApi();
        if (!api) {
          current = reduceVoiceQueue(current, { type: "block", note: CART_UNAVAILABLE });
          continue;
        }

        // re-read ทุกครั้งก่อนลงมือ — ระหว่างรอ AI เมนู/สถานะล็อกอาจเปลี่ยนไปแล้ว
        const snapshot = api.getSnapshot();
        const cartNow = workingCart ?? snapshot.cart;
        if (snapshot.locked) {
          current = reduceVoiceQueue(current, { type: "cancel_all" });
          publishQueue(current);
          return "ตะกร้าถูกล็อกแล้ว — ยกเลิกคำสั่งเสียงที่เหลือ";
        }

        const resolved = resolveAiVoiceCommand(item.command, {
          products: snapshot.products,
          productAliases,
        });

        if (resolved.status === "apply") {
          const outcome = applyVoiceCartIntent(resolved.intent, {
            cart: cartNow,
            products: snapshot.products,
            productAliases,
            locked: snapshot.locked,
          });
          if (outcome.status === "blocked") {
            current = reduceVoiceQueue(current, { type: "block", note: outcome.announcement });
            continue;
          }
          commitCart(api, cartNow, outcome.cart, outcome.announcement);
          workingCart = outcome.cart;
          current = reduceVoiceQueue(current, { type: "apply", note: outcome.announcement });
          continue;
        }

        if (resolved.status === "needs_option") {
          // one-dialog invariant: ถ้ามี dialog เปิดค้างอยู่ ห้ามเปิดใบใหม่
          if (api.getPicker?.()) {
            current = reduceVoiceQueue(current, { type: "await_input", note: resolved.note });
            publishQueue(current);
            return `${resolved.productName}: ${resolved.note}`;
          }
          const opened = api.openProduct?.(resolved.productId) ?? false;
          if (!opened) {
            current = reduceVoiceQueue(current, { type: "block", note: "เปิดหน้าต่างตัวเลือกไม่ได้" });
            continue;
          }
          onSelectTab("sell");
          current = reduceVoiceQueue(current, { type: "await_input", note: resolved.note });
          publishQueue(current);
          return {
            message: `${resolved.productName} — ${resolved.note} พูด "เลือก…" ได้เลย`,
            listenAgain: true,
          };
        }

        if (resolved.status === "needs_quantity") {
          current = reduceVoiceQueue(current, {
            type: "block",
            note: `${resolved.productName}: ไม่ได้ยินจำนวน`,
          });
          continue;
        }

        if (resolved.status === "ambiguous") {
          const names = resolved.candidates.slice(0, 4).map((c) => c.name).join(" / ");
          current = reduceVoiceQueue(current, { type: "block", note: `หลายรายการตรงกัน: ${names}` });
          continue;
        }

        if (resolved.status === "unavailable") {
          current = reduceVoiceQueue(current, { type: "block", note: `${resolved.productName} ของหมด` });
          continue;
        }

        current = reduceVoiceQueue(current, { type: "block", note: "คำสั่งนี้ยังไม่รองรับ" });
      }

      publishQueue(current);
      const summary = summarizeQueue(current);
      const parts = [
        summary.applied > 0 ? `เพิ่ม ${summary.applied} รายการ` : "",
        summary.blocked > 0 ? `ทำไม่ได้ ${summary.blocked}` : "",
        summary.skipped > 0 ? `ข้าม ${summary.skipped}` : "",
      ].filter(Boolean);
      if (summary.applied > 0) onSelectTab("sell");
      return parts.length > 0 ? parts.join(" · ") : "ไม่มีรายการที่ทำได้";
    },
    [commitCart, getCartApi, onSelectTab, productAliases, publishQueue],
  );

  const skipCurrentQueueItem = useCallback(() => {
    const current = queueRef.current;
    if (!current || isQueueComplete(current)) return;
    runQueue(reduceVoiceQueue(current, { type: "skip" }));
  }, [runQueue]);

  const cancelQueue = useCallback(() => {
    const current = queueRef.current;
    if (!current) return;
    publishQueue(reduceVoiceQueue(current, { type: "cancel_all" }));
    setUndoNotice("ยกเลิกคำสั่งเสียงที่เหลือแล้ว");
  }, [publishQueue]);

  const handleDeterministicResult = useCallback(
    (
      result: VoiceParseResult,
      transcript = "",
    ): string | VoiceResultResponse | Promise<string | VoiceResultResponse> => {
      setUndoNotice("");

      // ระบบเพิ่งเปิดไมค์ต่อเพื่อรอ "ตัวเลือก" — คนจริงมักพูดแค่ค่าที่ต้องการ
      // ("คั่วเข้ม" / "หวาน 0%") ไม่ใส่คำว่า "เลือก" นำหน้า parser จึงตอบว่าไม่รองรับ
      // ทั้งที่บริบทบนหน้าจอบอกความหมายชัด: หน้าต่างตัวเลือกเปิดค้างอยู่
      if (result.intent.type === "unknown" && result.resultCode === "no_match" && transcript.trim()) {
        const api = getCartApi();
        const picker = api?.getPicker?.() ?? null;
        if (api && picker) {
          const chosen = api.selectPickerChoice?.(transcript) ?? null;
          if (chosen) return describeChoice(api, chosen);
        }
      }

      // ── U21 — dialog ตัวเลือกของสินค้าเปิดอยู่: เลือก/ยืนยันด้วยเสียง ──────────
      if (result.intent.type === "pos.choose_option") {
        const api = getCartApi();
        const picker = api?.getPicker?.() ?? null;
        if (!api || !picker) return "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่ — พูดชื่อสินค้าก่อนได้เลย";
        if (result.decision !== "execute") return "ฟังไม่ชัด — ลองพูดชื่อตัวเลือกอีกครั้ง";
        const chosen = api.selectPickerChoice?.(result.intent.optionPhrase) ?? null;
        if (!chosen) {
          // บอกเฉพาะตัวเลือกที่ยังขาด ไม่ใช่ทุกกลุ่มของสินค้า
          const list = (picker.pendingChoices.length > 0 ? picker.pendingChoices : picker.choices)
            .slice(0, 6)
            .join(" / ");
          return {
            message: list ? `ไม่พบตัวเลือกที่พูด — มีให้เลือก: ${list}` : "ไม่พบตัวเลือกที่พูด",
            listenAgain: true,
          };
        }
        return describeChoice(api, chosen);
      }

      if (result.intent.type === "pos.confirm_selection") {
        const api = getCartApi();
        if (!api?.confirmPicker) return "ยังไม่มีหน้าต่างตัวเลือกเปิดอยู่";
        const outcome = api.confirmPicker();
        if (!outcome.ok) return outcome.message;
        onSelectTab("sell");
        // P7 — ต้องรอให้ dialog ปิดและตะกร้าที่เพิ่งยืนยันลงจริงก่อน แล้วค่อย advance
        // (เดินคิวต่อทันทีในจังหวะเดียวกันจะอ่าน snapshot เก่าแล้วทับของที่เพิ่งเพิ่ม)
        const pending = queueRef.current;
        if (pending && !isQueueComplete(pending)) {
          return (async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            const advanced = reduceVoiceQueue(pending, { type: "apply", note: outcome.message });
            const next = runQueue(advanced);
            const nextMessage = typeof next === "string" ? next : next.message;
            return typeof next === "string"
              ? `${outcome.message} · ${nextMessage}`
              : { ...next, message: `${outcome.message} · ${nextMessage}` };
          })();
        }
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

              // ไม่มีอะไรต้องเลือกแล้ว = การกด "เพิ่มในออร์เดอร์" ไม่ได้ให้ข้อมูลอะไรเพิ่ม
              // ปิดให้เองเลย ไม่งั้นคำสั่งเสียงจบลงด้วยการบังคับให้เอามือมาแตะจอ
              // ซึ่งขัดกับเหตุผลทั้งหมดของฟีเจอร์นี้ (คนมือไม่ว่าง)
              if (!missing && !picker.needsVariant) {
                const outcome = api.confirmPicker?.();
                if (outcome?.ok) return outcome.message;
                return {
                  message: `${picker.productName} พร้อมเพิ่มแล้ว — พูดว่า "ยืนยัน" ได้เลย`,
                  listenAgain: true,
                };
              }

              const what = missing || "ตัวเลือก";
              // ขั้นถัดไปคือคำสั่งเสียงอีกคำเสมอ ("เลือก…") จึงเปิดไมค์ต่อให้เลย
              // แคชเชียร์มักถือถาด/แก้วอยู่ การให้กดปุ่มซ้ำคือแรงเสียดทานที่ตัดออกได้
              return {
                message: list
                  ? `${picker.productName} ยังต้องเลือก ${what} — พูด "เลือก…" ได้เลย (${list})`
                  : `${picker.productName} ยังต้องเลือก ${what} — พูดชื่อตัวเลือกได้เลย`,
                listenAgain: true,
              };
            }
          }
          return resolution.announcement;
        }

        // การเปลี่ยนแปลงใหม่ทำให้ token เดิมใช้ไม่ได้ (แทนที่ทั้งใบ)
        undoSeqRef.current += 1;
        applyUndoToken(
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
    [aliases, allowedCommands, applyUndoToken, clock, getCartApi, onSelectTab, productAliases, router, runQueue, voiceEnabled],
  );

  /**
   * P5/P7 — ทางเข้าเดียวของปุ่มเสียง
   * deterministic ก่อนเสมอ; ส่ง AI เฉพาะ no_match ที่ไม่ได้อยู่ในบริบทเลือกตัวเลือก
   * (บริบทนั้น deterministic เดาได้ดีกว่าอยู่แล้ว และไม่ต้องเสียโควตา)
   */
  /** เริ่มคิวใหม่จากชุดคำสั่งที่ตีความได้ (ใช้ทั้งทาง deterministic และทาง AI) */
  const runCommandBatch = useCallback(
    (commands: readonly AiVoiceCommand[]): string | VoiceResultResponse => {
      queueSeqRef.current += 1;
      const next = createVoiceQueue(`vq-${queueSeqRef.current}`, commands);
      publishQueue(next);
      return runQueue(next);
    },
    [publishQueue, runQueue],
  );

  /**
   * ประโยคเดียวที่มีหลายเมนู ("เพิ่มลาเต้สองแก้วกับชาเย็นหนึ่งแก้ว")
   *
   * ต้องตรวจก่อนเส้นทาง AI เพราะประโยคแบบนี้ parser เดิม "ฟังออกเมนูแรก" เสมอ
   * จึงไม่เคยตกไปถึงทางสำรอง AI เลย — เมนูที่เหลือหายไปเงียบ ๆ
   * ตัดสินด้วยเมนูจริงบนจอ: ทุกท่อนต้องเป็นสินค้าที่มีอยู่ ไม่งั้นถือว่าเป็นคำสั่งเดียว
   */
  const detectCommandBatch = useCallback(
    (text: string) => {
      const products = getCartApi()?.getSnapshot().products ?? [];
      if (products.length === 0) return null;
      const resolve = (phrase: string) => resolveVoiceProductPhrase(phrase, products, productAliases ?? []);
      return buildMultiCommandBatch(text, {
        parse: (segment) => parseVoiceCommand(segment),
        isKnownProduct: (phrase) => resolve(phrase).status !== "not_found",
        isExactProduct: (phrase) => {
          const resolution = resolve(phrase);
          if (resolution.status !== "matched") return false;
          // ตัวจับคู่จับแบบคำขึ้นต้น จึงต้องเทียบชื่อเต็มซ้ำอีกชั้น
          return compactName(resolution.selection.product.name) === compactName(phrase);
        },
      });
    },
    [getCartApi, productAliases],
  );

  /**
   * ฟีเจอร์นี้มีไว้ให้คนที่มือไม่ว่าง — ถ้าจบรอบแล้วต้องเอามือมาแตะจอ ก็ไม่ต่างจาก
   * การกดปุ่มพูดตั้งแต่แรก จึงต้องเปิดไมค์ต่อทันทีหลังระบบพูดจบ เพื่อให้ผู้ใช้
   * "ยืนยัน" หรือสั่งคำสั่งถัดไปด้วยเสียงได้เลย
   *
   * จำกัดจำนวนรอบต่อเนื่องด้วย MAX_AUTO_LISTEN_CHAIN ในตัวปุ่มอยู่แล้ว
   * ไมค์จึงไม่เปิดค้างไม่รู้จบ และผู้ใช้เริ่มรอบใหม่ด้วยคำปลุกได้เสมอ
   */
  const keepListening = useCallback(
    async (
      outcome: string | VoiceResultResponse | Promise<string | VoiceResultResponse>,
      origin: VoiceActivationOrigin,
    ): Promise<string | VoiceResultResponse> => {
      const resolved = await outcome;
      if (origin !== "windows_standby") return resolved;
      const response = typeof resolved === "string" ? { message: resolved } : resolved;
      return { ...response, listenAgain: true };
    },
    [],
  );

  /**
   * ด่านสุดท้ายก่อนลงมือ
   *
   * ไม่มีขั้นยืนยันอีกแล้ว — คำปลุกลงมือได้ทันทีเหมือนกดปุ่มเอง
   * สิ่งที่รับประกันความปลอดภัยแทนคือ tier C/D ที่ยังบล็อกเหมือนเดิม
   * บวกกับหน้าต่างย้อนกลับที่สั่งด้วยเสียงได้ (ดู handleResult)
   */
  const applyWithStandbyPolicy = useCallback(
    (
      result: VoiceParseResult,
      transcript: string,
      context: VoiceResultContext,
    ): string | VoiceResultResponse | Promise<string | VoiceResultResponse> => {
      // decision ทั้งสองแบบใช้ข้อความเดิมของเส้นทาง deterministic (บอกเหตุผลตาม resultCode)
      decideStandbyAction(result, context.origin);
      return keepListening(handleDeterministicResult(result, transcript), context.origin);
    },
    [handleDeterministicResult, keepListening],
  );

  const handleResult = useCallback(
    async (
      result: VoiceParseResult,
      transcript = "",
      context: VoiceResultContext = { origin: "push_to_talk", sessionId: null },
    ): Promise<string | VoiceResultResponse> => {
      const text = transcript.trim();

      // ยังย้อนกลับได้อยู่ = ฟังคำสั่งย้อนกลับก่อน (allowlist ตรงตัวเท่านั้น)
      // ต้องอยู่ก่อนทุกอย่าง เพราะ "ยกเลิก" อยู่ใน denylist ของ parser (tier D)
      // ถ้าปล่อยให้ไหลไปตามปกติ จะกลายเป็น "คำสั่งต้องห้าม" แทนที่จะย้อนตะกร้า
      if (isVoiceUndoTokenValid(undoTokenRef.current, clock()) && readVoiceUndoReply(text) === "undo") {
        handleUndo();
        return keepListening("ย้อนกลับแล้ว", context.origin);
      }
      const pickerOpen = Boolean(getCartApi()?.getPicker?.());

      // สั่งหลายเมนูรวดเดียว — ห้ามทำระหว่าง dialog ตัวเลือกเปิดอยู่ (ต้องจบทีละรายการ)
      const batch = pickerOpen || text.length === 0 ? null : detectCommandBatch(text);
      if (batch) return keepListening(runCommandBatch(batch.commands), context.origin);

      const shouldTryAi =
        aiFallbackEnabled && voiceEnabled && result.resultCode === "no_match" && text.length > 0 && !pickerOpen;

      if (!shouldTryAi) return applyWithStandbyPolicy(result, transcript, context);

      // คำขอเก่าที่ยังค้างต้องถูกทิ้ง — คำตอบที่มาช้าห้ามไปแตะตะกร้าของรอบใหม่
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = createVoiceRequestId();

      const client =
        requestAiIntent ??
        ((utterance: string) =>
          requestAiVoiceIntent({ transcript: utterance, requestId, signal: controller.signal }));

      const outcome = await parseVoiceCommandHybrid(transcript, { requestAiVoiceIntent: client });
      if (controller.signal.aborted) return "";

      // เหตุการณ์ที่ 2 ของรอบนี้: ผลของทางสำรอง AI (ไม่มีคำพูดอยู่ในนั้น)
      reportVoiceTelemetry({
        intentType:
          outcome.source === "ai" ? outcome.envelope.commands[0]?.intent ?? "unknown" : "unknown",
        resultCode:
          outcome.source === "ai"
            ? "matched"
            : outcome.source === "blocked"
              ? "forbidden_command"
              : "no_match",
        locale: "th-TH",
        confidenceBucket: outcome.source === "ai" ? outcome.envelope.confidence : "low",
        source: "ai",
      });

      switch (outcome.source) {
        case "deterministic":
          return applyWithStandbyPolicy(outcome.result, transcript, context);
        case "blocked":
          return "คำสั่งนี้ต้องทำบนหน้าจอเอง — เสียงยังไม่รับคำสั่งเรื่องเงิน/ส่วนลด/สต๊อก";
        case "ai_unavailable":
          return AI_UNAVAILABLE_MESSAGE;
        case "ai_no_command":
          return "ยังไม่แน่ใจว่าหมายถึงเมนูไหน — ลองพูดชื่อเมนูให้ชัดอีกครั้ง";
        case "ai":
          return runCommandBatch(outcome.envelope.commands);
        default:
          return AI_UNAVAILABLE_MESSAGE;
      }
    },
    [
      aiFallbackEnabled,
      applyWithStandbyPolicy,
      clock,
      detectCommandBatch,
      getCartApi,
      handleUndo,
      keepListening,
      reportVoiceTelemetry,
      requestAiIntent,
      runCommandBatch,
      voiceEnabled,
    ],
  );

  if (!voiceEnabled) return null;

  const undoVisible = isVoiceUndoTokenValid(undoToken, clock());

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`.trim()}>
      <VoiceCommandButton
        adapter={adapter}
        feedback={feedback}
        standbyHost={resolvedStandbyHost}
        onResult={handleResult}
        onListeningStart={handleListeningStart}
        onTelemetry={(event) => {
          telemetry.record(event);
          reportVoiceTelemetry({ ...event, source: "deterministic" });
        }}
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
      <VoiceCommandQueue
        queue={queue}
        activeIndex={queue?.activeIndex ?? 0}
        onSkipCurrent={skipCurrentQueueItem}
        onCancelAll={cancelQueue}
      />
    </div>
  );
}
