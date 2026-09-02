"use client";

// U14 — Voice Tier A navigation (R2) · ตัวเชื่อมเดียวระหว่างปุ่มเสียงกับ shell
// หน้าที่: รับผล parse → ถาม resolveVoiceNavigation (pure) → ลงมือทำเฉพาะปลายทางที่อนุญาต
// ห้ามมี logic ตัดสินใจอยู่ในไฟล์นี้ — ตัดสินใจทั้งหมดอยู่ใน src/modules/voice-pos/navigation.ts
//
// หมายเหตุ: component นี้ mount เฉพาะเมื่อ stores.voice_command_enabled = true เท่านั้น
// (useRouter จึงไม่ถูกเรียกในเส้นทาง legacy/flag ปิด)

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { VoiceCommandButton } from "@/shared/components/VoiceCommandButton";
import { DASHBOARD_COMMANDS, type CommandItem } from "@/modules/assistant/command-index";
import {
  resolveVoiceNavigation,
  type VoicePosFocusAction,
  type VoicePosTabId,
} from "@/modules/voice-pos/navigation";
import type { VoiceSpeechAdapter } from "@/modules/voice-pos/speech-adapter";
import type { VoiceParseResult } from "@/modules/voice-pos/types";

const FOCUS_UNAVAILABLE: Record<VoicePosFocusAction, string> = {
  search: "หน้านี้ยังไม่มีช่องค้นหา — เลือกจากแท็บบนหน้าจอได้",
  cart: "ยังไม่พบตะกร้าบนหน้านี้ — เลือกจากแท็บบนหน้าจอได้",
};

export interface VoicePosControllerProps {
  readonly voiceEnabled: boolean;
  /** command ที่ผู้ใช้คนนี้เข้าถึงได้ (server กรองสิทธิ์มาแล้ว) */
  readonly allowedCommands: readonly CommandItem[];
  readonly onSelectTab: (tabId: VoicePosTabId) => void;
  /** ฉีด adapter สำหรับทดสอบ — ปกติปุ่มจะใช้ Web Speech ของเบราว์เซอร์เอง */
  readonly adapter?: VoiceSpeechAdapter;
  readonly className?: string;
}

export function VoicePosController({
  voiceEnabled,
  allowedCommands,
  onSelectTab,
  adapter,
  className,
}: VoicePosControllerProps) {
  const router = useRouter();

  const handleResult = useCallback(
    (result: VoiceParseResult): string => {
      const outcome = resolveVoiceNavigation(result, {
        voiceEnabled,
        allowedCommands,
        allCommands: DASHBOARD_COMMANDS,
      });
      if (outcome.status === "blocked") return outcome.announcement;

      const target = outcome.target;
      if (target.kind === "tab") {
        onSelectTab(target.tabId);
        return outcome.announcement;
      }
      if (target.kind === "focus") {
        // ตะกร้าอยู่ในแท็บขายเสมอ — สลับแท็บก่อนแล้วค่อยโฟกัส
        if (target.action === "cart") onSelectTab("sell");
        const element = document.querySelector<HTMLElement>(`[data-voice-focus="${target.action}"]`);
        if (!element) return FOCUS_UNAVAILABLE[target.action];
        element.scrollIntoView({ block: "nearest" });
        element.focus();
        return outcome.announcement;
      }
      // route มาจาก command index เท่านั้น (ตรวจแล้วใน resolveVoiceNavigation)
      router.push(target.href);
      return outcome.announcement;
    },
    [allowedCommands, onSelectTab, router, voiceEnabled],
  );

  if (!voiceEnabled) return null;

  return <VoiceCommandButton adapter={adapter} onResult={handleResult} className={className} />;
}
