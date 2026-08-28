import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPollCycle, isAllowedNetworkPrinterHost, decodePrintJobBase64, normalizeComPort, sendToComPort } from "../../scripts/print-hub.mjs";

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

describe("print hub agent — sendToComPort", () => {
  it("normalizes the port and hands the payload to the serial runner", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await sendToComPort(" com5 ", Buffer.from("x"), { runner, baud: 19200 });
    expect(runner).toHaveBeenCalledWith("COM5", expect.any(Buffer), 19200);
  });

  it("rejects an invalid COM port without invoking the runner", async () => {
    const runner = vi.fn();
    await expect(sendToComPort("LPT1", Buffer.from("x"), { runner })).rejects.toThrow(/COM port/);
    expect(runner).not.toHaveBeenCalled();
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

describe("print hub installer contract (Task 8/F2 source guards)", () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const installer = read("scripts/print-hub/install-windows.ps1");
  const uninstaller = read("scripts/print-hub/uninstall-windows.ps1");
  const cmd = read("scripts/print-hub/install.cmd");
  const agent = read("scripts/print-hub.mjs");
  const zipBuilder = read("scripts/build-print-hub-zip.mjs");

  it("registers the scheduled task as the CURRENT USER with RunLevel Limited (autostart without admin rights)", () => {
    expect(installer).toContain("New-ScheduledTaskPrincipal");
    expect(installer).toContain("-UserId $env:USERNAME");
    expect(installer).toContain("-RunLevel Limited");
    expect(installer).toContain("-AtLogOn");
  });

  it("runs a local health check after starting the task and reports the state honestly", () => {
    expect(installer).toContain("Get-ScheduledTaskInfo");
    expect(installer).toMatch(/State/);
    expect(installer).toContain("Health check");
  });

  it("restricts the config secret (hub token) to the current user via ACL", () => {
    expect(installer).toContain("icacls");
    expect(installer).toContain("$ConfigPath");
  });

  it("never echoes the hub token in installer or agent console output", () => {
    const installerEchoes = installer.split("\n").filter((line) => /Write-Host|Write-Warning|Write-Output/.test(line) && /\$HubToken/.test(line));
    expect(installerEchoes).toEqual([]);
    const agentLogs = agent.split("\n").filter(
      (line) => /console\.(log|error|warn|info)/.test(line) && /\$\{?[a-zA-Z.]*hubToken/i.test(line),
    );
    expect(agentLogs).toEqual([]);
  });

  it("ships an uninstaller that removes the scheduled task, plus the double-click cmd", () => {
    expect(uninstaller).toContain("Unregister-ScheduledTask");
    expect(cmd).toContain("install-windows.ps1");
  });

  it("packages the complete one-click kit into the downloadable zip", () => {
    for (const part of ["install.cmd", "uninstall-windows.ps1", "install-windows.ps1", "README-TH.txt", "print-hub.mjs"]) {
      expect(zipBuilder).toContain(part);
    }
  });

  it("README states the real success signal: the Hub page heartbeat turning online", () => {
    const readme = read("scripts/print-hub/README-TH.txt");
    expect(readme).toContain("ออนไลน์");
    expect(readme).toContain("Print Hub");
  });
});