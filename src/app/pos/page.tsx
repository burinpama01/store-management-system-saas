import { redirect } from "next/navigation";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { requirePermission } from "@/modules/auth/guards";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { getReceiptSettings } from "@/modules/stores/repository";
import { PosTerminal } from "./PosTerminal";

export const dynamic = "force-dynamic";

export default async function PosPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  await requirePermission("pos.use");

  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) redirect("/login");

  const [categoriesResult, productsResult, receiptSettingsResult] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
    getReceiptSettings(ctx.storeId),
  ]);

  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];
  const receiptSettings = receiptSettingsResult.data ?? null;

  return (
    <PosTerminal
      storeId={ctx.storeId}
      storeName={ctx.storeName}
      categories={categories}
      products={products}
      receiptSettings={receiptSettings}
    />
  );
}
