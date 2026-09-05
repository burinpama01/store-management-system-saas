// รายงานการใช้คำสั่งเสียง — อ่านจาก system_event_logs (ไม่มีคำพูดของผู้ใช้อยู่ในนั้น)
//
// รัน: node scripts/voice-usage-report.mjs [ชั่วโมงย้อนหลัง]
// ตัวอย่าง: node scripts/voice-usage-report.mjs 24
import pg from 'pg';
import fs from 'node:fs';

const HOURS = Number(process.argv[2] ?? 24);
const env = fs.readFileSync('.env', 'utf8');
const url =
  process.env.SUPABASE_DATABASE_URL ??
  env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_DATABASE_URL=')).slice(22).replace(/^"|"$/g, '');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const since = `now() - interval '${Number.isFinite(HOURS) ? HOURS : 24} hours'`;

const show = async (title, sql) => {
  const r = await c.query(sql);
  console.log(`\n── ${title} ──`);
  if (!r.rows.length) return console.log('  (ไม่มีข้อมูล)');
  for (const row of r.rows) console.log(' ', JSON.stringify(row));
};

await show(
  'สรุปผลการฟัง (parser เดิม)',
  `select context->>'resultCode' as result, context->>'intentType' as intent, count(*) as n
   from system_event_logs
   where source = 'voice.command' and context->>'source' = 'deterministic' and occurred_at > ${since}
   group by 1, 2 order by n desc`,
);

await show(
  'สรุปผลของทางสำรอง AI',
  `select context->>'resultCode' as result, context->>'intentType' as intent,
          context->>'confidenceBucket' as confidence, count(*) as n
   from system_event_logs
   where source = 'voice.command' and context->>'source' = 'ai' and occurred_at > ${since}
   group by 1, 2, 3 order by n desc`,
);

await show(
  'อัตราที่ AI ช่วยกู้คืนได้',
  `with d as (
     select count(*) filter (where context->>'resultCode' = 'no_match') as fell_through
     from system_event_logs
     where source = 'voice.command' and context->>'source' = 'deterministic' and occurred_at > ${since}
   ), a as (
     select count(*) filter (where context->>'resultCode' = 'matched') as rescued,
            count(*) as ai_calls
     from system_event_logs
     where source = 'voice.command' and context->>'source' = 'ai' and occurred_at > ${since}
   )
   select d.fell_through, a.ai_calls, a.rescued,
          case when a.ai_calls = 0 then null
               else round(100.0 * a.rescued / a.ai_calls, 1) end as rescue_pct
   from d, a`,
);

await show(
  'ฝั่ง server ของ AI (ai.voice-intent)',
  `select level, message, context->>'outcome' as outcome, context->>'commandCount' as commands,
          to_char(occurred_at, 'HH24:MI:SS') as at
   from system_event_logs
   where source = 'ai.voice-intent' and occurred_at > ${since}
   order by occurred_at desc limit 20`,
);

await show(
  'โควตา/ค่าใช้จ่าย',
  `select status, count(*) as n, sum(tokens) as tokens, round(sum(cost_thb), 2) as cost_thb
   from ai_usage_logs
   where feature = 'aiVoiceIntent' and created_at > ${since}
   group by status`,
);

await c.end();
