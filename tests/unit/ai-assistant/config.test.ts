import { describe, expect, it } from "vitest";
import { readAssistantConfig } from "@/modules/ai-assistant/config";

describe("trusted assistant config", () => {
  it("defaults to production and disabled", () => { expect(readAssistantConfig({})).toEqual({ enabled: false, environment: "production", liveEnabled: false, mutationsEnabled: false }); });
  it("requires an exact opt-in and keeps Live disabled in PR1", () => { expect(readAssistantConfig({ NODE_ENV: "test", AI_ASSISTANT_ENABLED: "true", AI_ASSISTANT_LIVE_ENABLED: "true" })).toEqual({ enabled: true, environment: "test", liveEnabled: false, mutationsEnabled: false }); expect(readAssistantConfig({ AI_ASSISTANT_ENABLED: "1" }).enabled).toBe(false); });
  it("applies kill switch over enabled flag", () => { expect(readAssistantConfig({ AI_ASSISTANT_ENABLED: "true", AI_ASSISTANT_KILL_SWITCH: "true" }).enabled).toBe(false); });
});
