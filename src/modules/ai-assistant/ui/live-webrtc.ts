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
//   - เสียงตอบของผู้ช่วยมาเป็น remote track ของ WebRTC ต้องต่อเข้า element เสียงเสมอ
//     (ไม่ต่อ = เงียบสนิททั้งที่ทุกอย่างทำงานถูก — ดู createRemoteAudioSink)

import type { LiveConnectionHandle, LiveConnectOptions } from "./live-assistant-core";

/**
 * ปลายทางแลก SDP ของ Realtime GA — `POST /v1/realtime/calls`
 *
 * ของเดิมยิงไป `/v1/realtime?model=...` ซึ่งเป็นรูปแบบก่อน GA และจะต่อไม่ติดเลย
 * (คู่กับ `/v1/realtime/sessions` ที่เราเลิกใช้ไปแล้วตอน M3 — ฝั่งสร้าง ephemeral token
 * ย้ายไป `/v1/realtime/client_secrets` แต่ฝั่ง SDP ยังค้างรูปแบบเก่าไว้)
 *
 * ไม่ต้องส่ง model ใน URL เพราะ model ถูกผูกไว้กับ ephemeral client secret ตั้งแต่ตอน
 * สร้างเซสชันฝั่ง server แล้ว (live-openai-tools.createLiveEphemeralSession)
 */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

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

// ── ปลายทางเสียงของผู้ช่วย (แยกออกมาให้เทสต์ได้โดยไม่มี DOM จริง) ──────────────────

/** ส่วนของ HTMLAudioElement ที่ sink ใช้จริง — ประกาศแคบ ๆ เพื่อให้ฉีดของปลอมในเทสต์ได้ */
export interface RemoteAudioElement {
  autoplay: boolean;
  srcObject: MediaStream | null;
  play: () => Promise<void> | void;
  pause: () => void;
  remove: () => void;
}

export interface RemoteAudioSink {
  /** ต่อ stream ที่ provider ส่งมาเข้าลำโพง — เรียกซ้ำด้วย stream เดิมได้ (ไม่สร้าง element ใหม่) */
  readonly attach: (stream: MediaStream) => void;
  /** ถอดเสียงออกทุกทาง — เรียกซ้ำได้ ปลอดภัยแม้ยังไม่เคย attach */
  readonly close: () => void;
}

/**
 * element เสียงเริ่มต้น: ไม่ผูกกับ layout ของหน้า (ไม่มีภาพ) และไม่ต้องให้ผู้ใช้กดเล่น
 * เพราะเซสชันเริ่มจากการแตะปุ่ม AI Live อยู่แล้ว (มี user activation ครบ)
 * `playsinline` จำเป็นกับ iPad/Safari ไม่งั้น WebView จะพยายามเปิดโหมดเต็มจอ
 */
function createDefaultAudioElement(): RemoteAudioElement {
  const element = document.createElement("audio");
  element.autoplay = true;
  element.setAttribute("playsinline", "");
  element.setAttribute("aria-hidden", "true");
  element.style.display = "none";
  document.body.appendChild(element);
  return element as unknown as RemoteAudioElement;
}

/**
 * ต่อเสียงตอบของผู้ช่วยเข้าลำโพงของเครื่อง
 *
 * เหตุผลที่ต้องมี: WebRTC ส่งเสียงกลับมาเป็น remote track ซึ่ง "ไม่ดังเอง" — ต้องมี
 * element เสียงถือ stream ไว้เสมอ ถ้าลืมส่วนนี้ ระบบจะทำงานถูกทุกอย่าง (tool วิ่ง ตะกร้าเปลี่ยน)
 * แต่ผู้ใช้ไม่ได้ยินอะไรเลย ซึ่งเป็นอาการที่ไล่สาเหตุยากที่สุดของโหมดเสียง
 *
 * play() ที่ถูกปฏิเสธ (autoplay policy) ไม่ทำให้เซสชันล้ม — element ตั้ง autoplay ไว้แล้ว
 * และเสียงจะเริ่มเองเมื่อเบราว์เซอร์ยอม; เราไม่โยน error ออกไปกวนบทสนทนา
 */
export function createRemoteAudioSink(createElement: () => RemoteAudioElement = createDefaultAudioElement): RemoteAudioSink {
  let element: RemoteAudioElement | null = null;
  let closed = false;

  return {
    attach(stream: MediaStream): void {
      if (closed) return;
      element ??= createElement();
      if (element.srcObject === stream) return;
      element.srcObject = stream;
      try {
        void Promise.resolve(element.play()).catch(() => undefined);
      } catch {
        // เบราว์เซอร์บางตัวโยนแบบ sync — autoplay ของ element จะจัดการต่อเอง
      }
    },
    close(): void {
      closed = true;
      const current = element;
      element = null;
      if (!current) return;
      try {
        current.pause();
      } catch {
        // หยุดไปแล้ว
      }
      current.srcObject = null;
      try {
        current.remove();
      } catch {
        // ถูกถอดออกจากหน้าไปแล้ว
      }
    },
  };
}

// ── แลก SDP กับ provider (แยกออกมาให้เทสต์รูปทรง request ได้โดยไม่มี WebRTC) ────────

/**
 * ส่ง offer SDP ไป `/v1/realtime/calls` แล้วคืน answer SDP เป็นข้อความ
 *
 * ทั้งสามอย่างนี้ห้ามเพี้ยน ไม่งั้นจะต่อไม่ติดโดยไม่มีอะไรบอกสาเหตุที่ฝั่งผู้ใช้:
 *   - method POST + `Content-Type: application/sdp` (body เป็น SDP ดิบ ไม่ใช่ JSON)
 *   - `Authorization: Bearer <ephemeral client secret>` (ไม่ใช่ OPENAI_API_KEY — ตัวจริงอยู่ฝั่ง server)
 *   - ไม่มี query string ใด ๆ (model ผูกกับ client secret ตั้งแต่ตอนสร้างเซสชันแล้ว)
 */
export async function exchangeSdpOffer(options: {
  readonly ephemeralToken: string;
  readonly offerSdp: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(REALTIME_CALLS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.ephemeralToken}`,
      "Content-Type": "application/sdp",
    },
    body: options.offerSdp,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`realtime_sdp_${response.status}`);
  return response.text();
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
  const speaker = createRemoteAudioSink();
  // เสียงของผู้ช่วยมาทาง track นี้ — ต่อเข้าลำโพงทันทีที่ provider ส่งมา
  // (event.streams ว่างในบางเบราว์เซอร์ จึงห่อ track เป็น stream เองเป็นทางสำรอง)
  peer.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    speaker.attach(stream);
  };

  let closed = false;
  const stopEverything = (): void => {
    if (closed) return;
    closed = true;
    speaker.close();
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
    const answerSdp = await exchangeSdpOffer({
      ephemeralToken: options.ephemeralToken,
      offerSdp: offer.sdp ?? "",
    });
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
