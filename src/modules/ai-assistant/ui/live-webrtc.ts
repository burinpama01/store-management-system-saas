// PR3-Live (M5) — ท่อเชื่อมเสียงสดจริงของเบราว์เซอร์: WebRTC → OpenAI Realtime (GA)
//
// บทบาทของไฟล์นี้: เป็น `connect` ที่ overlay ฉีดเข้า createLiveAssistantCore —
// จับไมค์ด้วย getUserMedia, ต่อ RTCPeerConnection, เปิด data channel "oai-events"
// แล้วแปลง event ของ provider เป็นสัญญาณที่ core รู้จักเท่านั้น (browser ห้าม execute tool
// เอง — function_call ทุกอันถูกส่งต่อให้ core เพื่อ relay ผ่าน server ตาม ADR-003)
//
// ขอบเขตที่ล็กไว้:
//   - ไม่เก็บ/ไม่บันทึกเสียงทุกชนิด — track ที่จับถูก stop ใน close เสมอ (ปิดไมค์ทุกทาง)
//   - ephemeral token ใช้แลก SDP เท่านั้น (OPENAI_API_KEY ไม่เคยมาถึง browser — M3)
//   - onOpen มาจาก data channel เปิดจริงจังหวะเดียว — event session.* ของ provider ไม่ใช้
//     ทริกเกอร์ซ้ำ (กันข้อความ "เริ่มฟังแล้ว" โผล่สองครั้ง)
//   - ข้อความดิบของ provider ไม่หลุดออกนอกไฟล์ — onError เป็นสัญญาณเดียว (fail closed)

import type { LiveConnectionHandle, LiveConnectOptions } from "./live-assistant-core";

const REALTIME_SDP_URL = (model: string): string =>
  `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

// ── สัญญาณที่ core รู้จัก (pure — เทสต์ได้โดยไม่มี WebRTC) ────────────────────────

export type RealtimeSignal =
  | { readonly kind: "user_speech_started" }
  | { readonly kind: "function_call"; readonly callId: string; readonly tool: string; readonly argsText: string }
  | { readonly kind: "assistant_response_done" }
  | { readonly kind: "error" };

/** แปลง event ดิบของ provider → สัญญาณที่ core รู้จัก; ไม่รู้จัก/รูปทรงเพี้ยน = null (เมินเงียบ ๆ) */
export function parseRealtimeEvent(raw: unknown): RealtimeSignal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as { type?: unknown; item?: unknown };
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      return { kind: "user_speech_started" };
    case "response.output_item.done": {
      const item = typeof event.item === "object" && event.item !== null
        ? (event.item as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown })
        : null;
      if (item?.type !== "function_call" || typeof item.call_id !== "string" || typeof item.name !== "string") return null;
      // argsText เป็น JSON string ดิบ — core เป็นคน parse เสมอ (ตาม contract ของ LiveConnectionHandlers)
      return {
        kind: "function_call",
        callId: item.call_id,
        tool: item.name,
        argsText: typeof item.arguments === "string" ? item.arguments : "",
      };
    }
    case "response.done":
      return { kind: "assistant_response_done" };
    case "error":
      return { kind: "error" };
    default:
      return null;
  }
}

// ── ตัวต่อจริง (browser เท่านั้น — ถูกเรียกตอนแตะปุ่ม AI Live) ────────────────────

/**
 * ต่อเสียงสด: จับไมค์ → offer SDP → แลก answer กับ provider ด้วย ephemeral token →
 * คืน handle ของ data channel ให้ core ส่ง function_call_output / ปิดทุกท่อน
 * ทุก failure ระหว่างต่อ = หยุด track ไมค์คืนก่อน throw เสมอ (ไม่ทิ้งไมค์ค้าง)
 */
export async function connectLiveWebRtc(options: LiveConnectOptions): Promise<LiveConnectionHandle> {
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const tracks: readonly MediaStreamTrack[] = [...media.getTracks()];
  const peer = new RTCPeerConnection();
  for (const track of tracks) peer.addTrack(track, media);
  const channel = peer.createDataChannel("oai-events");

  let closed = false;
  const stopEverything = (): void => {
    if (closed) return;
    closed = true;
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // หยุดไปแล้ว — ไม่มีผลอะไรเพิ่ม
      }
    }
    try {
      channel.close();
    } catch {
      // ปิดไปแล้ว
    }
    try {
      peer.close();
    } catch {
      // ปิดไปแล้ว
    }
  };

  const handlers = options.handlers;
  channel.onopen = () => handlers.onOpen();
  channel.onmessage = (message: MessageEvent) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(message.data));
    } catch {
      return; // ไม่ใช่ JSON — เมิน (fail closed ไม่เดา)
    }
    const signal = parseRealtimeEvent(parsed);
    if (!signal) return;
    switch (signal.kind) {
      case "user_speech_started":
        handlers.onUserSpeechStarted();
        return;
      case "function_call":
        handlers.onFunctionCall({ callId: signal.callId, tool: signal.tool, argsText: signal.argsText });
        return;
      case "assistant_response_done":
        handlers.onAssistantResponseDone();
        return;
      case "error":
        // ห้ามโชว์ข้อความดิบของ provider — core ใช้ข้อความไทย fail closed ของตัวเอง
        handlers.onError("realtime_error");
        return;
      default:
        return;
    }
  };
  channel.onclose = () => handlers.onClosed();
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected") handlers.onClosed();
  };

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(REALTIME_SDP_URL(options.model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.ephemeralToken}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`realtime_sdp_${response.status}`);
    const answerSdp = await response.text();
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    stopEverything();
    throw error;
  }

  return {
    sendFunctionCallOutput: (callId: string, outputJson: string): void => {
      if (channel.readyState !== "open") return; // ปิดไปแล้ว — core จะเห็น onClosed เอง
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: outputJson },
      }));
      channel.send(JSON.stringify({ type: "response.create" }));
    },
    close: stopEverything,
  };
}
