import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPollCycle, isAllowedNetworkPrinterHost, decodePrintJobBase64, normalizeComPort } from "../../scripts/print-hub.mjs";

const config = { serverUrl: "https://hub.example", storeId: "store-1", hubToken: "secret" };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("print hub agent — runPollCycle", () => {
  it("prints each claimed job and acks success", async () => {
    const job = { id: "job-1", host: "192.168.1.50", port: 9100, printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] })) // poll
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // ack
    const printJob = vi.fn().mockResolvedValue(undefined);

    const result = await runPollCycle({ config, fetchImpl, printJob });

    expect(result).toEqual({ ok: true, processed: 1 });
    expect(printJob).toHaveBeenCalledWith({ kind: "ip", host: "192.168.1.50", port: 9100 }, expect.any(Buffer));
    const ackBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(ackBody).toMatchObject({ jobId: "job-1", ok: true, storeId: "store-1" });
  });

  it("prints a Bluetooth job to the cashier-PC COM port and acks success", async () => {
    const job = { id: "job-bt", kind: "bt", device: "com5", printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn().mockResolvedValue(undefined);

    const result = await runPollCycle({ config, fetchImpl, printJob });

    expect(result).toEqual({ ok: true, processed: 1 });
    expect(printJob).toHaveBeenCalledWith({ kind: "bt", device: "COM5" }, expect.any(Buffer));
    const ackBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(ackBody).toMatchObject({ jobId: "job-bt", ok: true });
  });

  it("rejects a Bluetooth job with an invalid COM port without printing", async () => {
    const job = { id: "job-bt2", kind: "bt", device: "COM5; rm -rf", printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn();

    await runPollCycle({ config, fetchImpl, printJob });

    expect(printJob).not.toHaveBeenCalled();
    const ackBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(ackBody.ok).toBe(false);
    expect(ackBody.error).toContain("COM port");
  });

  it("acks failure when the printer is unreachable", async () => {
    const job = { id: "job-2", host: "192.168.1.50", port: 9100, printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn().mockRejectedValue(new Error("Connection timed out"));

    const result = await runPollCycle({ config, fetchImpl, printJob });

    expect(result.processed).toBe(1);
    const ackBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(ackBody.ok).toBe(false);
    expect(ackBody.error).toContain("timed out");
  });

  it("rejects a job targeting a non-LAN host without printing", async () => {
    const job = { id: "job-3", host: "8.8.8.8", port: 9100, printJobBase64: Buffer.from("x").toString("base64") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [job] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const printJob = vi.fn();

    await runPollCycle({ config, fetchImpl, printJob });

    expect(printJob).not.toHaveBeenCalled();
    const ackBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(ackBody.ok).toBe(false);
    expect(ackBody.error).toContain("disallowed");
  });

  it("signals auth failure on 401 and does not print", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { error: "Invalid Hub credentials" }));
    const printJob = vi.fn();

    const result = await runPollCycle({ config, fetchImpl, printJob });

    expect(result).toEqual({ ok: false, authFailed: true, processed: 0 });
    expect(printJob).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, jobs: [] }));
    const printJob = vi.fn();

    const result = await runPollCycle({ config, fetchImpl, printJob });

    expect(result).toEqual({ ok: true, processed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("print hub agent — guards", () => {
  it("validates LAN hosts", () => {
    expect(isAllowedNetworkPrinterHost("192.168.1.50")).toBe(true);
    expect(isAllowedNetworkPrinterHost("127.0.0.1")).toBe(false);
    expect(isAllowedNetworkPrinterHost("8.8.8.8")).toBe(false);
  });

  it("decodes valid base64 and rejects junk", () => {
    expect(decodePrintJobBase64(Buffer.from("hi").toString("base64")).length).toBe(2);
    expect(() => decodePrintJobBase64("not base64!!")).toThrow();
  });

  it("normalizes valid Bluetooth COM ports and rejects unsafe ones", () => {
    expect(normalizeComPort(" com5 ")).toBe("COM5");
    expect(normalizeComPort("COM128")).toBe("COM128");
    expect(normalizeComPort("COM0")).toBeNull();
    expect(normalizeComPort("LPT1")).toBeNull();
    expect(normalizeComPort("COM5; rm -rf")).toBeNull();
    expect(normalizeComPort("")).toBeNull();
  });
});

describe("print hub agent — packaging", () => {
  it("is wired as an npm script and exists on disk", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["print:hub"]).toBe("node scripts/print-hub.mjs");
    expect(existsSync(join(root, "scripts", "print-hub.mjs"))).toBe(true);
  });
});
