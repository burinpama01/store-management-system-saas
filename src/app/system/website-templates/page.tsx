import { listLibraryTemplatesForAdmin, type LibraryTemplateRow } from "@/modules/store-website/template-library";
import { listCustomDomainsForAdmin } from "@/modules/store-website/repository";
import { isVercelDomainsConfigured } from "@/modules/store-website/vercel-domains";
import { BUSINESS_LABELS, STYLE_LABELS, WEBSITE_TEMPLATES } from "@/modules/store-website/templates";
import { saveLibraryTemplateAction, setDomainStatusAction } from "./actions";

export const dynamic = "force-dynamic";

const COLOR_KEYS = [
  ["primary", "หลัก"],
  ["accent", "รอง"],
  ["background", "พื้นหลัง"],
  ["surface", "การ์ด"],
  ["text", "ตัวอักษร"],
] as const;

const DEFAULT_THEME = WEBSITE_TEMPLATES[0].theme;

function TemplateForm({ row, monthId }: { row: LibraryTemplateRow | null; monthId: string }) {
  const theme = row?.theme ?? DEFAULT_THEME;
  return (
    <form action={saveLibraryTemplateAction} className="grid gap-2 rounded-lg border border-[var(--border)] p-3 text-sm md:grid-cols-[1fr_1fr]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {row ? (
            <>
              <input type="hidden" name="id" value={row.id} />
              <code className="text-xs">{row.id}</code>
            </>
          ) : (
            <input name="id" required defaultValue={monthId} pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]" className="input w-56" placeholder="รหัส เช่น 2026-12-xmas" />
          )}
          <input name="name" required maxLength={60} defaultValue={row?.name ?? ""} className="input flex-1" placeholder="ชื่อเทมเพลต (ร้านเห็น)" />
        </div>
        <input name="description" maxLength={160} defaultValue={row?.description ?? ""} className="input w-full" placeholder="คำอธิบายสั้น" />
        <div className="flex flex-wrap gap-2">
          <select name="business" defaultValue={row?.business ?? "cafe"} className="input">
            {Object.entries(BUSINESS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select name="style" defaultValue={row?.style ?? "minimal"} className="input">
            {Object.entries(STYLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select name="font" defaultValue={theme.font} className="input">
            <option value="sans">ฟอนต์ปกติ</option>
            <option value="rounded">ฟอนต์มน</option>
            <option value="serif">ฟอนต์เซอริฟ</option>
          </select>
          <select name="radius" defaultValue={theme.radius} className="input">
            <option value="sm">มุมเหลี่ยม</option>
            <option value="md">มุมมนกลาง</option>
            <option value="lg">มุมมนมาก</option>
          </select>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-3 text-xs">
          {COLOR_KEYS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-1">
              <input type="color" name={key} defaultValue={theme[key]} />
              {label}
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" name="isPublished" defaultChecked={row?.isPublished ?? false} />
            เผยแพร่ให้ร้านเลือกใช้
            {row?.publishedAt && <span className="text-[var(--muted)]"> · เผยแพร่ครั้งแรก {row.publishedAt.slice(0, 10)}</span>}
          </label>
          <button type="submit" className={row ? "btn-secondary text-xs" : "btn-primary text-xs"}>{row ? "บันทึก" : "เพิ่มเทมเพลต"}</button>
        </div>
        <div className="flex h-10 overflow-hidden rounded" aria-hidden="true">
          {COLOR_KEYS.map(([key]) => <span key={key} className="flex-1" style={{ background: theme[key] }} />)}
        </div>
      </div>
    </form>
  );
}

const DOMAIN_STATUS: Record<string, string> = { pending: "รอ DNS", active: "ใช้งานได้", error: "มีปัญหา", none: "-" };

/** ซูเปอร์แอดมิน: คลังเทมเพลตรายเดือน + โดเมนของร้าน (layout ของ /system ตรวจสิทธิ์แล้ว) */
export default async function WebsiteTemplatesPage() {
  const [rows, domains] = await Promise.all([listLibraryTemplatesForAdmin(), listCustomDomainsForAdmin()]);
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const vercel = isVercelDomainsConfigured();
  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <h1 className="page-title">คลังเทมเพลตเว็บไซต์ร้าน</h1>
        <p className="text-sm text-[var(--muted)]">
          เพิ่มเทมเพลตใหม่ประจำเดือนได้โดยไม่ต้อง deploy · ติ๊ก “เผยแพร่” แล้วร้าน Enterprise เห็นในหน้าเว็บไซต์ร้านทันที พร้อมป้าย “ใหม่” 30 วัน
          · เทมเพลต = ชุดสี/ฟอนต์/มุม (เนื้อหาของร้านไม่เปลี่ยน) · ตั้งต้นในโค้ด {WEBSITE_TEMPLATES.length} แบบ
        </p>
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-semibold">เพิ่มเทมเพลตใหม่</p>
        <TemplateForm row={null} monthId={`${ym}-`} />
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-semibold">ในคลัง ({rows.length})</p>
        {rows.length === 0 && <p className="text-sm text-[var(--muted)]">ยังไม่มีเทมเพลตในคลัง</p>}
        {rows.map((row) => <TemplateForm key={row.id} row={row} monthId="" />)}
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-semibold">โดเมนของร้าน ({domains.length})</p>
        <p className="text-xs text-[var(--muted)]">
          {vercel
            ? "เซิร์ฟเวอร์ต่อโดเมนเข้า Vercel อัตโนมัติ (VERCEL_TOKEN พร้อม) — ร้านกด “ตรวจสอบ” เอง"
            : "เซิร์ฟเวอร์ไม่มี VERCEL_TOKEN/VERCEL_PROJECT_ID — ต้องเพิ่มโดเมนใน Vercel → Project → Domains เอง แล้วตั้งสถานะ “ใช้งานได้” ที่นี่"}
        </p>
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] gap-2 text-sm">
            {domains.map((d) => (
              <form key={d.storeId} action={setDomainStatusAction} className="grid grid-cols-[1.2fr_1.4fr_.7fr_1.6fr_auto] items-center gap-2">
                <input type="hidden" name="storeId" value={d.storeId} />
                <span className="truncate">{d.storeName} <span className="text-xs text-[var(--muted)]">/s/{d.slug}</span></span>
                <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="truncate font-mono text-xs underline">{d.domain}</a>
                <select name="status" defaultValue={d.status === "none" ? "pending" : d.status} className="input text-xs">
                  {(["pending", "active", "error"] as const).map((s) => <option key={s} value={s}>{DOMAIN_STATUS[s]}</option>)}
                </select>
                <input name="note" defaultValue={d.note ?? ""} maxLength={300} className="input text-xs" placeholder="หมายเหตุถึงร้าน" />
                <button type="submit" className="btn-secondary text-xs">บันทึก</button>
              </form>
            ))}
            {domains.length === 0 && <p className="text-[var(--muted)]">ยังไม่มีร้านตั้งโดเมน</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
