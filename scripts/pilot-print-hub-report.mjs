// รายงานตัวเลข pilot ของ Print Hub บนเครื่องร้านจริง (แผน v3 Phase 5)
//
// รัน:  npm run pilot:print-hub -- --days 21 [--store <uuid>]
//       ต้องมี SUPABASE_DATABASE_URL (prod) หรือ LOCAL_SUPABASE_DB_URL
//
// ทำไมเป็นสคริปต์อ่านอย่างเดียว ไม่ใช่ cron/ตารางสรุป:
//   * Vercel Hobby มี cron ครบ 2 ตัวแล้ว ไม่มี slot เหลือ (กฎเดิมของโปรเจกต์)
//   * ข้อมูลดิบถูกเก็บอยู่แล้วสองทาง — print_jobs (สถานะงานพิมพ์)
//     และ system_event_logs (log จาก Launcher/agent ที่ส่งผ่าน /api/launcher/logs)
//     pilot จึงไม่ต้อง "เพิ่มการเก็บ" แต่ต้อง "อ่านให้เป็นตัวเลขเดียวกันทุกวัน"
//   * รายงานเป็นสคริปต์ = ทำซ้ำได้ แนบเป็นหลักฐานได้ และไม่แตะ production runtime
//
// ตัวเลขที่ใช้ตัดสิน pilot (เกณฑ์อยู่ใน Plan/Windows Voice Standby and Print Hub
// Implementation Plan v3 §6 Task 0 และ §8):
//   ผ่าน   = unknown = 0 ต่อวัน, งานพิมพ์ล้มเหลว < 2% , ไม่มีวันที่ agent เงียบเกิน 30 นาทีในเวลาทำการ
//   ไม่ผ่าน = มี unknown ที่ต้องให้คนตัดสินเกิน 1 ใบ/วัน หรือมี requeue ซ้ำใบเดิม
import pg from "pg";

const DB_URL = process.env.SUPABASE_DATABASE_URL ?? process.env.LOCAL_SUPABASE_DB_URL;
if (!DB_URL) {
  console.error("ต้องตั้ง SUPABASE_DATABASE_URL (prod) หรือ LOCAL_SUPABASE_DB_URL ก่อน");
  process.exit(2);
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
};
const days = Number.parseInt(argValue("--days") ?? "21", 10);
const storeId = argValue("--store");

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const storeFilter = storeId ? "and store_id = $2" : "";
const params = storeId ? [days, storeId] : [days];

// 1. งานพิมพ์รายวัน — แกนหลักของ pilot
const jobs = await q(
  `select date_trunc('day', created_at at time zone 'Asia/Bangkok')::date as day,
          count(*)                                             as total,
          count(*) filter (where status = 'printed')            as printed,
          count(*) filter (where status = 'failed')             as failed,
          count(*) filter (where status = 'unknown')            as unknown,
          count(*) filter (where status in ('pending','claimed')) as open,
          count(*) filter (where attempts > 1)                  as retried,
          count(*) filter (where resolution = 'printed_confirmed') as human_confirmed,
          count(*) filter (where resolution = 'retried')        as human_retried,
          max(attempts)                                         as max_attempts
     from print_jobs
    where created_at >= now() - ($1 || ' days')::interval ${storeFilter}
    group by 1 order by 1`,
  params,
);

// 2. เหตุการณ์จาก Launcher/agent บนเครื่องร้าน (ส่งเข้ามาเองผ่าน /api/launcher/logs)
const events = await q(
  `select date_trunc('day', created_at at time zone 'Asia/Bangkok')::date as day,
          action,
          level,
          count(*) as hits
     from system_event_logs
    where created_at >= now() - ($1 || ' days')::interval
      and source in ('launcher.windows', 'print-hub')
      ${storeId ? "and store_id = $2" : ""}
    group by 1, 2, 3
   having count(*) > 0
    order by 1, 4 desc`,
  params,
);

// 3. ช่วงที่เครื่องร้านเงียบ — ใช้ระยะห่างระหว่าง log ติดกันเป็นตัวแทน "agent หยุดหายใจ"
const silence = await q(
  `with beats as (
     select store_id,
            created_at,
            lag(created_at) over (partition by store_id order by created_at) as previous_at
       from system_event_logs
      where created_at >= now() - ($1 || ' days')::interval
        and source in ('launcher.windows', 'print-hub')
        ${storeId ? "and store_id = $2" : ""}
   )
   select store_id,
          (previous_at at time zone 'Asia/Bangkok')::date as day,
          max(extract(epoch from (created_at - previous_at)) / 60)::int as longest_gap_minutes,
          count(*) filter (where created_at - previous_at > interval '30 minutes') as gaps_over_30m
     from beats
    where previous_at is not null
    group by 1, 2
   having count(*) filter (where created_at - previous_at > interval '30 minutes') > 0
    order by 2`,
  params,
);

const pct = (part, total) => (total > 0 ? ((part / total) * 100).toFixed(1) + "%" : "-");

console.log(`\n=== Print Hub pilot — ${days} วันล่าสุด${storeId ? ` (ร้าน ${storeId})` : " (ทุกร้าน)"} ===\n`);
console.log("วันที่       ทั้งหมด  พิมพ์ได้  ล้มเหลว  ไม่รู้ผล  ค้าง  ลองซ้ำ  คนยืนยัน  คนสั่งพิมพ์ใหม่");
for (const row of jobs) {
  console.log(
    `${row.day.toISOString().slice(0, 10)}  ${String(row.total).padStart(7)}  ${String(row.printed).padStart(7)}  ` +
      `${String(row.failed).padStart(7)}  ${String(row.unknown).padStart(8)}  ${String(row.open).padStart(4)}  ` +
      `${String(row.retried).padStart(6)}  ${String(row.human_confirmed).padStart(8)}  ${String(row.human_retried).padStart(14)}`,
  );
}

const totals = jobs.reduce(
  (acc, r) => ({
    total: acc.total + Number(r.total),
    printed: acc.printed + Number(r.printed),
    failed: acc.failed + Number(r.failed),
    unknown: acc.unknown + Number(r.unknown),
  }),
  { total: 0, printed: 0, failed: 0, unknown: 0 },
);

console.log(`\nรวม ${totals.total} งาน — พิมพ์สำเร็จ ${pct(totals.printed, totals.total)} · ` +
  `ล้มเหลว ${pct(totals.failed, totals.total)} · ไม่รู้ผล ${totals.unknown} ใบ`);

console.log("\n--- เหตุการณ์จากเครื่องร้าน (10 อันดับแรก) ---");
for (const row of events.slice(0, 10)) {
  console.log(`${row.day.toISOString().slice(0, 10)}  [${row.level}] ${row.action} × ${row.hits}`);
}
if (events.length === 0) {
  console.log("ไม่มีเลย — แปลว่า Launcher ยังไม่เคยส่ง log เข้ามา (ตรวจว่าเครื่องร้านติดตั้งแล้วจริง)");
}

console.log("\n--- ช่วงที่เครื่องเงียบเกิน 30 นาที ---");
for (const row of silence) {
  console.log(`${row.day.toISOString().slice(0, 10)}  ร้าน ${row.store_id}  เงียบนานสุด ${row.longest_gap_minutes} นาที (${row.gaps_over_30m} ครั้ง)`);
}
if (silence.length === 0) console.log("ไม่มี");

// เกณฑ์ตัดสินอัตโนมัติ — ให้คนอ่านเห็นทันทีว่ายังผ่านอยู่ไหม ไม่ต้องตีความเอง
const failRate = totals.total > 0 ? totals.failed / totals.total : 0;
const verdicts = [
  ["ไม่มีงานสถานะไม่รู้ผลค้าง", totals.unknown === 0],
  ["งานล้มเหลวน้อยกว่า 2%", failRate < 0.02],
  ["ไม่มีวันที่เครื่องเงียบเกิน 30 นาที", silence.length === 0],
  ["มี log จากเครื่องร้านจริง", events.length > 0],
];
console.log("\n--- เกณฑ์ Phase 5 ---");
for (const [name, pass] of verdicts) console.log(`${pass ? "ผ่าน" : "ไม่ผ่าน"}  ${name}`);
console.log(
  verdicts.every(([, pass]) => pass)
    ? "\nสรุป: ผ่านเกณฑ์ ณ ตอนนี้ — เดินหน้านับวัน pilot ต่อ"
    : "\nสรุป: ยังไม่ผ่าน — ห้ามขึ้น Phase 6 (Voice W0 บนเครื่องร้าน) จนกว่าจะแก้ข้อที่ไม่ผ่าน",
);

await client.end();
