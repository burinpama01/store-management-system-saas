import { notFound } from "next/navigation";
import { getStoreBySlug, listPublicTables } from "@/modules/stores/public-repository";
import { TableStatusBoard } from "./TableStatusBoard";

export const dynamic = "force-dynamic";

export default async function PublicTablesPage({
  params,
}: {
  params: Promise<{ storeSlug: string }>;
}) {
  const { storeSlug } = await params;
  if (storeSlug.length > 100) notFound();

  const storeRes = await getStoreBySlug(storeSlug);
  if (storeRes.error || !storeRes.data || !storeRes.data.isActive) notFound();

  const tablesRes = await listPublicTables(storeRes.data.id);

  return (
    <main className="min-h-dvh bg-slate-50 p-4">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-teal-700">Table Monitor</p>
          <h1 className="mt-1 text-xl font-bold text-slate-950">สถานะโต๊ะ</h1>
          <p className="mt-1 text-sm text-slate-500">{storeRes.data.name}</p>
        </header>
        <TableStatusBoard tables={tablesRes.data ?? []} />
      </div>
    </main>
  );
}
