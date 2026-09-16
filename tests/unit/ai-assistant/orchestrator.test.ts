import { describe, expect, it, vi } from "vitest";
import type { Result } from "@/modules/ai-assistant/foundation";
import { createTextInterpreter, runTextCommand, type TextCommandDeps, type TextIntentOutcome } from "@/modules/ai-assistant/orchestrator";
import type { AiVoiceCommand, AiVoiceIntentEnvelope } from "@/modules/voice-pos/ai-intent-schema";

// PR2 — orchestrator: deterministic ก่อนเสมอ, AI เฉพาะ no_match, และเดินคำสั่งผ่าน dispatcher เดิมทีละรายการ

const envelope = (commands: AiVoiceCommand[]): AiVoiceIntentEnvelope => ({ version: 1, outcome: "command_batch", commands, confidence: "high", reasonCode: "matched" });
const cmd = (overrides: Partial<AiVoiceCommand> = {}): AiVoiceCommand => ({ intent: "pos.add_item", productPhrase: "ลาเต้", quantity: 2, optionPhrases: [], ...overrides });

function setupInterpreter(options: { aiEnabled?: boolean; provider?: ReturnType<typeof vi.fn> } = {}) {
  const callProvider = options.provider ?? vi.fn(async () => ({ ok: false as const, reason: "ai_error" as const }));
  const interpret = createTextInterpreter({
    aiEnabled: () => options.aiEnabled ?? true,
    callProvider,
  });
  return { interpret, callProvider };
}

describe("text interpreter (deterministic → AI fallback)", () => {
  it("parses clear Thai add commands without calling the provider", async () => {
    const s = setupInterpreter();
    const outcome = await s.interpret("เพิ่มลาเต้สองแก้ว");
    expect(outcome).toMatchObject({ ok: true, source: "deterministic" });
    if (outcome.ok) {
      expect(outcome.commands[0]).toMatchObject({ intent: "pos.add_item", quantity: 2 });
      expect(outcome.commands[0].productPhrase).toContain("ลาเต้");
    }
    expect(s.callProvider).not.toHaveBeenCalled();
  });

  it("parses remove commands deterministically", async () => {
    const s = setupInterpreter();
    const outcome = await s.interpret("เอาลาเต้ออก");
    expect(outcome).toMatchObject({ ok: true, source: "deterministic" });
    if (outcome.ok) expect(outcome.commands[0]).toMatchObject({ intent: "pos.remove_item" });
    expect(s.callProvider).not.toHaveBeenCalled();
  });

  it("blocks forbidden content before any network call", async () => {
    const s = setupInterpreter();
    expect(await s.interpret("ชำระเงินให้หน่อย")).toEqual({ ok: false, reason: "forbidden" });
    expect(s.callProvider).not.toHaveBeenCalled();
  });

  it("falls back to the provider only on no_match and forwards its commands", async () => {
    const s = setupInterpreter({ provider: vi.fn(async () => ({ ok: true as const, envelope: envelope([cmd({ productPhrase: "ชาเขียวมะนาว", quantity: null })]) })) });
    const outcome = await s.interpret("ขอชาเขียวมะนาวหนึ่งแก้วครับ");
    expect(s.callProvider).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, source: "ai" });
  });

  it("applies the same denylist to what the AI proposes", async () => {
    const s = setupInterpreter({ provider: vi.fn(async () => ({ ok: true as const, envelope: envelope([cmd({ productPhrase: "ส่วนลด 50 บาท" })]) })) });
    expect(await s.interpret("บลาบลา")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("reports unavailable AI and quota states as typed failures", async () => {
    const disabled = setupInterpreter({ aiEnabled: false });
    expect(await disabled.interpret("อะไรก็ได้")).toEqual({ ok: false, reason: "ai_disabled" });
    const denied = setupInterpreter({ provider: vi.fn(async () => ({ ok: false as const, reason: "quota_denied" as const })) });
    expect(await denied.interpret("อะไรก็ได้")).toEqual({ ok: false, reason: "quota_denied" });
  });

  it("keeps deterministic quantity guards without wasting a provider call", async () => {
    const s = setupInterpreter();
    const outcome = await s.interpret("เพิ่มลาเต้ 500 แก้ว");
    expect(outcome).toMatchObject({ ok: true, source: "deterministic", commands: [] });
    expect(s.callProvider).not.toHaveBeenCalled();
  });
});

describe("text command runner", () => {
  const cart = { activeCartId: "cart-12345678", cartVersion: 7 };
  function setupDispatch() {
    const dispatch = vi.fn(async (request: { tool: string; args: unknown; idempotencyKey: string }): Promise<Result> => ({ ok: true, data: { tool: request.tool, idempotencyKey: request.idempotencyKey, args: request.args } }));
    return dispatch;
  }
  const deterministic = vi.fn(async () => ({ ok: true as const, source: "deterministic" as const, commands: [] as AiVoiceCommand[] }));
  const deps = (
    dispatch: ReturnType<typeof setupDispatch>,
    overrides: Partial<{ cart: typeof cart | null; requestId: string; interpret: TextCommandDeps["interpret"] }> = {},
  ): TextCommandDeps => ({
    interpret: overrides.interpret ?? deterministic,
    dispatch,
    cart: "cart" in overrides ? overrides.cart ?? null : cart,
    requestId: overrides.requestId ?? "req-12345678",
  });

  it("dispatches each command in order with per-command idempotency keys", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { interpret: vi.fn(async () => ({ ok: true as const, source: "ai" as const, commands: [cmd(), cmd({ intent: "pos.remove_item", quantity: null })] })) });
    const run = await runTextCommand("อะไรก็ได้", d);
    expect(run).toMatchObject({ ok: true });
    if (run.ok) {
      expect(run.outcomes).toHaveLength(2);
      expect(run.outcomes[0]).toMatchObject({ kind: "tool", ok: true, tool: "pos.add_item" });
      expect(run.outcomes[1]).toMatchObject({ kind: "tool", ok: true, tool: "pos.remove_item" });
    }
    expect(dispatch.mock.calls.map((call) => call[0].idempotencyKey)).toEqual(["req-12345678-0", "req-12345678-1"]);
    expect(dispatch.mock.calls[0][0].args).toMatchObject({ activeCartId: cart.activeCartId, cartVersion: 7, quantity: 2 });
  });

  it("clears search through the client bridge without dispatching", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { interpret: vi.fn(async (): Promise<TextIntentOutcome> => ({ ok: true, source: "deterministic", commands: [{ intent: "pos.clear_search", productPhrase: null, quantity: null, optionPhrases: [] }] })) });
    const run = await runTextCommand("ล้างค้นหา", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "client_action", action: "clear_search" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("marks navigation as unsupported for text mode", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { interpret: vi.fn(async (): Promise<TextIntentOutcome> => ({ ok: true, source: "ai", commands: [{ intent: "navigate", productPhrase: null, quantity: null, optionPhrases: [] }] })) });
    const run = await runTextCommand("เปิดหน้าโต๊ะ", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "skipped", ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when no cart binding was presented", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { cart: null, interpret: vi.fn(async () => ({ ok: true as const, source: "ai" as const, commands: [cmd()] })) });
    const run = await runTextCommand("อะไรก็ได้", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "error", ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks for a missing quantity instead of guessing one", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { interpret: vi.fn(async () => ({ ok: true as const, source: "ai" as const, commands: [cmd({ quantity: null })] })) });
    const run = await runTextCommand("อะไรก็ได้", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "clarification", ok: false, result: { status: "clarification", reason: "needs_quantity" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("defaults increase/decrease to one step like the voice contract", async () => {
    const dispatch = setupDispatch();
    const d = deps(dispatch, { interpret: vi.fn(async () => ({ ok: true as const, source: "ai" as const, commands: [cmd({ intent: "pos.increase_item", quantity: null })] })) });
    const run = await runTextCommand("อะไรก็ได้", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "tool", ok: true, tool: "pos.change_quantity" });
    expect(dispatch.mock.calls[0][0].args).toMatchObject({ mode: "increase", quantity: 1 });
  });

  it("surfaces dispatcher denial codes as typed error outcomes", async () => {
    const dispatch = vi.fn(async (): Promise<Result> => ({ ok: false, code: "MUTATIONS_DISABLED" }));
    const d = deps(dispatch, { interpret: vi.fn(async () => ({ ok: true as const, source: "deterministic" as const, commands: [cmd()] })) });
    const run = await runTextCommand("อะไรก็ได้", d);
    expect(run.ok && run.outcomes[0]).toMatchObject({ kind: "error", ok: false, code: "MUTATIONS_DISABLED", tool: "pos.add_item" });
  });
});
