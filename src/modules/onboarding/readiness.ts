// Readiness engine (F1/Task 5) — pure derivation from a typed count snapshot.
// Deterministic by design: no AI, no guessing; the repository supplies real counts
// scoped to organization + store, and the UI renders what this returns.
export type ReadinessStepId =
  | "store-profile"
  | "catalog"
  | "table"
  | "printer"
  | "first-paid-order";

export type ReadinessSnapshot = Readonly<{
  profileComplete: boolean;
  products: number;
  tables: number;
  printers: number;
  members: number;
  paidOrders: number;
}>;

export type SetupProfile = Readonly<{ usesTables: boolean; needsPrinting: boolean }>;

export type ReadinessStep = Readonly<{ id: ReadinessStepId; status: "complete" | "pending" }>;

export type StoreReadiness = Readonly<{
  steps: ReadinessStep[];
  completed: number;
  nextStep: ReadinessStepId | null;
}>;

function buildRequiredSteps(s: ReadinessSnapshot, p: SetupProfile): ReadinessStep[] {
  const checks: Array<[ReadinessStepId, boolean]> = [
    ["store-profile", s.profileComplete],
    ["catalog", s.products > 0],
  ];
  if (p.usesTables) checks.push(["table", s.tables > 0]);
  if (p.needsPrinting) checks.push(["printer", s.printers > 0]);
  checks.push(["first-paid-order", s.paidOrders > 0]);
  return checks.map(([id, done]) => ({ id, status: done ? "complete" : "pending" }));
}

export function getStoreReadiness(snapshot: ReadinessSnapshot, profile: SetupProfile): StoreReadiness {
  const steps = buildRequiredSteps(snapshot, profile);
  return {
    steps,
    completed: steps.filter((s) => s.status === "complete").length,
    nextStep: steps.find((s) => s.status !== "complete")?.id ?? null,
  };
}