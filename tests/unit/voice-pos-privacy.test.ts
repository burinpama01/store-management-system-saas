// U16 — Voice privacy: สแกน schema + source + สัญญา telemetry
// เจตนา: ถ้ามีใครเผลอเพิ่มการเก็บเสียง/คำพูด/normalized phrase เข้ามา เทสต์ชุดนี้ต้องพังทันที
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "@/modules/voice-pos/parser";
import { buildVoiceTelemetry } from "@/modules/voice-pos/types";
import {
  createInMemoryVoiceTelemetrySink,
  sanitizeVoiceTelemetry,
  VOICE_TELEMETRY_ALLOWED_KEYS,
  VOICE_TELEMETRY_RETENTION_MS,
} from "@/modules/voice-pos/telemetry";

const ROOT = process.cwd();

/** ตัดคอมเมนต์ออกก่อนสแกน — เราสนใจ "โค้ดที่ทำงานจริง" ไม่ใช่คำอธิบายที่พูดถึงข้อห้าม */
function stripComments(source: string, kind: "ts" | "sql"): string {
  if (kind === "sql") return source.replace(/--.*$/gm, "");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readAll(dir: string, filter: (name: string) => boolean): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAll(full, filter));
    else if (filter(entry.name)) out.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

describe("privacy scan — schema", () => {
  it("ไม่มีคอลัมน์สำหรับเก็บเสียง/คำพูด/normalized phrase ใน migration ใดเลย", () => {
    const migrations = readAll(join(ROOT, "supabase", "migrations"), (n) => n.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0);

    // ชื่อคอลัมน์ต้องห้าม — จับเฉพาะรูปแบบ "<ชื่อ> <type>" ในคำสั่งสร้าง/เพิ่มคอลัมน์
    const forbidden = /\b(transcript|audio_url|audio_data|voiceprint|spoken_text|utterance)\b/i;
    const offenders = migrations.filter((file) => forbidden.test(stripComments(file.source, "sql")));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("voice_aliases เก็บเฉพาะ alias ที่ร้านพิมพ์เอง (มี created_by ไว้ตรวจย้อนหลัง)", () => {
    const foundation = readFileSync(
      join(ROOT, "supabase", "migrations", "20260831000001_unified_pos_foundation.sql"),
      "utf8",
    );
    expect(foundation).toContain("create table public.voice_aliases");
    expect(foundation).toContain("created_by");
    expect(foundation).toContain("is_active");
  });
});

describe("privacy scan — source", () => {
  const voiceModule = readAll(join(ROOT, "src", "modules", "voice-pos"), (n) => n.endsWith(".ts"));
  const voiceUi = [
    join(ROOT, "src", "shared", "components", "VoiceCommandButton.tsx"),
    join(ROOT, "src", "app", "pos", "unified", "VoicePosController.tsx"),
  ].map((path) => ({ path, source: readFileSync(path, "utf8") }));

  it("โมดูลเสียงไม่เขียนอะไรลงที่เก็บถาวรเลย", () => {
    const persistence = /(localStorage|sessionStorage|indexedDB|document\.cookie)/;
    const offenders = [...voiceModule, ...voiceUi].filter((file) =>
      persistence.test(stripComments(file.source, "ts")),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("ไม่มี console.* ในเส้นทางเสียง (กัน transcript หลุดลง log)", () => {
    const offenders = [...voiceModule, ...voiceUi].filter((file) =>
      /console\.(log|info|warn|error|debug)/.test(stripComments(file.source, "ts")),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("parser/adapter ไม่ยิง network เอง", () => {
    const offenders = voiceModule.filter(
      (file) =>
        !file.path.endsWith("alias-repository.ts") &&
        /(fetch\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon)/.test(stripComments(file.source, "ts")),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("repository ของ alias ไม่มีเส้นทางรับ transcript (ห้าม auto-learning)", () => {
    const aliasRepo = readFileSync(join(ROOT, "src", "modules", "voice-pos", "alias-repository.ts"), "utf8");
    expect(stripComments(aliasRepo, "ts")).not.toMatch(/transcript/i);
    expect(aliasRepo).toContain("created_by");
  });
});

describe("telemetry contract", () => {
  it("เก็บได้เฉพาะฟิลด์ที่อนุญาต และไม่มีคำพูดของผู้ใช้", () => {
    const result = parseVoiceCommand("เพิ่มลาเต้ 2 แก้ว");
    const event = buildVoiceTelemetry(result, "th-TH", new Date("2026-09-03T00:00:00.000Z"));
    expect(Object.keys(event).sort()).toEqual([...VOICE_TELEMETRY_ALLOWED_KEYS]);
    expect(JSON.stringify(event)).not.toContain("ลาเต้");
  });

  it("sanitize ตัดฟิลด์แปลกปลอมทิ้งแม้ผู้เรียกจะแนบมา", () => {
    const result = parseVoiceCommand("เปิดครัว");
    const dirty = {
      ...buildVoiceTelemetry(result, "th-TH"),
      transcript: "เปิดครัว",
      audio: "base64...",
    } as unknown as ReturnType<typeof buildVoiceTelemetry>;

    const clean = sanitizeVoiceTelemetry(dirty);
    expect(Object.keys(clean).sort()).toEqual([...VOICE_TELEMETRY_ALLOWED_KEYS]);
    expect(JSON.stringify(clean)).not.toContain("เปิดครัว");
    expect(JSON.stringify(clean)).not.toContain("base64");
  });

  it("purge ทิ้งเหตุการณ์ที่เกิน 30 วัน", () => {
    const sink = createInMemoryVoiceTelemetrySink();
    const result = parseVoiceCommand("เปิดครัว");
    const now = new Date("2026-09-03T00:00:00.000Z");
    const old = new Date(now.getTime() - VOICE_TELEMETRY_RETENTION_MS - 1000);

    sink.record(buildVoiceTelemetry(result, "th-TH", old), old);
    expect(sink.list(old)).toHaveLength(1);

    sink.record(buildVoiceTelemetry(result, "th-TH", now), now);
    const remaining = sink.list(now);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].at).toBe(now.toISOString());
  });

  it("เวลาที่อ่านไม่ออก ถือว่าตรวจอายุไม่ได้ = ไม่เก็บ", () => {
    const sink = createInMemoryVoiceTelemetrySink();
    const result = parseVoiceCommand("เปิดครัว");
    const event = { ...buildVoiceTelemetry(result, "th-TH"), at: "ไม่ใช่เวลา" };
    sink.record(event);
    expect(sink.list()).toHaveLength(0);
  });
});
