import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLiveAssistantCore,
  createLiveIdempotencyKey,
  type LiveAssistantCoreDeps,
  type LiveConnectOptions,
  type LiveConnectionHandle,
  type LiveSessionResponse,
  type LiveToolRelayResponse,
  type LiveToolRequestBody,
} from "@/modules/ai-assistant/ui/live-assistant-core";
import type { AssistantCartBridge } from "@/modules/ai-assistant/ui/text-assistant-core";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";

// PR3-Live (M5) — core ของโหมดเสียงสดระดับ module (ไม่มี React/WebRTC — ท่อจริงฉีดเข้ามา)
// จุดที่ต้องพิสูจน์: fail closed ทุกด่าน (claim ไมค์/bridge/เซสชัน/เชื่อมต่อ), สถานะสดครบ,
// relay failure แบบ typed ถึง model, หมด cap ปิดเซสชันเอง, และปิดไมค์ทุกทาง (ADR-008)

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    storeId: "store",
    organizationId: "org",
    categoryId: "cat",
    basePrice: 50,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    variants: [],
    modifierGroups: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const defaultProducts: readonly Product[] = [
  product({ id: "p-latte", name: "ลาเต้", basePrice: 55 }),
  product({ id: "p-greentea", name: "ชาเขียว", basePrice: 40 }),
];

const EMPTY_CART: Cart = { storeId: "store", items: [], subtotal: 0, discount: 0, total: 0 };

function createBridge() {
  let cart: Cart = EMPTY_CART;
  let locked = false;
  const commits: Cart[] = [];
  const api: AssistantCartBridge = {
    getSnapshot: () => ({ cart, products: defaultProducts, locked }),
    commit: (next) => {
      commits.push(next);
      cart = next;
    },
  };
  return {
    api,
    commits,
    get cart() {
      return cart;
    },
    setLocked: (value: boolean) => {
      locked = value;
    },
  };
}

interface FakeTimer {
  readonly ms: number;
  cancelled: boolean;
  readonly fn: () => void;
}

const OK_SESSION: LiveSessionResponse = {
  ok: true,
  sessionId: "sess-live0001",
  sessionToken: "tok-live0001",
  ephemeralToken: "ek-test-token-0001",
  model: "gpt-realtime-2.1-mini",
  expiresAt: 1_900_000,
  caps: { toolCallsPerSession: 40 },
};

function relayOk(data: unknown, counts?: { used: number; cap: number }): LiveToolRelayResponse {
  return {
    ok: true,
    callId: "call_test0001",
    tool: "pos.add_item",
    outcome: { ok: true, data },
    ...(counts ? { toolCallsUsed: counts.used, toolCallsCap: counts.cap } : {}),
  };
}

const ADD_APPLY_RESULT = {
  status: "apply",
  intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 },
  productName: "ลาเต้",
};

/** ตัวช่วยล้าง microtask chain ของ relayChain (mock ทั้งหมด resolve ทันที) */
async function flushAsync(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function createHarness(overrides: Partial<LiveAssistantCoreDeps> = {}, create = createLiveAssistantCore) {
  const bridge = createBridge();
  const timers: FakeTimer[] = [];
  const schedule = vi.fn((fn: () => void, ms: number) => {
    const timer: FakeTimer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  });
  const runTimers = (ms: number) => {
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.ms === ms) timer.fn();
    }
  };
  let handlers: LiveConnectOptions["handlers"] | null = null;
  const sendFunctionCallOutput = vi.fn();
  const closeHandle = vi.fn();
  const connect = vi.fn(async (options: LiveConnectOptions): Promise<LiveConnectionHandle> => {
    handlers = options.handlers;
    return { sendFunctionCallOutput, close: closeHandle };
  });
  const createSession = vi.fn(async () => OK_SESSION);
  const relayTool = vi.fn<(body: LiveToolRequestBody) => Promise<LiveToolRelayResponse>>(async () => relayOk(ADD_APPLY_RESULT, { used: 3, cap: 40 }));
  const endSession = vi.fn(async () => null);
  const claimMic = vi.fn(() => true);
  const releaseMic = vi.fn();
  const now = { value: 1_000_000 };
  const core = create({
    cartId: "cart-livetest01",
    getCartApi: () => bridge.api,
    getProductAliases: () => [],
    createSession,
    relayTool,
    endSession,
    connect,
    claimMic,
    releaseMic,
    now: () => now.value,
    schedule,
    idleTimeoutMs: 5_000,
    ...overrides,
  });
  return {
    core,
    bridge,
    timers,
    runTimers,
    now,
    connect,
    createSession,
    relayTool,
    endSession,
    claimMic,
    releaseMic,
    sendFunctionCallOutput,
    closeHandle,
    getHandlers: () => {
      if (!handlers) throw new Error("connect was not called");
      return handlers;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("start — ด่าน fail closed ก่อนเปิดเสียง", () => {
  it("claim ไมค์ไม่ได้ = งดจับทันที ไม่ยิง session (ADR-008 fail closed)", async () => {
    const harness = createHarness({ claimMic: () => false });
    await harness.core.start();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.connect).not.toHaveBeenCalled();
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("error");
    expect(entries[entries.length - 1].message).toContain("ปุ่มเสียงเดิมกำลังฟังอยู่");
  });

  it("bridge ไม่พร้อม = คืนไมค์และบอกผู้ใช้ ไม่เปิดเซสชัน", async () => {
    const harness = createHarness({ getCartApi: () => null });
    await harness.core.start();
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    expect(harness.createSession).not.toHaveBeenCalled();
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toContain("หน้าขายยังไม่พร้อม");
  });

  it("เซสชันถูกปฏิเสธ = คืนไมค์ กลับ idle และโชว์ข้อความของ server (manualPath ชนะ)", async () => {
    const harness = createHarness({
      createSession: async () => ({ ok: false, reason: "live_pilot_only", manualPath: "โหมดเสียงสดเปิดให้เฉพาะร้านที่เข้าร่วมทดลอง" }),
    });
    await harness.core.start();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("โหมดเสียงสดเปิดให้เฉพาะร้านที่เข้าร่วมทดลอง");
  });

  it("createSession โยน (เครือข่ายล่ม) = network_error แบบ fail closed ไม่ throw ออกนอก core", async () => {
    const harness = createHarness({ createSession: async () => { throw new Error("down"); } });
    await expect(harness.core.start()).resolves.toBeUndefined();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toContain("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  });

  it("เปิดช่องเสียงไม่สำเร็จ (getUserMedia ล้ม) = คืนไมค์ + ปิดเซสชันบน server แบบ best-effort", async () => {
    const harness = createHarness({ connect: async () => { throw new Error("mic denied"); } });
    await harness.core.start();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    expect(harness.endSession).toHaveBeenCalledWith({ sessionId: "sess-live0001", sessionToken: "tok-live0001" });
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toContain("ตรวจสิทธิ์ไมโครโฟน");
  });
});

describe("start — เส้นทางปกติและสถานะสด", () => {
  it("เปิดสำเร็จ: ส่ง activeCartId ให้ session route, ต่อเสียงด้วย ephemeral token + model จาก server", async () => {
    const harness = createHarness();
    await harness.core.start();
    expect(harness.createSession).toHaveBeenCalledWith({ activeCartId: "cart-livetest01" });
    expect(harness.connect).toHaveBeenCalledTimes(1);
    const connectOptions = harness.connect.mock.calls[0][0];
    expect(connectOptions.ephemeralToken).toBe("ek-test-token-0001");
    expect(connectOptions.model).toBe("gpt-realtime-2.1-mini");
    const state = harness.core.getState();
    // phase เป็น active แล้วตั้งแต่ start จบ — แต่ status ยัง null จนกว่า data channel จะเปิด (onOpen)
    expect(state.phase).toBe("active");
    expect(state.status).toBeNull();
    expect(state.toolCallsCap).toBe(40);
    // ตั้ง expiry timer ตามเวลาหมดอายุของ server (900 วินาทีจาก now)
    expect(harness.timers.filter((timer) => !timer.cancelled && timer.ms === 900_000)).toHaveLength(1);
  });

  it("start ซ้ำระหว่างเชื่อมต่อ/ใช้งาน = ไม่สร้างเซสชันซ้ำ", async () => {
    const harness = createHarness();
    await harness.core.start();
    await harness.core.start();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it("onOpen → ฟังอยู่; function call → กำลังทำ; ส่ง output แล้ว → พูดยืนยัน; จบ response → กลับไปฟัง", async () => {
    const harness = createHarness();
    // คุมจังหวะ relay ด้วย deferred — สถานะแต่ละช่วงต้องอ่านได้ชัดเจนไม่แข่งกับ microtask
    let releaseRelay: (value: LiveToolRelayResponse) => void = () => undefined;
    harness.relayTool.mockImplementation(
      () => new Promise<LiveToolRelayResponse>((resolve) => {
        releaseRelay = resolve;
      }),
    );
    await harness.core.start();
    const handlers = harness.getHandlers();
    handlers.onOpen();
    expect(harness.core.getState().status).toBe("listening");
    handlers.onFunctionCall({ callId: "call_status001", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.core.getState().status).toBe("working"));
    releaseRelay(relayOk(ADD_APPLY_RESULT, { used: 1, cap: 40 }));
    await vi.waitFor(() => expect(harness.core.getState().status).toBe("speaking"));
    handlers.onAssistantResponseDone();
    expect(harness.core.getState().status).toBe("listening");
    handlers.onUserSpeechStarted();
    expect(harness.core.getState().status).toBe("listening");
  });

  it("นับ toolCallsUsed จาก response ฝั่งสำเร็จเท่านั้น", async () => {
    const harness = createHarness();
    await harness.core.start();
    const handlers = harness.getHandlers();
    handlers.onFunctionCall({ callId: "call_count001", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.core.getState().toolCallsUsed).toBe(3));
    // relay ล้มเหลว (ไม่มี field นับ) = ตัวเลขเดิมคงอยู่
    harness.relayTool.mockResolvedValueOnce({ ok: false, reason: "rate_limited" });
    handlers.onFunctionCall({ callId: "call_count002", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(2));
    expect(harness.core.getState().toolCallsUsed).toBe(3);
  });
});

describe("function call → relay → ตะกร้า", () => {
  it("apply สำเร็จ: relay ด้วย idempotencyKey/cartVersion/summary ที่ถูกต้อง แล้ว commit ตะกร้าผ่าน bridge เดิม", async () => {
    const harness = createHarness();
    const relayBodies: LiveToolRequestBody[] = [];
    harness.relayTool.mockImplementation(async (body) => {
      relayBodies.push(body);
      return relayOk(ADD_APPLY_RESULT, { used: 1, cap: 40 });
    });
    await harness.core.start();
    harness.getHandlers().onOpen();
    harness.getHandlers().onFunctionCall({
      callId: "call_apply001",
      tool: "pos_add_item",
      argsText: '{"productPhrase":"ลาเต้","quantity":2}',
    });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    const body = relayBodies[0];
    expect(body.sessionId).toBe("sess-live0001");
    expect(body.sessionToken).toBe("tok-live0001");
    expect(body.callId).toBe("call_apply001");
    expect(body.tool).toBe("pos.add_item");
    expect(body.args).toEqual({ productPhrase: "ลาเต้", quantity: 2 });
    expect(body.idempotencyKey).toBe(createLiveIdempotencyKey("call_apply001"));
    expect(body.cartVersion).toBe(0);
    expect(body.summary).toEqual({ itemCount: 0, total: 0, locked: false });
    // ผลที่อนุมัติผลักเข้าตะกร้าจริง + applied กลับไปให้ model
    expect(harness.bridge.commits).toHaveLength(1);
    expect(harness.bridge.cart.items).toHaveLength(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("assistant");
    expect(entries[entries.length - 1].message).toContain("ลาเต้");
    const output = JSON.parse(String(harness.sendFunctionCallOutput.mock.calls[0][1]));
    expect(output.applied).toBe(true);
    expect(output.status).toBe("apply");
    // คำสั่งถัดไปได้ cartVersion ที่ไต่ขึ้น (server ห้าม version ย้อนหลัง)
    harness.getHandlers().onFunctionCall({ callId: "call_apply002", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(relayBodies.length).toBe(2));
    expect(relayBodies[1].cartVersion).toBe(1);
    expect(relayBodies[1].summary?.itemCount).toBe(1);
  });

  it("denial จาก dispatcher (ok:false code) = ข้อความไทยกลาง + ส่ง typed failure กลับให้ model", async () => {
    const harness = createHarness();
    harness.relayTool.mockResolvedValueOnce({
      ok: true,
      callId: "call_denied01",
      tool: "pos.add_item",
      outcome: { ok: false, code: "MUTATIONS_DISABLED" },
    });
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_denied01", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("error");
    expect(entries[entries.length - 1].message).toContain("ยังปิดในรอบนี้");
    expect(harness.bridge.commits).toHaveLength(0);
    const [outCallId, outJson] = harness.sendFunctionCallOutput.mock.calls[0];
    expect(outCallId).toBe("call_denied01");
    expect(JSON.parse(String(outJson))).toEqual({ ok: false, code: "MUTATIONS_DISABLED" });
    // เซสชันยังเปิดอยู่ — denial ของ tool ไม่ใช่เหตุปิดโหมด
    expect(harness.core.getState().phase).toBe("active");
  });

  it("clarification (ambiguous) = บอกผู้ใช้เลือก ไม่แตะตะกร้า และส่งผลดิบกลับให้ model", async () => {
    const harness = createHarness();
    harness.relayTool.mockResolvedValueOnce({
      ok: true,
      callId: "call_ambig001",
      tool: "pos.search_product",
      outcome: { ok: true, data: { status: "ambiguous", candidates: [{ id: "p-1", name: "ชาเย็น" }, { id: "p-2", name: "ชาดำ" }] } },
    });
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_ambig001", tool: "pos_search_product", argsText: '{"query":"ชา"}' });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toContain("หลายรายการตรงกัน");
    expect(harness.bridge.commits).toHaveLength(0);
    const [, ambiguousJson] = harness.sendFunctionCallOutput.mock.calls[0];
    expect(JSON.parse(String(ambiguousJson))).toEqual({
      status: "ambiguous",
      candidates: [{ id: "p-1", name: "ชาเย็น" }, { id: "p-2", name: "ชาดำ" }],
    });
  });

  it("relay failure แบบ typed = ข้อความไทยตาม reason + ส่ง reason เดิมกลับให้ model + เซสชันยังเปิด", async () => {
    const harness = createHarness();
    harness.relayTool.mockResolvedValueOnce({ ok: false, reason: "live_tool_not_allowed" });
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_notallow", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("คำสั่งนี้ยังไม่เปิดใช้ในโหมดเสียงสด");
    const [notAllowCallId, notAllowJson] = harness.sendFunctionCallOutput.mock.calls[0];
    expect(notAllowCallId).toBe("call_notallow");
    expect(JSON.parse(String(notAllowJson))).toEqual({ ok: false, reason: "live_tool_not_allowed" });
    expect(harness.endSession).not.toHaveBeenCalled();
  });

  it("ชื่อ tool ที่ model ส่งมาต้องแปลงกลับเป็นชื่อจริงก่อน relay — ชื่อไม่รู้จัก/มีจุด = ไม่ relay", async () => {
    const harness = createHarness();
    harness.relayTool.mockResolvedValue(relayOk(ADD_APPLY_RESULT));
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_unknown1", tool: "pos_clear_search", argsText: "" });
    harness.getHandlers().onFunctionCall({ callId: "call_dotname1", tool: "pos.add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(2));
    expect(harness.relayTool).not.toHaveBeenCalled();
    for (const [, json] of harness.sendFunctionCallOutput.mock.calls) {
      expect(JSON.parse(String(json))).toEqual({ ok: false, reason: "unknown_tool" });
    }
    harness.getHandlers().onFunctionCall({ callId: "call_wirename", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.relayTool).toHaveBeenCalledTimes(1));
    expect(harness.relayTool.mock.calls[0][0].tool).toBe("pos.add_item");
  });

  it("relayTool โยน (เครือข่ายล่มกลางบทสนทนา) = network_error ทั้งข้อความและ output", async () => {
    const harness = createHarness();
    harness.relayTool.mockRejectedValueOnce(new Error("down"));
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_netfail", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("ส่งคำสั่งไม่สำเร็จ — พูดใหม่อีกครั้ง");
    const [, netFailJson] = harness.sendFunctionCallOutput.mock.calls[0];
    expect(JSON.parse(String(netFailJson))).toEqual({ ok: false, reason: "network_error" });
  });

  it("args ที่ไม่ใช่ JSON = ส่ง invalid_args กลับให้ model พูดแก้ตัว ไม่เดิน relay", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_badargs", tool: "pos_add_item", argsText: "{not json" });
    await vi.waitFor(() => expect(harness.sendFunctionCallOutput).toHaveBeenCalledTimes(1));
    expect(harness.relayTool).not.toHaveBeenCalled();
    const [, badArgsJson] = harness.sendFunctionCallOutput.mock.calls[0];
    expect(JSON.parse(String(badArgsJson))).toEqual({ ok: false, reason: "invalid_args" });
  });

  it("callId ซ้ำจาก provider = relay ครั้งเดียว (กันคำสั่งซ้ำสองรอบ)", async () => {
    const harness = createHarness();
    await harness.core.start();
    const handlers = harness.getHandlers();
    handlers.onFunctionCall({ callId: "call_dup0001", tool: "pos_add_item", argsText: "" });
    handlers.onFunctionCall({ callId: "call_dup0001", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.relayTool).toHaveBeenCalledTimes(1));
  });

  it("call หลังจบเซสชัน = เมิน (ไม่ relay ไม่ส่ง output)", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.core.stop("user");
    harness.getHandlers().onFunctionCall({ callId: "call_afterend", tool: "pos_add_item", argsText: "" });
    await flushAsync();
    expect(harness.relayTool).not.toHaveBeenCalled();
    expect(harness.sendFunctionCallOutput).not.toHaveBeenCalled();
  });
});

describe("หมด cap — ปิดเซสชันทันที", () => {
  it("relay ตอบ live_tool_cap_reached = stop(cap) คืนไมค์ ปิดเซสชัน และไม่ส่ง output เพิ่ม", async () => {
    const harness = createHarness();
    harness.relayTool.mockResolvedValueOnce({ ok: false, reason: "live_tool_cap_reached" });
    await harness.core.start();
    harness.getHandlers().onFunctionCall({ callId: "call_cap0001", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(harness.core.getState().phase).toBe("idle"));
    expect(harness.closeHandle).toHaveBeenCalledTimes(1);
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    expect(harness.endSession).toHaveBeenCalledTimes(1);
    expect(harness.sendFunctionCallOutput).not.toHaveBeenCalled();
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("assistant");
    expect(entries[entries.length - 1].message).toBe("ใช้จำนวนคำสั่งของเซสชันครบแล้ว — ปิดโหมดเสียงสด");
  });
});

describe("จบเซสชันทุกทาง — ปิดไมค์ทุกท่อน (ADR-008)", () => {
  it("แตะซ้ำ (stop user) = ปิด handle + คืนไมค์ + DELETE เซสชัน + ข้อความธรรมดา และเรียกซ้ำไม่ทำอะไรเพิ่ม", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.core.stop("user");
    expect(harness.closeHandle).toHaveBeenCalledTimes(1);
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    expect(harness.endSession).toHaveBeenCalledTimes(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("assistant");
    expect(entries[entries.length - 1].message).toBe("ปิดโหมดเสียงสดแล้ว");
    harness.core.stop("user");
    expect(harness.endSession).toHaveBeenCalledTimes(1);
  });

  it("idle timeout = ปิดเองด้วยข้อความไม่มีเสียงสนทนา และ status ใหม่เริ่มนับใหม่ (timer เก่าถูกยกเลิก)", async () => {
    const harness = createHarness();
    await harness.core.start();
    const handlers = harness.getHandlers();
    handlers.onOpen();
    const idleTimers = () => harness.timers.filter((timer) => timer.ms === 5_000);
    expect(idleTimers().filter((timer) => !timer.cancelled)).toHaveLength(1);
    // เริ่มฟังใหม่อีกจังหวะ = นาฬิกา idle เริ่มนับใหม่ (ตัวเก่าถูกยกเลิก)
    handlers.onUserSpeechStarted();
    expect(idleTimers().filter((timer) => !timer.cancelled)).toHaveLength(1);
    harness.runTimers(5_000);
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("ไม่มีการสนทนาสักพัก — ปิดโหมดเสียงสดให้อัตโนมัติ");
  });

  it("หมดเวลาเซสชันของ server (expiry) = ปิดฝั่งนี้ให้ตรงจังหวะ", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.runTimers(900_000);
    expect(harness.core.getState().phase).toBe("idle");
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("หมดเวลาของเซสชันเสียงสด — เปิดใหม่ได้เสมอ");
  });

  it("error จาก provider = ปิดด้วยข้อความไทย fail closed (ไม่โชว์ข้อความดิบ) ระดับ error", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.getHandlers().onError("raw provider message ห้ามโชว์");
    expect(harness.core.getState().phase).toBe("idle");
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].level).toBe("error");
    expect(entries[entries.length - 1].message).toBe("การเชื่อมต่อเสียงมีปัญหา — ลองเปิดโหมดเสียงสดใหม่อีกครั้ง");
    expect(JSON.stringify(entries)).not.toContain("raw provider message");
  });

  it("การเชื่อมต่อหลุด (onClosed ระหว่าง active) = ปิดเซสชัน ไม่ทิ้งไมค์ค้าง", async () => {
    const harness = createHarness();
    await harness.core.start();
    harness.getHandlers().onClosed();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.closeHandle).toHaveBeenCalledTimes(1);
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    const entries = harness.core.getState().entries;
    expect(entries[entries.length - 1].message).toBe("การเชื่อมต่อเสียงหลุด — เปิดโหมดเสียงสดใหม่ได้เลย");
  });

  it("close ของ handle โยน = กลืนไว้ ยังคืนไมค์และปิดเซสชันครบ", async () => {
    const harness = createHarness({ });
    harness.closeHandle.mockImplementation(() => { throw new Error("already closed"); });
    await harness.core.start();
    harness.core.stop("user");
    expect(harness.releaseMic).toHaveBeenCalledTimes(1);
    expect(harness.endSession).toHaveBeenCalledTimes(1);
    expect(harness.core.getState().phase).toBe("idle");
  });
});

describe("createLiveIdempotencyKey — ต้องผ่านรูปแบบ [A-Za-z0-9_-]{8,64} ของ route", () => {
  it("รู้จัก callId ของ provider และล้างอักขระแปลกปลอม", () => {
    expect(createLiveIdempotencyKey("call_ABzDSbLENKV0tdW6")).toBe("live-call_ABzDSbLENKV0tdW6");
    const cleaned = createLiveIdempotencyKey("call/ทดสอบ!#");
    expect(cleaned).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(cleaned.startsWith("live-call")).toBe(true);
  });

  it("สั้นเกิน 8 = pad ต่อท้าย ยาวเกิน 64 = ตัด", () => {
    expect(createLiveIdempotencyKey("ab")).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(createLiveIdempotencyKey("a".repeat(100))).toHaveLength(64);
    expect(createLiveIdempotencyKey("a".repeat(100))).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("การจัดคิวคำสั่ง — apply ตะกร้าต้องเดินทีละคำสั่ง", () => {
  it("call เข้าพร้อมกัน 2 คำสั่ง = relay ตามลำดับที่รับ ไม่สลับ", async () => {
    const harness = createHarness();
    const order: string[] = [];
    harness.relayTool.mockImplementation(async (body) => {
      order.push(body.callId);
      return relayOk(ADD_APPLY_RESULT, { used: order.length, cap: 40 });
    });
    await harness.core.start();
    const handlers = harness.getHandlers();
    handlers.onFunctionCall({ callId: "call_seq0001", tool: "pos_add_item", argsText: "" });
    handlers.onFunctionCall({ callId: "call_seq0002", tool: "pos_add_item", argsText: "" });
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual(["call_seq0001", "call_seq0002"]);
  });
});

describe("ADR-008 กับสมุดจดไมค์จริง (mic-ownership ตัวเดียวกับปุ่มเสียงเดิม)", () => {
  it("voice-pos ถือไมค์อยู่ = เริ่มไม่ได้; ว่าง = claim เป็น ai-live; จบ = คืน", async () => {
    vi.resetModules();
    const { createLiveAssistantCore: createFresh } = await import("@/modules/ai-assistant/ui/live-assistant-core");
    const mic = await import("@/modules/voice-pos/mic-ownership");
    // ไม่ฉีด claimMic/releaseMic — ให้ core ใช้สมุดจดไมค์จริงของโมดูล (ค่า default)
    const harness = createHarness({ claimMic: undefined, releaseMic: undefined }, createFresh);
    expect(mic.claimMicOwnership("voice-pos")).toBe(true);
    await harness.core.start();
    expect(harness.core.getState().phase).toBe("idle");
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(mic.readMicOwnership()).toBe("voice-pos");
    mic.releaseMicOwnership("voice-pos");
    await harness.core.start();
    expect(mic.readMicOwnership()).toBe("ai-live");
    expect(harness.core.getState().phase).not.toBe("idle");
    harness.core.stop("user");
    expect(mic.readMicOwnership()).toBeNull();
  });
});

// PR3-Live (diagnostics) — timeline ต้องอ่านแล้วบอกได้ว่าพังตรงไหน โดยไม่มี transcript/เสียง/args
describe("telemetry ของ core", () => {
  function telemetrySpy() {
    const events: { event: string; stage: string; result: string; reason?: string; sessionId?: string; metadata?: Record<string, unknown> }[] = [];
    return {
      events,
      telemetry: {
        emit: (event: Parameters<NonNullable<LiveAssistantCoreDeps["telemetry"]>["emit"]>[0]) => events.push(event),
        flush: () => {},
        recent: () => [],
      },
      names: () => events.map((event) => event.event),
    };
  }

  it("เส้นทางปกติ: ขอเปิด → ได้ไมค์ → สร้างเซสชัน → ลงตะกร้าสำเร็จ → ปิดเอง", async () => {
    const spy = telemetrySpy();
    const harness = createHarness({ telemetry: spy.telemetry });

    await harness.core.start();
    harness.getHandlers().onOpen();
    harness.getHandlers().onFunctionCall({ callId: "call_test0001", tool: "pos_add_item", argsText: "{}" });
    await flushAsync();
    harness.core.stop("user");

    expect(spy.names()).toEqual(expect.arrayContaining([
      "live.requested",
      "mic.claim_started",
      "mic.claimed",
      "live.session_create_started",
      "live.access_granted",
      "live.session_created",
      "cart.apply_started",
      "cart.apply_succeeded",
      "live.stop_requested",
      "mic.released",
      "live.stopped",
    ]));
    // event ของเซสชันต้องผูก sessionId ให้ timeline ต่อกันได้
    expect(spy.events.find((event) => event.event === "cart.apply_succeeded")?.sessionId).toBe("sess-live0001");
    // ห้ามมีข้อความผู้ใช้/args หลุดเข้า metadata
    const payload = JSON.stringify(spy.events);
    expect(payload).not.toContain("ลาเต้");
    expect(payload).not.toContain("tok-live0001");
  });

  it("ตะกร้าถูกล็อก = cart.apply_failed พร้อมเหตุผล (server รู้แค่ว่า tool ผ่าน)", async () => {
    const spy = telemetrySpy();
    const harness = createHarness({ telemetry: spy.telemetry });
    harness.bridge.setLocked(true);

    await harness.core.start();
    harness.getHandlers().onOpen();
    harness.getHandlers().onFunctionCall({ callId: "call_test0002", tool: "pos_add_item", argsText: "{}" });
    await flushAsync();

    const failed = spy.events.find((event) => event.event === "cart.apply_failed");
    expect(failed).toBeDefined();
    expect(failed?.reason).toBe("cart_locked");
  });

  it("หน้าขายไม่พร้อม = บอกได้ว่าไมค์ถูกคืนเพราะอะไร ไม่ใช่เงียบหาย", async () => {
    const spy = telemetrySpy();
    const harness = createHarness({ telemetry: spy.telemetry, getCartApi: () => null });

    await harness.core.start();

    expect(spy.names()).toEqual([
      "live.requested",
      "mic.claim_started",
      "mic.claimed",
      "mic.released",
      "live.session_create_failed",
    ]);
    expect(spy.events[3].reason).toBe("cart_api_missing");
  });

  it("แย่งไมค์ไม่ได้ = mic.claim_failed reason=voice_pos_busy", async () => {
    const spy = telemetrySpy();
    const harness = createHarness({ telemetry: spy.telemetry, claimMic: () => false });

    await harness.core.start();

    expect(spy.names()).toEqual(["live.requested", "mic.claim_started", "mic.claim_failed"]);
    expect(spy.events[2].reason).toBe("voice_pos_busy");
  });

  it("ด่านฝั่ง server ปฏิเสธ = live.access_denied พร้อม reason ของด่านนั้น", async () => {
    const spy = telemetrySpy();
    const harness = createHarness({
      telemetry: spy.telemetry,
      createSession: async () => ({ ok: false as const, reason: "live_pilot_only" }),
    });

    await harness.core.start();

    const denied = spy.events.find((event) => event.event === "live.access_denied");
    expect(denied?.reason).toBe("live_pilot_only");
    expect(spy.names()).toContain("mic.released");
  });

  it("จบทุกทางมีเหตุผล normalize เดียวกัน (idle/expired/cap/network)", async () => {
    for (const scenario of ["idle", "expired", "network"] as const) {
      const spy = telemetrySpy();
      const harness = createHarness({ telemetry: spy.telemetry });
      await harness.core.start();
      harness.getHandlers().onOpen();

      if (scenario === "idle") harness.runTimers(5_000);
      if (scenario === "expired") harness.runTimers(900_000);
      if (scenario === "network") harness.getHandlers().onClosed();

      const stopped = spy.events.find((event) => event.event === "live.stopped");
      expect(stopped?.reason, scenario).toBe(scenario);
      expect(stopped?.metadata?.toolCallsUsed, scenario).toBe(0);
    }
  });
});

// M1 — สั่งงานจริง: หลายเมนูในประโยคเดียว แล้ว "กดปุ่มคิดเงิน" ให้พนักงาน
describe("สั่งงานหลายรายการ + เปิดหน้าจอรับชำระ", () => {
  function batchRelay(): LiveToolRelayResponse {
    return {
      ok: true,
      callId: "call_batch0001",
      tool: "pos.add_items",
      outcome: {
        ok: true,
        data: {
          status: "apply_batch",
          items: [
            { intent: { type: "pos.add_item", productPhrase: "ลาเต้", quantity: 2 }, productName: "ลาเต้" },
            { intent: { type: "pos.add_item", productPhrase: "ชาเขียว", quantity: 1 }, productName: "ชาเขียว" },
          ],
        },
      },
      toolCallsUsed: 1,
      toolCallsCap: 40,
    };
  }

  it("หนึ่ง tool call = ใส่ตะกร้าครบทุกรายการตามลำดับ และ cartVersion ไต่ตามจำนวนที่ใส่จริง", async () => {
    const relayTool = vi.fn(async () => batchRelay());
    const harness = createHarness({ relayTool });
    await harness.core.start();
    harness.getHandlers().onOpen();

    harness.getHandlers().onFunctionCall({ callId: "call_batch0001", tool: "pos_add_items", argsText: "{}" });
    await flushAsync();

    expect(harness.bridge.commits).toHaveLength(2);
    expect(harness.bridge.cart.items.map((item) => item.productName)).toEqual(["ลาเต้", "ชาเขียว"]);
    expect(harness.bridge.cart.items.map((item) => item.quantity)).toEqual([2, 1]);
    // relay ครั้งเดียวเท่านั้น (นี่คือเหตุผลของ pos.add_items)
    expect(relayTool).toHaveBeenCalledTimes(1);
  });

  it("open_checkout = ยิงคำสั่งเปิดแผงรับชำระของ POS ไม่แตะตะกร้าและไม่มีการจ่ายเงิน", async () => {
    const commands: string[] = [];
    const listener = (event: Event) => commands.push(String((event as CustomEvent).detail));
    const target = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: (event: Event) => { listener(event); return true; } };
    vi.stubGlobal("window", target);
    vi.stubGlobal("CustomEvent", class { detail: unknown; type: string; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } } as never);
    try {
      const harness = createHarness({
        relayTool: vi.fn(async () => ({
          ok: true as const,
          callId: "call_checkout01",
          tool: "pos.open_checkout",
          outcome: { ok: true as const, data: { status: "client_action", action: "open_checkout", announcement: "เปิดหน้าจอรับชำระให้แล้ว" } },
        })),
      });
      await harness.core.start();
      harness.getHandlers().onOpen();

      harness.getHandlers().onFunctionCall({ callId: "call_checkout01", tool: "pos_open_checkout", argsText: "{}" });
      await flushAsync();

      expect(commands).toEqual(["open-checkout"]);
      expect(harness.bridge.commits).toHaveLength(0);
      const entries = harness.core.getState().entries;
      expect(entries[entries.length - 1].message).toContain("เปิดหน้าจอรับชำระ");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
