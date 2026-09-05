"use client";

import { useRef, useState } from "react";
import { ModalDialog, ProgressBar, QrCode } from "@/shared/components/ui";
import { uploadWithProgress } from "@/shared/services/upload";
import type { AiUsageSummary } from "@/modules/ai/quota";
import type { CreditPack, TopupHistoryRow } from "@/modules/ai/credits";
import type { SubscriptionQr } from "@/modules/billing/promptpay-provider";
import { getAiUsageAction, getTopupQrAction } from "./ai-credit-actions";

function thb(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function tokens(n: number): string {
  return n.toLocaleString("th-TH");
}
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABEL: Record<TopupHistoryRow["status"], string> = {
  verified: "สำเร็จ",
  rejected: "ไม่ผ่าน",
  duplicate: "สลิปซ้ำ",
};

/**
 * การ์ด "การใช้งาน AI" — โควตาก้อนเดียวรวมทุกฟีเจอร์ (สแกนเมนู / ผู้ช่วยอุปกรณ์ / สั่งงานด้วยเสียง)
 * นับเป็นโทเคนต่อเดือนต่อองค์กร และเติมเงินซื้อโทเคนเพิ่มได้เมื่อโควตาฟรีหมด
 */
export function AiUsagePanel({
  initialSummary,
  initialPacks,
  initialHistory,
  canManageBilling,
  paymentConfigured,
  recipientName,
}: {
  initialSummary: AiUsageSummary;
  initialPacks: CreditPack[];
  initialHistory: TopupHistoryRow[];
  canManageBilling: boolean;
  paymentConfigured: boolean;
  recipientName: string | null;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [packs, setPacks] = useState(initialPacks);
  const [history, setHistory] = useState(initialHistory);
  const [topupOpen, setTopupOpen] = useState(false);
  const [selectedPack, setSelectedPack] = useState<CreditPack | null>(null);
  const [qr, setQr] = useState<SubscriptionQr | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const slipRef = useRef<HTMLInputElement>(null);

  /** เลือกแพ็ก = ขอ QR ของยอดนั้นทันที (ทำในตัวจัดการอีเวนต์ ไม่ใช่ effect) */
  async function selectPack(pack: CreditPack | null) {
    setSelectedPack(pack);
    setQr(null);
    if (!pack) return;
    setQrLoading(true);
    const res = await getTopupQrAction(pack.id);
    setQrLoading(false);
    if (res.ok) setQr(res.qr);
    else setMessage({ kind: "error", text: res.error });
  }

  async function refresh() {
    const res = await getAiUsageAction();
    if (res.ok) {
      setSummary(res.summary);
      setPacks(res.packs);
      setHistory(res.history);
    }
  }

  async function submitSlip(file: File) {
    if (!selectedPack) return;
    setUploading(true);
    setUploadPercent(0);
    setMessage(null);
    const fd = new FormData();
    fd.set("packId", selectedPack.id);
    fd.set("slip", file);
    const res = await uploadWithProgress<{
      ok?: boolean;
      status?: string;
      reason?: string | null;
      tokensAdded?: number;
      error?: string;
    }>("/api/ai/credit-topup", fd, setUploadPercent);
    setUploading(false);
    if (slipRef.current) slipRef.current.value = "";
    if (!res.data) {
      setMessage({ kind: "error", text: "เชื่อมต่อไม่สำเร็จ — ลองใหม่" });
      return;
    }
    if (res.data.error) {
      setMessage({ kind: "error", text: res.data.error });
      return;
    }
    if (res.data.ok) {
      setMessage({
        kind: "ok",
        text: `เติมเครดิตสำเร็จ +${tokens(res.data.tokensAdded ?? 0)} โทเคน — ใช้งาน AI ต่อได้ทันที`,
      });
      await refresh();
      setTopupOpen(false);
      return;
    }
    setMessage({ kind: "error", text: res.data.reason ?? "ตรวจสลิปไม่ผ่าน" });
  }

  const monthlyPercent = summary.budget > 0 ? Math.min(100, Math.round((summary.used / summary.budget) * 100)) : 0;
  const exhausted = summary.remainingRequests <= 0;

  return (
    <section className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">การใช้งาน AI</h2>
          <p className="text-xs text-[var(--muted)]">
            โควตาก้อนเดียวใช้ร่วมกันทุกฟีเจอร์ AI — นับเป็นโทเคนต่อเดือน ต่อองค์กร
          </p>
        </div>
        {canManageBilling ? (
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setTopupOpen(true);
              void selectPack(packs[0] ?? null);
            }}
            className="btn-primary min-h-11 px-4 text-sm"
            disabled={packs.length === 0}
          >
            เติมเงินเพิ่มโทเคน
          </button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="text-xs text-[var(--muted)]">โควตาฟรีเดือนนี้</p>
          <p className="text-lg font-bold tabular-nums">
            {tokens(summary.remaining)} <span className="text-xs font-normal text-[var(--muted)]">/ {tokens(summary.budget)} โทเคน</span>
          </p>
          <div className="mt-2">
            <ProgressBar percent={monthlyPercent} label="ใช้ไปแล้ว" />
          </div>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="text-xs text-[var(--muted)]">เครดิตที่เติมไว้</p>
          <p className="text-lg font-bold tabular-nums">{tokens(summary.creditRemaining)} <span className="text-xs font-normal text-[var(--muted)]">โทเคน</span></p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {summary.creditUsedThisMonth > 0 ? `เดือนนี้ใช้เครดิตไป ${tokens(summary.creditUsedThisMonth)} โทเคน` : "ไม่หมดอายุรายเดือน"}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="text-xs text-[var(--muted)]">ใช้ AI ได้อีก</p>
          <p className={`text-lg font-bold tabular-nums ${exhausted ? "text-red-600" : ""}`}>
            {tokens(summary.remainingRequests)} <span className="text-xs font-normal text-[var(--muted)]">ครั้ง</span>
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            รวม {tokens(summary.totalRemaining)} โทเคน · ครั้งละ {tokens(summary.maxTokensPerRequest)} โทเคน
          </p>
        </div>
      </div>

      {exhausted ? (
        <p className="mt-3 rounded-[var(--radius-md)] border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          โควตา AI หมดแล้ว — ฟีเจอร์ AI ทุกตัวจะหยุดทำงานจนกว่าจะขึ้นเดือนใหม่ หรือเติมเงินซื้อโทเคนเพิ่ม
        </p>
      ) : null}

      <div className="mt-4">
        <h3 className="mb-2 text-sm font-bold">แยกตามฟีเจอร์ (เดือนนี้)</h3>
        <ul className="space-y-1 text-sm">
          {summary.byFeature.map((f) => (
            <li key={f.feature} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1 last:border-0">
              <span>{f.label}</span>
              <span className="tabular-nums text-[var(--muted)]">
                {tokens(f.tokens)} โทเคน · {tokens(f.requests)} ครั้ง
              </span>
            </li>
          ))}
        </ul>
      </div>

      {history.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-bold">ประวัติการเติมเงิน</h3>
          <ul className="space-y-1 text-sm">
            {history.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 text-[var(--ink-2)]">
                <span>
                  {formatDateTime(row.createdAt)} · +{tokens(row.tokens)} โทเคน
                </span>
                <span className={row.status === "verified" ? "text-emerald-700" : "text-red-600"}>
                  {thb(row.amount)} บาท · {STATUS_LABEL[row.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p
          className={`mt-3 rounded-[var(--radius-md)] p-3 text-sm ${
            message.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
          }`}
          role="alert"
        >
          {message.text}
        </p>
      ) : null}

      <ModalDialog
        open={topupOpen}
        title="เติมเงินเพื่อใช้งาน AI ต่อ"
        description="โอนตามยอดของแพ็กที่เลือก แล้วแนบสลิป ระบบตรวจสลิปอัตโนมัติและเพิ่มเครดิตให้ทันที"
        onClose={() => setTopupOpen(false)}
      >
        <div className="space-y-3">
          <div className="grid gap-2">
            {packs.map((pack) => (
              <label
                key={pack.id}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] border p-3 text-sm ${
                  selectedPack?.id === pack.id ? "border-[var(--brand)] bg-[var(--surface-muted)]" : "border-[var(--border)]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="ai-credit-pack"
                    checked={selectedPack?.id === pack.id}
                    onChange={() => void selectPack(pack)}
                    disabled={uploading}
                  />
                  <span>
                    {pack.name}
                    <span className="block text-xs text-[var(--muted)]">
                      ประมาณ {tokens(Math.floor(pack.tokens / summary.maxTokensPerRequest))} ครั้ง
                    </span>
                  </span>
                </span>
                <b className="tabular-nums">{thb(pack.priceThb)} บาท</b>
              </label>
            ))}
          </div>

          {!paymentConfigured ? (
            <p className="rounded-[var(--radius-md)] bg-amber-50 p-3 text-sm text-amber-800">
              ระบบยังไม่ได้ตั้งค่าบัญชีรับเงิน — ติดต่อผู้ดูแลระบบ
            </p>
          ) : qrLoading ? (
            <p className="text-sm text-[var(--muted)]">กำลังสร้าง QR…</p>
          ) : qr && qr.type === "payload" ? (
            <div className="flex flex-col items-center gap-2">
              <QrCode value={qr.payload} />
              <p className="text-xs text-[var(--muted)]">
                {qr.amountEmbedded ? "QR มียอดฝังแล้ว" : "QR ไม่มียอด — กรอกยอดเอง"}
                {recipientName ? ` · ผู้รับ: ${recipientName}` : ""}
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <input
              ref={slipRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void submitSlip(f);
              }}
              className="w-full text-sm"
              disabled={uploading || !selectedPack || !paymentConfigured}
            />
            {uploading ? (
              <div className="space-y-1" aria-live="polite">
                <ProgressBar
                  percent={uploadPercent}
                  label={uploadPercent < 100 ? "กำลังอัปโหลดสลิป" : "กำลังตรวจสลิปกับธนาคาร"}
                />
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">แนบสลิปโอนเงินเพื่อรับเครดิตทันที (สลิปเดิมใช้ซ้ำไม่ได้)</p>
            )}
            {message && message.kind === "error" ? (
              <p className="rounded-[var(--radius-md)] bg-amber-50 p-3 text-sm text-amber-800" role="alert">
                {message.text}
              </p>
            ) : null}
          </div>
        </div>
      </ModalDialog>
    </section>
  );
}
