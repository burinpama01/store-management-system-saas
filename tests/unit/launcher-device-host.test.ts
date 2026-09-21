import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_CHANNEL,
  getLauncherDeviceSnapshot,
  initLauncherDevice,
  parseDeviceMessage,
  playAlertViaLauncher,
  resetLauncherDeviceForTests,
  saveLauncherSpeakers,
} from "@/modules/launcher/device-host";
import { LAUNCHER_SHA256, LAUNCHER_SIZE_BYTES, LAUNCHER_VERSION, launcherDownloadUrl } from "@/modules/launcher/version";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function installFakeWebView() {
  const sent: Array<Record<string, unknown>> = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  const webview = {
    postMessage: (message: unknown) => sent.push(message as Record<string, unknown>),
    addEventListener: (_type: "message", fn: (event: { data: unknown }) => void) => {
      listener = fn;
    },
  };
  vi.stubGlobal("window", { chrome: { webview }, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  return { sent, reply: (data: unknown) => listener?.({ data }) };
}

afterEach(() => {
  resetLauncherDeviceForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseDeviceMessage", () => {
  it("ignores other channels and garbage", () => {
    expect(parseDeviceMessage(null)).toBeNull();
    expect(parseDeviceMessage({ v: 1, type: "wake" })).toBeNull();
    expect(parseDeviceMessage({ channel: DEVICE_CHANNEL, type: "shell" })).toBeNull();
    expect(parseDeviceMessage({ channel: DEVICE_CHANNEL, type: "hello" })).toBeNull(); // ไม่มี version
  });

  it("reads hello, speakers and update status", () => {
    expect(
      parseDeviceMessage({ channel: DEVICE_CHANNEL, type: "hello", version: "0.5.0", capabilities: ["alert-player", 5] }),
    ).toEqual({ version: "0.5.0", capabilities: ["alert-player"], legacy: false });

    const speakers = parseDeviceMessage({
      channel: DEVICE_CHANNEL,
      type: "speakers",
      devices: [{ id: "{a}", name: "Realtek", isDefault: true }, { id: "", name: "broken" }],
      alertDeviceId: "{b}",
      alertVolume: 180,
      musicDeviceId: null,
      musicRoutingSupported: true,
    });
    expect(speakers?.speakers).toEqual({
      devices: [{ id: "{a}", name: "Realtek", isDefault: true }],
      alertDeviceId: "{b}",
      alertVolume: 100,
      musicDeviceId: null,
      musicRoutingSupported: true,
    });

    expect(
      parseDeviceMessage({ channel: DEVICE_CHANNEL, type: "update.status", state: "ready", currentVersion: "0.5.0", version: "0.5.1" }),
    ).toEqual({ update: { state: "ready", currentVersion: "0.5.0", version: "0.5.1", error: null } });
  });
});

describe("launcher device bridge", () => {
  it("does nothing in a normal browser", () => {
    vi.stubGlobal("window", {});
    initLauncherDevice();
    expect(getLauncherDeviceSnapshot().inLauncher).toBe(false);
    expect(playAlertViaLauncher("order")).toBe(false);
  });

  it("routes alerts to the Launcher only after it announces alert-player", () => {
    const { sent, reply } = installFakeWebView();
    initLauncherDevice();
    expect(sent[0]).toEqual({ channel: DEVICE_CHANNEL, type: "hello.request" });
    expect(playAlertViaLauncher("order")).toBe(false); // ยังไม่ตอบ hello → เบราว์เซอร์เล่นเอง

    reply({ channel: DEVICE_CHANNEL, type: "hello", version: "0.5.0", capabilities: ["alert-player", "speakers"] });
    expect(playAlertViaLauncher("qr")).toBe(true);
    expect(sent.at(-1)).toEqual({ channel: DEVICE_CHANNEL, type: "alert.play", sound: "qr" });

    saveLauncherSpeakers({ alertDeviceId: "{usb}", alertVolume: 42.4, musicDeviceId: null });
    expect(sent.at(-1)).toEqual({
      channel: DEVICE_CHANNEL,
      type: "speakers.set",
      alertDeviceId: "{usb}",
      alertVolume: 42,
      musicDeviceId: "",
    });
  });

  it("marks an old Launcher (no hello reply) as legacy", () => {
    vi.useFakeTimers();
    installFakeWebView();
    initLauncherDevice();
    expect(getLauncherDeviceSnapshot()).toMatchObject({ inLauncher: true, legacy: false });
    vi.advanceTimersByTime(4100);
    expect(getLauncherDeviceSnapshot().legacy).toBe(true);
  });

  it("alert-sound asks the Launcher first", () => {
    const source = read("src/shared/notifications/alert-sound.ts");
    expect(source).toContain("if (playAlertViaLauncher(pattern)) return;");
  });
});

describe("launcher release manifest", () => {
  it("download URL stays on our release tag", () => {
    expect(launcherDownloadUrl("0.5.1")).toBe(
      "https://github.com/burinpama01/store-management-system-saas/releases/download/launcher-v0.5.1/storeos-launcher-0.5.1.zip",
    );
  });

  it("the published version carries a real SHA-256 and size (Launcher drops anything that does not match)", () => {
    expect(LAUNCHER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(LAUNCHER_SIZE_BYTES).toBeGreaterThan(1_000_000);
  });

  it("GET /api/launcher/latest serves the manifest publicly", async () => {
    const { GET } = await import("@/app/api/launcher/latest/route");
    const res = GET(new Request("https://www.store-os.online/api/launcher/latest?channel=prod"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: LAUNCHER_VERSION,
      url: launcherDownloadUrl(),
      sha256: LAUNCHER_SHA256,
      size: LAUNCHER_SIZE_BYTES,
      notes: expect.any(String),
    });
    expect(GET(new Request("https://x/api/launcher/latest?channel=beta")).status).toBe(404);
    expect(read("src/server/integrations/supabase/middleware.ts")).toContain('request.nextUrl.pathname === "/api/launcher/latest"');
  });

  it("regressions caught by the real update run (0.5.0 e2e)", () => {
    // 1) static HttpClient ข้าม partial file เคยอ่าน LauncherVersion ตอนยังเป็น null → MainWindow เปิดไม่ขึ้น
    const devices = read("windows/StoreOS.Launcher/MainWindow.Devices.cs");
    expect(devices).toContain("private static readonly Lazy<HttpClient> UpdateHttp = new(CreateUpdateHttp);");
    expect(devices).toContain('TryAddWithoutValidation("User-Agent"');
    // 2) StartupUri ทำให้ WPF สร้าง MainWindow แม้สั่ง Shutdown ในโหมดติดตั้งอัปเดต
    expect(read("windows/StoreOS.Launcher/App.xaml")).not.toMatch(/StartupUri\s*=/);
    expect(read("windows/StoreOS.Launcher/App.xaml.cs")).toContain("new MainWindow().Show();");
  });

  it("the C# update policy trusts the same download prefix", () => {
    const policy = read("windows/StoreOS.Launcher/Services/Update/LauncherUpdatePolicy.cs");
    expect(policy).toContain(
      '"https://github.com/burinpama01/store-management-system-saas/releases/download/launcher-v"',
    );
  });
});
