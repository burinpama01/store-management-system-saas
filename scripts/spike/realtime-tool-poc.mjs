// M1 PoC — พิสูจน์ OpenAI Realtime tool round-trip กับ API จริง (เกต §11 ของ plan v2)
//
// ทำงานเฉพาะ dev เครื่องนักพัฒนา (ไม่ deploy) — ห้ามใช้เป็นตัวอย่าง production
//   1) สร้าง session + tool `system_echo` ({message} → {message}) + instruction ไทยสั้น ๆ
//   2) ส่งข้อความไทยที่บังคับให้เรียก tool
//   3) รับ function_call → ส่ง function_call_output → รับคำยืนยันจาก model (text หรือ audio transcript)
//
// ข้อปฏิบัติ: OPENAI_API_KEY อ่านจาก env เครื่องหรือ .env.local เท่านั้น — ห้าม print/ลง log คีย์ทุกกรณี
// รัน: node scripts/spike/realtime-tool-poc.mjs   (เขียนผลลง artifacts/realtime-tool-poc.log)
// เลือก model: env REALTIME_POC_MODEL → ค่าเริ่ม gpt-realtime-mini → ยอม fallback ตามที่ /v1/models รายงานจริง

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const LOG_PATH = path.join(repoRoot, "artifacts", "realtime-tool-poc.log");
const OVERALL_TIMEOUT_MS = 110_000;

// ── log helpers ──────────────────────────────────────────────────────────────
const logLines = [];
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logLines.push(line);
  console.log(line);
}
function writeLog() {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, logLines.join("\n") + "\n", "utf8");
  console.log(`\nlog written → ${LOG_PATH}`);
}
process.on("exit", () => {
  if (logLines.length > 0) writeLog();
});

// ── คีย์ (ห้ามแสดงค่า) ────────────────────────────────────────────────────────
function readApiKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 10) {
    log("OPENAI_API_KEY source: process.env");
    return process.env.OPENAI_API_KEY;
  }
  const envLocal = path.join(repoRoot, ".env.local");
  if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, "utf8").split(/\r?\n/)) {
      const match = line.match(/^OPENAI_API_KEY=(.*)$/);
      if (match) {
        const value = match[1].trim().replace(/^["']|["']$/g, "");
        if (value.length > 10) {
          log("OPENAI_API_KEY source: .env.local (ค่าไม่แสดง)");
          return value;
        }
      }
    }
  }
  throw new Error("OPENAI_API_KEY ไม่พบทั้ง env และ .env.local — ยกเลิก PoC");
}

// ── model discovery (หลักฐานว่า account นี้ใช้ realtime ตัวไหนได้) ─────────────
async function listRealtimeModels(apiKey) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    log(`GET /v1/models → HTTP ${response.status} (ใช้ค่าเริ่มต่อ ไม่ถือว่า fail)`);
    return null;
  }
  const payload = await response.json();
  const ids = (payload.data ?? []).map((m) => m.id).filter((id) => id.includes("realtime")).sort();
  log(`realtime models ที่ /v1/models รายงาน: ${JSON.stringify(ids)}`);
  return ids;
}

function pickModelOrder(available) {
  const preferred = process.env.REALTIME_POC_MODEL;
  const defaults = ["gpt-realtime-mini", "gpt-4o-mini-realtime-preview"];
  const fromAvailable = available?.length ? available : defaults;
  if (preferred) {
    log(`REALTIME_POC_MODEL ถูกกำหนด: ${preferred} (ลองก่อน)`);
    return [preferred, ...fromAvailable.filter((m) => m !== preferred)].slice(0, 3);
  }
  // ถูกสุดที่รองรับเสียงไทยตามแผน = realtime-mini family (รวม gpt-realtime-2.1-mini ที่ account รายงาน)
  return [...fromAvailable].sort((a, b) => {
    const rank = (id) => (id.includes("realtime-mini") || (id.includes("realtime") && id.includes("mini")) ? 0 : id.startsWith("gpt-4o-mini-realtime") ? 1 : 2);
    return rank(a) - rank(b);
  }).slice(0, 3);
}

// ── session config ตาม family ของ model (GA gpt-realtime* ใช้รูปทรง session ใหม่) ──
function buildSessionUpdate(model) {
  const tools = [{
    type: "function",
    name: "system_echo",
    description: "Dev tool สำหรับพิสูจน์ tool round-trip — คืนข้อความที่ได้รับกลับมาตรงตัว",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "ข้อความที่จะสะท้อนกลับ" } },
      required: ["message"],
      additionalProperties: false,
    },
  }];
  const instructions = "คุณคือผู้ช่วยทดสอบภาษาไทย เมื่อผู้ใช้ขอให้เรียก system_echo ให้เรียกทันที แล้วตอบยืนยันสั้น ๆ เป็นภาษาไทยว่าเรียกแล้วพร้อมข้อความที่ tool คืนมา";
  if (model.startsWith("gpt-realtime")) {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        tools,
        tool_choice: "auto",
      },
      __family: "ga",
    };
  }
  return {
    type: "session.update",
    session: {
      instructions,
      voice: "alloy",
      modalities: ["text", "audio"],
      tools,
      tool_choice: "auto",
    },
    __family: "legacy",
  };
}

// ── WS run ต่อ 1 model ───────────────────────────────────────────────────────
function connectWs(model, apiKey) {
  return new Promise((resolve, reject) => {
    const WebSocket = requireWs();
    // GA API (gpt-realtime*) ห้ามใส่ header OpenAI-Beta: realtime=v1 — API ตอบ error
    // beta_api_shape_disabled ("The Realtime Beta API is no longer supported") ตามหลักฐานใน log
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", (error) => reject(Object.assign(error, { phase: "connect" })));
  });
}

// ws เป็น devDependency เท่านั้น — เป็น CJS ที่ export คลาสตรง ๆ (พร้อม .WebSocket alias) จึงต้องเลือกรูปแบบให้ถูก
import { createRequire } from "node:module";
const requireWs = () => {
  const mod = createRequire(import.meta.url)("ws");
  return mod.WebSocket ?? mod.default ?? mod;
};

function waitFor(ws, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`รอ event "${type}" เกิน ${timeoutMs}ms`));
    }, timeoutMs);
    function onMessage(raw) {
      let event;
      try { event = JSON.parse(raw.toString("utf8")); } catch { return; }
      // debug: บันทึก event ที่เข้ามาทุกชนิด (payload ย่อ) เพื่อให้ fail ได้พร้อมหลักฐาน
      const preview = JSON.stringify(event).slice(0, 300);
      log(`event เข้า: ${event.type} — ${preview}`);
      if (event.type === "error") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(new Error(`API error event ระหว่างรอ "${type}": ${preview}`));
        return;
      }
      if (event.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(event);
      }
    }
    ws.on("message", onMessage);
  });
}

async function runOnce(model, apiKey) {
  const trace = [];
  const note = (type) => { trace.push(type); };
  log(`\n── พยายามต่อ model ${model} ──`);
  const ws = await connectWs(model, apiKey);
  log("WebSocket เปิดแล้ว (wss://api.openai.com/v1/realtime)");

  const sessionUpdate = buildSessionUpdate(model);
  const family = sessionUpdate.__family;
  delete sessionUpdate.__family;
  ws.send(JSON.stringify(sessionUpdate));
  log(`session.update ส่งแล้ว (family=${family}, tools=system_echo, tool_choice=auto)`);

  const acked = await waitFor(ws, "session.updated", 15_000);
  const ackedTools = JSON.stringify(acked.session?.tools ?? acked.session?.tool_choice ?? null);
  log(`session.updated รับแล้ว — model ที่ API ยืนยัน: ${acked.session?.model ?? model}; tool ใน session: ${ackedTools.slice(0, 200)}`);

  // 1) ส่ง input ไทยที่บังคับเรียก tool
  const userText = "เรียก system_echo ด้วยข้อความ สวัสดี";
  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
  }));
  ws.send(JSON.stringify({ type: "response.create" }));
  log(`ส่ง input: "${userText}" + response.create`);

  // 2) รอ function_call (สังเกตทั้ง output_item.added และ function_call_arguments.done)
  let callId = null;
  let callArgs = null;
  let callName = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !callArgs) {
    const event = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("รอ function_call เกินเวลา")), deadline - Date.now());
      ws.once("message", (raw) => {
        clearTimeout(timer);
        let parsed;
        try { parsed = JSON.parse(raw.toString("utf8")); } catch { resolve(null); return; }
        resolve(parsed);
      });
    }).catch((error) => { throw error; });
    if (!event) continue;
    note(event.type);
    if (event.type === "error") {
      throw new Error(`API ส่ง error event: ${JSON.stringify(event).slice(0, 400)}`);
    }
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      callId = event.item.call_id ?? event.item.id;
      callName = event.item.name;
      log(`function_call เริ่ม: name=${callName} call_id=${callId}`);
    }
    if (event.type === "response.function_call_arguments.done") {
      callId = event.call_id ?? callId;
      callName = event.name ?? callName;
      callArgs = event.arguments;
      log(`function_call arguments เสร็จ: name=${callName} args=${String(callArgs).slice(0, 200)}`);
    }
  }
  if (!callArgs) throw new Error("ไม่ได้รับ function_call ภายใน 60 วิ (model ตอบด้วยวิธีอื่น — ดู trace)");
  if (callName !== "system_echo") throw new Error(`model เรียก tool ผิด: ${callName}`);

  // 3) ส่ง function_call_output กลับเข้า session (sideband pattern เดียวกับที่ production จะทำผ่าน route เรา)
  const parsedArgs = JSON.parse(callArgs);
  const outputPayload = { message: String(parsedArgs.message ?? "") };
  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(outputPayload) },
  }));
  ws.send(JSON.stringify({ type: "response.create" }));
  log(`ส่ง function_call_output: ${JSON.stringify(outputPayload)} + response.create`);

  // 4) รอ response.done รอบสอง → เก็บคำยืนยัน (text หรือ audio transcript) + usage
  //    response.done ของรอบแรก (รอบที่สั่ง function_call) มาถึงหลังส่ง output แล้ว — ต้องข้าม
  //    โดยวนรับจนได้ response ที่มี message ของผู้ช่วย (พูดตอบหลังได้ output ของ tool)
  let finalDone = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const done = await waitFor(ws, "response.done", 45_000);
    const outputs = done.response?.output ?? [];
    const usage = done.response?.usage ?? null;
    log(`response.done #${attempt}: id=${done.response?.id} items=${outputs.map((o) => o.type).join(",")}`);
    log(`  usage: ${JSON.stringify(usage)}`);
    for (const item of outputs) {
      if (item.type === "message") {
        log(`  message content: ${JSON.stringify(item.content)?.slice(0, 800)}`);
      }
    }
    // response แรกอาจมีทั้งคำทัก (message) และ function_call ปนกัน — คำยืนยันที่ใช้ได้ต้องมา "หลัง"
    // ส่ง function_call_output คือ response ที่มี message แล้วไม่มี function_call อีกต่อหนึ่ง
    if (outputs.some((o) => o.type === "message") && !outputs.some((o) => o.type === "function_call")) { finalDone = done; break; }
  }
  if (!finalDone) throw new Error("ไม่พบ response.done ที่มี message ของผู้ช่วยหลังส่ง function_call_output");
  const outputs = finalDone.response?.output ?? [];
  const usage = finalDone.response?.usage ?? null;
  const sayings = [];
  for (const item of outputs) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      // GA API ใช้ part type "output_audio" (มี transcript) — รองรับชื่อเก่า "audio" และ "text" ด้วย
      if ((part.type === "output_audio" || part.type === "audio") && typeof part.transcript === "string" && part.transcript.length > 0) sayings.push(part.transcript);
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) sayings.push(part.text);
    }
  }
  log(`คำยืนยันจาก model: ${JSON.stringify(sayings)}`);
  log(`event trace รอบนี้: ${JSON.stringify(trace)}`);

  const echoed = sayings.some((s) => s.includes(outputPayload.message));
  if (sayings.length === 0) throw new Error("ไม่พบข้อความยืนยันใน response.done รอบสอง");
  if (!echoed) log("⚠️ คำยืนยันไม่อ้างข้อความที่ echo ตรงตัว — ถือว่า round-trip ผ่านแต่ต้องอ่านคำตอบเอง");
  ws.close();
  return { model, family, usage, sayings, echoed, ackedModel: acked.session?.model ?? model };
}

async function main() {
  log("=== OpenAI Realtime tool round-trip PoC (M1) ===");
  const apiKey = readApiKey();
  const available = await listRealtimeModels(apiKey);
  const candidates = pickModelOrder(available);
  log(`ลำดับ model ที่จะลอง: ${JSON.stringify(candidates)}`);

  const failures = [];
  for (const model of candidates) {
    try {
      const result = await runOnce(model, apiKey);
      const pass = true;
      log("\n=== VERDICT: PASS — tool round-trip ครบ (function_call → function_call_output → คำยืนยันจาก model) ===");
      log(`model ที่พิสูจน์ผ่าน: ${result.model} (API ยืนยัน: ${result.ackedModel}, session family: ${result.family})`);
      log(`echo ตรงตัว: ${result.echoed ? "ใช่" : "ไม่ตรงตัว (ดูคำยืนยันด้านบน)"}`);
      log(`ต้นทุนรอบนี้ (จาก usage): ${JSON.stringify(result.usage)}`);
      log("หมายเหตุต้นทุน: usage เป็น token ต่อรอบคำสั่ง (input_text สั้น + ตอบเสียงสั้น) — แปลงเป็นต้นทุน/นาทีต้องคูณอัตรา 1 นาทีของ pricing page ณ วันเปิดใช้");
      process.exitCode = 0;
      return;
    } catch (error) {
      failures.push({ model, error: String(error?.message ?? error) });
      log(`✗ model ${model} ล้มเหลว: ${String(error?.message ?? error).slice(0, 400)}`);
    }
  }
  log("\n=== VERDICT: FAIL — ทุก model ที่ลองไม่พิสูจน์ tool round-trip ได้ ===");
  log(`รายละเอียดความล้มเหลว: ${JSON.stringify(failures, null, 2)}`);
  log("ตามเกต §11: ห้ามเขียน production ต่อจนกว่าจะพิสูจน์ผ่าน — รายงานหลักฐานข้างบนทั้งหมด");
  process.exitCode = 1;
}

const overallTimer = setTimeout(() => {
  log(`✗ หมดเวลารวม ${OVERALL_TIMEOUT_MS}ms — ยกเลิก PoC`);
  process.exit(2);
}, OVERALL_TIMEOUT_MS);
overallTimer.unref?.();

main().catch((error) => {
  log(`✗ PoC ล้มเหลว: ${String(error?.stack ?? error).slice(0, 800)}`);
  process.exitCode = 1;
});
