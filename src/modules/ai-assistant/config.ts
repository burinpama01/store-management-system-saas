import type { Environment } from "./foundation";

/** รับเฉพาะ environment จาก server composition root ห้ามรับจาก request */
export function readAssistantConfig(env: Readonly<Record<string, string | undefined>>) {
  const environment: Environment = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? env.NODE_ENV : "production";
  return {
    environment,
    enabled: env.AI_ASSISTANT_ENABLED === "true" && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    liveEnabled: false as const,
    // PR1 ไม่มี env ปลดล็อก mutation — เปิดได้เมื่อมี durable idempotency เท่านั้น
    mutationsEnabled: false as const,
  };
}
