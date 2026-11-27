import { FESTIVALS, LUNAR_FESTIVAL_KEYS } from "@/modules/store-website/festivals";
import { listFestivalDates } from "@/modules/store-website/festival-dates-repository";
import { saveFestivalDateAction } from "./actions";

export const dynamic = "force-dynamic";

const nameOf = (key: string) => FESTIVALS.find((f) => f.key === key)?.name ?? key;

/** ซูเปอร์แอดมิน: ตรวจ/ยืนยันวันที่เทศกาลจันทรคติรายปี (layout ของ /system ตรวจสิทธิ์แล้ว) */
export default async function WebsiteFestivalDatesPage() {
  const rows = await listFestivalDates();
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric" }).format(new Date()));
  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <h1 className="page-title">วันที่เทศกาล (เว็บไซต์ร้าน)</h1>
        <p className="text-sm text-[var(--muted)]">
          เทศกาลตามจันทรคติ/ปฏิทินจีนเปลี่ยนวันทุกปี — ตรวจกับปฏิทินราชการ (วันพระ, ลอยกระทง; ระวังปีอธิกมาส) และปฏิทินจีนก่อนติ๊ก “ยืนยัน”
          เว็บร้านแสดงเฉพาะวันที่ยืนยันแล้ว · เทศกาลวันคงที่ (ปีใหม่ สงกรานต์ ฯลฯ) ระบบคำนวณเอง
        </p>
      </div>
      <div className="panel overflow-x-auto p-4">
        <div className="grid min-w-[760px] gap-2 text-sm">
          <div className="grid grid-cols-[1.4fr_.6fr_1fr_1fr_.6fr_1.4fr_auto] gap-2 text-xs text-[var(--muted)]">
            <span>เทศกาล</span><span>ปี</span><span>เริ่ม</span><span>จบ</span><span>ยืนยัน</span><span>หมายเหตุ</span><span />
          </div>
          {rows.map((row) => (
            <form
              key={`${row.festivalKey}-${row.year}`}
              action={saveFestivalDateAction}
              className={`grid grid-cols-[1.4fr_.6fr_1fr_1fr_.6fr_1.4fr_auto] items-center gap-2 rounded px-1 py-1 ${row.verified ? "" : "bg-amber-50"}`}
            >
              <span>{nameOf(row.festivalKey)}</span>
              <input type="hidden" name="festivalKey" value={row.festivalKey} />
              <input type="hidden" name="year" value={row.year} />
              <span>{row.year}</span>
              <input type="date" name="startsOn" defaultValue={row.startsOn} className="input" />
              <input type="date" name="endsOn" defaultValue={row.endsOn} className="input" />
              <input type="checkbox" name="verified" defaultChecked={row.verified} aria-label="ยืนยันวันที่" />
              <input name="note" defaultValue={row.note ?? ""} maxLength={200} className="input" />
              <button type="submit" className="btn-secondary text-xs">บันทึก</button>
            </form>
          ))}
        </div>
      </div>
      <div className="panel p-4">
        <p className="mb-2 text-sm font-semibold">เพิ่มวันที่ปีใหม่</p>
        <form action={saveFestivalDateAction} className="flex flex-wrap items-end gap-2 text-sm">
          <select name="festivalKey" className="input">
            {LUNAR_FESTIVAL_KEYS.map((key) => (
              <option key={key} value={key}>{nameOf(key)}</option>
            ))}
          </select>
          <input name="year" type="number" defaultValue={year + 2} min={2024} max={2100} className="input w-24" />
          <input type="date" name="startsOn" className="input" required />
          <input type="date" name="endsOn" className="input" />
          <label className="flex items-center gap-1">
            <input type="checkbox" name="verified" />ยืนยัน
          </label>
          <input name="note" placeholder="แหล่งอ้างอิง" maxLength={200} className="input" />
          <button type="submit" className="btn-primary text-xs">เพิ่ม</button>
        </form>
      </div>
    </div>
  );
}
