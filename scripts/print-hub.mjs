// StoreOS Print Hub agent.
// Runs on the store's cashier PC / mini-PC. Long-polls the StoreOS server for
// print jobs enqueued by tablet/iPad POS (which cannot reach a LAN printer over
// HTTPS), then prints each claimed job over TCP and acks the result.
//
// Config: scripts/print-hub.config.json next to this file, or STOREOS_HUB_* env.
//   { "serverUrl": "https://store-os-manage.vercel.app",
//     "storeId": "<uuid>", "hubToken": "<token>", "pollIntervalMs": 2500 }

import net from "node:net";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PRINT_JOB_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const ERROR_BACKOFF_MS = 8000;

function clampInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Pace bytes to the printer. A cheap thermal printer's input buffer overruns
// when a large raster (e.g. a receipt with a logo/QR image) is written in one
// shot over TCP -- it loses sync mid GS v 0 and prints the rest of the raster as
// garbage characters. Writing in small chunks with a short delay (like the
// Bluetooth client) lets the printer keep up. Tunable via env if a printer
// needs to go slower.
const PRINT_CHUNK_BYTES = clampInt(process.env.STOREOS_HUB_CHUNK_BYTES, 1024);
const PRINT_CHUNK_DELAY_MS = clampInt(process.env.STOREOS_HUB_CHUNK_DELAY_MS, 20);

const PRIVATE_LAN_RANGES = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];
const BLOCKED_LAN_RANGES = [/^127\./, /^169\.254\./, /^0\./, /^255\./];

export function isAllowedNetworkPrinterHost(ip) {
  if (typeof ip !== "string" || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  if (BLOCKED_LAN_RANGES.some((range) => range.test(ip))) return false;
  return PRIVATE_LAN_RANGES.some((range) => range.test(ip));
}

// Windows Bluetooth SPP ports are COM1..COM999. Validate + normalize strictly
// so the value is safe to interpolate into the `mode` command / device path.
export function normalizeComPort(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  return /^COM([1-9]\d{0,2})$/.test(raw) ? raw : null;
}

export function decodePrintJobBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid print job");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PRINT_JOB_BYTES) {
    throw new Error("Print job too large");
  }
  return bytes;
}

export function sendToSocket(host, port, data, options = {}) {
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunkBytes = options.chunkBytes ?? PRINT_CHUNK_BYTES;
  const chunkDelayMs = options.chunkDelayMs ?? PRINT_CHUNK_DELAY_MS;
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let timer = setTimeout(() => settle(new Error(`Connection timed out (${connectTimeoutMs}ms)`)), connectTimeoutMs);
    function settle(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        socket.end();
        resolve();
      }
    }
    socket.on("error", settle);
    socket.connect(port, host, async () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new Error(`Print send timed out (${SEND_TIMEOUT_MS}ms)`)), SEND_TIMEOUT_MS);
      try {
        for (let offset = 0; offset < data.length && !done; offset += chunkBytes) {
          const end = Math.min(offset + chunkBytes, data.length);
          await new Promise((res, rej) => socket.write(data.subarray(offset, end), (e) => (e ? rej(e) : res())));
          if (chunkDelayMs > 0 && end < data.length) {
            await new Promise((res) => setTimeout(res, chunkDelayMs));
          }
        }
        settle();
      } catch (err) {
        settle(err);
      }
    });
  });
}

// PowerShell that opens the COM port via .NET SerialPort and writes a payload
// file in small paced chunks. Node's fs cannot reliably open a Windows serial
// device (it fails with "UNKNOWN: unknown error, open '\\.\COMx'"), so we use
// System.IO.Ports.SerialPort, which is the supported way to talk to a COM port.
// `port` is pre-validated to /^COM\d+$/ and `file` is an internal temp path, so
// neither can inject into the script.
function buildSerialPortScript(port, file, baud) {
  return [
    "$ErrorActionPreference='Stop';",
    `$bytes=[System.IO.File]::ReadAllBytes('${file}');`,
    `$sp=New-Object System.IO.Ports.SerialPort('${port}',${baud},[System.IO.Ports.Parity]::None,8,[System.IO.Ports.StopBits]::One);`,
    "$sp.WriteTimeout=8000; $sp.Open();",
    "$i=0; while($i -lt $bytes.Length){ $n=[Math]::Min(256,$bytes.Length-$i); $sp.Write($bytes,$i,$n); Start-Sleep -Milliseconds 15; $i+=$n }",
    "Start-Sleep -Milliseconds 400; $sp.Close();",
  ].join(" ");
}

/**
 * Writes ESC/POS bytes to a Bluetooth printer paired to this PC as a Windows
 * SPP COM port (e.g. COM5), via PowerShell's .NET SerialPort. Paced in 256-byte
 * chunks because cheap thermal printers drop data when flooded. `runner` is
 * injectable so tests do not spawn PowerShell.
 */
export function sendToComPort(comPort, data, options = {}) {
  // Most Bluetooth SPP ports ignore baud, but a few printers need a specific
  // rate; allow STOREOS_HUB_BAUD to override without a code change.
  const baud = options.baud ?? clampInt(process.env.STOREOS_HUB_BAUD, 9600);
  const runner = options.runner ?? defaultSerialRunner;
  return new Promise((resolve, reject) => {
    const port = normalizeComPort(comPort);
    if (!port) {
      reject(new Error("Invalid or disallowed Bluetooth COM port"));
      return;
    }
    runner(port, data, baud).then(resolve, reject);
  });
}

function defaultSerialRunner(port, data, baud) {
  return new Promise((resolve, reject) => {
    const file = join(tmpdir(), `storeos-hub-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    try {
      writeFileSync(file, data);
    } catch (err) {
      reject(err);
      return;
    }
    const script = buildSerialPortScript(port, file, baud);
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: SEND_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        try { unlinkSync(file); } catch { /* temp file cleanup is best-effort */ }
        if (err) {
          const detail = (stderr || err.message || "COM write failed").toString().trim().replace(/\s+/g, " ");
          reject(new Error(detail.slice(0, 200)));
          return;
        }
        resolve();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// USB printers on the cashier PC
//
// A thermal printer plugged in over USB is claimed by the Windows driver
// (usbprint.sys), so a browser cannot talk to it with WebUSB -- claimInterface
// fails with "Access denied". The supported way to push raw ESC/POS bytes is the
// Windows spooler with datatype "RAW": OpenPrinter -> StartDocPrinter ->
// WritePrinter. That works with the generic "USB Printing Support" driver and
// with any vendor driver, without changing drivers (no Zadig) and without
// sharing the printer.
// ---------------------------------------------------------------------------

const USB_PORT_RE = /^(USB|DOT4|WSD)/i;
// Names vendors give receipt/thermal printers. Used only to RANK candidates when
// the store has not picked one -- never to exclude a printer outright.
// "EPSON" ทั้งคำกว้างเกินไป (อิงค์เจ็ต A4 ก็ชื่อ EPSON) จึงจับเฉพาะซีรีส์ความร้อน TM-.
const RECEIPT_NAME_RE = /(POS|THERMAL|RECEIPT|58|80|XP-|XP_|TM-|RONGTA|RP\d|PT-|GP-|ZJ-|SPRT|BIXOLON)/i;

// อุปกรณ์ที่ไม่ใช่เครื่องพิมพ์กระดาษจริง หรือพิมพ์ใบเสร็จไม่ได้แน่ ๆ — ตัดออกจากการเดา
// อัตโนมัติเสมอ (ผู้ใช้ยังเลือกเองได้จากหน้า Settings ถ้าจำเป็น) เพื่อไม่ให้ใบเสร็จหลุด
// ไปออกที่แฟกซ์/เครื่องพิมพ์เสมือนแล้วเด้ง dialog ค้างที่พีซีแคชเชียร์
const NON_RECEIPT_NAME_RE = /(FAX|OneNote|PDF|XPS|Scan|Fold|Send To|Any Printer)/i;
const VIRTUAL_PORT_RE = /^(nul:|PORTPROMPT:|FILE:|SHRFAX|Microsoft\.Office)/i;

/** Windows printer names are free text; only allow what can be safely quoted. */
export function normalizeWindowsPrinterName(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 128) return null;
  return /^[\p{L}\p{M}\p{N} _.\-()#+\/&,:]+$/u.test(raw) ? raw : null;
}

/**
 * Ranks the printers Windows can see and returns the one a receipt should go to.
 * Pure, so the ranking is unit-tested without touching PowerShell.
 *   1. the name the store picked, if it is still present
 *   2. a USB-port printer whose name looks like a receipt printer
 *   3. any USB-port printer
 *   4. the Windows default printer
 * Offline printers rank last within each tier, so a stale entry never shadows
 * the printer that is actually plugged in.
 */
export function pickUsbPrinter(printers, requestedName) {
  const list = Array.isArray(printers) ? printers.filter((p) => p && typeof p.name === "string" && p.name) : [];
  if (list.length === 0) return null;

  if (requestedName) {
    const exact = list.find((p) => p.name === requestedName);
    if (exact) return exact;
    // ชื่อที่ตั้งไว้หายไป (ถอดสาย/ลบเครื่องพิมพ์) -> ตกไปโหมดตรวจจับอัตโนมัติแทนที่จะพัง
  }

  const rank = (p) => {
    const port = String(p.port ?? "");
    if (NON_RECEIPT_NAME_RE.test(p.name) || VIRTUAL_PORT_RE.test(port)) return 3;
    const usb = USB_PORT_RE.test(port);
    if (usb && RECEIPT_NAME_RE.test(p.name)) return 0;
    if (usb) return 1;
    if (p.isDefault) return 2;
    return 3;
  };
  const scored = list
    .map((p, index) => ({ p, tier: rank(p), stale: p.offline ? 1 : 0, index }))
    .sort((a, b) => a.tier - b.tier || a.stale - b.stale || a.index - b.index);
  const best = scored[0];
  // tier 3 = ไม่ใช่ USB และไม่ใช่ default -> ไม่เดาให้ ปล่อยให้รายงานว่าไม่พบ
  return best && best.tier < 3 ? best.p : null;
}

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

function runPowerShell(script, timeoutMs = SEND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [...PS_ARGS, script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "PowerShell failed").toString().trim().replace(/\s+/g, " ");
          reject(new Error(detail.slice(0, 200)));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

/** Parses the JSON that `listWindowsPrinters` asks PowerShell for. */
export function parseWindowsPrinterList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim() || "[]");
  } catch {
    return [];
  }
  // ConvertTo-Json ยุบ array ที่มีสมาชิกเดียวเป็น object เดี่ยว
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const printers = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = normalizeWindowsPrinterName(row.Name);
    if (!name) continue;
    const port = typeof row.PortName === "string" ? row.PortName.trim().slice(0, 64) : "";
    printers.push({
      name,
      port,
      isDefault: row.Default === true,
      isUsb: USB_PORT_RE.test(port),
      offline: row.WorkOffline === true,
    });
  }
  return printers;
}

const PRINTER_CACHE_MS = clampInt(process.env.STOREOS_HUB_PRINTER_CACHE_MS, 20000);
let printerCache = { at: 0, printers: [] };

/** Enumerates the printers Windows can see (cached briefly; polls run every ~2.5s). */
export async function listWindowsPrinters(options = {}) {
  const runner = options.runner ?? ((script) => runPowerShell(script, DEFAULT_TIMEOUT_MS * 3));
  const now = Date.now();
  if (!options.runner && !options.force && now - printerCache.at < PRINTER_CACHE_MS) {
    return printerCache.printers;
  }
  const script =
    "$ErrorActionPreference='Stop'; " +
    "Get-CimInstance -ClassName Win32_Printer | " +
    "Select-Object Name,PortName,Default,WorkOffline | ConvertTo-Json -Compress -Depth 3";
  let printers = [];
  try {
    printers = parseWindowsPrinterList(await runner(script));
  } catch {
    // ไม่ใช่ Windows หรือ WMI ใช้ไม่ได้ -> ไม่มีเครื่องพิมพ์ให้รายงาน (ไม่ใช่เหตุให้ Hub ตาย)
    printers = [];
  }
  if (!options.runner) printerCache = { at: now, printers };
  return printers;
}

// Sends a payload file to a Windows printer with datatype RAW via winspool.drv.
// `printerName` is pre-validated to a safe character set and single quotes are
// doubled, so it cannot break out of the PowerShell string literal.
export function buildRawSpoolScript(printerName, file) {
  const safeName = printerName.replace(/'/g, "''");
  const csharp = [
    "using System;using System.Runtime.InteropServices;",
    "public class StoreOsRawPrint{",
    "[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public class DOCINFO{",
    "[MarshalAs(UnmanagedType.LPWStr)]public string pDocName;",
    "[MarshalAs(UnmanagedType.LPWStr)]public string pOutputFile;",
    "[MarshalAs(UnmanagedType.LPWStr)]public string pDataType;}",
    '[DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool OpenPrinter(string src,out IntPtr h,IntPtr pd);',
    '[DllImport("winspool.drv",SetLastError=true)]public static extern bool ClosePrinter(IntPtr h);',
    '[DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool StartDocPrinter(IntPtr h,int level,[In,MarshalAs(UnmanagedType.LPStruct)]DOCINFO di);',
    '[DllImport("winspool.drv",SetLastError=true)]public static extern bool EndDocPrinter(IntPtr h);',
    '[DllImport("winspool.drv",SetLastError=true)]public static extern bool StartPagePrinter(IntPtr h);',
    '[DllImport("winspool.drv",SetLastError=true)]public static extern bool EndPagePrinter(IntPtr h);',
    '[DllImport("winspool.drv",SetLastError=true)]public static extern bool WritePrinter(IntPtr h,IntPtr buf,int count,out int written);',
    "public static void Send(string printer,byte[] bytes){",
    'IntPtr h;if(!OpenPrinter(printer,out h,IntPtr.Zero))throw new Exception("OpenPrinter failed: "+Marshal.GetLastWin32Error());',
    'try{DOCINFO di=new DOCINFO();di.pDocName="StoreOS Receipt";di.pDataType="RAW";',
    'if(!StartDocPrinter(h,1,di))throw new Exception("StartDocPrinter failed: "+Marshal.GetLastWin32Error());',
    'try{if(!StartPagePrinter(h))throw new Exception("StartPagePrinter failed: "+Marshal.GetLastWin32Error());',
    "IntPtr buf=Marshal.AllocCoTaskMem(bytes.Length);",
    "try{Marshal.Copy(bytes,0,buf,bytes.Length);int written;",
    'if(!WritePrinter(h,buf,bytes.Length,out written))throw new Exception("WritePrinter failed: "+Marshal.GetLastWin32Error());',
    'if(written!=bytes.Length)throw new Exception("Short write: "+written+"/"+bytes.Length);}',
    "finally{Marshal.FreeCoTaskMem(buf);}",
    "EndPagePrinter(h);}finally{EndDocPrinter(h);}}finally{ClosePrinter(h);}}}",
  ].join("");
  return [
    "$ErrorActionPreference='Stop';",
    // ตัวปิด here-string ต้องอยู่ต้นบรรทัดของมันเอง จึงขึ้นบรรทัดใหม่หลัง '@
    `$src=@'\n${csharp}\n'@\n`,
    "if(-not ('StoreOsRawPrint' -as [type])){ Add-Type -TypeDefinition $src };",
    `[StoreOsRawPrint]::Send('${safeName}',[System.IO.File]::ReadAllBytes('${file}'));`,
  ].join(" ");
}

/**
 * Writes ESC/POS bytes to a printer installed on this PC (USB, or any port
 * Windows knows) through the spooler's RAW datatype. `runner` is injectable so
 * tests do not spawn PowerShell.
 */
export function sendToWindowsPrinter(printerName, data, options = {}) {
  const runner = options.runner ?? defaultRawSpoolRunner;
  return new Promise((resolve, reject) => {
    const name = normalizeWindowsPrinterName(printerName);
    if (!name) {
      reject(new Error("Invalid or disallowed Windows printer name"));
      return;
    }
    runner(name, data).then(resolve, reject);
  });
}

function defaultRawSpoolRunner(name, data) {
  const file = join(tmpdir(), `storeos-hub-usb-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  try {
    writeFileSync(file, data);
  } catch (err) {
    return Promise.reject(err);
  }
  const cleanup = () => {
    try { unlinkSync(file); } catch { /* temp file cleanup is best-effort */ }
  };
  return runPowerShell(buildRawSpoolScript(name, file)).then(
    () => { cleanup(); },
    (err) => { cleanup(); throw err; },
  );
}

/**
 * Resolves the USB target for a job and prints it. An empty `requestedName`
 * means the store chose auto-detect, so the printer is picked fresh for every
 * job -- moving the cable to another USB port needs no reconfiguration.
 */
export async function printUsbJob(requestedName, bytes, options = {}) {
  const printers = options.printers ?? (await listWindowsPrinters());
  const chosen = pickUsbPrinter(printers, normalizeWindowsPrinterName(requestedName));
  if (!chosen) {
    throw new Error(
      requestedName
        ? `ไม่พบเครื่องพิมพ์ "${requestedName}" บนเครื่องแคชเชียร์ (ตรวจสายUSB / ติดตั้งไดรเวอร์แล้วหรือยัง)`
        : "ไม่พบเครื่องพิมพ์ USB บนเครื่องแคชเชียร์ - เสียบสาย USB แล้วรอ Windows ติดตั้งไดรเวอร์ จากนั้นลองพิมพ์ใหม่",
    );
  }
  const send = options.send ?? sendToWindowsPrinter;
  await send(chosen.name, bytes);
  return chosen;
}

/**
 * Runs one poll cycle: claim jobs, print each, ack the result. Pure w.r.t. its
 * injected `fetchImpl` and `printJob`, so it can be unit-tested without sockets.
 * `printJob(target, bytes)` receives an `{ kind: "ip", host, port }` or
 * `{ kind: "bt", device }` target. Returns the number of jobs processed.
 */
export async function runPollCycle({ config, fetchImpl, printJob, listDevices = listWindowsPrinters }) {
  const { serverUrl, storeId, hubToken } = config;
  // รายงานเครื่องพิมพ์ที่เห็นบนพีซีนี้ไปกับทุก poll -> หน้า Settings แสดงรายการให้ร้าน
  // กดเลือกเครื่องพิมพ์ USB ได้ทันทีที่เสียบสาย โดยไม่ต้องพิมพ์ชื่อเครื่องเอง
  let devices;
  try {
    devices = await listDevices();
  } catch {
    devices = undefined;
  }
  const pollRes = await fetchImpl(`${serverUrl}/api/print/hub/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(devices ? { storeId, hubToken, devices } : { storeId, hubToken }),
  });

  if (pollRes.status === 401) return { ok: false, authFailed: true, processed: 0 };
  if (!pollRes.ok) return { ok: false, processed: 0, status: pollRes.status };

  const body = await pollRes.json();
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  let processed = 0;
  for (const job of jobs) {
    let ok = true;
    let error = null;
    // เป้าหมายที่ใช้พิมพ์จริง — สำหรับ USB คือชื่อเครื่องพิมพ์ที่ตรวจจับได้ตอนนั้น
    let target = null;
    try {
      const bytes = decodePrintJobBase64(job.printJobBase64);
      if (job.kind === "bt") {
        const device = normalizeComPort(job.device);
        if (!device) throw new Error("Invalid or disallowed Bluetooth COM port");
        await printJob({ kind: "bt", device }, bytes);
      } else if (job.kind === "usb") {
        // device ว่าง = โหมดตรวจจับอัตโนมัติ (Hub เลือกเครื่องพิมพ์ USB ที่เสียบอยู่เอง)
        const chosen = await printJob({ kind: "usb", device: job.device ?? null }, bytes);
        target = chosen && typeof chosen.name === "string" ? chosen.name : job.device ?? null;
      } else {
        if (!isAllowedNetworkPrinterHost(job.host)) throw new Error("Invalid or disallowed IP address");
        await printJob({ kind: "ip", host: job.host, port: job.port ?? 9100 }, bytes);
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : "Print failed";
    }
    await fetchImpl(`${serverUrl}/api/print/hub/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId, hubToken, jobId: job.id, ok, error, kind: job.kind ?? "ip", target }),
    });
    processed += 1;
  }
  return { ok: true, processed };
}

function loadConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = join(here, "print-hub.config.json");
  let fileConfig = {};
  try {
    // Strip a UTF-8 BOM (PowerShell/Notepad may prepend one) before parsing,
    // otherwise JSON.parse throws on the leading U+FEFF.
    const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    fileConfig = JSON.parse(raw);
  } catch (err) {
    // Missing file is fine (env vars may supply config); surface parse errors.
    if (err && err.code !== "ENOENT") {
      console.error(`Could not read ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const config = {
    serverUrl: (process.env.STOREOS_HUB_SERVER_URL ?? fileConfig.serverUrl ?? "").replace(/\/+$/, ""),
    storeId: process.env.STOREOS_HUB_STORE_ID ?? fileConfig.storeId ?? "",
    hubToken: process.env.STOREOS_HUB_TOKEN ?? fileConfig.hubToken ?? "",
    pollIntervalMs: Number(process.env.STOREOS_HUB_POLL_MS ?? fileConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  };
  if (!config.serverUrl || !config.storeId || !config.hubToken) {
    throw new Error("Missing Print Hub config: serverUrl, storeId and hubToken are required");
  }
  return config;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = loadConfig();
  console.log(`StoreOS Print Hub started for store ${config.storeId} -> ${config.serverUrl}`);
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    let waitMs = config.pollIntervalMs;
    try {
      const result = await runPollCycle({
        config,
        fetchImpl: fetch,
        printJob: async (target, bytes) => {
          if (target.kind === "bt") return sendToComPort(target.device, bytes);
          if (target.kind === "usb") {
            const chosen = await printUsbJob(target.device, bytes);
            console.log(`USB job printed on "${chosen.name}" (${chosen.port || "unknown port"}).`);
            return chosen;
          }
          return sendToSocket(target.host, target.port, bytes);
        },
      });
      if (result.authFailed) {
        console.error("Hub token rejected (401). Check storeId/hubToken in config.");
        waitMs = ERROR_BACKOFF_MS;
      } else if (result.processed > 0) {
        console.log(`Printed ${result.processed} job(s).`);
      }
    } catch (err) {
      console.error(`Poll cycle failed: ${err instanceof Error ? err.message : err}`);
      waitMs = ERROR_BACKOFF_MS;
    }
    await sleep(waitMs);
  }
  console.log("StoreOS Print Hub stopped.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
