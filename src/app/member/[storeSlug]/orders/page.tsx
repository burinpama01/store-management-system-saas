import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** ประวัติการสั่งย้ายไปเป็นแท็บในหน้าสั่งออนไลน์แล้ว — ลิงก์เดิมพาไปแท็บประวัติ (พก ?code= ต่อ) */
export default async function MemberOrderHistoryRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ storeSlug: string }>;
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { storeSlug } = await params;
  const { code } = await searchParams;
  const codeQs = typeof code === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(code) ? `code=${encodeURIComponent(code)}&` : "";
  redirect(`/member/${encodeURIComponent(storeSlug.slice(0, 100))}/order?${codeQs}view=history`);
}
