// P10 — รวบหลักฐานของรอบนี้ไว้ที่เดียว (ไม่มี transcript/audio ในไฟล์ผลลัพธ์)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const evidence = {
  capturedAt: new Date().toISOString(),
  head: run('git rev-parse --short HEAD'),
  branch: run('git rev-parse --abbrev-ref HEAD'),
  version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  scope: {
    completed: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P9', 'P10 (บางส่วน)'],
    skipped: {
      P8: 'Windows Standby — ไม่มี windows-host.ts/standby-policy.ts ในโปรเจกต์ ตามกฎ P0 ของแผนเองให้ทำ P1–P7 แบบ push-to-talk แล้วหยุด',
    },
    versionRange: {
      planReserved: '0.43.x',
      used: '0.44.x',
      reason: '0.43.0 ถูก Stock Pool ใช้ไปแล้ว (deploy prod 2026-09-04)',
    },
  },
  measurements: {
    providerLatencyMs: [1816, 3540, 3845],
    note: 'gpt-4o-mini · Responses API · structured output · วัดจากเครื่องพัฒนา 3 ครั้ง',
    timeoutDecision:
      'แผนกำหนด 2000ms แต่ค่าที่วัดได้เกินทุกครั้ง จึงตั้ง default 6000ms และเปิดให้ override ด้วย AI_VOICE_INTENT_TIMEOUT_MS — ต้องวัด p95 จริงตอน pilot',
  },
  gates: {},
};

const gate = (name, cmd, { allowFail = false } = {}) => {
  const started = Date.now();
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    evidence.gates[name] = { ok: true, ms: Date.now() - started, tail: out.trim().split('\n').slice(-3) };
  } catch (error) {
    const tail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-6);
    evidence.gates[name] = { ok: false, allowFail, ms: Date.now() - started, tail };
  }
  console.log(`${evidence.gates[name].ok ? 'PASS' : 'FAIL'}  ${name}`);
};

gate('typecheck', 'npx tsc --noEmit');
gate('unit:voice+ai', 'npx vitest run --reporter=dot voice ai-');
gate('build', 'npm run build');

fs.writeFileSync('artifacts/voice-ai-phase1/release-gate.json', JSON.stringify(evidence, null, 2));
console.log('\nเขียนหลักฐานที่ artifacts/voice-ai-phase1/release-gate.json');
