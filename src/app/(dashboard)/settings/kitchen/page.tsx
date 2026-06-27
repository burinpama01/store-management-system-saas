import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listProducts } from "@/modules/catalog/repository";
import {
  listKitchenStationStaffAssignments,
  listKitchenStations,
} from "@/modules/qr-ordering/kitchen-stations";
import { listStoreMemberships } from "@/modules/settings/repository";
import { listPrinters } from "@/modules/stores/repository";
import { KitchenStationsManager } from "./KitchenStationsManager";

export const dynamic = "force-dynamic";

export default async function KitchenSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const [stationsRes, productsRes, staffAssignmentsRes, membersRes, printersRes] = await Promise.all([
    listKitchenStations(ctx.storeId, { includeInactive: true }),
    listProducts(ctx.storeId, { includeInactive: true }),
    listKitchenStationStaffAssignments(ctx.storeId),
    listStoreMemberships(ctx.organizationId, ctx.storeId),
    listPrinters(ctx.storeId, ctx.organizationId),
  ]);
  const staffMembers = (membersRes.data ?? []).filter((member) => member.role === "staff");

  return (
    <KitchenStationsManager
      stations={stationsRes.data ?? []}
      products={productsRes.data ?? []}
      staffMembers={staffMembers.map((member) => ({
        userId: member.userId,
        email: member.email,
      }))}
      staffAssignments={staffAssignmentsRes.data ?? []}
      printers={(printersRes.data ?? []).map((printer) => ({
        id: printer.id,
        name: printer.name,
        type: printer.type,
      }))}
      stationError={stationsRes.error?.userMessage ?? null}
      productError={
        productsRes.error?.userMessage ??
        staffAssignmentsRes.error?.userMessage ??
        membersRes.error?.userMessage ??
        null
      }
    />
  );
}
