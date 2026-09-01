// U8 · R1 backend qualification gate — fail-closed backend verifier
// (plan: Plan/QR Order Voice Unified POS Implementation Plan v2.html, task U8)
//
// Gate sequence (ทุก step บันทึก start/end/exit/trimmed output ลง evidence):
//   preflight  : Docker daemon, supabase CLI, local stack @ 127.0.0.1:54321, git repo,
//                working tree — dirty ต้องอยู่ใน U8 scope เท่านั้น (ตัด noise แล้ว, fail-closed)
//   (a) supabase db reset --local
//   (b) supabase test db --local            → TAP parse, ต้อง Result: PASS + zero failed
//   (b2) realtime readiness probe (U8 2.5)  → รัน U3 เดี่ยว (env inject เหมือน step c) ซ้ำ ≤6 attempt
//                ผ่าน = attempt ใด exit 0 + zero failed/skip · ไม่ผ่าน = รอ 60s แล้วลองใหม่ (เว้นรอบสุดท้าย)
//                ครบ 6 attempt ไม่ผ่าน = step (b2) FAIL → (c)(d) blocked — ทุก attempt (start/end/exit/tail) ลง evidence ครบ
//                เหตุผล: หลัง db reset realtime ต้อง lazy-init tenant ครั้งแรกที่ client connect (วัดได้ 135s-160s+)
//                → step (c) เคยตกทุก gate run ในช่วง warm-up แม้ U3 ผ่านเมื่อรันซ้ำหลังจากนั้น
//   (c) vitest unified-pos integration      → env ถูก inject โดย verifier; ห้ามมี skip; blocked ถ้า (b2) fail
//   (d) full canonical vitest suite         → discovery ต้องไม่มี path ใน dot-workspaces; blocked ถ้า (b2) fail
//   (e) npm run typecheck
//   (f) npm run lint
//   (g) npm run build
//   (h) git diff --check
// verdict: BACKEND_GATE_PASS / BACKEND_GATE_FAIL + evidence JSON/HTML (ไม่มี secret)
//
// Security rules:
//   - keys อ่านจาก `supabase status -o env` ตอน runtime เท่านั้น — ห้าม hardcode/log
//   - URL ต้องเป็น loopback (127.0.0.1/localhost/[::1]) + port 54321 เท่านั้น
//     (mirror tests/integration/helpers/local-supabase.ts)
//   - ทุกบรรทัดที่เก็บลง evidence ผ่าน sanitizeLine() + redact secrets ก่อนเขียน
//
// Usage: node scripts/verify-unified-pos-backend.mjs [--preflight-only]
//   --preflight-only : รัน preflight + discovery + เขียน evidence (verdict SKIPPED_RUN)
//                      ไม่ reset / ไม่รัน test ใดๆ — ใช้ตรวจ shape ของ evidence
//   exit 0 = PASS/SKIPPED_RUN, exit 1 = FAIL, exit 2 = usage error

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'unified-pos');
const OUT_JSON = join(OUT_DIR, 'r1-backend-gate.json');
const OUT_HTML = join(OUT_DIR, 'r1-backend-gate.html');
const VITEST_MJS = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const IS_WIN = process.platform === 'win32';

const GATE_SCHEMA = 'storeos.r1-backend-gate/v1';
const GATE_NAME = 'U8 · R1 backend qualification checkpoint';
const PLAN_REF = 'Plan/QR Order Voice Unified POS Implementation Plan v2.html (U8)';

const LOCAL_API_PORT = 54321;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
// dot-prefixed workspace dirs ที่ห้ามมี test discovery (fail-closed: จับทุก dot segment ด้วย)
const NAMED_FORBIDDEN_DIRS = ['.codex-temp', '.worktrees', '.codex', '.codex-remote-attachments'];
// preflight: working tree — แผน U8 รัน gate "ก่อน" commit ตามลำดับ จึงต้องยอมรับ
// change ของงาน U8 ที่ค้างใน worktree ได้ กติกา (fail-closed คงเดิม):
//   1) เก็บ git status --porcelain ทั้งหมด (staged+unstaged+untracked)
//   2) ตัด noise ที่ repo รู้จักออก (DIRTY_NOISE_PREFIXES)
//   3) ไฟล์ที่เหลือต้องอยู่ใน U8 scope เท่านั้น ไม่งั้น FAIL
//   รายการ dirty เต็มถูกบันทึกลง evidence ทุกกรณี (ผ่าน/ไม่ผ่าน)
const DIRTY_NOISE_PREFIXES = [
  '.codex-temp/',
  '.codex-remote-attachments/',
  'artifacts/',
  'output/',
  'test-results/',
  'Marketing/',
  'Design/',
  'Plan/',
  '.openclaw',
  '.playwright-cli/',
  'probe-types.ts',
  'public/logo.png.png',
];
// U8 scope: ไฟล์ gate tooling + งาน uncommitted ของ U8 (part 1/1.5/1.6 + review fix)
// หมายเหตุ: src/modules/qr-ordering/repository.ts คือ fix ของ review run นี้ (U8 part 2)
// — orchestrator จะตัดรายการนี้ออกได้หลัง commit แล้ว
const U8_DIRTY_ALLOW_EXACT = [
  'scripts/verify-unified-pos-backend.mjs',
  'vitest.config.ts',
  'package.json',
  'package-lock.json',
  'src/modules/qr-ordering/repository.ts',
  'eslint.config.mjs', // U8: hygiene ignores + quarantine react-hooks/set-state-in-effect 5 ไฟล์ legacy
];
function isU8ScopeDirtyPath(p) {
  if (U8_DIRTY_ALLOW_EXACT.includes(p)) return true;
  if (p.startsWith('tests/integration/unified-pos-') && p.endsWith('.test.ts')) return true;
  if (p.startsWith('tests/unit/unified-pos-') && p.endsWith('.test.ts')) return true;
  if (p.startsWith('supabase/tests/')) return true;
  if (p.startsWith('supabase/migrations/20260901')) return true;
  return false;
}
// porcelain v1: path มีช่องว่าง/อักขระพิเศษถูก C-style quote (เช่น "Plan/xxx v1.html")
// scope ของการ match เป็น ASCII prefix ล้วน จึงถอด quote + octal escape แบบพอเพียง
function unquoteGitPath(p) {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p
      .slice(1, -1)
      .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\(["\\])/g, '$1')
      .replace(/\\(t|n|r)/g, (m) => (m === 't' ? '\t' : m === 'n' ? '\n' : '\r'));
  }
  return p;
}
// skip policy: zero-skip — ตัวเลข skip/todo ทุกตัวนับเป็น unexpected
const SKIP_POLICY = 'zero-skip (allowlist ว่าง — ถ้าจะอนุญาตให้ข้ามจริง ต้องมีหลักฐานผู้ใช้)';

// step (b2) realtime readiness probe (U8 part 2.5): หลัง `db reset` realtime ต้อง lazy-init tenant
// ครั้งแรกที่ client connect (วัดได้ 135s-160s+ วันที่ 2026-09-01) — U3 รอบแรกหลัง reset จึงตกได้
// แม้ assertion ถูก (งบ resilient ในตัว 10s+3×40s ไม่พอใน run ที่แย่สุด) — probe จึง "อุ่นเครื่อง" ด้วย
// การรัน U3 เดี่ยวจริงซ้ำ (spawn pipeline เดียวกับ step c) ก่อนขึ้น step (c)
// PASS = มีอย่างน้อย 1 attempt exit 0 + zero failed/skip · FAIL = ครบ 6 attempt → (c)(d) blocked
const READINESS_PROBE_FILE = 'tests/integration/unified-pos-realtime.test.ts';
const READINESS_MAX_ATTEMPTS = 6;
const READINESS_RETRY_WAIT_MS = 60_000; // พักหลัง attempt ที่ fail (เว้นรอบสุดท้าย) — ให้ tenant warm-up
const READINESS_ATTEMPT_TIMEOUT_MS = 600_000; // ต่อ attempt — สูงกว่างบ resilient ในตัว U3 (~3 นาที) มากพอ

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const stripAnsi = (s) => String(s).replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
const toPosix = (p) => String(p).replace(/\\/g, '/');

const SECRET_LINE_RE = /^\s*[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=/;
function sanitizeLine(line) {
  let out = String(line).replace(/\s+$/, '');
  if (SECRET_LINE_RE.test(out)) return '[REDACTED key/secret assignment]';
  out = out.replace(/(postgres(ql)?:\/\/)[^\s"'<>]+/gi, '$1[REDACTED]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED-JWT]');
  out = out.replace(/\bSB_(SECRET|PUBLISHABLE)_[A-Za-z0-9_-]{8,}/g, '[REDACTED-KEY]');
  return out;
}

// shell ที่เหมาะกับ win32: cmd.exe เป็นตัว invoke (supabase/npm/npx/docker เป็น shim/.cmd)
function winCommand(cmd, args) {
  const quote = (a) => (/[\s"|&<>^%!]/.test(a) || a === '' ? `"${String(a).replace(/"/g, '\\"')}"` : a);
  // cmd เองก็อาจมีช่องว่าง (เช่น process.execPath = "C:\Program Files\nodejs\node.exe")
  const cmdPart = /[\s"]/.test(cmd) ? `"${cmd}"` : cmd;
  return `${cmdPart} ${args.map(quote).join(' ')}`.trim();
}

function runQuick(cmd, args, { timeoutMs = 60000, cwd = REPO_ROOT } = {}) {
  const opts = {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    shell: IS_WIN,
    env: { ...process.env, NO_COLOR: '1' },
  };
  const r = IS_WIN ? spawnSync(winCommand(cmd, args), opts) : spawnSync(cmd, args, opts);
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    signal: r.signal,
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// streaming runner: สตรีมทุกบรรทัด (sanitized) ขึ้น console, เก็บ head+tail ลง evidence
function runStreamed({ cmd, args, env = {}, timeoutMs = 300000 }) {
  return new Promise((resolveRun) => {
    const startedAt = new Date();
    const rec = {
      exit_code: null,
      signal: null,
      timed_out: false,
      spawn_error: null,
      started_at: nowIso(),
      ended_at: null,
      duration_ms: 0,
      lines: [],
      total_lines: 0,
    };
    const all = [];
    const HEAD = 12;
    const TAIL = 48;
    let raw = '';
    let child;
    try {
      const opts = { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1', ...env }, windowsHide: true };
      child = IS_WIN ? spawn(winCommand(cmd, args), { ...opts, shell: true }) : spawn(cmd, args, opts);
    } catch (e) {
      rec.spawn_error = String(e && e.message ? e.message : e);
      rec.ended_at = nowIso();
      rec.duration_ms = Date.now() - startedAt.getTime();
      resolveRun({ ...rec, all: [] });
      return;
    }
    const timer = setTimeout(() => {
      rec.timed_out = true;
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* best effort */ }
    }, timeoutMs);

    const flushLine = (lineText) => {
      const clean = sanitizeLine(stripAnsi(lineText)).trim();
      if (clean === '') return;
      all.push(clean);
      rec.total_lines += 1;
      console.log(`    | ${clean}`);
    };
    const handleChunk = (chunk) => {
      raw += String(chunk);
      let i;
      while ((i = raw.indexOf('\n')) >= 0) {
        flushLine(raw.slice(0, i));
        raw = raw.slice(i + 1);
      }
    };

    if (child.stdout) child.stdout.on('data', handleChunk);
    if (child.stderr) child.stderr.on('data', handleChunk);
    child.on('error', (e) => {
      rec.spawn_error = String(e && e.message ? e.message : e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (raw.trim() !== '') flushLine(raw);
      rec.exit_code = code;
      rec.signal = signal;
      rec.ended_at = nowIso();
      rec.duration_ms = Date.now() - startedAt.getTime();
      if (all.length <= HEAD + TAIL) rec.lines = [...all];
      else rec.lines = [...all.slice(0, HEAD), `… ${all.length - HEAD - TAIL} บรรทัดถูกละไว้ (เก็บเฉพาะ head/tail) …`, ...all.slice(-TAIL)];
      resolveRun({ ...rec, all });
    });
  });
}

// ---------------------------------------------------------------------------
// parsers (defensive: missing summary = fail, ไม่ถือว่า pass)
// ---------------------------------------------------------------------------

// `supabase status -o env` → KEY=VALUE (value อาจอยู่ใน quotes)
function parseKeyValueEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// pgTAP summary จาก `supabase test db --local` (pg_prove-style)
// ตัวอย่าง pass:  supabase/tests/000_smoke.sql .. ok
//                 All tests successful.
//                 Files=7, Tests=xxx, 1 wallclock secs (...)
//                 Result: PASS
// ตัวอย่าง fail:  ... .. Failed 2/61 subtests  /  Dubious, test returned 1
function parsePgtapSummary(text) {
  const lines = String(text).split(/\r?\n/).map((l) => stripAnsi(l).trim()).filter(Boolean);
  const merged = lines.join('\n');
  const out = {
    summary_found: false,
    result: null,
    files: null,
    tests: null,
    failed_subtests: 0,
    failed_programs: 0,
    dubious: 0,
    per_file: [],
    all_ok: false,
    bail_out: null,
  };
  const resultM = merged.match(/Result:\s*(PASS|FAIL)/i);
  if (resultM) {
    out.summary_found = true;
    out.result = resultM[1].toUpperCase();
  }
  const countM = merged.match(/Files=(\d+),\s*Tests=(\d+)/);
  if (countM) {
    out.files = Number(countM[1]);
    out.tests = Number(countM[2]);
  }
  const fsM = merged.match(/Failed\s+(\d+)\/(\d+)\s+subtests/);
  if (fsM) out.failed_subtests = Number(fsM[1]);
  const fpM = merged.match(/Failed\s+(\d+)\/(\d+)\s+test programs/);
  if (fpM) out.failed_programs = Number(fpM[1]);
  const dM = merged.match(/Dubious, test returned\s+(\d+)/);
  if (dM) out.dubious = Number(dM[1]);
  const bailM = merged.match(/Bail out!\s*(.*)$/m);
  if (bailM) out.bail_out = bailM[1].trim() || '(no message)';
  for (const line of lines) {
    const m = line.match(/^(.+?\.sql)\s*\.{2,}\s*(.*)$/);
    if (m) out.per_file.push({ file: m[1], status: m[2].trim(), ok: /^ok\b/.test(m[2].trim()) });
  }
  out.all_ok = out.per_file.length > 0 && out.per_file.every((p) => p.ok);
  return out;
}

// vitest summary (ANSI-stripped): "Test Files  1 failed | 119 passed (120)" / "Tests  4 passed | 2 skipped (6)"
function parseVitestSummary(text) {
  const lines = String(text).split(/\r?\n/).map((l) => stripAnsi(l).trim());
  const out = {
    summary_found: false,
    test_files: { passed: 0, failed: 0, skipped: 0, todo: 0, total: null },
    tests: { passed: 0, failed: 0, skipped: 0, todo: 0, total: null },
    raw_summary_lines: [],
  };
  const token = (line) => {
    const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) counts[m[2]] = Number(m[1]);
    const totalM = line.match(/\((\d+)\)\s*$/);
    return { counts, total: totalM ? Number(totalM[1]) : null };
  };
  for (const line of lines) {
    if (/^Test Files\b/.test(line)) {
      out.summary_found = true;
      const t = token(line);
      out.test_files = { ...t.counts, total: t.total };
      out.raw_summary_lines.push(line);
    } else if (/^Tests\s/.test(line)) {
      out.summary_found = true;
      const t = token(line);
      out.tests = { ...t.counts, total: t.total };
      out.raw_summary_lines.push(line);
    }
  }
  return out;
}

// `vitest list --filesOnly` → 1 path/บรรทัด; offender = segment ที่ขึ้นต้นด้วย '.'
// U8 part 1.5: เมื่อใช้ vitest projects แต่ละบรรทัดมี prefix "[ชื่อ project] " — ตัดออกก่อน parse
function parseDiscoveryList(stdout) {
  const files = String(stdout)
    .split(/\r?\n/)
    .map((l) => toPosix(stripAnsi(l).trim()).replace(/^\[[^\]]+\]\s*/, ''))
    .filter((l) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(l));
  const offenders = [];
  const namedHits = [];
  for (const f of files) {
    const segs = f.replace(/^\.\//, '').split('/');
    for (const seg of segs) {
      if (seg.startsWith('.') && seg !== '.' && seg !== '..') {
        offenders.push(f);
        if (NAMED_FORBIDDEN_DIRS.includes(seg)) namedHits.push(seg);
        break;
      }
    }
  }
  return { file_count: files.length, offenders, named_hits: [...new Set(namedHits)], ok: offenders.length === 0 };
}

// ---------------------------------------------------------------------------
// local supabase env (runtime only, loopback-only, never logged)
// ---------------------------------------------------------------------------

function getLocalSupabaseEnv() {
  const r = runQuick('supabase', ['status', '-o', 'env'], { timeoutMs: 90000 });
  if (r.status !== 0 || r.error) {
    throw new Error(
      `supabase status -o env ล้มเหลว (exit ${r.status}${r.error ? `, ${r.error}` : ''}) — ต้องรัน supabase start ก่อน (preflight abort, ไม่มี skip)`
    );
  }
  const vars = parseKeyValueEnv(`${r.stdout}\n${r.stderr}`);

  const apiUrl = vars.API_URL;
  if (!apiUrl) throw new Error('API_URL หายจาก supabase status -o env — local stack ยังไม่พร้อม');
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`API_URL "${apiUrl}" ไม่ใช่ URL ที่ถูกต้อง`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`API_URL ต้องใช้ protocol http/https (ได้รับ "${parsed.protocol}")`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`non-loopback URL rejected — API_URL ต้องเป็น 127.0.0.1 / localhost / [::1] เท่านั้น (ได้รับ hostname "${hostname}")`);
  }
  if (parsed.port !== String(LOCAL_API_PORT)) {
    throw new Error(`API_URL ต้องอยู่ที่ port ${LOCAL_API_PORT} เท่านั้น (ได้รับ "${parsed.port}")`);
  }

  const publishable = vars.PUBLISHABLE_KEY || vars.ANON_KEY;
  const service = vars.SERVICE_ROLE_KEY || vars.SECRET_KEY;
  if (!publishable) throw new Error('PUBLISHABLE_KEY/ANON_KEY หายจาก supabase status -o env');
  if (!service) throw new Error('SERVICE_ROLE_KEY/SECRET_KEY หายจาก supabase status -o env');

  return {
    url: apiUrl,
    publishable,
    service,
    publishableSource: vars.PUBLISHABLE_KEY ? 'PUBLISHABLE_KEY' : 'ANON_KEY',
    serviceSource: vars.SERVICE_ROLE_KEY ? 'SERVICE_ROLE_KEY' : 'SECRET_KEY',
    // เก็บไว้สำหรับ redact หลัง evidence สร้างเสร็จ (ไม่เคยพิมพ์ออกมา)
    redactSecrets: [publishable, service, vars.ANON_KEY, vars.SECRET_KEY, vars.JWT_SECRET].filter(Boolean),
  };
}

async function checkLocalStackHttp(env) {
  try {
    const res = await fetch(`${env.url}/rest/v1/`, {
      headers: { apikey: env.publishable },
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, detail: `GET ${env.url}/rest/v1/ → HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `GET ${env.url}/rest/v1/ ไม่สำเร็จ: ${String(e && e.message ? e.message : e)}` };
  }
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function runPreflight() {
  const checks = [];

  // 1. git repo
  const gitR = runQuick('git', ['rev-parse', '--is-inside-work-tree']);
  const gitOk = gitR.status === 0 && gitR.stdout.trim() === 'true';
  checks.push({ id: 'git-repo', label: 'git repository present', ok: gitOk, detail: gitOk ? 'worktree ตรวจพบ' : `git rev-parse ล้มเหลว (exit ${gitR.status})` });

  // 2. docker daemon + supabase containers
  const dockerR = runQuick('docker', ['ps', '--format', '{{.Names}}|{{.Image}}'], { timeoutMs: 45000 });
  const dockerOk = dockerR.status === 0 && !dockerR.error;
  const containers = dockerOk
    ? dockerR.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, image] = l.split('|');
        return { name: (name || '').trim(), image: (image || '').trim() };
      })
    : [];
  const supabaseContainers = containers.filter((c) => c.name.startsWith('supabase_'));
  const dbContainer = supabaseContainers.find((c) => c.name.startsWith('supabase_db_'));
  checks.push({
    id: 'docker-daemon',
    label: 'docker daemon reachable + supabase stack containers',
    ok: dockerOk && supabaseContainers.length >= 4,
    detail: dockerOk ? `supabase containers: ${supabaseContainers.length}, db: ${dbContainer ? dbContainer.name : '(ไม่พบ)'}` : `docker ps ล้มเหลว (exit ${dockerR.status}${dockerR.error ? `, ${dockerR.error}` : ''})`,
  });

  // 3. supabase CLI
  const supaR = runQuick('supabase', ['--version']);
  const supaVerM = (supaR.status === 0 ? `${supaR.stdout}\n${supaR.stderr}` : '').match(/\b(\d+\.\d+\.\d+)\b/);
  checks.push({ id: 'supabase-cli', label: 'supabase CLI available', ok: supaR.status === 0, detail: supaVerM ? `v${supaVerM[1]}` : `supabase --version ล้มเหลว (exit ${supaR.status})` });

  // 4. node/npm (informational)
  const npmR = runQuick('npm', ['--version']);
  checks.push({ id: 'node-npm', label: 'node/npm runtime', ok: npmR.status === 0, detail: `node ${process.version} / npm ${npmR.status === 0 ? npmR.stdout.trim() : '(ไม่ทราบ)'}` });

  // 5. local supabase env (loopback + port 54321 + keys)
  let localEnv = null;
  try {
    localEnv = getLocalSupabaseEnv();
    checks.push({ id: 'local-supabase-env', label: 'local supabase env (loopback-only, runtime)', ok: true, detail: `${localEnv.url} — publishable=${localEnv.publishableSource}, service=${localEnv.serviceSource}` });
  } catch (e) {
    checks.push({ id: 'local-supabase-env', label: 'local supabase env (loopback-only, runtime)', ok: false, detail: e.message });
  }

  // 6. local stack HTTP reachable
  if (localEnv) {
    const http = await checkLocalStackHttp(localEnv);
    checks.push({ id: 'local-stack-http', label: `local stack reachable @ 127.0.0.1:${LOCAL_API_PORT}`, ok: http.ok, detail: http.detail });
  } else {
    checks.push({ id: 'local-stack-http', label: `local stack reachable @ 127.0.0.1:${LOCAL_API_PORT}`, ok: false, detail: 'ข้ามเพราะ local-supabase-env ล้มเหลว' });
  }

  // 7. working tree — dirty ทั้งหมด (หลังตัด noise) ต้องอยู่ใน U8 scope เท่านั้น
  const dirtyR = runQuick('git', ['status', '--porcelain']);
  const rawDirtyLines = dirtyR.status === 0
    ? dirtyR.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
    : [];
  const dirtyEntries = rawDirtyLines.map((line) => {
    const status = line.slice(0, 2);
    let path = unquoteGitPath(line.slice(3));
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4); // rename: พิจารณา path ปลายทาง
    return { status, path, line };
  });
  const noiseEntries = dirtyEntries.filter((e) => DIRTY_NOISE_PREFIXES.some((pfx) => e.path.startsWith(pfx)));
  const remainingEntries = dirtyEntries.filter((e) => !noiseEntries.includes(e));
  const inScopeEntries = remainingEntries.filter((e) => isU8ScopeDirtyPath(e.path));
  const unexpectedEntries = remainingEntries.filter((e) => !isU8ScopeDirtyPath(e.path));
  const dirtyOk = dirtyR.status === 0 && unexpectedEntries.length === 0;
  if (dirtyR.status !== 0) rawDirtyLines.push('<git status ล้มเหลว>');
  const dirtySummary = `noise=${noiseEntries.length}, in-scope=${inScopeEntries.length}, unexpected=${unexpectedEntries.length}`;
  checks.push({
    id: 'worktree-clean',
    label: 'working tree — dirty limited to U8 scope (noise excluded)',
    ok: dirtyOk,
    detail: dirtyOk
      ? `ไม่มี change นอก U8 scope (${dirtySummary})`
      : `WARN+FAIL — มี change นอก U8 scope (${dirtySummary}): ${unexpectedEntries.slice(0, 8).map((e) => e.line).join(' | ')}`,
  });
  const dirty = {
    policy: 'git status --porcelain ทั้งหมด → ตัด noise → ต้องอยู่ใน U8 scope (fail-closed)',
    noise_prefixes: DIRTY_NOISE_PREFIXES,
    allowlist_exact: U8_DIRTY_ALLOW_EXACT,
    raw: rawDirtyLines,
    noise_excluded: noiseEntries.map((e) => e.line),
    in_scope: inScopeEntries.map((e) => e.line),
    unexpected: unexpectedEntries.map((e) => e.line),
    summary: dirtySummary,
    ok: dirtyOk,
  };

  // 8. vitest CLI ติดตั้ง
  const vitestOk = existsSync(VITEST_MJS);
  checks.push({ id: 'vitest-cli', label: 'vitest CLI installed (local)', ok: vitestOk, detail: vitestOk ? VITEST_MJS.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '') : `ไม่พบ ${VITEST_MJS}` });

  // 9. unified-pos integration files
  let integrationFiles = [];
  if (existsSync(join(REPO_ROOT, 'tests', 'integration'))) {
    integrationFiles = readdirSync(join(REPO_ROOT, 'tests', 'integration'))
      .filter((f) => /^unified-pos-.*\.test\.ts$/.test(f))
      .sort();
  }
  checks.push({ id: 'integration-files', label: 'unified-pos integration test files', ok: integrationFiles.length >= 1, detail: integrationFiles.length ? `${integrationFiles.length} ไฟล์: ${integrationFiles.join(', ')}` : 'ไม่พบ tests/integration/unified-pos-*.test.ts' });

  // 10. postgres version (docker exec, read-only)
  let pgVersion = 'unknown';
  if (dbContainer) {
    const pgR = runQuick('docker', ['exec', dbContainer.name, 'postgres', '--version'], { timeoutMs: 30000 });
    const pgM = `${pgR.stdout}\n${pgR.stderr}`.match(/PostgreSQL\)\s*([0-9.]+)/);
    if (pgM) pgVersion = pgM[1];
  }
  checks.push({ id: 'postgres-version', label: 'postgres version (docker exec)', ok: dbContainer && pgVersion !== 'unknown', detail: pgVersion !== 'unknown' ? `PostgreSQL ${pgVersion}` : dbContainer ? 'อ่านเวอร์ชันไม่ได้' : 'ไม่พบ supabase_db_* container' });

  const failedChecks = checks.filter((c) => !c.ok);
  return { checks, failedChecks, localEnv, dbContainer, supabaseContainers, integrationFiles, dirty, versions: { node: process.version, npm: npmR.status === 0 ? npmR.stdout.trim() : 'unknown', supabase: supaVerM ? supaVerM[1] : 'unknown', postgres: pgVersion } };
}

// ---------------------------------------------------------------------------
// discovery hygiene (ก่อน step d)
// ---------------------------------------------------------------------------

function runDiscovery() {
  const r = runQuick(process.execPath, [VITEST_MJS, 'list', '--filesOnly'], { timeoutMs: 180000 });
  if (r.status !== 0) {
    return { runnable: false, detail: `vitest list --filesOnly ล้มเหลว (exit ${r.status})`, ...parseDiscoveryList('') };
  }
  return { runnable: true, detail: `vitest list --filesOnly exit 0`, ...parseDiscoveryList(r.stdout) };
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function buildSteps(ctx) {
  const integrationArgs = ctx.integrationFiles.map((f) => `tests/integration/${f}`);
  const childEnv = ctx.localEnv
    ? {
        LOCAL_SUPABASE_URL: ctx.localEnv.url,
        LOCAL_SUPABASE_PUBLISHABLE_KEY: ctx.localEnv.publishable,
        LOCAL_SUPABASE_SERVICE_KEY: ctx.localEnv.service,
      }
    : {};
  return [
    { id: 'a', name: 'Reset local database (migrations + seed)', command: 'supabase db reset --local', cmd: 'supabase', args: ['db', 'reset', '--local'], timeoutMs: 600000, kind: 'plain', blockedBy: [] },
    { id: 'b', name: 'pgTAP suite (supabase test db --local)', command: 'supabase test db --local', cmd: 'supabase', args: ['test', 'db', '--local'], timeoutMs: 600000, kind: 'pgtap', blockedBy: ['a'] },
    {
      id: 'b2',
      name: `realtime readiness probe (U3 เดี่ยว, ซ้ำ ≤${READINESS_MAX_ATTEMPTS} attempt ห่าง ${READINESS_RETRY_WAIT_MS / 1000}s)`,
      command: `npx vitest run ${READINESS_PROBE_FILE}`,
      cmd: 'npx',
      args: ['vitest', 'run', READINESS_PROBE_FILE],
      timeoutMs: READINESS_ATTEMPT_TIMEOUT_MS,
      kind: 'readiness',
      blockedBy: ['a'],
      env: childEnv,
    },
    { id: 'c', name: 'unified-pos integration tests (env injected, zero-skip)', command: `npx vitest run ${integrationArgs.join(' ')}`, cmd: 'npx', args: ['vitest', 'run', ...integrationArgs], timeoutMs: 900000, kind: 'vitest', blockedBy: ['a', 'b2'], env: childEnv },
    { id: 'd', name: 'full canonical vitest suite (env injected, zero-skip)', command: 'npx vitest run', cmd: 'npx', args: ['vitest', 'run'], timeoutMs: 1500000, kind: 'vitest', blockedBy: ['a', 'b2'], env: childEnv },
    { id: 'e', name: 'typecheck', command: 'npm run typecheck', cmd: 'npm', args: ['run', 'typecheck'], timeoutMs: 300000, kind: 'plain', blockedBy: [] },
    { id: 'f', name: 'lint', command: 'npm run lint', cmd: 'npm', args: ['run', 'lint'], timeoutMs: 600000, kind: 'plain', blockedBy: [] },
    { id: 'g', name: 'build', command: 'npm run build', cmd: 'npm', args: ['run', 'build'], timeoutMs: 1500000, kind: 'plain', blockedBy: [] },
    { id: 'h', name: 'git diff --check', command: 'git diff --check', cmd: 'git', args: ['diff', '--check'], timeoutMs: 60000, kind: 'plain', blockedBy: [] },
  ];
}

function pgtapPass(rec, parsed) {
  const ok = rec.exit_code === 0 && !rec.timed_out && parsed.summary_found && parsed.result === 'PASS'
    && parsed.failed_subtests === 0 && parsed.failed_programs === 0 && parsed.dubious === 0
    && !parsed.bail_out && parsed.per_file.length > 0 && parsed.all_ok;
  const reasons = [];
  if (rec.timed_out) reasons.push('timeout');
  if (rec.exit_code !== 0) reasons.push(`exit=${rec.exit_code}`);
  if (!parsed.summary_found) reasons.push('TAP summary not found (defensive)');
  if (parsed.summary_found && parsed.result !== 'PASS') reasons.push(`Result: ${parsed.result}`);
  if (parsed.failed_subtests > 0) reasons.push(`failed subtests=${parsed.failed_subtests}`);
  if (parsed.failed_programs > 0) reasons.push(`failed programs=${parsed.failed_programs}`);
  if (parsed.dubious > 0) reasons.push(`dubious=${parsed.dubious}`);
  if (parsed.bail_out) reasons.push(`bail out: ${parsed.bail_out}`);
  if (parsed.per_file.length === 0) reasons.push('ไม่เจอบรรทัดผลรายไฟล์ *.sql');
  if (!parsed.all_ok) reasons.push(`มีไฟล์ไม่ ok: ${parsed.per_file.filter((p) => !p.ok).map((p) => p.file).join(', ')}`);
  return { ok, reasons };
}

function vitestPass(rec, parsed, { zeroSkip = true } = {}) {
  const t = parsed.tests;
  const f = parsed.test_files;
  const reasons = [];
  if (rec.timed_out) reasons.push('timeout');
  if (rec.exit_code !== 0) reasons.push(`exit=${rec.exit_code}`);
  if (!parsed.summary_found) reasons.push('vitest summary not found (defensive)');
  if (t.total !== null && t.failed > 0) reasons.push(`tests failed=${t.failed}`);
  if (f.total !== null && f.failed > 0) reasons.push(`test files failed=${f.failed}`);
  if (zeroSkip && (t.skipped > 0 || t.todo > 0)) reasons.push(`unexpected skipped=${t.skipped} todo=${t.todo} (policy: ${SKIP_POLICY})`);
  const ok = reasons.length === 0;
  return { ok, reasons, skipCount: t.skipped + t.todo };
}

function assertPgtapFileCount(parsed, diskCount) {
  if (parsed.files === null) return { ok: false, detail: 'ไม่พบ Files=N ใน TAP summary' };
  const ok = parsed.files === diskCount;
  return { ok, detail: `TAP Files=${parsed.files} vs *.sql บนดิสก์=${diskCount}${ok ? '' : ' (MISMATCH → fail-closed)'}` };
}

async function runSteps(ctx, state) {
  const steps = buildSteps(ctx);
  const blocked = new Set();
  for (const step of steps) {
    // ถ้า discovery fail แล้ว record ของ step d ถูกใส่ไว้ก่อนแล้ว — ห้ามรัน/บันทึกซ้ำ
    if (step.id === 'd' && state.steps.some((s) => s.id === 'd')) continue;
    const blockers = Array.isArray(step.blockedBy) ? step.blockedBy : (step.blockedBy ? [step.blockedBy] : []);
    const failedBlockers = blockers.filter((id) => blocked.has(id));
    if (failedBlockers.length > 0) {
      state.steps.push({
        id: step.id,
        name: step.name,
        command: step.command,
        status: 'blocked',
        reason: `ข้ามเพราะ step ${failedBlockers.join(' และ ')} ล้มเหลว (DB state ไม่น่าเชื่อถือ)`,
        started_at: null,
        ended_at: null,
        duration_ms: null,
        exit_code: null,
        parsed: null,
        attempts: null,
        passed_on_attempt: null,
        output_lines: [],
        output_total_lines: 0,
      });
      continue;
    }
    const rec = step.kind === 'readiness' ? await runReadinessStep(step, state) : await runStep(step, ctx, state);
    if (rec.status === 'failed') blocked.add(step.id);
  }
}

async function runStep(step, ctx, state) {
  const label = `[step ${step.id}] ${step.name}`;
  console.log(`\n${label} — START ${new Date().toLocaleString('th-TH')}`);
  const rec = await runStreamed({ cmd: step.cmd, args: step.args, env: step.env ?? {}, timeoutMs: step.timeoutMs });
  console.log(`${label} — done exit=${rec.exit_code}${rec.timed_out ? ' TIMEOUT' : ''} (${fmtDur(rec.duration_ms)})`);

  const record = {
    id: step.id,
    name: step.name,
    command: step.command,
    status: 'failed',
    reason: null,
    started_at: rec.started_at,
    ended_at: rec.ended_at,
    duration_ms: rec.duration_ms,
    exit_code: rec.exit_code,
    timed_out: rec.timed_out,
    spawn_error: rec.spawn_error,
    parsed: null,
    output_lines: rec.lines,
    output_total_lines: rec.total_lines,
  };

  const all = rec.all || [];
  let failReasons = [];
  if (rec.timed_out) failReasons.push('timeout (process ถูก kill)');
  if (rec.spawn_error) failReasons.push(`spawn error: ${rec.spawn_error}`);

  if (step.kind === 'pgtap') {
    const parsed = parsePgtapSummary(all.join('\n'));
    const p = pgtapPass(rec, parsed);
    failReasons = failReasons.concat(p.reasons);
    const diskCount = existsSync(join(REPO_ROOT, 'supabase', 'tests'))
      ? readdirSync(join(REPO_ROOT, 'supabase', 'tests')).filter((f) => f.endsWith('.sql')).length
      : 0;
    const fc = assertPgtapFileCount(parsed, diskCount);
    if (!fc.ok) failReasons.push(fc.detail);
    record.parsed = { ...parsed, files_on_disk: diskCount, file_count_ok: fc.ok, file_count_detail: fc.detail };
    if (p.ok && fc.ok && failReasons.length === 0) record.status = 'passed';
    else record.reason = failReasons.join('; ');
    if (failReasons.length > 0) console.log(`    ! ${failReasons.join('; ')}`);
  } else if (step.kind === 'vitest') {
    const parsed = parseVitestSummary(all.join('\n'));
    const p = vitestPass(rec, parsed, { zeroSkip: true });
    failReasons = failReasons.concat(p.reasons);
    state.unexpectedSkips += p.skipCount;
    record.parsed = parsed;
    if (p.ok && failReasons.length === 0) record.status = 'passed';
    else record.reason = failReasons.join('; ');
    if (failReasons.length > 0) console.log(`    ! ${failReasons.join('; ')}`);
  } else {
    if (rec.exit_code !== 0) failReasons.push(`exit=${rec.exit_code}`);
    record.status = failReasons.length === 0 ? 'passed' : 'failed';
    record.reason = failReasons.length ? failReasons.join('; ') : null;
    if (failReasons.length > 0) console.log(`    ! ${failReasons.join('; ')}`);
  }

  state.steps.push(record);
  return record;
}

// step (b2): realtime readiness probe — รัน U3 เดี่ยวซ้ำจน realtime พร้อม (warm-up หลัง db reset)
// ทุก attempt ถูกบันทึกครบ (attempt/start/end/exit/tail) เพื่อให้ evidence โชว์ progression อย่างตรงไปตรงมา
async function runReadinessStep(step, state) {
  const label = `[step ${step.id}] ${step.name}`;
  console.log(`\n${label} — START ${new Date().toLocaleString('th-TH')}`);
  const stepStartMs = Date.now();
  const attempts = [];
  let passed = false;

  for (let n = 1; n <= READINESS_MAX_ATTEMPTS; n++) {
    console.log(`${label} — attempt ${n}/${READINESS_MAX_ATTEMPTS} START`);
    // spawn pipeline เดียวกับ step c (runStreamed + env inject จาก verifier + sanitize)
    const rec = await runStreamed({ cmd: step.cmd, args: step.args, env: step.env ?? {}, timeoutMs: step.timeoutMs });
    const parsed = parseVitestSummary((rec.all || []).join('\n'));
    const verdict = vitestPass(rec, parsed, { zeroSkip: true });
    state.unexpectedSkips += verdict.skipCount; // skip จากทุก attempt นับเป็น unexpected ตาม policy ของ gate
    attempts.push({
      attempt: n,
      started_at: rec.started_at,
      ended_at: rec.ended_at,
      duration_ms: rec.duration_ms,
      exit_code: rec.exit_code,
      timed_out: rec.timed_out,
      spawn_error: rec.spawn_error,
      ok: verdict.ok,
      fail_reasons: verdict.reasons,
      parsed,
      output_lines: rec.lines,
      output_total_lines: rec.total_lines,
      wait_before_next_ms: null,
    });
    console.log(
      `${label} — attempt ${n} done exit=${rec.exit_code}${rec.timed_out ? ' TIMEOUT' : ''} (${fmtDur(rec.duration_ms)}) → `
      + (verdict.ok ? 'READY (probe ผ่าน)' : `ยังไม่พร้อม: ${verdict.reasons.join('; ') || '(ไม่มีเหตุผล — defensive)'}`)
    );
    if (verdict.ok) {
      passed = true;
      break;
    }
    if (n < READINESS_MAX_ATTEMPTS) {
      attempts[attempts.length - 1].wait_before_next_ms = READINESS_RETRY_WAIT_MS;
      console.log(`${label} — รอ ${fmtDur(READINESS_RETRY_WAIT_MS)} ก่อน attempt ${n + 1} (ให้ realtime tenant warm-up หลัง db reset)`);
      await new Promise((r) => setTimeout(r, READINESS_RETRY_WAIT_MS));
    }
  }

  const stepDurationMs = Date.now() - stepStartMs;
  const last = attempts[attempts.length - 1];
  const progress = attempts
    .map((a) => `#${a.attempt} exit=${a.exit_code === null ? '?' : a.exit_code}${a.timed_out ? ' timeout' : ''} ${a.ok ? 'pass' : (a.fail_reasons.join('; ') || 'fail')}`)
    .join(' | ');
  const record = {
    id: step.id,
    name: step.name,
    command: step.command,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? null
      : `probe ล้มเหลวครบ ${READINESS_MAX_ATTEMPTS} attempt — ${progress}`,
    started_at: attempts[0].started_at,
    ended_at: last.ended_at,
    duration_ms: stepDurationMs,
    exit_code: last.exit_code,
    timed_out: false,
    spawn_error: null,
    parsed: last.parsed,
    attempts,
    passed_on_attempt: passed ? last.attempt : null,
    // tail output ราย attempt อยู่ใน attempts[].output_lines — ชั้น step เก็บสรุปกันซ้ำซ้อน
    output_lines: [],
    output_total_lines: attempts.reduce((sum, a) => sum + (a.output_total_lines || 0), 0),
  };
  console.log(
    `${label} — ${passed ? `probe ผ่านที่ attempt ${last.attempt}/${READINESS_MAX_ATTEMPTS}` : `probe ล้มเหลวครบ ${READINESS_MAX_ATTEMPTS} attempt → steps (c)(d) จะถูก block`} `
    + `(รวม ${fmtDur(stepDurationMs)})`
  );
  state.steps.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// evidence (JSON + HTML) — ไม่มี secret ทุกกรณี
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildEvidence(state, ctx, outcome) {
  const stepsPlain = state.steps.map((s) => ({
    id: s.id,
    name: s.name,
    command: s.command,
    status: s.status,
    reason: s.reason,
    started_at: s.started_at,
    ended_at: s.ended_at,
    duration_ms: s.duration_ms,
    exit_code: s.exit_code,
    timed_out: s.timed_out,
    parsed: s.parsed,
    attempts: s.attempts ?? null,
    passed_on_attempt: s.passed_on_attempt ?? null,
    output_total_lines: s.output_total_lines,
    output_lines: s.output_lines,
  }));

  const payload = {
    schema: GATE_SCHEMA,
    gate: GATE_NAME,
    plan_ref: PLAN_REF,
    mode: state.mode,
    verdict: outcome.verdict,
    exit_code: outcome.exitCode,
    generated_at_local: new Date().toLocaleString('th-TH'),
    generated_at_iso: nowIso(),
    duration_ms: outcome.durationMs,
    package: { name: state.package.name, version: state.package.version },
    commit: state.commit,
    tools: ctx.versions,
    docker: {
      daemon_ok: (ctx.checks || []).some((c) => c.id === 'docker-daemon' && c.ok),
      supabase_containers: (ctx.supabaseContainers || []).map((c) => ({ name: c.name, image: c.image })),
      db_container: ctx.dbContainer ? ctx.dbContainer.name : null,
    },
    local_supabase: ctx.localEnv
      ? {
          url: ctx.localEnv.url,
          api_port: LOCAL_API_PORT,
          keys_obtained: ['publishable', 'service'],
          publishable_source: ctx.localEnv.publishableSource,
          service_source: ctx.localEnv.serviceSource,
          key_source: 'supabase status -o env (runtime, never hardcoded)',
          // เก็บเฉพาะบูลีนว่า key ถูกนำไปใช้ — ค่าตัวเองไม่เคยเขียนลง evidence
          keys_in_evidence: false,
        }
      : null,
    preflight: {
      ok: ctx.failedChecks.length === 0,
      checks: ctx.checks.map((c) => ({ id: c.id, label: c.label, ok: c.ok, detail: sanitizeLine(c.detail) })),
      failed_checks: ctx.failedChecks.map((c) => c.id),
      // U8 part 2: รายการ dirty เต็มของ worktree (staged+unstaged+untracked) — เก็บทุกกรณี
      // ไม่ว่า worktree-clean จะผ่านหรือไม่ (ผ่าน sanitize ที่ระดับบรรทัดเดิม)
      dirty_worktree: ctx.dirty
        ? {
            policy: ctx.dirty.policy,
            noise_prefixes: ctx.dirty.noise_prefixes,
            allowlist_exact: ctx.dirty.allowlist_exact,
            summary: ctx.dirty.summary,
            ok: ctx.dirty.ok,
            raw: ctx.dirty.raw.map((l) => sanitizeLine(l)),
            noise_excluded: ctx.dirty.noise_excluded.map((l) => sanitizeLine(l)),
            in_scope: ctx.dirty.in_scope.map((l) => sanitizeLine(l)),
            unexpected: ctx.dirty.unexpected.map((l) => sanitizeLine(l)),
          }
        : null,
    },
    discovery: state.discovery
      ? {
          command: `node ${VITEST_MJS.replace(REPO_ROOT, '').replace(/^[\\/]/, '')} list --filesOnly`,
          runnable: state.discovery.runnable,
          ok: state.discovery.ok,
          file_count: state.discovery.file_count,
          named_forbidden_dirs: NAMED_FORBIDDEN_DIRS,
          offenders: state.discovery.offenders,
          named_hits: state.discovery.named_hits,
          detail: state.discovery.detail,
        }
      : null,
    steps: stepsPlain,
    failed_steps: stepsPlain.filter((s) => s.status === 'failed').map((s) => s.id),
    blocked_steps: stepsPlain.filter((s) => s.status === 'blocked').map((s) => ({ id: s.id, reason: s.reason })),
    unexpected_skips: state.unexpectedSkips,
    skip_policy: SKIP_POLICY,
    secrets_scanned: outcome.secretsScanned,
  };
  return payload;
}

function redactAll(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

function writeEvidenceJson(payload, secrets) {
  const json = redactAll(JSON.stringify(payload, null, 2), secrets);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, json, 'utf8');
  return json;
}

function renderHtml(payload) {
  const badge = payload.verdict === 'BACKEND_GATE_PASS' ? 'pass' : payload.verdict === 'SKIPPED_RUN' ? 'skipped' : 'fail';
  const badgeLabel = { pass: 'BACKEND_GATE_PASS', skipped: 'SKIPPED_RUN', fail: payload.verdict }[badge];
  const stepsRows = (payload.steps || [])
    .map(
      (s) => `<tr class="${s.status}">
        <td class="mono">${esc(s.id)}</td>
        <td>${esc(s.name)}</td>
        <td class="mono">${esc(s.command)}</td>
        <td class="mono">${s.exit_code === null ? '—' : esc(s.exit_code)}</td>
        <td class="mono">${s.duration_ms === null ? '—' : esc(fmtDur(s.duration_ms))}</td>
        <td>${esc(s.status)}${s.reason ? `<div class="reason">${esc(s.reason)}</div>` : ''}</td>
      </tr>`
    )
    .join('\n');
  const preflightRows = (payload.preflight?.checks || [])
    .map((c) => `<tr class="${c.ok ? 'passed' : 'failed'}"><td class="mono">${esc(c.id)}</td><td>${esc(c.label)}</td><td class="mono">${c.ok ? 'OK' : 'FAIL'}</td><td>${esc(c.detail)}</td></tr>`)
    .join('\n');
  const dirty = payload.preflight?.dirty_worktree ?? null;
  const dirtyRows = dirty
    ? dirty.raw.map((line) => {
        const cls = dirty.noise_excluded.includes(line) ? 'small' : dirty.unexpected.includes(line) ? 'failed' : 'passed';
        const tag = dirty.noise_excluded.includes(line) ? 'noise' : dirty.unexpected.includes(line) ? 'UNEXPECTED' : 'in-scope';
        return `<tr class="${cls}"><td class="mono">${esc(line)}</td><td>${esc(tag)}</td></tr>`;
      }).join('\n')
    : '';
  const dockerRows = (payload.docker?.supabase_containers || [])
    .map((c) => `<tr><td class="mono">${esc(c.name)}</td><td class="mono">${esc(c.image)}</td></tr>`)
    .join('\n');
  const stepDetail = (payload.steps || [])
    .map((s) => {
      const parsedHtml = s.parsed
        ? `<pre class="parsed">${esc(JSON.stringify(s.parsed, null, 2))}</pre>`
        : '';
      const outHtml = s.output_lines && s.output_lines.length
        ? `<pre>${esc(s.output_lines.join('\n'))}</pre>`
        : '<pre>(ไม่มี output)</pre>';
      // step (b2): ตาราง attempt ทุกรอบ + tail ราย attempt (progression ต้องโชว์ตรงไปตรงมา)
      const attemptsHtml = s.attempts && s.attempts.length
        ? `<p class="small">readiness attempts (${esc(s.attempts.length)}) — ผ่านที่ attempt <span class="mono">${esc(s.passed_on_attempt ?? '—')}</span>:</p>
        <table>
          <tr><th>#</th><th>Start</th><th>End</th><th>Duration</th><th>Exit</th><th>ผล</th></tr>
          ${s.attempts.map((a) => `<tr class="${a.ok ? 'passed' : 'failed'}">
            <td class="mono">#${esc(a.attempt)}</td>
            <td class="mono small">${esc(a.started_at ?? '—')}</td>
            <td class="mono small">${esc(a.ended_at ?? '—')}</td>
            <td class="mono">${esc(fmtDur(a.duration_ms ?? 0))}</td>
            <td class="mono">${a.exit_code === null ? '—' : esc(a.exit_code)}${a.timed_out ? ' (timeout)' : ''}</td>
            <td>${a.ok ? 'READY (probe ผ่าน)' : 'ยังไม่พร้อม'}${a.fail_reasons && a.fail_reasons.length ? `<div class="reason">${esc(a.fail_reasons.join('; '))}</div>` : ''}${a.wait_before_next_ms ? `<div class="small">รอ ${esc(fmtDur(a.wait_before_next_ms))} ก่อน attempt ถัดไป</div>` : ''}</td>
          </tr>`).join('\n')}
        </table>
        ${s.attempts.map((a) => `<p class="small mono">attempt #${esc(a.attempt)} — output (head/tail, ${esc(a.output_total_lines ?? 0)} บรรทัดทั้งหมด):</p><pre>${a.output_lines && a.output_lines.length ? esc(a.output_lines.join('\n')) : '(ไม่มี output)'}</pre>`).join('\n')}`
        : '';
      return `<div class="card">
        <h3><span class="mono">${esc(s.id)}</span> · ${esc(s.name)} — <span class="${s.status}">${esc(s.status)}</span></h3>
        <p class="mono small">${esc(s.command)} · exit ${s.exit_code === null ? '—' : esc(s.exit_code)} · ${esc(fmtDur(s.duration_ms ?? 0))} · start ${esc(s.started_at ?? '—')} · end ${esc(s.ended_at ?? '—')}</p>
        ${s.reason ? `<p class="reason">เหตุผล: ${esc(s.reason)}</p>` : ''}
        ${parsedHtml}
        ${attemptsHtml}
        ${attemptsHtml ? '' : `<p class="small">output (head/tail, ${esc(s.output_total_lines ?? 0)} บรรทัดทั้งหมด):</p>${outHtml}`}
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(payload.gate)} — ${esc(payload.verdict)}</title>
<style>
  :root { --ok:#0e7a3d; --bad:#b3261e; --warn:#9a6700; --ink:#1f2328; --muted:#57606a; --line:#d0d7de; --bg:#f6f8fa; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--ink); background: #fff; margin: 0; padding: 24px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; } h3 { font-size: 15px; margin: 0 0 8px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  .badge { display:inline-block; padding: 8px 16px; border-radius: 8px; color:#fff; font-weight: 700; font-family: ui-monospace, Consolas, monospace; }
  .badge.pass { background: var(--ok); } .badge.fail { background: var(--bad); } .badge.skipped { background: var(--warn); }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13.5px; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--bg); font-weight: 600; }
  tr.passed td:last-child { color: var(--ok); font-weight: 600; }
  tr.failed td:last-child { color: var(--bad); font-weight: 600; }
  .mono { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
  .small { font-size: 12px; color: var(--muted); }
  pre { background: #0d1117; color: #e6edf3; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  pre.parsed { background: #f6f8fa; color: #1f2328; border: 1px solid var(--line); }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .reason { color: var(--bad); font-size: 12.5px; margin-top: 4px; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
  .meta-cell { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; font-size: 13px; }
  .meta-cell b { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: .04em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(payload.gate)}</h1>
  <p class="small">${esc(payload.plan_ref)} · evidence schema ${esc(payload.schema)} · mode ${esc(payload.mode)}</p>
  <p><span class="badge ${badge}">${esc(badgeLabel)}</span></p>

  <h2>สรุป / Summary</h2>
  <div class="meta-grid">
    <div class="meta-cell"><b>Verdict</b><span class="mono">${esc(payload.verdict)}</span></div>
    <div class="meta-cell"><b>Package</b><span class="mono">${esc(payload.package?.name)}@${esc(payload.package?.version)}</span></div>
    <div class="meta-cell"><b>Commit</b><span class="mono">${esc(payload.commit?.sha ?? 'unknown')} (${esc(payload.commit?.branch ?? '?')})</span></div>
    <div class="meta-cell"><b>Generated</b>${esc(payload.generated_at_local)}<br><span class="small">${esc(payload.generated_at_iso)} · ${esc(fmtDur(payload.duration_ms ?? 0))}</span></div>
    <div class="meta-cell"><b>Unexpected skips</b><span class="mono">${esc(payload.unexpected_skips ?? 0)}</span><br><span class="small">${esc(payload.skip_policy)}</span></div>
    <div class="meta-cell"><b>Failed steps</b><span class="mono">${esc((payload.failed_steps || []).join(', ') || '—')}</span></div>
  </div>

  <h2>เครื่องมือ / Tool versions</h2>
  <table>
    <tr><th>Tool</th><th>Version</th><th>หมายเหตุ</th></tr>
    <tr><td>node</td><td class="mono">${esc(payload.tools?.node ?? 'unknown')}</td><td>process.version</td></tr>
    <tr><td>npm</td><td class="mono">${esc(payload.tools?.npm ?? 'unknown')}</td><td>npm --version</td></tr>
    <tr><td>supabase CLI</td><td class="mono">${esc(payload.tools?.supabase ?? 'unknown')}</td><td>supabase --version</td></tr>
    <tr><td>PostgreSQL</td><td class="mono">${esc(payload.tools?.postgres ?? 'unknown')}</td><td>docker exec (db container)</td></tr>
  </table>

  <h2>Docker (supabase containers) / Local Supabase</h2>
  <table>
    <tr><th>Container</th><th>Image</th></tr>
    ${dockerRows || '<tr><td colspan="2">(ไม่พบ)</td></tr>'}
  </table>
  ${payload.local_supabase ? `<p class="small">Local URL: <span class="mono">${esc(payload.local_supabase.url)}</span> · keys จาก <span class="mono">${esc(payload.local_supabase.key_source)}</span> (${esc(payload.local_supabase.publishable_source)}/${esc(payload.local_supabase.service_source)}) · keys_in_evidence: ${esc(payload.local_supabase.keys_in_evidence)}</p>` : ''}

  <h2>Preflight</h2>
  <table>
    <tr><th>ID</th><th>Check</th><th>ผล</th><th>รายละเอียด</th></tr>
    ${preflightRows}
  </table>
  ${dirty ? `
  <h3>รายการ dirty ของ worktree (${esc(dirty.raw.length)} รายการ — ${esc(dirty.summary)})</h3>
  <p class="small">${esc(dirty.policy)} · allowlist: ${esc(dirty.allowlist_exact.join(', '))}</p>
  <table>
    <tr><th>git status --porcelain</th><th>ประเภท</th></tr>
    ${dirtyRows || '<tr><td colspan="2">(worktree สะอาด)</td></tr>'}
  </table>` : ''}

  <h2>Test discovery hygiene (vitest list --filesOnly)</h2>
  ${payload.discovery ? `
  <table>
    <tr><th>ไฟล์ที่ค้นพบ</th><th>ผล</th><th>Offenders (dot-workspaces)</th></tr>
    <tr class="${payload.discovery.ok ? 'passed' : 'failed'}"><td class="mono">${esc(payload.discovery.file_count)}</td><td>${payload.discovery.ok ? 'OK' : 'FAIL'}</td><td>${payload.discovery.offenders.map((o) => esc(o)).join('<br>') || '—'}</td></tr>
  </table>
  <p class="small">ห้ามมี path ใต้: ${esc(payload.discovery.named_forbidden_dirs.join(', '))} หรือ dot-prefixed workspace dir ใดๆ · ${esc(payload.discovery.detail)}</p>` : '<p class="small">ไม่มีการรัน discovery ในโหมดนี้</p>'}

  <h2>Steps (${esc((payload.steps || []).length)})</h2>
  <table>
    <tr><th>ID</th><th>Step</th><th>Command</th><th>Exit</th><th>Duration</th><th>Status</th></tr>
    ${stepsRows || '<tr><td colspan="6">(ไม่มี step — preflight-only)</td></tr>'}
  </table>

  <h2>รายละเอียดแต่ละ step / Step details</h2>
  ${stepDetail || '<p class="small">(ไม่มี step — preflight-only)</p>'}

  <p class="small">Evidence ถูก sanitize — ไม่มี secret/API key ปรากฏในไฟล์นี้ · schema ${esc(payload.schema)}</p>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const preflightOnly = argv.includes('--preflight-only');
  // fail-closed: รับเฉพาะ flag ที่รู้จักเท่านั้น
  const badArgs = argv.filter((a) => a !== '--preflight-only');
  if (badArgs.length > 0) {
    console.error('usage: node scripts/verify-unified-pos-backend.mjs [--preflight-only]');
    process.exit(2);
  }

  const startedMs = Date.now();
  const state = {
    mode: preflightOnly ? 'preflight-only' : 'full',
    package: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')),
    commit: null,
    steps: [],
    discovery: null,
    unexpectedSkips: 0,
  };

  // commit info (best-effort)
  {
    const sha = runQuick('git', ['rev-parse', 'HEAD']);
    const branch = runQuick('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const subj = runQuick('git', ['log', '-1', '--pretty=%s']);
    state.commit = {
      sha: sha.status === 0 ? sha.stdout.trim() : 'unknown',
      short_sha: sha.status === 0 ? sha.stdout.trim().slice(0, 7) : 'unknown',
      branch: branch.status === 0 ? branch.stdout.trim() : 'unknown',
      subject: subj.status === 0 ? subj.stdout.trim() : 'unknown',
    };
  }

  console.log('══════════════════════════════════════════════════════════════');
  console.log(` ${GATE_NAME} (fail-closed backend verifier)`);
  console.log(` plan: ${PLAN_REF}`);
  console.log(` mode: ${state.mode}`);
  console.log('══════════════════════════════════════════════════════════════');

  // preflight
  console.log('\n[preflight] start');
  const ctx = await runPreflight();
  ctx.preflightOk = ctx.failedChecks.length === 0;
  for (const c of ctx.checks) console.log(`  [preflight] ${c.id} → ${c.ok ? 'OK' : 'FAIL'} — ${sanitizeLine(c.detail)}`);
  console.log(`[preflight] done — ${ctx.failedChecks.length} failed check(s)`);

  const finish = (verdict, exitCode) => {
    const payload = buildEvidence(state, ctx, {
      verdict,
      exitCode,
      durationMs: Date.now() - startedMs,
      secretsScanned: true,
    });
    const secrets = ctx.localEnv ? ctx.localEnv.redactSecrets : [];
    const json = writeEvidenceJson(payload, secrets);
    const html = redactAll(renderHtml(payload), secrets);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_HTML, html, 'utf8');

    // self-check: ยืนยันว่า evidence ไม่มี key ตัวจริง (บูลีนเท่านั้น, ไม่ปริ้นต์ค่า)
    let keyLeak = false;
    for (const s of secrets) {
      if (s && (json.includes(s) || html.includes(s))) keyLeak = true;
    }
    console.log('\n──────────────────────────────────────────────────────────────');
    if (verdict === 'BACKEND_GATE_PASS') {
      console.log('verdict: BACKEND_GATE_PASS — ทุก step ผ่าน และ zero unexpected skip');
    } else if (verdict === 'SKIPPED_RUN') {
      console.log('verdict: SKIPPED_RUN (--preflight-only — ยังไม่รัน steps จริง)');
    } else {
      console.log(`verdict: ${verdict}${payload.failed_steps.length ? ` — failed steps: ${payload.failed_steps.join(', ')}` : ''}`);
    }
    if (keyLeak) console.log('WARNING: พบ key หลุดใน evidence (ต้องแก้ทันที)');
    else console.log('evidence key-leak check: clean');
    console.log('evidence:');
    console.log('  ' + OUT_JSON);
    console.log('  ' + OUT_HTML);
    console.log('──────────────────────────────────────────────────────────────');
    const out = `${verdict}${verdict === 'BACKEND_GATE_FAIL' && payload.failed_steps.length ? ` (failed: ${payload.failed_steps.join(', ')})` : ''}\n`;
    process.stdout.write(out, () => process.exit(exitCode));
  };

  if (!ctx.preflightOk) {
    console.error('\n[abort] preflight ล้มเหลว — fail-closed, ห้าม skip step ใดๆ');
    finish(preflightOnly ? 'PREFLIGHT_FAIL' : 'BACKEND_GATE_FAIL', 1);
    return;
  }
  console.log('[preflight] ผ่านครบ — พร้อมรัน gate');

  // discovery hygiene (preflight-only: ตรวจ read-only; full: ใช้กับ step d)
  {
    console.log('\n[discovery] vitest list --filesOnly …');
    const d = runDiscovery();
    state.discovery = d;
    console.log(`[discovery] files=${d.file_count} offenders=${d.offenders.length} → ${d.ok ? 'OK' : 'FAIL'}`);
    if (d.offenders.length > 0) {
      console.log(`  ! offenders: ${d.offenders.join(', ')}`);
    }
  }

  if (preflightOnly) {
    if (!state.discovery.ok) {
      console.error('[abort] discovery hygiene ล้มเหลว (dot-workspace test files) — preflight-only ยังไม่รัน steps');
      finish('BACKEND_GATE_FAIL', 1);
      return;
    }
    finish('SKIPPED_RUN', 0);
    return;
  }

  // step d: discovery ที่ต้องผ่านก่อนรัน suite
  if (state.discovery && !state.discovery.ok) {
    state.steps.push({
      id: 'd',
      name: 'full canonical vitest suite (env injected, zero-skip)',
      command: 'npx vitest run',
      status: 'failed',
      reason: `discovery hygiene ล้มเหลว — พบ test file ใน dot-workspace (offenders: ${state.discovery.offenders.join(', ')})`,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      exit_code: null,
      parsed: state.discovery,
      output_lines: [],
      output_total_lines: 0,
    });
  }

  await runSteps(ctx, state);

  const failedSteps = state.steps.filter((s) => s.status === 'failed').map((s) => s.id);
  const pass = ctx.preflightOk && failedSteps.length === 0 && state.unexpectedSkips === 0 && state.discovery && state.discovery.ok;
  finish(pass ? 'BACKEND_GATE_PASS' : 'BACKEND_GATE_FAIL', pass ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL (unexpected):', e && e.stack ? e.stack : String(e));
  console.error('verdict: BACKEND_GATE_FAIL (verifier crash — fail-closed)');
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_JSON, JSON.stringify({ schema: GATE_SCHEMA, gate: GATE_NAME, verdict: 'BACKEND_GATE_FAIL', fatal: String(e && e.message ? e.message : e), generated_at_iso: nowIso() }, null, 2), 'utf8');
  } catch { /* best effort */ }
  process.exit(1);
});
