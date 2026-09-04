import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_VERSION,
  PROTOCOL_VERSION,
  buildHealthSnapshot,
  createHubRuntimeState,
  evaluateLock,
  hubStateDir,
  isProcessAlive,
  runPollCycle,
  writeJsonAtomic,
} from "../../scripts/print-hub.mjs";
import { checkAgentProtocol, PRINT_HUB_MIN_PROTOCOL_VERSION } from "@/modules/printing/print-hub";

// v3 Task 7 — Hub ตัวเดียวต่อเครื่อง + health ที่ Launcher อ่านได้ + protocol handshake
//
// เครื่องแคชเชียร์เปิด Hub ได้สองทาง (Scheduled Task และ Launcher) ถ้าเปิดซ้อนกันจะมี
// agent สองตัวสแกน/พิมพ์พร้อมกัน — ฝั่งเซิร์ฟเวอร์กันการเคลมซ้ำไว้แล้ว แต่ฝั่งเครื่อง
// ต้องมีล็อกด้วย. health.json ต้องไม่มีความลับ เพราะเป็นไฟล์ที่โปรแกรมอื่นอ่านได้

const config = { serverUrl: "https://hub.example", storeId: "store-1", hubToken: "secret" };
const noDevices = async () => [];

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("evaluateLock — ตัวเดียวต่อเครื่อง", () => {
  const now = Date.now();
  const lockOf = (pid: number, ageMs = 0) =>
    JSON.stringify({ pid, startedAt: new Date(now - ageMs).toISOString(), updatedAt: new Date(now - ageMs).toISOString() });

  it("ไม่มีไฟล์ล็อก = เริ่มได้", () => {
    expect(evaluateLock(null, { now })).toMatchObject({ canStart: true, reason: "no_lock" });
  });

  it("โปรเซสเดิมยังอยู่และ heartbeat สด = ห้ามเปิดซ้อน", () => {
    const verdict = evaluateLock(lockOf(4242), { now, isAlive: () => true, pid: 1 });
    expect(verdict).toMatchObject({ canStart: false, reason: "already_running", holderPid: 4242 });
  });

  it("ล็อกค้างจากเครื่องดับ (โปรเซสตายแล้ว) = ยึดต่อได้", () => {
    expect(evaluateLock(lockOf(999999), { now, isAlive: () => false, pid: 1 })).toMatchObject({
      canStart: true,
      reason: "stale_lock",
    });
  });

  it("โปรเซสยังอยู่แต่ heartbeat ค้างนาน = ถือว่าค้าง ยึดต่อได้", () => {
    const verdict = evaluateLock(lockOf(4242, 10 * 60_000), { now, isAlive: () => true, pid: 1 });
    expect(verdict).toMatchObject({ canStart: true, reason: "stale_heartbeat" });
  });

  it("ไฟล์ล็อกเสีย/ไม่มี pid = ไม่บล็อกตัวเอง", () => {
    expect(evaluateLock("{not json", { now })).toMatchObject({ canStart: true, reason: "corrupt_lock" });
    expect(evaluateLock(JSON.stringify({ pid: "x" }), { now })).toMatchObject({ canStart: true });
  });

  it("ล็อกของตัวเอง (restart ในโปรเซสเดิม) ไม่บล็อก", () => {
    expect(evaluateLock(lockOf(process.pid), { now, isAlive: () => true })).toMatchObject({ reason: "own_lock" });
  });

  it("isProcessAlive: pid ที่ไม่ถูกต้องคือไม่มีชีวิต, EPERM ถือว่ายังอยู่", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-3)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
    const permDenied = vi.fn(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(isProcessAlive(1234, permDenied as unknown as typeof process.kill)).toBe(true);
  });
});

describe("health snapshot — ไม่มีความลับในไฟล์ที่โปรแกรมอื่นอ่านได้", () => {
  it("เก็บเฉพาะฟิลด์ที่ปลอดภัยและมีเวอร์ชัน/สถานะครบ", () => {
    const snapshot = buildHealthSnapshot({
      pid: 111,
      state: "ready",
      startedAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:05.000Z",
      lastPollAt: "2026-09-04T00:00:05.000Z",
      storeId: "store-1",
      printersSeen: 2,
    });
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      state: "ready",
      printersSeen: 2,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hubToken");
    expect(serialized).not.toContain("secret");
    expect(Object.keys(snapshot)).not.toContain("payloadB64");
  });

  it("ฟิลด์ที่ไม่ได้ส่งมาเป็น null ไม่ใช่ undefined (ผู้อ่านไม่ต้องเดา)", () => {
    const snapshot = buildHealthSnapshot({ pid: 1, state: "starting", startedAt: "t", updatedAt: "t" });
    expect(snapshot.lastSuccessAt).toBeNull();
    expect(snapshot.lastErrorCode).toBeNull();
  });
});

describe("createHubRuntimeState — ล็อก + health บนดิสก์จริง", () => {
  it("ยึดล็อกแล้วเขียน health ที่อ่านกลับได้ และปล่อยล็อกตอนปิด", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-state-"));
    const runtime = createHubRuntimeState({ dir });

    expect(runtime.acquireLock().ok).toBe(true);
    runtime.update({ state: "ready", storeId: "store-1", lastPollAt: "2026-09-04T00:00:00.000Z" });

    const health = JSON.parse(readFileSync(runtime.healthPath, "utf8"));
    expect(health).toMatchObject({ state: "ready", storeId: "store-1", agentVersion: AGENT_VERSION });
    expect(existsSync(runtime.lockPath)).toBe(true);

    runtime.release();
    expect(existsSync(runtime.lockPath)).toBe(false);
  });

  it("โปรเซสที่สองบนเครื่องเดียวกันเปิดไม่ได้", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-state-"));
    writeFileSync(
      join(dir, "hub.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    );
    // จำลองว่าเจ้าของล็อกเป็นโปรเซสอื่นที่ยังมีชีวิต
    const runtime = createHubRuntimeState({ dir, pid: process.pid + 1, isAlive: () => true });
    expect(runtime.acquireLock()).toMatchObject({ ok: false, reason: "already_running" });
  });

  it("writeJsonAtomic ไม่ทิ้งไฟล์ครึ่ง ๆ (เขียน tmp แล้ว rename)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-state-"));
    const target = join(dir, "health.json");
    writeJsonAtomic(target, { a: 1 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("hubStateDir อยู่ใต้โฟลเดอร์ผู้ใช้ ไม่ใช่โฟลเดอร์โปรแกรม", () => {
    expect(hubStateDir({ ...process.env, LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" })).toContain(
      "StoreOSPrintHub",
    );
  });
});

describe("protocol handshake", () => {
  it("agent ส่ง protocolVersion ไปกับ poll", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [] }));
    await runPollCycle({ config, fetchImpl, printJob: vi.fn(), listDevices: noDevices });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("เซิร์ฟเวอร์ตอบ 426 = หยุดและบอกวิธีแก้ ไม่ retry เงียบ ๆ", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(426, { error: "Print Hub เวอร์ชันนี้เก่าเกินไป" }));
    const result = await runPollCycle({ config, fetchImpl, printJob: vi.fn(), listDevices: noDevices });
    expect(result).toMatchObject({ ok: false, outdated: true });
    expect(result.message).toContain("เก่าเกินไป");
  });

  it("ฝั่งเซิร์ฟเวอร์: agent เก่าที่ไม่ส่งเลข ยังผ่านในช่วง compatibility window", () => {
    expect(checkAgentProtocol(undefined)).toMatchObject({ version: 0, supported: true });
    expect(checkAgentProtocol(1)).toMatchObject({ version: 1, supported: true });
    expect(PRINT_HUB_MIN_PROTOCOL_VERSION).toBe(0);
  });

  it("ฝั่งเซิร์ฟเวอร์: ค่าที่ไม่ใช่จำนวนเต็มถูกตีเป็น legacy ไม่ใช่ error", () => {
    expect(checkAgentProtocol("abc")).toMatchObject({ version: 0, supported: true });
    expect(checkAgentProtocol(-1)).toMatchObject({ version: 0 });
  });
});
