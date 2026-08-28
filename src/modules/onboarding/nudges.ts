// Task 12/E (v0.34.3) — Activation nudges (F5).
// Deterministic core reusing the Task 5 readiness engine: nudge at most ONE
// step per store per Asia/Bangkok day, stop entirely once a real paid order
// exists, respect opt-out. Idempotency key = store:step:date (unique claim).
import { getStoreReadiness, type ReadinessSnapshot, type SetupProfile, type ReadinessStepId } from "./readiness";

export type ActivationNudge = Readonly<{ step: ReadinessStepId; idempotencyKey: string }>;

/** YYYY-MM-DD in Asia/Bangkok regardless of the server clock timezone. */
export function bangkokDateIso(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(date);
}

export function pickActivationNudge(args: {
  storeId: string;
  readiness: ReadinessSnapshot;
  profile: SetupProfile | null;
  nudgedStepsToday: ReadonlyArray<string>;
  optedOut: boolean;
  now: Date;
}): ActivationNudge | null {
  if (args.optedOut) return null;
  if (args.readiness.paidOrders > 0) return null;
  const profile = args.profile ?? { usesTables: true, needsPrinting: true };
  const readiness = getStoreReadiness(args.readiness, profile);
  const step = readiness.nextStep;
  if (!step) return null;
  const today = bangkokDateIso(args.now);
  if (args.nudgedStepsToday.includes(step)) return null;
  return { step, idempotencyKey: `${args.storeId}:${step}:${today}` };
}