"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { VERCEL_A_RECORD, VERCEL_CNAME, isApexDomain, normalizeDomain, type CustomDomainStatus } from "@/modules/store-website/domains";
import { checkCustomDomainAction, removeCustomDomainAction, setCustomDomainAction } from "./actions";

const STATUS: Record<CustomDomainStatus, { text: string; cls: string }> = {
  none: { text: "ยังไม่ได้ตั้ง", cls: "bg-gray-100 text-gray-700" },
  pending: { text: "รอตั้งค่า DNS", cls: "bg-amber-100 text-amber-800" },
  active: { text: "ใช้งานได้", cls: "bg-green-100 text-green-800" },
  error: { text: "มีปัญหา", cls: "bg-red-100 text-red-800" },
};

/** S4: โดเมนของร้านเอง เช่น www.eachother.cafe → เปิดเว็บร้านแทน store-os.online/s/<slug> */
export function DomainPanel({
  domain,
  status,
  note,
}: {
  domain: string | null;
  status: CustomDomainStatus;
  note: string | null;
}) {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();
  const [value, setValue] = useState(domain ?? "");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = domain ?? normalizeDomain(value);
  const apex = shown ? isApexDomain(shown) : false;

  function run(task: () => Promise<{ ok: boolean; error: string | null }>, okText: string) {
    startTransition(async () => {
      const result = await task();
      setMessage(result.ok ? { tone: "ok", text: okText } : { tone: "error", text: result.error ?? "ไม่สำเร็จ" });
      router.refresh();
    });
  }

  return (
    <div className="panel space-y-3 p-4 text-sm">
      {confirmDialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">โดเมนของร้านเอง (ไม่บังคับ)</p>
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[status].cls}`}>{STATUS[status].text}</span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        มีโดเมนที่จดไว้แล้ว (เช่น www.eachother.cafe) ใช้เปิดเว็บร้านแทนลิงก์ store-os.online ได้ · ลิงก์เดิมยังใช้ได้ตามปกติ · ค่าจดโดเมนร้านจ่ายกับผู้ให้บริการโดเมนเอง
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input w-64"
          style={{ fontSize: 16 }}
          value={value}
          placeholder="www.ร้านของคุณ.com"
          maxLength={253}
          onChange={(e) => setValue(e.target.value)}
        />
        {normalizeDomain(value) !== (domain ?? "") && value.trim() !== "" && (
          <button type="button" className="btn-primary text-xs" disabled={pending} onClick={() => run(() => setCustomDomainAction(value), "บันทึกโดเมนแล้ว — ตั้งค่า DNS ตามด้านล่าง แล้วกดตรวจสอบ")}>
            บันทึกโดเมน
          </button>
        )}
        {domain && (
          <>
            <button type="button" className="btn-secondary text-xs" disabled={pending} onClick={() => startTransition(async () => {
              const result = await checkCustomDomainAction();
              setMessage(
                !result.ok
                  ? { tone: "error", text: result.error ?? "ตรวจไม่สำเร็จ" }
                  : result.status === "active"
                    ? { tone: "ok", text: `โดเมนใช้งานได้แล้ว — เปิด https://${domain} ได้เลย` }
                    : { tone: "error", text: "ยังใช้ไม่ได้ — ดูหมายเหตุด้านล่าง" },
              );
              router.refresh();
            })}>
              ตรวจสอบ
            </button>
            <button type="button" className="btn-secondary text-xs" disabled={pending} onClick={async () => {
              if (!(await confirm({ title: "เลิกใช้โดเมนนี้?", message: `${domain} จะไม่เปิดเว็บร้านอีก (ลิงก์ store-os.online ยังใช้ได้)`, confirmLabel: "เลิกใช้", danger: true }))) return;
              run(() => removeCustomDomainAction(), "เลิกใช้โดเมนแล้ว");
              setValue("");
            }}>
              เลิกใช้
            </button>
          </>
        )}
      </div>
      {note && <p className="rounded bg-[var(--surface-muted,#f5f5f4)] px-2 py-1 text-xs">{note}</p>}
      {shown && status !== "active" && (
        <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs">
          <p className="mb-1 font-semibold">ตั้งค่า DNS ที่ผู้ให้บริการโดเมน (เช่น GoDaddy, Namecheap, THNIC)</p>
          <table className="w-full text-left">
            <thead className="text-[var(--color-text-muted)]">
              <tr><th className="pr-2">ชนิด</th><th className="pr-2">ชื่อ (Host)</th><th>ค่า (Value)</th></tr>
            </thead>
            <tbody className="font-mono">
              {apex ? (
                <tr><td className="pr-2">A</td><td className="pr-2">@</td><td>{VERCEL_A_RECORD}</td></tr>
              ) : (
                <tr><td className="pr-2">CNAME</td><td className="pr-2">{shown.split(".")[0]}</td><td>{VERCEL_CNAME}</td></tr>
              )}
            </tbody>
          </table>
          <p className="mt-1 text-[var(--color-text-muted)]">
            {apex ? "โดเมนหลัก (ไม่มี www) ใช้ A record · " : "โดเมนย่อย (เช่น www) ใช้ CNAME · "}
            DNS อาจใช้เวลา 5 นาที–24 ชม. แล้วกด “ตรวจสอบ” · ระบบออกใบรับรอง https ให้อัตโนมัติ
          </p>
        </div>
      )}
      {message && <p className={message.tone === "ok" ? "text-xs text-green-700" : "text-xs text-red-700"}>{message.text}</p>}
    </div>
  );
}
