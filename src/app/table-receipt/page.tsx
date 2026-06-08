import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getStore, getTable } from "@/modules/stores/repository";
import { QrCode } from "@/shared/components/ui/QrCode";
import { nowMs } from "@/shared/utils/time";
import { PrintButton } from "../payslip/PrintButton";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function TableReceiptPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("pos.use")) redirect("/dashboard");

  const params = await searchParams;
  const tableId = params.tableId ?? "";
  if (!UUID_RE.test(tableId)) redirect("/pos");

  const [storeRes, tableRes, h] = await Promise.all([getStore(ctx.storeId), getTable(tableId, ctx.storeId), headers()]);
  const store = storeRes.data;
  const table = tableRes.data;
  if (!store || !table) redirect("/pos");

  const host = h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = host ? `${proto}://${host}` : "";
  const qrUrl = `${baseUrl}/qr/${store.slug}/${table.id}`;

  const active = table.sessionExpiresAt && Date.parse(table.sessionExpiresAt) > nowMs();

  return (
    <main className="mx-auto max-w-xs bg-white p-5 text-center text-gray-900">
      <style>{`@media print { @page { margin: 6mm; } body { background: white; } }`}</style>
      <div className="mb-3 print:hidden">
        <PrintButton />
      </div>

      <h1 className="text-lg font-bold">{store.name}</h1>
      <p className="mt-1 text-sm text-gray-500">ใบเปิดโต๊ะ</p>
      <p className="mt-3 text-2xl font-extrabold">โต๊ะ {table.label ?? table.number}</p>

      {active && table.sessionStartedAt && table.sessionExpiresAt ? (
        <div className="mt-3 text-sm">
          <p>เปิดโต๊ะ: {fmtTime(table.sessionStartedAt, store.timezone)} น.</p>
          <p className="font-bold text-orange-600">ใช้ได้ถึง: {fmtTime(table.sessionExpiresAt, store.timezone)} น.</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-red-600">โต๊ะนี้ยังไม่ได้เปิด / หมดเวลาแล้ว</p>
      )}

      <div className="mt-4 flex justify-center">
        {baseUrl ? <QrCode value={qrUrl} size={210} /> : null}
      </div>
      <p className="mt-3 text-sm font-semibold">สแกนเพื่อสั่งอาหาร</p>
      <p className="mt-1 text-xs text-gray-400">สั่งได้จนถึงเวลาที่ระบุด้านบน · หมดเวลาแล้วกรุณาแจ้งพนักงาน</p>
    </main>
  );
}
