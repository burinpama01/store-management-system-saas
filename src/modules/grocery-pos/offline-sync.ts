import type { Cart } from "@/modules/pos/types";

export const GROCERY_POS_OFFLINE_DB_NAME = "storeos-grocery-pos-offline";
export const GROCERY_POS_OFFLINE_DB_VERSION = 1;
export const GROCERY_POS_OPERATION_STORE = "operations";
export const GROCERY_POS_DEVICE_STORAGE_PREFIX = "storeos:grocery-pos:device";

export type GroceryOfflineOperationStatus = "pending" | "syncing" | "synced" | "failed";

export interface GroceryOfflineOrderPayload {
  cart: Cart;
  customerId?: string | null;
  /** ระดับราคาที่แคชเชียร์เลือก (ยืนยันซ้ำฝั่ง server ตอน sync) */
  priceTier?: string | null;
  couponCode?: string | null;
  clientCouponDiscountAmount?: number;
  note?: string;
}

export interface GroceryOfflineOrderOperation {
  operationId: string;
  operationType: "create_order";
  status: GroceryOfflineOperationStatus;
  storeId: string;
  deviceId: string;
  idempotencyKey: string;
  catalogVersion: string;
  createdAt: string;
  updatedAt: string;
  payload: GroceryOfflineOrderPayload;
  retryCount?: number;
  lastAttemptAt?: string | null;
  serverOrderId?: string | null;
  error?: string | null;
}

export interface GroceryOfflineSyncState {
  supported: boolean;
  online: boolean;
  pendingOperations: number;
  failedOperations: number;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface BuildGroceryOfflineOrderOperationInput extends GroceryOfflineOrderPayload {
  storeId: string;
  deviceId: string;
  operationId?: string;
  catalogVersion: string;
  createdAt?: Date;
}

export interface GrocerySyncRunResult {
  attempted: number;
  synced: number;
  failed: number;
  skipped: boolean;
}

export type GrocerySyncPostResult =
  | { ok: true; orderId: string; orderNumber?: string | null }
  | { ok: false; error: string };

export function isGroceryOfflineSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resolveGroceryPosDeviceId(storeId: string): string {
  const storageKey = `${GROCERY_POS_DEVICE_STORAGE_PREFIX}:${storeId}`;
  if (typeof localStorage === "undefined") return `server:${storeId}`;
  const existing = localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = `device-${randomId()}`;
  localStorage.setItem(storageKey, created);
  return created;
}

type GroceryCatalogVersionProduct = {
  id: string;
  basePrice?: number;
  priceWholesale?: number | null;
  priceAgent?: number | null;
  priceRegular?: number | null;
  isActive?: boolean;
  availableForPos?: boolean;
  availableForQr?: boolean;
  updatedAt?: string;
  units?: Array<{
    id: string;
    name?: string;
    quantity?: number;
    price?: number;
    priceWholesale?: number | null;
    priceAgent?: number | null;
    priceRegular?: number | null;
    barcode?: string;
    isActive?: boolean;
    sortOrder?: number;
  }>;
  variants?: Array<{
    id: string;
    name?: string;
    barcode?: string;
    sku?: string;
    priceAdjustment?: number;
    stockQuantity?: number;
    trackStock?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }>;
  modifierGroups?: Array<{
    id: string;
    name?: string;
    selectionType?: string;
    isRequired?: boolean;
    minSelections?: number;
    maxSelections?: number;
    sortOrder?: number;
    options?: Array<{
      id: string;
      name?: string;
      priceAdjustment?: number;
      isDefault?: boolean;
      isActive?: boolean;
      sortOrder?: number;
    }>;
  }>;
};

function stableCatalogHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildGroceryCatalogVersion(input: { products: GroceryCatalogVersionProduct[] }): string {
  const latestProductUpdate = input.products
    .map((product) => product.updatedAt ?? "")
    .sort()
    .at(-1) ?? "";
  const normalizedProducts = input.products
    .map((product) => ({
      id: product.id,
      basePrice: product.basePrice ?? 0,
      priceWholesale: product.priceWholesale ?? null,
      priceAgent: product.priceAgent ?? null,
      priceRegular: product.priceRegular ?? null,
      isActive: product.isActive ?? true,
      availableForPos: product.availableForPos ?? true,
      availableForQr: product.availableForQr ?? false,
      updatedAt: product.updatedAt ?? "",
      units: [...(product.units ?? [])]
        .map((unit) => ({
          id: unit.id,
          name: unit.name ?? "",
          quantity: unit.quantity ?? 0,
          price: unit.price ?? 0,
          priceWholesale: unit.priceWholesale ?? null,
          priceAgent: unit.priceAgent ?? null,
          priceRegular: unit.priceRegular ?? null,
          barcode: unit.barcode ?? "",
          isActive: unit.isActive ?? true,
          sortOrder: unit.sortOrder ?? 0,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
      variants: [...(product.variants ?? [])]
        .map((variant) => ({
          id: variant.id,
          name: variant.name ?? "",
          barcode: variant.barcode ?? "",
          sku: variant.sku ?? "",
          priceAdjustment: variant.priceAdjustment ?? 0,
          stockQuantity: variant.stockQuantity ?? null,
          trackStock: variant.trackStock ?? false,
          isActive: variant.isActive ?? true,
          sortOrder: variant.sortOrder ?? 0,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
      modifierGroups: [...(product.modifierGroups ?? [])]
        .map((group) => ({
          id: group.id,
          name: group.name ?? "",
          selectionType: group.selectionType ?? "",
          isRequired: group.isRequired ?? false,
          minSelections: group.minSelections ?? 0,
          maxSelections: group.maxSelections ?? 0,
          sortOrder: group.sortOrder ?? 0,
          options: [...(group.options ?? [])]
            .map((option) => ({
              id: option.id,
              name: option.name ?? "",
              priceAdjustment: option.priceAdjustment ?? 0,
              isDefault: option.isDefault ?? false,
              isActive: option.isActive ?? true,
              sortOrder: option.sortOrder ?? 0,
            }))
            .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const variantCount = normalizedProducts.reduce((sum, product) => sum + product.variants.length, 0);
  const modifierGroupCount = normalizedProducts.reduce((sum, product) => sum + product.modifierGroups.length, 0);
  const modifierOptionCount = normalizedProducts.reduce(
    (sum, product) =>
      sum + product.modifierGroups.reduce((groupSum, group) => groupSum + group.options.length, 0),
    0,
  );
  const fingerprint = stableCatalogHash(JSON.stringify(normalizedProducts));
  return [
    "catalog",
    `products:${normalizedProducts.length}`,
    `variants:${variantCount}`,
    `modifierGroups:${modifierGroupCount}`,
    `modifierOptions:${modifierOptionCount}`,
    `updated:${latestProductUpdate}`,
    `hash:${fingerprint}`,
  ].join(":");
}

export function buildGroceryOfflineOrderOperation(
  input: BuildGroceryOfflineOrderOperationInput,
): GroceryOfflineOrderOperation {
  const operationId = input.operationId ?? randomId();
  const now = (input.createdAt ?? new Date()).toISOString();
  return {
    operationId,
    operationType: "create_order",
    status: "pending",
    storeId: input.storeId,
    deviceId: input.deviceId,
    idempotencyKey: `grocery-offline:${input.storeId}:${input.deviceId}:${operationId}`,
    catalogVersion: input.catalogVersion,
    createdAt: now,
    updatedAt: now,
    payload: {
      cart: input.cart,
      customerId: input.customerId ?? null,
      priceTier: input.priceTier ?? null,
      couponCode: input.couponCode ?? null,
      clientCouponDiscountAmount: input.clientCouponDiscountAmount ?? 0,
      note: input.note ?? "Grocery POS offline",
    },
    retryCount: 0,
    lastAttemptAt: null,
    serverOrderId: null,
    error: null,
  };
}

function openGroceryOfflineDb(): Promise<IDBDatabase> {
  if (!isGroceryOfflineSupported()) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GROCERY_POS_OFFLINE_DB_NAME, GROCERY_POS_OFFLINE_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Cannot open offline queue"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GROCERY_POS_OPERATION_STORE)) {
        const store = db.createObjectStore(GROCERY_POS_OPERATION_STORE, { keyPath: "operationId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("storeId", "storeId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function withOperationStore<T>(
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => IDBRequest<T> | Promise<IDBRequest<T>>,
): Promise<T> {
  return openGroceryOfflineDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(GROCERY_POS_OPERATION_STORE, mode);
      const store = tx.objectStore(GROCERY_POS_OPERATION_STORE);
      let request: IDBRequest<T>;
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("Offline queue transaction failed"));
      };

      Promise.resolve(handler(store))
        .then((result) => {
          request = result;
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("Offline queue request failed"));
        })
        .catch((error) => reject(error));
    }),
  );
}

export async function enqueueGroceryOfflineOrder(operation: GroceryOfflineOrderOperation): Promise<void> {
  await withOperationStore<IDBValidKey>("readwrite", (store) =>
    store.put({
      ...operation,
      status: "pending",
      updatedAt: new Date().toISOString(),
    }),
  );
}

export async function listPendingGroceryOfflineOperations(storeId?: string): Promise<GroceryOfflineOrderOperation[]> {
  const operations = await withOperationStore<GroceryOfflineOrderOperation[]>("readonly", (store) => store.getAll());
  return operations.filter((operation) => {
    const retryable = operation.status === "pending" || operation.status === "failed";
    return retryable && (!storeId || operation.storeId === storeId);
  });
}

export async function getGroceryOfflineSyncState(storeId?: string): Promise<GroceryOfflineSyncState> {
  if (!isGroceryOfflineSupported()) {
    return {
      supported: false,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      pendingOperations: 0,
      failedOperations: 0,
    };
  }

  const operations = await withOperationStore<GroceryOfflineOrderOperation[]>("readonly", (store) => store.getAll());
  const scoped = storeId ? operations.filter((operation) => operation.storeId === storeId) : operations;
  return {
    supported: true,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    pendingOperations: scoped.filter((operation) => operation.status === "pending").length,
    failedOperations: scoped.filter((operation) => operation.status === "failed").length,
    lastSyncedAt: scoped
      .filter((operation) => operation.status === "synced")
      .map((operation) => operation.updatedAt)
      .sort()
      .at(-1) ?? null,
    lastError: scoped.find((operation) => operation.status === "failed")?.error ?? null,
  };
}

export async function markGroceryOfflineOperationSynced(operationId: string, orderId: string): Promise<void> {
  const operations = await withOperationStore<GroceryOfflineOrderOperation[]>("readonly", (store) => store.getAll());
  const operation = operations.find((item) => item.operationId === operationId);
  if (!operation) return;
  await withOperationStore<IDBValidKey>("readwrite", (store) =>
    store.put({
      ...operation,
      status: "synced",
      serverOrderId: orderId,
      error: null,
      updatedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
    }),
  );
}

export async function markGroceryOfflineOperationFailed(operationId: string, error: string): Promise<void> {
  const operations = await withOperationStore<GroceryOfflineOrderOperation[]>("readonly", (store) => store.getAll());
  const operation = operations.find((item) => item.operationId === operationId);
  if (!operation) return;
  await withOperationStore<IDBValidKey>("readwrite", (store) =>
    store.put({
      ...operation,
      status: "failed",
      error,
      retryCount: (operation.retryCount ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
    }),
  );
}

export function createGroceryPosSyncRunner(input: {
  isOnline: () => boolean;
  listPending: () => Promise<GroceryOfflineOrderOperation[]>;
  postOperation: (operation: GroceryOfflineOrderOperation) => Promise<GrocerySyncPostResult>;
  markSynced: (operationId: string, orderId: string) => Promise<void>;
  markFailed: (operationId: string, error: string) => Promise<void>;
}): () => Promise<GrocerySyncRunResult> {
  return async () => {
    if (!input.isOnline()) return { attempted: 0, synced: 0, failed: 0, skipped: true };

    const pending = await input.listPending();
    let synced = 0;
    let failed = 0;
    for (const operation of pending) {
      const result = await input.postOperation(operation);
      if (result.ok) {
        synced += 1;
        await input.markSynced(operation.operationId, result.orderId);
      } else {
        failed += 1;
        await input.markFailed(operation.operationId, result.error);
      }
    }

    return {
      attempted: pending.length,
      synced,
      failed,
      skipped: false,
    };
  };
}

export async function postGroceryOfflineOperation(
  operation: GroceryOfflineOrderOperation,
): Promise<GrocerySyncPostResult> {
  const response = await fetch("/api/pos/grocery/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    return { ok: false, error: body?.error ?? "sync_failed" };
  }
  return { ok: true, orderId: body.orderId, orderNumber: body.orderNumber ?? null };
}

export function installGroceryPosOfflineSync(input: {
  storeId: string;
  onStatus?: (state: GroceryOfflineSyncState) => void;
}): () => void {
  if (typeof window === "undefined") return () => undefined;

  let disposed = false;
  const emitState = async () => {
    if (disposed) return;
    try {
      input.onStatus?.(await getGroceryOfflineSyncState(input.storeId));
    } catch (error) {
      input.onStatus?.({
        supported: isGroceryOfflineSupported(),
        online: navigator.onLine,
        pendingOperations: 0,
        failedOperations: 1,
        lastError: error instanceof Error ? error.message : "offline_sync_state_failed",
      });
    }
  };
  const run = createGroceryPosSyncRunner({
    isOnline: () => navigator.onLine,
    listPending: () => listPendingGroceryOfflineOperations(input.storeId),
    postOperation: postGroceryOfflineOperation,
    markSynced: markGroceryOfflineOperationSynced,
    markFailed: markGroceryOfflineOperationFailed,
  });
  const sync = async () => {
    await emitState();
    await run();
    await emitState();
  };

  window.addEventListener("online", sync);
  document.addEventListener("visibilitychange", sync);
  void sync();

  return () => {
    disposed = true;
    window.removeEventListener("online", sync);
    document.removeEventListener("visibilitychange", sync);
  };
}
