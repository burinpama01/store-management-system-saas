// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const actions = vi.hoisted(() => ({ assignStationStaffAction: vi.fn(async () => ({})), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock("@/app/(dashboard)/settings/kitchen/actions", () => ({
  assignStationStaffAction: actions.assignStationStaffAction,
  assignProductStationAction: vi.fn(), deleteStationAction: vi.fn(), saveStationAction: vi.fn(),
}));
import { KitchenStationsManager } from "@/app/(dashboard)/settings/kitchen/KitchenStationsManager";
afterEach(cleanup);

it("submits multiple selected people to the same station", async () => {
  render(<KitchenStationsManager
    stations={[{ id: "station", organizationId: "org", storeId: "store", name: "ครัว", sortOrder: 0, isActive: true, createdAt: "", updatedAt: "" }]}
    products={[]} printers={[]} staffAssignments={[]}
    staffMembers={[{ userId: "s", email: "staff@example.test" }, { userId: "m", email: "manager@example.test" }]}
  />);
  fireEvent.click(screen.getByRole("checkbox", { name: "staff@example.test" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "manager@example.test" }));
  fireEvent.click(screen.getByRole("button", { name: "บันทึกผู้รับผิดชอบครัว" }));
  await waitFor(() => expect(actions.assignStationStaffAction).toHaveBeenCalledWith("station", ["s", "m"]));
});
