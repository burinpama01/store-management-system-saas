"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Product } from "@/modules/catalog/types";
import type {
  KitchenStation,
  KitchenStationStaffAssignment,
} from "@/modules/qr-ordering/kitchen-stations";
import {
  assignProductStationAction,
  assignStationStaffAction,
  deleteStationAction,
  saveStationAction,
} from "./actions";
import { Button } from "@/shared/components/ui";

interface Props {
  stations: KitchenStation[];
  products: Product[];
  staffMembers: Array<{ userId: string; email: string }>;
  staffAssignments: KitchenStationStaffAssignment[];
  stationError?: string | null;
  productError?: string | null;
}

export function KitchenStationsManager({
  stations,
  products,
  staffMembers,
  staffAssignments,
  stationError,
  productError,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<KitchenStation | null>(null);
  const [showForm, setShowForm] = useState(stations.length === 0);
  const [error, setError] = useState<string | null>(stationError ?? productError ?? null);

  const activeStations = useMemo(
    () => stations.filter((station) => station.isActive),
    [stations],
  );
  const stationById = useMemo(
    () => new Map(stations.map((station) => [station.id, station])),
    [stations],
  );
  const assignedStaffByStation = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const assignment of staffAssignments) {
      const set = map.get(assignment.kitchenStationId) ?? new Set<string>();
      set.add(assignment.userId);
      map.set(assignment.kitchenStationId, set);
    }
    return map;
  }, [staffAssignments]);

  function handleStationSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await saveStationAction(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(null);
      setShowForm(false);
      router.refresh();
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const result = await deleteStationAction(id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(null);
      router.refresh();
    });
  }

  function handleAssign(productId: string, stationId: string) {
    startTransition(async () => {
      const result = await assignProductStationAction(productId, stationId || null);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  function handleAssignStaff(stationId: string, formData: FormData) {
    const userIds = formData.getAll("staffUserIds").map(String);
    startTransition(async () => {
      const result = await assignStationStaffAction(stationId, userIds);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  const formStation = editing;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">Kitchen stations</h2>
            <p className="mt-1 text-sm text-gray-500">
              Route QR order items to preparation areas for this store.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditing(null);
              setShowForm((value) => !value);
            }}
          >
            {showForm ? "Close" : "Add station"}
          </button>
        </div>

        {error && <div className="alert-danger mt-4">{error}</div>}

        {showForm && (
          <form action={handleStationSubmit} className="mt-4 grid gap-3 rounded-lg border border-gray-200 p-4 md:grid-cols-3">
            <input type="hidden" name="id" value={formStation?.id ?? ""} />
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Name</span>
              <input
                className="form-input"
                name="name"
                defaultValue={formStation?.name ?? ""}
                maxLength={80}
                required
                placeholder="Hot kitchen"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Sort</span>
              <input
                className="form-input"
                name="sortOrder"
                type="number"
                min={0}
                max={999}
                defaultValue={formStation?.sortOrder ?? 0}
              />
            </label>
            <label className="space-y-1 md:col-span-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Description</span>
              <input
                className="form-input"
                name="description"
                defaultValue={formStation?.description ?? ""}
                placeholder="Optional notes for staff"
              />
            </label>
            <div className="flex gap-2 md:col-span-3">
              <Button variant="primary" type="submit" loading={isPending}>
                Save station
              </Button>
              {formStation && (
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setShowForm(false);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
          {stations.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No kitchen station yet.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {stations.map((station) => {
                const assignedStaff = assignedStaffByStation.get(station.id) ?? new Set<string>();
                return (
                <div key={station.id} className="grid gap-4 p-4 lg:grid-cols-[1fr_360px] lg:items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-gray-900">{station.name}</p>
                      <span className={station.isActive ? "badge badge-success" : "badge"}>
                        {station.isActive ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {station.description || "No description"} · sort {station.sortOrder}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
                    {station.isActive && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setEditing(station);
                          setShowForm(true);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {station.isActive && (
                      <Button
                        variant="danger"
                        onClick={() => handleDelete(station.id)}
                        loading={isPending}
                      >
                        Disable
                      </Button>
                    )}
                  </div>
                  {station.isActive && (
                    <form
                      action={(formData) => handleAssignStaff(station.id, formData)}
                      className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-3 lg:col-span-2"
                    >
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Staff assigned to this kitchen
                        </p>
                        <p className="mt-1 text-xs text-gray-500">
                          Only staff linked here will see QR order items for this kitchen.
                        </p>
                      </div>
                      {staffMembers.length === 0 ? (
                        <p className="text-sm text-gray-500">No staff role members found.</p>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {staffMembers.map((member) => (
                            <label
                              key={member.userId}
                              className="flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
                            >
                              <input
                                type="checkbox"
                                name="staffUserIds"
                                value={member.userId}
                                defaultChecked={assignedStaff.has(member.userId)}
                                disabled={isPending}
                              />
                              <span className="min-w-0 truncate">{member.email}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      <Button type="submit" variant="secondary" className="min-h-11 px-3 text-xs" loading={isPending}>
                        Save staff routing
                      </Button>
                    </form>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">Product routing</h2>
            <p className="mt-1 text-sm text-gray-500">
              Assign QR menu items to the station that should prepare them.
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
          {products.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No products found.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {products.map((product) => {
                const assigned = product.kitchenStationId
                  ? stationById.get(product.kitchenStationId)
                  : null;
                return (
                  <div key={product.id} className="grid gap-3 p-4 md:grid-cols-[1fr_260px] md:items-center">
                    <div>
                      <p className="font-medium text-gray-900">{product.name}</p>
                      <p className="text-sm text-gray-500">
                        {product.availableForQr ? "QR enabled" : "QR disabled"} ·{" "}
                        {assigned?.name ?? "Unassigned"}
                      </p>
                    </div>
                    <select
                      className="form-input"
                      value={product.kitchenStationId ?? ""}
                      onChange={(event) => handleAssign(product.id, event.target.value)}
                      disabled={isPending}
                    >
                      <option value="">Unassigned</option>
                      {activeStations.map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
