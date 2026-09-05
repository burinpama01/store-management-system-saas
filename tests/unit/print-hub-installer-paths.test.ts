import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * กันบั๊กที่เจอบนเครื่องร้านจริง 2026-09-05
 *
 * ตัวติดตั้งหา print-hub.mjs จาก "โฟลเดอร์แม่ของตัวเอง" ซึ่งถูกเฉพาะ layout ของ repo
 *   repo    : scripts/print-hub/install-windows.ps1  +  scripts/print-hub.mjs   (คนละชั้น)
 *   แพ็กเกจ : storeos-launcher/print-hub/{install-windows.ps1, print-hub.mjs}  (ชั้นเดียวกัน)
 * แพ็กเกจจริงจึงติดตั้งไม่ได้เลย ขึ้น "ไม่พบ print-hub.mjs"
 *
 * และ config ต้องอยู่ที่เดียวกับที่ Launcher เขียนตอน auto-provision
 * (%LOCALAPPDATA%\StoreOSPrintHub) ไม่งั้น Launcher เขียนไฟล์ที่ agent ไม่เคยอ่าน
 */
const installer = readFileSync(
  join(process.cwd(), "scripts/print-hub/install-windows.ps1"),
  "utf8",
);

const buildScript = readFileSync(
  join(process.cwd(), "scripts/windows-launcher/build-launcher.ps1"),
  "utf8",
);

describe("ตัวติดตั้ง Print Hub — เส้นทางไฟล์", () => {
  it("หา agent ทั้งในโฟลเดอร์ตัวเองและโฟลเดอร์แม่", () => {
    expect(installer).toContain('Join-Path $ScriptDir "print-hub.mjs"');
    expect(installer).toContain('Join-Path (Split-Path -Parent $ScriptDir) "print-hub.mjs"');
    // โฟลเดอร์ตัวเองต้องมาก่อน เพราะ layout ของแพ็กเกจคือชั้นเดียวกัน
    expect(installer.indexOf('Join-Path $ScriptDir "print-hub.mjs"'))
      .toBeLessThan(installer.indexOf('Join-Path (Split-Path -Parent $ScriptDir) "print-hub.mjs"'));
  });

  it("ไม่ใช้โฟลเดอร์แม่เป็นที่เดียวอีกแล้ว", () => {
    expect(installer).not.toContain('$ScriptsDir = Split-Path -Parent $ScriptDir');
  });

  it("ติดตั้ง agent ลง LocalAppData ไม่ใช่รันจากโฟลเดอร์ที่โหลดมา", () => {
    expect(installer).toContain('$InstallRoot = Join-Path $env:LOCALAPPDATA "StoreOSPrintHub"');
    expect(installer).toContain("Copy-Item -Path $AgentSource -Destination $AgentPath -Force");
    expect(installer).toContain('$AgentPath = Join-Path $InstallRoot "print-hub.mjs"');
  });

  it("config อยู่ที่เดียวกับที่ Launcher เขียนตอน auto-provision", () => {
    expect(installer).toContain('$ConfigPath = Join-Path $InstallRoot "print-hub.config.json"');

    // Launcher ฝั่ง C# ใช้ path เดียวกัน
    const mainWindow = readFileSync(
      join(process.cwd(), "windows/StoreOS.Launcher/MainWindow.xaml.cs"),
      "utf8",
    );
    expect(mainWindow).toContain('"StoreOSPrintHub"');
    expect(mainWindow).toContain('"print-hub.config.json"');
  });

  it("ไม่มี config ไม่ใช่ error อีกต่อไป — Launcher จะตั้งค่าให้เองตอนล็อกอิน", () => {
    // เดิม throw ทำให้ติดตั้งไม่จบ ทั้งที่ auto-provision จะให้ค่ามาเองในอีกไม่กี่วินาที
    expect(installer).toContain("$PendingProvision = $true");
    expect(installer).not.toContain('throw "ไม่พบค่าตั้งค่า');
    // ข้าม health check ที่รอ Running ไม่งั้นขึ้น warning ทั้งที่ปกติ (agent ยังไม่มี config)
    expect(installer).toContain("if ($PendingProvision) {");
    // ตั้ง ACL เฉพาะตอนมีไฟล์จริง (ไม่มี config แล้ว icacls จะ error)
    expect(installer).toMatch(/if \(Test-Path \$ConfigPath\) \{\s*\r?\n\s*icacls/);
  });

  it("ปิด agent ตัวเก่าที่ค้างอยู่ก่อนติดตั้งทับ", () => {
    // เคสจริง: ร้านเปิด print-hub.cmd ด้วยมือ เหลือ node.exe ถือ config เก่ายิง 401 วนไม่หยุด
    expect(installer).toContain("Win32_Process");
    expect(installer).toContain("print-hub\\.mjs");
    // ต้องกรองด้วย command line — ห้ามปิด node ของงานอื่นบนเครื่อง
    expect(installer).toContain("$_.CommandLine -match");
  });

  it("ย้าย config ที่ผู้ใช้ดาวน์โหลดมาเข้าที่ทางการ — หาให้ครบทุกที่ที่คนวางจริง", () => {
    expect(installer).toContain("$DroppedConfig");
    expect(installer).toContain("Copy-Item -Path $DroppedConfig -Destination $ConfigPath -Force");
    // เคสจริง: ไฟล์อยู่ที่ Downloads แต่สคริปต์อยู่ลึกลงไปสองชั้น (Downloads/storeos-launcher/print-hub)
    expect(installer).toContain("$PackageRoot = Split-Path -Parent $ScriptDir");
    expect(installer).toContain("(Split-Path -Parent $PackageRoot)");
    expect(installer).toContain("(Get-Location).Path");
    expect(installer).toContain('Join-Path $env:USERPROFILE "Downloads"');
  });
});

describe("แพ็กเกจที่ส่งให้ร้าน", () => {
  it("วาง agent ไว้ในโฟลเดอร์เดียวกับตัวติดตั้ง (layout ที่ทดสอบไว้)", () => {
    // ถ้าบรรทัดนี้เปลี่ยน layout ต้องกลับมาแก้ตัวติดตั้งด้วย
    expect(buildScript).toContain('$hubStage = Join-Path $StageDir "print-hub"');
    expect(buildScript).toContain('Copy-Item (Join-Path $RepoRoot "scripts\\print-hub.mjs") $hubStage -Force');
  });
});
