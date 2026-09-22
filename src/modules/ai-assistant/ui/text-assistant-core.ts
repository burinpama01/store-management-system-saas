// PR2 — ตัวควบคุมของ overlay ข้อความ (ไม่มี React/timer ในไฟล์นี้ — ทดสอบได้ระดับ module)
//
// หน้าที่เดียว: รับข้อความ → ยิง /api/ai-assistant/text-command → เดินแผนที่ planAssistantTurn
// ให้จบต่อหน้าตะกร้าจริงผ่าน bridge เดิม (applyVoiceCartIntent / clearSearch / openProduct)
// พร้อม Undo 6 วินาทีที่ "ยอมย้อนเฉพาะเมื่อตะกร้ายังใบเดิมเป๊ะ" — การแก้ด้วยมือหรือคำสั่งใหม่
// ทำให้ fingerprint ไม่ตรง = undo ปฏิเสธทันที (ไม่ commit ทับสิ่งที่คนอื่นแก้ไป)
//
// ขอบเขตที่ล็อกไว้:
//   - ไม่มีตะกร้าเป็นของตัวเอง — commit เดียวคือ bridge เดิมของหน้าขาย (ADR-008/009)
//   - ไม่มีไมค์ ไม่มีการ capture เสียงทุกชนิด (Voice POS ยังเป็นเจ้าของไมค์ฝ่ายเดียว)
//   - bridge เป็น null = fail closed เป็นข้อความ ไม่ crash ไม่ fallback ไปแตะตะกร้าเอง
//   - cartVersion คือตัวนับฝั่ง client ที่ไต่ขึ้นเท่านั้น (server ผูกใบเดียวต่อ session และห้าม version ย้อนหลัง)

import { applyVoiceCartIntent, type VoiceProductAlias } from "@/modules/voice-pos/cart";
import { emitPosCommand } from "@/modules/pos/section-bus";
import type { VoiceIntent } from "@/modules/voice-pos/types";
import {
  consumeVoiceUndoToken,
  createVoiceUndoToken,
  type VoiceUndoToken,
} from "@/modules/voice-pos/undo";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";
import {
  ASSISTANT_CART_ID_PATTERN,
  cartFingerprint,
  createAssistantCartId,
  createAssistantRequestId,
  describeFailureReason,
  planAssistantTurn,
  type AssistantCandidate,
  type AssistantProposal,
  type AssistantTurnStep,
} from "./text-assistant-ui";

/**
 * โครงสร้างย่อยของ VoiceCartApi ที่ core ใช้ — ตัวจริงจาก voice-cart-bridge ผ่านได้ตามโครง
 * (นิยามเองไว้ที่นี่เพื่อไม่ต้อง import ข้าม modules → app)
 */
export interface AssistantCartBridge {
  readonly getSnapshot: () => {
    readonly cart: Cart;
    readonly products: readonly Product[];
    readonly locked: boolean;
  };
  readonly commit: (cart: Cart) => void;
  readonly clearSearch?: () => void;
  readonly openProduct?: (productId: string) => boolean;
}

/** body ของ POST /api/ai-assistant/text-command (โหมดข้อความ) */
export interface TextCommandRequestBody {
  readonly requestId: string;
  readonly text?: string;
  readonly activeCartId: string;
  readonly cartVersion: number;
  /** P2 — กดยืนยันการ์ด (ส่งแทน text) */
  readonly confirm?: { readonly tool: string; readonly proposalId: string; readonly answers?: Record<string, string> };
}

/** ผลตอบของ route — parse แบบทนทานที่ core เสมอ (network boundary ห้ามเชื่อรูปทรงเงียบ ๆ) */
export type TextCommandResponse =
  | { readonly ok: true; readonly requestId?: string; readonly outcomes?: readonly unknown[]; readonly failure?: string; readonly note?: string }
  | { readonly ok: false; readonly reason?: string };

export type TextAssistantUiEntry = {
  readonly id: number;
  readonly level: "assistant" | "error";
  readonly message: string;
  readonly candidates?: readonly AssistantCandidate[];
};

export interface TextAssistantState {
  readonly entries: readonly TextAssistantUiEntry[];
  readonly busy: boolean;
  /** null = ไม่มีอะไรให้ย้อน (หรือหมดเวลา/ถูกปฏิเสธไปแล้ว) */
  readonly undo: { readonly label: string; readonly expiresAt: number } | null;
  /** ตัวนับ version ล่าสุด — ผู้เรียกใช้เก็บคู่กับ cartId เพื่อให้ remount ยังผูก session เดิมได้ */
  readonly cartVersion: number;
  /** P2 — การ์ดรอยืนยันที่ค้างอยู่ (null = ไม่มี) ผู้ใช้ต้องกดยืนยันหรือยกเลิกก่อน */
  readonly proposal: AssistantProposal | null;
}

export interface TextAssistantCoreDeps {
  readonly getCartApi: () => AssistantCartBridge | null;
  readonly sendCommand: (body: TextCommandRequestBody) => Promise<TextCommandResponse>;
  /**
   * id ตะกร้า + version ที่เคยใช้ (เช่น จาก sessionStorage ต่อแท็บ) — reuse เพื่อให้ reload/กลับมา
   * หน้าเดิมยังผูก session เดิมได้: server ผูกตะกร้า 1 ใบต่อ session และปฏิเสธ version ย้อนหลัง
   * (id ใหม่/version เคาะกลับทุก mount = โดน CONTEXT_UNAVAILABLE จนครบ TTL)
   * รูปแบบไม่ตรงที่ server รับ = สร้าง/เริ่มใหม่ทันที (fail closed)
   */
  readonly cartId?: string;
  readonly initialCartVersion?: number;
  /** คำเรียกเมนูของร้าน (ชุดเดียวกับ Voice POS) — อ่านตอน apply แต่ละครั้ง */
  readonly getProductAliases?: () => readonly VoiceProductAlias[];
  /** กลับไปแท็บขายหลังแก้ตะกร้า/เปิด dialog สินค้า (พฤติกรรมเดียวกับเสียง) */
  readonly onFocusSell?: () => void;
  readonly clock?: () => number;
  readonly maxEntries?: number;
}

const CART_UNAVAILABLE_MESSAGE = "หน้าขายยังไม่พร้อม — ผู้ช่วยยังใช้ไม่ได้ในขณะนี้";
const UNDO_STALE_MESSAGE = "ตะกร้าถูกแก้ไปแล้ว — ย้อนกลับไม่ได้ แก้บนหน้าจอแทน";
const NO_COMMAND_MESSAGE = "ไม่มีคำสั่งที่ทำได้ — พิมพ์ใหม่แบบสั้น ๆ เช่น “เพิ่มลาเต้ 2 แก้ว”";

export interface TextAssistantCore {
  /** id ตะกร้าของ terminal นี้ (opaque) — ใช้ในการตรวจ binding ฝั่ง server */
  readonly cartId: string;
  readonly send: (text: string) => Promise<void>;
  readonly undo: () => void;
  /** P2 — กดยืนยันการ์ดที่ค้างอยู่ พร้อมคำตอบของสิ่งที่ขาด (subject id → option id) */
  readonly confirmProposal: (answers?: Record<string, string>) => Promise<void>;
  readonly dismissProposal: () => void;
  readonly getState: () => TextAssistantState;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createTextAssistantCore(deps: TextAssistantCoreDeps): TextAssistantCore {
  const clock = deps.clock ?? (() => Date.now());
  const maxEntries = Math.max(1, deps.maxEntries ?? 40);

  let entries: readonly TextAssistantUiEntry[] = [];
  let busy = false;
  let undo: TextAssistantState["undo"] = null;
  let undoToken: VoiceUndoToken | null = null;
  /** fingerprint ของตะกร้า "หลังการแก้ล่าสุดที่ผู้ช่วยทำ" — เทียบก่อน undo ทุกครั้ง */
  let appliedFingerprint: string | null = null;
  /**
   * ตัวนับ cartVersion ฝั่ง client — ไต่ขึ้นอย่างเดียว (server ห้ามย้อนหลัง) และเริ่มจากค่า
   * ที่ผู้เรียกเคยเก็บไว้ เพื่อให้ remount ยังส่ง version ที่ไม่ต่ำกว่าที่ server เคยเห็น
   */
  const activeCartId = typeof deps.cartId === "string" && ASSISTANT_CART_ID_PATTERN.test(deps.cartId)
    ? deps.cartId
    : createAssistantCartId();
  const startCartVersion = typeof deps.initialCartVersion === "number"
    && Number.isSafeInteger(deps.initialCartVersion)
    && deps.initialCartVersion > 0
    ? deps.initialCartVersion
    : 0;
  let cartVersion = startCartVersion;
  let requestSequence = 0;
  let entrySequence = 0;

  const listeners = new Set<() => void>();
  let pendingProposal: AssistantProposal | null = null;
  let snapshot: TextAssistantState = { entries, busy, undo, cartVersion, proposal: pendingProposal };

  function notify(): void {
    snapshot = { entries, busy, undo, cartVersion, proposal: pendingProposal };
    for (const listener of listeners) listener();
  }

  function pushEntry(level: TextAssistantUiEntry["level"], message: string, candidates?: readonly AssistantCandidate[]): void {
    entrySequence += 1;
    const next: TextAssistantUiEntry = { id: entrySequence, level, message, ...(candidates ? { candidates } : {}) };
    entries = [...entries, next].slice(-maxEntries);
  }

  function clearUndo(): void {
    undoToken = null;
    undo = null;
  }

  /**
   * ส่ง 1 คำสั่ง — busy ค้างอยู่หรือข้อความว่าง = ไม่ทำอะไร
   * bridge ไม่พร้อม = fail closed เป็นข้อความ (ห้ามยิงคำสั่งตะกร้าโดยไม่มีหน้าขายรับผล)
   */
  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (busy || trimmed.length === 0) return;
    const api = deps.getCartApi();
    if (!api) {
      pushEntry("error", CART_UNAVAILABLE_MESSAGE);
      notify();
      return;
    }
    requestSequence += 1;
    const body: TextCommandRequestBody = { requestId: createAssistantRequestId(requestSequence), text: trimmed, activeCartId, cartVersion };
    busy = true;
    notify();
    let response: TextCommandResponse;
    try {
      response = await deps.sendCommand(body);
    } catch {
      busy = false;
      pushEntry("error", describeFailureReason("network_error"));
      notify();
      return;
    }
    busy = false;
    processResponse(response, api);
    notify();
  }

  function processResponse(response: TextCommandResponse, api: AssistantCartBridge): void {
    if (!response || typeof response !== "object" || response.ok !== true) {
      const reason = response && typeof response === "object" && "reason" in response && typeof response.reason === "string"
        ? response.reason
        : "network_error";
      pushEntry("error", describeFailureReason(reason));
      return;
    }
    if (typeof response.failure === "string" && response.failure.length > 0) {
      pushEntry("error", describeFailureReason(response.failure, response.note));
      return;
    }
    const outcomes = Array.isArray(response.outcomes) ? response.outcomes : [];
    if (outcomes.length === 0) {
      pushEntry("assistant", typeof response.note === "string" && response.note.length > 0 ? response.note : NO_COMMAND_MESSAGE);
      return;
    }
    executeSteps(planAssistantTurn(outcomes), api);
  }

  /**
   * เดินแผนตามลำดับ — apply หลายรายการในคำสั่งเดียวต่อยอดจากตะกร้าที่เพิ่ง commit
   * (setState เป็น async จึงห้ามอ่าน snapshot ใหม่ระหว่างรอบ) และ undo ของคำสั่งนี้
   * ครอบ "ทั้งคำสั่ง" — 1 รอบพิมพ์ = 1 การเปลี่ยนแปลง = 1 token
   */
  function executeSteps(steps: readonly AssistantTurnStep[], api: AssistantCartBridge): void {
    let workingCart: Cart | null = null;
    let turnPreviousCart: Cart | null = null;
    let lastAnnouncement = "";
    let appliedAny = false;

    for (const step of steps) {
      switch (step.kind) {
        case "message":
          pushEntry(step.level, step.message, step.candidates);
          break;
        case "clear_search": {
          if (typeof api.clearSearch === "function") {
            api.clearSearch();
            pushEntry("assistant", step.note ?? "ล้างช่องค้นหาบนหน้าขายแล้ว");
          } else {
            pushEntry("error", "หน้านี้ยังไม่มีช่องค้นหา — ใช้หน้าจอแทนได้");
          }
          break;
        }
        case "proposal": {
          // การ์ดขึ้นจอ ยังไม่มีอะไรถูกเขียน — ผู้ใช้ต้องกดยืนยันหรือยกเลิกเอง
          pendingProposal = step.proposal;
          pushEntry("assistant", step.proposal.summary);
          break;
        }
        case "open_product": {
          // dialog ตัวเลือกเป็นของหน้าขาย — เปิดไม่ได้ = ข้อความ clarification ที่แสดงไปแล้วเป็นทางออก
          if (api.openProduct?.(step.productId)) deps.onFocusSell?.();
          break;
        }
        case "open_checkout": {
          // "กดปุ่มคิดเงิน" ให้เท่านั้น — แผงรับชำระ/QR/การยืนยันเป็นโค้ดเดิมและเป็นหน้าที่ของคน
          deps.onFocusSell?.();
          emitPosCommand("open-checkout");
          pushEntry("assistant", step.message);
          break;
        }
        case "apply": {
          const snapshot = api.getSnapshot();
          const cartBefore = workingCart ?? snapshot.cart;
          const resolution = applyVoiceCartIntent(step.intent as unknown as VoiceIntent, {
            cart: cartBefore,
            products: snapshot.products,
            productAliases: deps.getProductAliases?.() ?? [],
            locked: snapshot.locked,
          });
          if (resolution.status === "blocked") {
            pushEntry("error", resolution.announcement);
            break;
          }
          if (!turnPreviousCart) turnPreviousCart = cartBefore;
          api.commit(resolution.cart);
          workingCart = resolution.cart;
          cartVersion += 1;
          appliedFingerprint = cartFingerprint(resolution.cart);
          lastAnnouncement = resolution.announcement;
          if (!appliedAny) {
            appliedAny = true;
            deps.onFocusSell?.();
          }
          pushEntry("assistant", resolution.announcement);
          break;
        }
      }
    }

    if (turnPreviousCart && appliedAny) {
      undoToken = createVoiceUndoToken({
        id: `text-undo-${requestSequence}`,
        previousCart: turnPreviousCart,
        label: lastAnnouncement,
        now: clock(),
      });
      undo = { label: lastAnnouncement, expiresAt: undoToken.expiresAt };
    }
  }

  /**
   * ย้อนกลับ — ยอมเฉพาะเมื่อ (1) token ยังไม่หมดเวลา และ (2) ตะกร้าปัจจุบัน "เป๊ะ" กับสถานะ
   * หลังการแก้ที่ผู้ช่วยทำไว้ (fingerprint ตรง) — มีการแก้ด้วยมือ/คำสั่งใหม่แทรก = ปฏิเสธ
   * เพราะการย้อนเป็น snapshot ทั้งใบ จึงต้องไม่มีสิทธิ์ทับสิ่งที่เกิดขึ้นหลังจากนั้น
   */
  function undoLast(): void {
    if (!undoToken) return;
    const api = deps.getCartApi();
    if (!api) {
      pushEntry("error", CART_UNAVAILABLE_MESSAGE);
      notify();
      return;
    }
    const outcome = consumeVoiceUndoToken(undoToken, clock());
    if (outcome.status === "expired") {
      clearUndo();
      pushEntry("assistant", outcome.announcement);
      notify();
      return;
    }
    if (appliedFingerprint === null || cartFingerprint(api.getSnapshot().cart) !== appliedFingerprint) {
      clearUndo();
      pushEntry("error", UNDO_STALE_MESSAGE);
      notify();
      return;
    }
    api.commit(outcome.cart);
    clearUndo();
    cartVersion += 1;
    appliedFingerprint = cartFingerprint(outcome.cart);
    pushEntry("assistant", outcome.announcement);
    notify();
  }

  /**
   * กดยืนยันการ์ด — ส่ง proposalId กลับไปอย่างเดียว ไม่ส่ง args ใหม่
   *
   * ผลที่ได้กลับอาจเป็นการ์ดใบใหม่ (เช่นตอบสิ่งที่ขาดยังไม่ครบ) จึงเดินผ่าน
   * processResponse ตัวเดิม ไม่ได้สมมติว่ายืนยันแล้วต้องจบเสมอ
   */
  async function confirmProposal(answers: Record<string, string> = {}): Promise<void> {
    const proposal = pendingProposal;
    if (busy || !proposal) return;
    const api = deps.getCartApi();
    if (!api) {
      pushEntry("error", CART_UNAVAILABLE_MESSAGE);
      notify();
      return;
    }
    requestSequence += 1;
    const body: TextCommandRequestBody = {
      requestId: createAssistantRequestId(requestSequence),
      activeCartId,
      cartVersion,
      confirm: { tool: proposal.tool, proposalId: proposal.id, answers },
    };
    pendingProposal = null;
    busy = true;
    notify();
    let response: TextCommandResponse;
    try {
      response = await deps.sendCommand(body);
    } catch {
      busy = false;
      pushEntry("error", describeFailureReason("network_error"));
      notify();
      return;
    }
    busy = false;
    processResponse(response, api);
    notify();
  }

  function dismissProposal(): void {
    if (!pendingProposal) return;
    pendingProposal = null;
    pushEntry("assistant", "ยกเลิกแล้ว ไม่มีอะไรถูกบันทึก");
    notify();
  }

  return {
    cartId: activeCartId,
    send,
    undo: undoLast,
    confirmProposal,
    dismissProposal,
    getState: (): TextAssistantState => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
