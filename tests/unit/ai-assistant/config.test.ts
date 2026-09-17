import { describe, expect, it } from "vitest";
import { readAssistantConfig } from "@/modules/ai-assistant/config";

describe("trusted assistant config", () => {
  it("defaults to production and disabled", () => {
    expect(readAssistantConfig({})).toEqual({
      enabled: false,
      environment: "production",
      liveEnabled: false,
      livePilotOrgIds: [],
      liveMaxSessionMinutes: 15,
      liveMaxToolCallsPerSession: 40,
      liveMaxConcurrentSessionsPerStore: 2,
      liveModel: "gpt-realtime-2.1-mini",
      liveDiagnosticsEnabled: false,
      liveSpeechSpeed: 0.85,
      liveTranscriptsEnabled: false,
      liveTranscriptRetentionDays: 30,
      liveTranscribeModel: "gpt-4o-mini-transcribe",
      mutationsEnabled: false,
    });
  });

  it("ความเร็วเสียงพูดรับเฉพาะช่วงที่ provider รองรับ ค่าผิด = 0.85", () => {
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_SPEECH_SPEED: "0.7" }).liveSpeechSpeed).toBe(0.7);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_SPEECH_SPEED: "2" }).liveSpeechSpeed).toBe(0.85);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_SPEECH_SPEED: "abc" }).liveSpeechSpeed).toBe(0.85);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_SPEECH_SPEED: "0.1" }).liveSpeechSpeed).toBe(0.85);
  });

  it("เก็บบทสนทนาต้องเปิดตรงตัว และปิดตาม kill switch กลาง", () => {
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED: "true" }).liveTranscriptsEnabled).toBe(true);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED: "1" }).liveTranscriptsEnabled).toBe(false);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED: "true", AI_ASSISTANT_KILL_SWITCH: "true" }).liveTranscriptsEnabled).toBe(false);
  });

  it("โหมดวินิจฉัยต้องเปิดตรงตัวและยังอยู่ใต้ kill switch กลาง", () => {
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED: "true" }).liveDiagnosticsEnabled).toBe(true);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED: "1" }).liveDiagnosticsEnabled).toBe(false);
    expect(readAssistantConfig({
      AI_ASSISTANT_LIVE_DIAGNOSTICS_ENABLED: "true",
      AI_ASSISTANT_KILL_SWITCH: "true",
    }).liveDiagnosticsEnabled).toBe(false);
  });
  it("requires an exact opt-in and keeps kill switch on top of every channel", () => {
    expect(readAssistantConfig({ NODE_ENV: "test", AI_ASSISTANT_ENABLED: "true" }).enabled).toBe(true);
    expect(readAssistantConfig({ AI_ASSISTANT_ENABLED: "1" }).enabled).toBe(false);
    // PR3-Live — kill switch กลางคุม Live เสมอ แม้ LIVE_ENABLED เปิดตรงตัว; รับเฉพาะ "true"
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_ENABLED: "true" }).liveEnabled).toBe(true);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_ENABLED: "true", AI_ASSISTANT_KILL_SWITCH: "true" }).liveEnabled).toBe(false);
    expect(readAssistantConfig({ AI_ASSISTANT_LIVE_ENABLED: "1" }).liveEnabled).toBe(false);
  });
  it("applies kill switch over enabled flag", () => { expect(readAssistantConfig({ AI_ASSISTANT_ENABLED: "true", AI_ASSISTANT_KILL_SWITCH: "true" }).enabled).toBe(false); });
  it("unlocks mutations only via the exact AI_ASSISTANT_MUTATIONS_ENABLED=true (PR3)", () => {
    expect(readAssistantConfig({}).mutationsEnabled).toBe(false);
    expect(readAssistantConfig({ AI_ASSISTANT_MUTATIONS_ENABLED: "1" }).mutationsEnabled).toBe(false);
    expect(readAssistantConfig({ AI_ASSISTANT_MUTATIONS_ENABLED: "TRUE" }).mutationsEnabled).toBe(false);
    expect(readAssistantConfig({ NODE_ENV: "development", AI_ASSISTANT_MUTATIONS_ENABLED: "true" }).mutationsEnabled).toBe(true);
    // production ยังต้องผ่านเกต durable store ของ dispatcher อีกชั้น — env นี้เปิดเองไม่พอ
    expect(readAssistantConfig({ NODE_ENV: "production", AI_ASSISTANT_MUTATIONS_ENABLED: "true" }).mutationsEnabled).toBe(true);
  });
  it("parses pilot org ids as a case-insensitive CSV set (PR3-Live M2)", () => {
    const config = readAssistantConfig({ AI_ASSISTANT_LIVE_PILOT_ORG_IDS: " 11460ba9-BD2D-48d3-bda6-c5e7ddacacc9 , other-org ,," });
    expect(config.livePilotOrgIds).toEqual(["11460ba9-bd2d-48d3-bda6-c5e7ddacacc9", "other-org"]);
    expect(readAssistantConfig({}).livePilotOrgIds).toEqual([]);
    // org นอก pilot ต้องหาไม่เจอแม้ต่างตัวพิมพ์
    expect(config.livePilotOrgIds.includes("11460BA9-BD2D-48D3-BDA6-C5E7DDACACC9".toLowerCase())).toBe(true);
  });
  it("keeps hard caps on sane values from env, else falls back to defaults (PR3-Live M2)", () => {
    const config = readAssistantConfig({
      AI_ASSISTANT_LIVE_MAX_SESSION_MINUTES: "5",
      AI_ASSISTANT_LIVE_MAX_TOOL_CALLS_PER_SESSION: "10",
      AI_ASSISTANT_LIVE_MAX_CONCURRENT_SESSIONS_PER_STORE: "1",
      AI_ASSISTANT_LIVE_MODEL: " gpt-realtime-mini-2025-12-15 ",
    });
    expect(config.liveMaxSessionMinutes).toBe(5);
    expect(config.liveMaxToolCallsPerSession).toBe(10);
    expect(config.liveMaxConcurrentSessionsPerStore).toBe(1);
    expect(config.liveModel).toBe("gpt-realtime-mini-2025-12-15");
    const broken = readAssistantConfig({
      AI_ASSISTANT_LIVE_MAX_SESSION_MINUTES: "0",
      AI_ASSISTANT_LIVE_MAX_TOOL_CALLS_PER_SESSION: "-3",
      AI_ASSISTANT_LIVE_MAX_CONCURRENT_SESSIONS_PER_STORE: "abc",
      AI_ASSISTANT_LIVE_MODEL: "   ",
    });
    expect(broken.liveMaxSessionMinutes).toBe(15);
    expect(broken.liveMaxToolCallsPerSession).toBe(40);
    expect(broken.liveMaxConcurrentSessionsPerStore).toBe(2);
    expect(broken.liveModel).toBe("gpt-realtime-2.1-mini");
  });
});
