// StoreOS Print Hub agent.
// Runs on the store's cashier PC / mini-PC. Long-polls the StoreOS server for
// print jobs enqueued by tablet/iPad POS (which cannot reach a LAN printer over
// HTTPS), then prints each claimed job over TCP and acks the result.
//
// Config: scripts/print-hub.config.json next to this file, or STOREOS_HUB_* env.
//   { "serverUrl": "https://store-os-manage.vercel.app",
//     "storeId": "<uuid>", "hubToken": "<token>", "pollIntervalMs": 2500 }

import net from "node:net";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// เวอร์ชันของ agent ตัวนี้ + protocol ที่คุยกับเซิร์ฟเวอร์ (แผน v3 Task 3).
// ส่งไปกับทุก poll เพื่อให้เซิร์ฟเวอร์รู้ว่าร้านไหนยังรัน Hub รุ่นเก่า -- เดิมไม่มีเลย
// จึงไล่ปัญหา "ร้านนี้พิมพ์ไม่ออก" ไม่ได้ว่าเป็นเพราะ agent เก่าหรือของอย่างอื่น
export const AGENT_VERSION = "1.2.0";
export const PROTOCOL_VERSION = 1;

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

// ตระกูลเครื่องพิมพ์เอกสาร A4 (เลเซอร์/อิงค์เจ็ต/มัลติฟังก์ชัน). ผู้ใช้เลือกเองได้ถ้าจะใช้จริง
// แต่ **ห้ามถูกผูกอัตโนมัติ** เพราะใบเสร็จที่หลุดไปออกเครื่องเอกสารในออฟฟิศคือความเสียหาย
// ที่ร้านไม่รู้ตัวจนกว่าลูกค้าจะทวงใบเสร็จ (แผน v3 §4: "eligible USB thermal printer")
const NON_THERMAL_NAME_RE =
  /(LASER|DESKJET|OFFICEJET|INKJET|PIXMA|IMAGECLASS|ECOTANK|WORKFORCE|STYLUS|MFC-|DCP-|HL-|SMARTTANK|ENVY|INK TANK|L\d{3,4}|G\d{3,4} SERIES)/i;

/** Windows printer names are free text; only allow what can be safely quoted. */
export function normalizeWindowsPrinterName(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 128) return null;
  return /^[\p{L}\p{M}\p{N} _.\-()#+\/&,:]+$/u.test(raw) ? raw : null;
}

/**
 * ตัดอุปกรณ์ที่ไม่ใช่เครื่องพิมพ์กระดาษจริงออกก่อนจัดอันดับเสมอ (แผน v3 §4)
 * เครื่องพิมพ์เสมือน (PDF/XPS/OneNote/FAX) ต้องไม่มีสิทธิ์ถูกเลือกอัตโนมัติเลย
 */
export function isEligibleReceiptCandidate(printer) {
  if (!printer || typeof printer.name !== "string" || !printer.name) return false;
  const port = String(printer.port ?? "");
  if (NON_RECEIPT_NAME_RE.test(printer.name) || VIRTUAL_PORT_RE.test(port)) return false;
  return USB_PORT_RE.test(port);
}

function identityOf(printer) {
  const id = printer && typeof printer.identity === "object" && printer.identity ? printer.identity : null;
  return id;
}

function sameSerial(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * เลือกเครื่องพิมพ์ปลายทางของงาน USB จาก binding ของร้าน (แผน v3 §4)
 *
 *   1  identity เดิมตรงแบบ exact (pnpDeviceId)        -> exact_reconnect
 *   2  VID+PID+serial ตรงและมีตัวเดียว                 -> identity_match
 *   3  ชื่อเดิมที่ร้านผูกไว้ยังอยู่                      -> legacy_name
 *   4  policy auto_single และพบเครื่องที่เข้าเกณฑ์ตัวเดียว -> auto_single
 *   5  หลายตัว / weak match                            -> ambiguous (ห้ามพิมพ์)
 *   6  ไม่พบเลย                                        -> unavailable
 *
 * **ไม่มี** ขั้นที่ถอยไปใช้เครื่องพิมพ์เริ่มต้นของ Windows — isDefault ใช้เพื่อแสดงผล
 * เท่านั้น ไม่มีคะแนนในการเลือก เพราะใบเสร็จที่ไหลไปเครื่อง A4/PDF ของสำนักงานคือ
 * ความเสียหายที่ร้านไม่รู้ตัวจนกว่าลูกค้าจะทวงใบเสร็จ
 *
 * คืน { printer, reason } เสมอ (printer = null เมื่อยังเลือกไม่ได้) เพื่อให้ผู้เรียก
 * รายงานสาเหตุกลับไปได้ว่าทำไมงานถึงยังไม่ถูกพิมพ์
 */
export function selectUsbPrinter(printers, binding = {}) {
  const list = Array.isArray(printers) ? printers.filter((p) => p && typeof p.name === "string" && p.name) : [];
  if (list.length === 0) return { printer: null, reason: "unavailable" };

  const online = (p) => !p.offline;
  const bound = identityOf(binding);
  const policy = binding.policy === "confirm_multi" || binding.policy === "manual" ? binding.policy : "auto_single";

  // 1. identity เดิมตรงเป๊ะ — ย้ายพอร์ต USB / เปลี่ยนชื่อคิวแล้วก็ยังเจอ
  if (bound && bound.pnpDeviceId) {
    const exact = list.find((p) => {
      const id = identityOf(p);
      return id && id.pnpDeviceId && id.pnpDeviceId === bound.pnpDeviceId;
    });
    if (exact) return { printer: exact, reason: "exact_reconnect" };
  }

  // 2. VID+PID+serial ตรงและมีผู้สมัครเดียว (เครื่องเดิม ลงไดรเวอร์ใหม่จน pnp id เปลี่ยน)
  if (bound && bound.vid && bound.pid) {
    const matches = list.filter((p) => {
      const id = identityOf(p);
      if (!id || id.vid !== bound.vid || id.pid !== bound.pid) return false;
      // มี serial ทั้งคู่ต้องตรงกัน; ไม่มี serial ให้ผ่านเฉพาะกรณีมีผู้สมัครเดียว
      if (bound.serial && id.serial) return sameSerial(bound.serial, id.serial);
      return !bound.serial && !id.serial;
    });
    if (matches.length === 1) return { printer: matches[0], reason: "identity_match" };
    if (matches.length > 1) return { printer: null, reason: "ambiguous" };
  }

  // 3. ชื่อที่ร้านผูกไว้ (binding เดิมก่อนมี identity) — ผู้ใช้เลือกเองจึงไม่กรองด้วย
  //    เกณฑ์ "หน้าตาเหมือนเครื่องพิมพ์ใบเสร็จ"
  if (binding.name) {
    const byName = list.find((p) => p.name === binding.name);
    if (byName) return { printer: byName, reason: "legacy_name" };
    // ชื่อที่ผูกไว้หายไป: manual = หยุด, โหมดอื่นไปต่อที่การเลือกอัตโนมัติด้านล่าง
    if (policy === "manual") return { printer: null, reason: "unavailable" };
  }

  if (policy === "manual") return { printer: null, reason: "manual_required" };

  // 4./5. ยังไม่มี binding — เดาให้เฉพาะเมื่อไม่กำกวมจริง ๆ
  const eligible = list.filter(isEligibleReceiptCandidate).filter((p) => !NON_THERMAL_NAME_RE.test(p.name));
  if (eligible.length === 0) return { printer: null, reason: "unavailable" };
  if (policy === "confirm_multi") return { printer: null, reason: "ambiguous" };

  const onlineEligible = eligible.filter(online);
  const pool = onlineEligible.length > 0 ? onlineEligible : eligible;
  if (pool.length === 1) return { printer: pool[0], reason: "auto_single" };

  // หลายตัว: ยอมเลือกเฉพาะเมื่อมีตัวที่ "ชื่อเหมือนเครื่องพิมพ์ใบเสร็จ" อยู่ตัวเดียว
  const receiptLike = pool.filter((p) => RECEIPT_NAME_RE.test(p.name));
  if (receiptLike.length === 1) return { printer: receiptLike[0], reason: "auto_single" };
  return { printer: null, reason: "ambiguous" };
}

/**
 * เดิม: จัดอันดับแล้วคืนเครื่องพิมพ์ตัวเดียว (มี fallback ไป Windows default)
 * ตอนนี้เป็น wrapper บาง ๆ ของ selectUsbPrinter เพื่อคงหน้าตาเดิมของผู้เรียกไว้
 */
export function pickUsbPrinter(printers, requestedName) {
  return selectUsbPrinter(printers, { name: requestedName ?? null }).printer;
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

/**
 * Parses the JSON that `listWindowsPrinters` asks PowerShell for.
 * รองรับทั้งรูปเดิม (array ของ Win32_Printer) และรูปใหม่ของ v3
 * ({ printers, devices }) เพื่อให้ agent/เซิร์ฟเวอร์รุ่นคาบเกี่ยวกันยังอ่านออก
 */
export function parseWindowsPrinterList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim() || "[]");
  } catch {
    return [];
  }
  const source = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && parsed.printers !== undefined
    ? parsed.printers
    : [parsed];
  // ConvertTo-Json ยุบ array ที่มีสมาชิกเดียวเป็น object เดี่ยว
  const rows = Array.isArray(source) ? source : source ? [source] : [];
  const printers = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = normalizeWindowsPrinterName(row.Name);
    if (!name) continue;
    const port = typeof row.PortName === "string" ? row.PortName.trim().slice(0, 64) : "";
    const driverName = typeof row.DriverName === "string" ? row.DriverName.trim().slice(0, 128) : "";
    printers.push({
      name,
      port,
      driverName,
      isDefault: row.Default === true,
      isUsb: USB_PORT_RE.test(port),
      offline: row.WorkOffline === true,
    });
  }
  return printers;
}

// PNP id ของอุปกรณ์ USB มีสองรูปที่เจอบ่อย:
//   USB\VID_04B8&PID_0E15\<serial>          (ตัวอุปกรณ์ USB)
//   USBPRINT\<MODEL>\<instance>             (คิวเครื่องพิมพ์ที่ผูกกับอุปกรณ์นั้น)
// เอา VID/PID/serial เท่าที่มี ส่วน pnpDeviceId เก็บทั้งสตริงเสมอเพราะเสถียรกว่าชื่อคิว
const USB_VID_PID_RE = /USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\([^\\]+)/i;

/** แปลงรายการ Win32_PnPEntity ที่เป็นอุปกรณ์เครื่องพิมพ์ USB ให้เป็น identity ที่ใช้จับคู่ได้ */
export function parsePnpPrinterDevices(value) {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const devices = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const pnpDeviceId = typeof row.PNPDeviceID === "string" ? row.PNPDeviceID.trim().slice(0, 256) : "";
    if (!pnpDeviceId) continue;
    const label = typeof row.Name === "string" ? row.Name.trim().slice(0, 128) : "";
    const match = USB_VID_PID_RE.exec(pnpDeviceId);
    devices.push({
      pnpDeviceId,
      label,
      vid: match ? match[1].toUpperCase() : null,
      pid: match ? match[2].toUpperCase() : null,
      // instance ที่ขึ้นต้นด้วย & เป็นเลขที่ Windows ตั้งตามพอร์ต (เปลี่ยนเมื่อย้ายพอร์ต)
      // จึงไม่นับเป็น serial ของเครื่อง
      serial: match && !match[3].startsWith("&") ? match[3].slice(0, 64) : null,
    });
  }
  return devices;
}

function normalizeForMatch(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * จับคู่คิวเครื่องพิมพ์ของ Windows กับอุปกรณ์ USB ที่เห็นใน PnP โดยเทียบชื่อแบบหลวม
 * (ตัดอักขระที่ไม่ใช่ตัวอักษร/ตัวเลขออก แล้วดูว่าฝั่งไหนครอบอีกฝั่ง) — จับคู่ได้ก็ได้
 * identity ที่เสถียร จับไม่ได้ก็ยังทำงานเหมือนเดิมด้วยชื่อคิว ไม่มีอะไรพัง
 *
 * หมายเหตุ: การจับคู่จริงบนเครื่องหลากรุ่นยังต้องพิสูจน์กับฮาร์ดแวร์ (gate G5 ของแผน)
 */
export function mergePrinterIdentities(printers, devices) {
  const list = Array.isArray(devices) ? devices : [];
  return (Array.isArray(printers) ? printers : []).map((printer) => {
    const key = normalizeForMatch(printer.name);
    const hit = list.find((device) => {
      const label = normalizeForMatch(device.label);
      if (!label || !key) return false;
      return label === key || label.includes(key) || key.includes(label);
    });
    if (!hit) return printer;
    return {
      ...printer,
      identity: {
        v: 1,
        queueName: printer.name,
        pnpDeviceId: hit.pnpDeviceId,
        vid: hit.vid,
        pid: hit.pid,
        serial: hit.serial,
        driverName: printer.driverName || null,
      },
    };
  });
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
    "$p = @(Get-CimInstance -ClassName Win32_Printer | " +
    "Select-Object Name,PortName,Default,WorkOffline,DriverName); " +
    // อุปกรณ์ฝั่ง PnP ที่ไดรเวอร์เครื่องพิมพ์ USB ยึดอยู่ ใช้ทำ identity ที่เสถียรกว่าชื่อคิว
    "$d = @(); try { $d = @(Get-CimInstance -ClassName Win32_PnPEntity " +
    "-Filter \"Service='usbprint' or Service='WinUSB' or Service='usbccgp'\" | " +
    "Select-Object Name,PNPDeviceID) } catch { $d = @() }; " +
    "[pscustomobject]@{ printers = $p; devices = $d } | ConvertTo-Json -Compress -Depth 4";
  let printers = [];
  try {
    const stdout = await runner(script);
    let payload = {};
    try {
      payload = JSON.parse(String(stdout || "").trim() || "{}");
    } catch {
      payload = {};
    }
    printers = mergePrinterIdentities(
      parseWindowsPrinterList(stdout),
      parsePnpPrinterDevices(payload && typeof payload === "object" ? payload.devices : []),
    );
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
 * เลือกปลายทางของงาน USB จาก binding ที่เซิร์ฟเวอร์ส่งมา แล้วพิมพ์
 * binding ว่าง = ร้านยังไม่ได้ผูกเครื่องไหน -> ใช้ policy ตัดสิน (ค่าเริ่มต้น auto_single)
 * เมื่อเลือกไม่ได้ ต้องบอกเหตุผลเป็นภาษาที่ร้านแก้ตามได้ ไม่ใช่ error ดิบ
 */
export function describeUnavailableUsbTarget(reason, binding = {}) {
  if (reason === "ambiguous") {
    return "พบเครื่องพิมพ์ที่ใช้ได้มากกว่าหนึ่งเครื่อง — เลือกเครื่องที่ต้องการในหน้าตั้งค่า Print Hub ก่อน";
  }
  if (reason === "manual_required") {
    return "ตั้งค่าไว้เป็นเลือกเครื่องเอง แต่ยังไม่ได้เลือกเครื่องพิมพ์ — เลือกในหน้าตั้งค่า Print Hub";
  }
  return binding.name
    ? `ไม่พบเครื่องพิมพ์ "${binding.name}" บนเครื่องแคชเชียร์ (ตรวจสาย USB / ติดตั้งไดรเวอร์แล้วหรือยัง)`
    : "ไม่พบเครื่องพิมพ์ USB บนเครื่องแคชเชียร์ - เสียบสาย USB แล้วรอ Windows ติดตั้งไดรเวอร์ จากนั้นลองพิมพ์ใหม่";
}

export async function printUsbJob(binding, bytes, options = {}) {
  const resolved =
    typeof binding === "string" || binding === null || binding === undefined
      ? { name: normalizeWindowsPrinterName(binding), identity: null, policy: "auto_single" }
      : {
          name: normalizeWindowsPrinterName(binding.name ?? null),
          identity: binding.identity ?? null,
          policy: binding.policy ?? "auto_single",
        };

  const printers = options.printers ?? (await listWindowsPrinters());
  const { printer, reason } = selectUsbPrinter(printers, resolved);
  if (!printer) {
    const error = new Error(describeUnavailableUsbTarget(reason, resolved));
    // เลือกปลายทางไม่ได้ = ยังไม่ได้ส่งไบต์ออกไปแน่นอน -> failed (พิมพ์ซ้ำได้ปลอดภัย)
    error.printOutcome = "failed";
    error.reason = reason;
    throw error;
  }
  const send = options.send ?? sendToWindowsPrinter;
  await send(printer.name, bytes);
  return { ...printer, reason };
}

// ข้อความ error ที่แปลว่า "ยังไม่ได้ส่งไบต์ออกไปแน่นอน" -- งานพวกนี้พิมพ์ซ้ำได้ปลอดภัย
// "Connection timed out" = ต่อ socket ไม่ติดตั้งแต่แรก (ยังไม่ได้ส่งไบต์) ต่างจาก
// "Print send timed out" ที่ต่อติดแล้วค้างระหว่างส่ง ซึ่งกระดาษอาจออกไปบางส่วนแล้ว
// ความต่างนี้เจอจากการทดสอบกับเครื่องจริง: เครื่องพิมพ์รับ TCP ได้ทีละงาน งานที่ต่อไม่ทัน
// ถูกตีเป็น unknown ทั้งที่ยังไม่ได้พิมพ์ ทำให้ต้องให้คนมานั่งไล่ตรวจโดยไม่จำเป็น
const DEFINITE_FAILURE_RE =
  /Invalid or disallowed|Invalid print job|Print job too large|ไม่พบเครื่องพิมพ์|Connection timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|OpenPrinter failed/i;

/**
 * แยก "รู้แน่ว่าไม่ออก" (failed) ออกจาก "ไม่รู้ผล" (unknown).
 * timeout / สายหลุดกลางทาง / เขียนไม่ครบ = กระดาษอาจออกไปแล้วบางส่วนหรือทั้งใบ
 * จึงห้ามรายงานเป็น failed เพราะ failed เปิดทางให้พิมพ์ซ้ำได้ ส่วน unknown ต้องให้คน
 * ไปดูกระดาษจริงก่อนเสมอ. ผู้เรียกที่รู้ผลแน่ (เช่น เลือกปลายทางไม่ได้ตั้งแต่ต้น)
 * ระบุ error.printOutcome มาเองได้.
 */
export function classifyPrintOutcome(error) {
  if (error && typeof error === "object" && (error.printOutcome === "failed" || error.printOutcome === "unknown")) {
    return error.printOutcome;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return DEFINITE_FAILURE_RE.test(message) ? "failed" : "unknown";
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
    body: JSON.stringify({
      storeId,
      hubToken,
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      ...(devices ? { devices } : {}),
    }),
  });

  if (pollRes.status === 401) return { ok: false, authFailed: true, processed: 0 };
  // 426 = เซิร์ฟเวอร์ไม่รับ protocol รุ่นนี้แล้ว -> ต้องอัปเดต Hub ไม่ใช่ retry ไปเรื่อย ๆ
  if (pollRes.status === 426) {
    let message = "Print Hub เวอร์ชันนี้เก่าเกินไป — ดาวน์โหลดตัวติดตั้งใหม่จากหน้าตั้งค่า Print Hub";
    try {
      const detail = await pollRes.json();
      if (detail && typeof detail.error === "string") message = detail.error;
    } catch {
      // ไม่มีรายละเอียดก็ใช้ข้อความมาตรฐาน
    }
    return { ok: false, processed: 0, outdated: true, message };
  }
  if (!pollRes.ok) return { ok: false, processed: 0, status: pollRes.status };

  const body = await pollRes.json();
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

  let processed = 0;
  for (const job of jobs) {
    let outcome = "printed";
    let error = null;
    // เป้าหมายที่ใช้พิมพ์จริง — สำหรับ USB คือชื่อเครื่องพิมพ์ที่ตรวจจับได้ตอนนั้น
    let target = null;
    let reason = null;
    let identity = null;
    try {
      const bytes = decodePrintJobBase64(job.printJobBase64);
      if (job.kind === "bt") {
        const device = normalizeComPort(job.device);
        if (!device) throw new Error("Invalid or disallowed Bluetooth COM port");
        await printJob({ kind: "bt", device }, bytes);
      } else if (job.kind === "usb") {
        // binding มาจากเซิร์ฟเวอร์ (แถว printers) — agent ไม่เก็บ config การผูกเครื่องเอง
        const binding = job.usb ?? { name: job.device ?? null, identity: null, policy: "auto_single" };
        const chosen = await printJob({ kind: "usb", device: binding.name ?? null, binding }, bytes);
        target = chosen && typeof chosen.name === "string" ? chosen.name : binding.name ?? null;
        reason = chosen && typeof chosen.reason === "string" ? chosen.reason : null;
        // identity ของเครื่องที่พิมพ์สำเร็จจริง ส่งกลับให้เซิร์ฟเวอร์จำไว้ (ครั้งแรกเท่านั้น)
        identity = chosen && chosen.identity ? chosen.identity : null;
      } else {
        if (!isAllowedNetworkPrinterHost(job.host)) throw new Error("Invalid or disallowed IP address");
        await printJob({ kind: "ip", host: job.host, port: job.port ?? 9100 }, bytes);
      }
    } catch (err) {
      outcome = classifyPrintOutcome(err);
      error = err instanceof Error ? err.message : "Print failed";
    }
    try {
      await fetchImpl(`${serverUrl}/api/print/hub/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          hubToken,
          jobId: job.id,
          // ok ยังส่งอยู่เพื่อให้เซิร์ฟเวอร์รุ่นก่อนหน้าอ่านได้ระหว่างช่วงเปลี่ยนผ่าน
          ok: outcome === "printed",
          outcome,
          claimToken: job.claimToken ?? null,
          error,
          kind: job.kind ?? "ip",
          target,
          reason,
          targetIdentity: identity,
        }),
      });
    } catch {
      // ack ไม่ถึงเซิร์ฟเวอร์ (เน็ตหลุด) -- ไม่ต้องเดาแทน: งานจะค้าง claimed แล้วถูก
      // เซิร์ฟเวอร์ปิดเป็น unknown เมื่อ lease หมด ซึ่งเป็นผลลัพธ์ที่ถูกต้องกว่าการ
      // รายงานสำเร็จ/ล้มเหลวโดยไม่มีหลักฐาน
    }
    processed += 1;
  }
  return { ok: true, processed, printersSeen: Array.isArray(devices) ? devices.length : null };
}

// ---------------------------------------------------------------------------
// Single instance + health (แผน v3 Task 7)
//
// เครื่องแคชเชียร์มีสองทางที่จะเปิด Hub ได้: Scheduled Task "StoreOSPrintHub"
// (ตัวติดตั้งสร้างไว้) และในอนาคตคือ Launcher. ถ้าสองทางต่างฝ่ายต่างเปิด จะมี agent
// สองตัวแย่งเคลมงานกัน -- ฝั่งเซิร์ฟเวอร์กันไว้แล้วด้วย FOR UPDATE SKIP LOCKED แต่
// ฝั่งเครื่องก็ต้องมีตัวล็อกด้วย ไม่งั้นจะมีสองโปรเซสสแกน/พิมพ์ซ้อนกันโดยไม่มีใครรู้.
//
// health.json คือช่องทางเดียวที่ Launcher จะรู้ว่า Hub "พร้อมจริง" ไม่ใช่แค่ process เปิด
// ห้ามมี token / payload งานพิมพ์ / path อุปกรณ์ดิบ ในไฟล์นี้เด็ดขาด (แผน v3 Task 7)
// ---------------------------------------------------------------------------

export function hubStateDir(env = process.env) {
  const base = env.STOREOS_HUB_STATE_DIR || env.LOCALAPPDATA || env.TMPDIR || tmpdir();
  return join(base, "StoreOSPrintHub");
}

/** ตรวจว่าโปรเซสที่ถือล็อกยังอยู่จริงไหม (ล็อกค้างจากเครื่องดับต้องไม่บล็อกตลอดไป) */
export function isProcessAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = โปรเซสมีอยู่แต่คนละสิทธิ์ -> ถือว่ายังอยู่
    return !!err && err.code === "EPERM";
  }
}

/**
 * ตัดสินว่าจะยึดล็อกได้ไหมจากเนื้อไฟล์ล็อกที่อ่านมา (pure -> ทดสอบได้)
 * คืน { canStart, reason, holderPid }
 */
export function evaluateLock(rawLock, options = {}) {
  const now = options.now ?? Date.now();
  const alive = options.isAlive ?? ((pid) => isProcessAlive(pid));
  const selfPid = options.pid ?? process.pid;
  if (!rawLock) return { canStart: true, reason: "no_lock", holderPid: null };

  let lock;
  try {
    lock = typeof rawLock === "string" ? JSON.parse(rawLock) : rawLock;
  } catch {
    return { canStart: true, reason: "corrupt_lock", holderPid: null };
  }
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { canStart: true, reason: "corrupt_lock", holderPid: null };
  if (pid === selfPid) return { canStart: true, reason: "own_lock", holderPid: pid };
  if (!alive(pid)) return { canStart: true, reason: "stale_lock", holderPid: pid };

  // โปรเซสเดิมยังอยู่ แต่ถ้าไฟล์ล็อกเก่ามาก (heartbeat ไม่ขยับ) แปลว่ามันค้าง
  const beatAt = Date.parse(lock?.updatedAt ?? lock?.startedAt ?? "");
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  if (Number.isFinite(beatAt) && now - beatAt > staleAfterMs) {
    return { canStart: true, reason: "stale_heartbeat", holderPid: pid };
  }
  return { canStart: false, reason: "already_running", holderPid: pid };
}

/** เขียนไฟล์แบบ atomic (เขียน .tmp แล้ว rename) — ผู้อ่านจะไม่เจอไฟล์ครึ่ง ๆ กลาง ๆ */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * สร้างสแนปช็อตสถานะที่ Launcher/ผู้ดูแลอ่านได้ — เก็บเฉพาะข้อมูลที่ปลอดภัย
 * (ไม่มี hubToken, ไม่มีเนื้องานพิมพ์, ไม่มี path อุปกรณ์)
 */
export function buildHealthSnapshot(input) {
  return {
    schemaVersion: 1,
    pid: input.pid,
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    state: input.state,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    lastPollAt: input.lastPollAt ?? null,
    lastSuccessAt: input.lastSuccessAt ?? null,
    lastErrorCode: input.lastErrorCode ?? null,
    printersSeen: Number.isInteger(input.printersSeen) ? input.printersSeen : null,
    // storeId เป็นตัวระบุร้าน ไม่ใช่ความลับ แต่ token ห้ามอยู่ในไฟล์นี้เด็ดขาด
    storeId: input.storeId ?? null,
  };
}

/** ตัวจัดการล็อก+health ที่ main ใช้ (แยกไฟล์ I/O ออกมาเพื่อให้ทดสอบส่วนตัดสินใจได้) */
export function createHubRuntimeState(options = {}) {
  const dir = options.dir ?? hubStateDir();
  const lockPath = join(dir, "hub.lock");
  const healthPath = join(dir, "health.json");
  const startedAt = new Date().toISOString();
  let health = null;

  return {
    lockPath,
    healthPath,
    /** พยายามยึดล็อก คืน { ok, reason, holderPid } */
    acquireLock() {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // เขียนไม่ได้ก็ยังเดินต่อได้ (โหมดไม่มีล็อก) แต่ต้องไม่เงียบ
        return { ok: true, reason: "state_dir_unavailable", holderPid: null };
      }
      let raw = null;
      try {
        raw = readFileSync(lockPath, "utf8");
      } catch {
        raw = null;
      }
      const verdict = evaluateLock(raw, options);
      if (!verdict.canStart) return { ok: false, reason: verdict.reason, holderPid: verdict.holderPid };
      writeJsonAtomic(lockPath, { pid: process.pid, startedAt, updatedAt: startedAt });
      return { ok: true, reason: verdict.reason, holderPid: verdict.holderPid };
    },
    /** อัปเดต health + heartbeat ของล็อก (เรียกทุกรอบ poll) */
    update(patch) {
      const now = new Date().toISOString();
      health = buildHealthSnapshot({
        ...(health ?? {}),
        ...patch,
        pid: process.pid,
        startedAt,
        updatedAt: now,
      });
      try {
        writeJsonAtomic(healthPath, health);
        writeJsonAtomic(lockPath, { pid: process.pid, startedAt, updatedAt: now });
      } catch {
        // เขียนสถานะไม่ได้ต้องไม่ทำให้การพิมพ์หยุด
      }
      return health;
    },
    release() {
      try {
        unlinkSync(lockPath);
      } catch {
        // ไฟล์อาจถูกลบไปแล้ว
      }
    },
  };
}

export function hubConfigPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "print-hub.config.json");
}

/**
 * ลายเซ็นของไฟล์ config (เวลาแก้ + ขนาด) — ใช้รู้ว่า Launcher เขียนทับหรือยัง
 * ไม่มีไฟล์ = null ซึ่งต่างจาก "มีไฟล์แต่ยังไม่เปลี่ยน" อย่างชัดเจน
 */
export function configFileStamp(path = hubConfigPath()) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** credential เปลี่ยนจริงไหม (pollIntervalMs เปลี่ยนไม่ต้องประกาศอะไร) */
export function hasCredentialChanged(previous, next) {
  if (!previous || !next) return false;
  return previous.hubToken !== next.hubToken
    || previous.storeId !== next.storeId
    || previous.serverUrl !== next.serverUrl;
}

function loadConfig() {
  const configPath = hubConfigPath();
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
  let config = loadConfig();
  let configStamp = configFileStamp();

  // ตัวเดียวต่อเครื่องเท่านั้น: Scheduled Task และ Launcher อาจสั่งเปิดพร้อมกันได้
  const runtime = createHubRuntimeState();
  const lock = runtime.acquireLock();
  if (!lock.ok) {
    console.log(
      `StoreOS Print Hub กำลังทำงานอยู่แล้ว (PID ${lock.holderPid}) — ปิดตัวนี้ทิ้งเพื่อไม่ให้พิมพ์ซ้อนกัน`,
    );
    process.exitCode = 3;
    return;
  }

  console.log(`StoreOS Print Hub started for store ${config.storeId} -> ${config.serverUrl}`);
  runtime.update({ state: "starting", storeId: config.storeId });
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    // Launcher เขียน config ใหม่ตอนขอ token ให้เครื่องนี้ แล้วสั่ง restart task ต่อ
    // แต่การ restart อาจไม่ผ่าน (สิทธิ์/นโยบายเครื่อง) — ถ้าเราไม่อ่านไฟล์ซ้ำเลย
    // เครื่องจะค้าง 401 ตลอดไปทั้งที่ token ที่ถูกต้องนอนอยู่ในไฟล์ข้าง ๆ
    const stamp = configFileStamp();
    if (stamp !== null && stamp !== configStamp) {
      configStamp = stamp;
      try {
        const next = loadConfig();
        if (hasCredentialChanged(config, next)) {
          config = next;
          console.log("พบค่าตั้งค่าใหม่ในไฟล์ — ใช้ token ล่าสุดต่อทันที");
          runtime.update({ state: "starting", lastErrorCode: null, storeId: config.storeId });
        }
      } catch (err) {
        // ไฟล์กำลังถูกเขียนอยู่/ไม่ครบ — ใช้ค่าเดิมต่อ แล้วลองใหม่รอบหน้า
        console.error(`อ่านค่าตั้งค่าใหม่ไม่สำเร็จ: ${err instanceof Error ? err.message : err}`);
      }
    }

    let waitMs = config.pollIntervalMs;
    try {
      const result = await runPollCycle({
        config,
        fetchImpl: fetch,
        printJob: async (target, bytes) => {
          if (target.kind === "bt") return sendToComPort(target.device, bytes);
          if (target.kind === "usb") {
            const chosen = await printUsbJob(target.binding ?? target.device, bytes);
            console.log(`USB job printed on "${chosen.name}" (${chosen.port || "unknown port"}).`);
            return chosen;
          }
          return sendToSocket(target.host, target.port, bytes);
        },
      });
      const pollAt = new Date().toISOString();
      if (result.authFailed) {
        console.error("Hub token rejected (401). Check storeId/hubToken in config.");
        runtime.update({ state: "error", lastPollAt: pollAt, lastErrorCode: "auth_rejected", storeId: config.storeId });
        waitMs = ERROR_BACKOFF_MS;
      } else if (result.outdated) {
        // เซิร์ฟเวอร์ปฏิเสธ protocol รุ่นนี้ -> รอนานขึ้นและบอกวิธีแก้ ไม่ถล่ม endpoint
        console.error(result.message);
        runtime.update({ state: "outdated", lastPollAt: pollAt, lastErrorCode: "protocol_unsupported", storeId: config.storeId });
        waitMs = Math.max(ERROR_BACKOFF_MS * 4, waitMs);
      } else if (result.ok) {
        runtime.update({
          state: "ready",
          lastPollAt: pollAt,
          lastSuccessAt: pollAt,
          lastErrorCode: null,
          printersSeen: result.printersSeen ?? null,
          storeId: config.storeId,
        });
        // processed = จำนวนงานที่ "จัดการแล้ว" ไม่ใช่ "พิมพ์สำเร็จ" — บางใบ ack เป็น failed/unknown
        if (result.processed > 0) console.log(`Handled ${result.processed} job(s) this cycle.`);
      } else {
        runtime.update({ state: "degraded", lastPollAt: pollAt, lastErrorCode: `http_${result.status ?? "error"}`, storeId: config.storeId });
        waitMs = ERROR_BACKOFF_MS;
      }
    } catch (err) {
      console.error(`Poll cycle failed: ${err instanceof Error ? err.message : err}`);
      runtime.update({ state: "degraded", lastErrorCode: "poll_failed", storeId: config.storeId });
      waitMs = ERROR_BACKOFF_MS;
    }
    await sleep(waitMs);
  }
  runtime.update({ state: "stopping", storeId: config.storeId });
  runtime.release();
  console.log("StoreOS Print Hub stopped.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
