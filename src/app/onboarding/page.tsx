import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getReadinessSnapshot } from "@/modules/onboarding/repository";
import { getStoreReadiness } from "@/modules/onboarding/readiness";
import type { ReadinessStepId } from "@/modules/onboarding/readiness";
import { getStore } from "@/modules/stores/repository";
import { LineAddDialog } from "./LineAddDialog";
import { SetupProfileForm } from "./SetupProfileForm";

export const dynamic = "force-dynamic";

const STEP_LINKS: Record<ReadinessStepId, { href: string; title: string; desc: string }> = {
  "store-profile": {
    href: "/settings/store",
    title: "ตั้งค่าข้อมูลร้าน",
    desc: "กรอกชื่อร้าน ที่อยู่ และเบอร์โทรให้ครบ",
  },
  catalog: { href: "/catalog", title: "เพิ่มเมนูสินค้า", desc: "สร้างหมวดหมู่ สินค้า ตัวเลือก และราคาเพื่อเริ่มขาย" },
  table: { href: "/settings/tables", title: "ตั้งค่าโต๊ะ", desc: "เพิ่มโต๊ะและ QR ประจำโต๊ะสำหรับลูกค้าสั่งเอง" },
  printer: { href: "/settings/print-hub", title: "เชื่อมเครื่องพิมพ์", desc: "ตั้งค่าเครื่องพิมพ์ใบเสร็จ/สลิปของร้าน" },
  "first-paid-order": {
    href: "/pos",
    title: "ปิดบิลขายจริงบิลแรก",
    desc: "เปิดบิลที่ POS แล้วรับเงินให้สำเร็จ 1 บิล — นับเป็นร้านที่เริ่มขายได้จริง",
  },
};

function resolveLineAddFriendUrl() {
  if (process.env.LINE_ADD_FRIEND_URL) return process.env.LINE_ADD_FRIEND_URL;
  if (process.env.LINE_OFFICIAL_ACCOUNT_ID) {
    return `https://line.me/R/ti/p/${process.env.LINE_OFFICIAL_ACCOUNT_ID}`;
  }
  return null;
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!ctx) redirect("/login");
  const params = await searchParams;
  const addFriendUrl = resolveLineAddFriendUrl();
  const providerReady = Boolean(
    process.env.LINE_CHANNEL_ACCESS_TOKEN &&
      process.env.LINE_CHANNEL_SECRET &&
      process.env.LINE_ACCOUNT_LINK_BASE_URL &&
      addFriendUrl,
  );
  const canManage = resolved.can("settings.manage_store");

  // Legacy-safe: no saved profile yet ({} or missing) → show all steps and keep
  // the legacy navigation; never interpret the empty profile as "all false".
  const storeRes = await getStore(ctx.storeId);
  const profile = storeRes.data?.setupProfile ?? null;
  const readinessProfile = profile ?? { usesTables: true, needsPrinting: true };

  const snapshotRes = await getReadinessSnapshot(ctx.storeId, ctx.organizationId);
  const readiness = snapshotRes.data ? getStoreReadiness(snapshotRes.data, readinessProfile) : null;
  const membersCount = snapshotRes.data?.members ?? null;

  return (
    <main className="min-h-screen bg-[var(--canvas)]">
      <LineAddDialog
        open={params.linePrompt === "1"}
        addFriendUrl={addFriendUrl}
        providerReady={providerReady}
      />
      <div className="mx-auto max-w-3xl px-6 py-10">
        <span className="badge badge-brand mb-3">ยินดีต้อนรับ</span>
        <h1 className="text-3xl font-extrabold text-[var(--ink)]">เริ่มต้นใช้งาน {ctx.orgName}</h1>
        <p className="mt-2 text-[var(--ink-2)]">
          ร้าน <strong>{ctx.storeName}</strong> — ระบบดูสถานะจริงของร้านแล้วช่วยนำทางทีละขั้น
        </p>

        {snapshotRes.error && !readiness ? (
          <div className="mt-6 rounded-[var(--radius-lg)] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            โหลดสถานะร้านไม่สำเร็จ ({snapshotRes.error}) — ลองรีเฟรช หรือไปที่หน้า{" "}
            <Link href="/settings/store" className="font-bold underline">
              ตั้งค่าร้าน
            </Link>{" "}
            และ{" "}
            <Link href="/catalog" className="font-bold underline">
              เมนูสินค้า
            </Link>{" "}
            ก่อนก็ได้
          </div>
        ) : null}

        {readiness ? (
          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between text-sm text-[var(--muted)]">
              <span>
                ความพร้อมเปิดขาย {readiness.completed}/{readiness.steps.length} ขั้น
              </span>
              {membersCount !== null ? (
                <span>สมาชิก {membersCount} คน (ข้อมูลประกอบ — ไม่บังคับ)</span>
              ) : null}
            </div>
            {readiness.steps.map((step, i) => {
              const link = STEP_LINKS[step.id];
              return (
                <Link
                  key={step.id}
                  href={link.href}
                  className={`flex items-start gap-4 rounded-[var(--radius-lg)] border p-4 transition-colors hover:border-[var(--tenant-primary)] ${
                    step.status === "complete"
                      ? "border-green-200 bg-green-50/60"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${
                      step.status === "complete"
                        ? "bg-green-600 text-white"
                        : "bg-[var(--tenant-primary-soft)] text-[var(--tenant-primary-strong)]"
                    }`}
                    aria-label={step.status === "complete" ? "เสร็จแล้ว" : `ขั้นที่ ${i + 1} ยังไม่เสร็จ`}
                  >
                    {step.status === "complete" ? "✓" : i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-bold text-[var(--ink)]">
                      {link.title}
                      {step.status === "pending" && readiness.nextStep === step.id ? (
                        <span className="badge badge-brand ml-2 align-middle">ทำต่อที่นี่</span>
                      ) : null}
                    </p>
                    <p className="text-sm text-[var(--muted)]">{link.desc}</p>
                  </div>
                </Link>
              );
            })}
            <p className="text-xs text-[var(--muted)]">
              เชิญทีมงานและเลือกแพ็กเกจทำภายหลังได้ — ทำเองคนเดียวก็เริ่มขายได้:{" "}
              <Link href="/settings/team" className="font-bold underline">
                ทีมงาน
              </Link>{" "}
              ·{" "}
              <Link href="/settings/billing" className="font-bold underline">
                แพ็กเกจ
              </Link>
            </p>
          </div>
        ) : null}

        <div className="mt-8">
          <SetupProfileForm
            canManage={canManage}
            initial={{
              businessMode: profile?.businessMode ?? "",
              usesTables: profile?.usesTables ?? true,
              needsPrinting: profile?.needsPrinting ?? true,
              hasProfile: profile !== null,
            }}
          />
        </div>

        <Link href="/dashboard" className="btn-primary mt-8 inline-block">
          ไปที่แดชบอร์ด
        </Link>
      </div>
    </main>
  );
}