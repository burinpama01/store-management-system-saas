import type { Environment } from "./foundation";

/** รับเฉพาะ environment จาก server composition root ห้ามรับจาก request */
export function readAssistantConfig(env: Readonly<Record<string, string | undefined>>) {
  const environment: Environment = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? env.NODE_ENV : "production";
  return {
    environment,
    enabled: env.AI_ASSISTANT_ENABLED === "true" && env.AI_ASSISTANT_KILL_SWITCH !== "true",
    liveEnabled: false as const,
    // PR3 — mutation ปลดได้เฉพาะ env เป็น "true" แบบตรงตัว แต่ใน production ยังต้องผ่าน
    // เกต durable store ของ dispatcher อีกชั้น (env เดียวไม่พอ — ดู checkpoint หัวข้อปลด mutation)
    mutationsEnabled: env.AI_ASSISTANT_MUTATIONS_ENABLED === "true",
  };
}
