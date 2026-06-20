import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  buildLineIssueLinkTokenRequest,
  buildLineReplyMessageRequest,
  verifyLineSignature,
} from "@/modules/notifications/line";
import {
  consumeLineAccountLinkSession,
  getLineOwnerAccountLinkByLineUserId,
  upsertLineAccountLink,
  upsertLineNotificationTarget,
} from "@/modules/notifications/repository";

export const dynamic = "force-dynamic";

type LineWebhookEvent = {
  type?: string;
  replyToken?: string;
  source?: {
    type?: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
  link?: {
    result?: string;
    nonce?: string;
  };
};

function hashNonce(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

function shouldStartLink(event: LineWebhookEvent) {
  const text = event.message?.text?.trim().toLowerCase();
  return (
    event.type === "message" &&
    event.message?.type === "text" &&
    event.source?.type !== "group" &&
    event.source?.type !== "room" &&
    (text === "ผูกบัญชี" || text === "link")
  );
}

function shouldBindGroup(event: LineWebhookEvent) {
  const text = event.message?.text?.trim().toLowerCase();
  return (
    event.type === "message" &&
    event.message?.type === "text" &&
    (event.source?.type === "group" || event.source?.type === "room") &&
    (text === "ผูกกลุ่ม" || text === "link group" || text === "link room")
  );
}

function getLineChatTarget(event: LineWebhookEvent): { targetType: "group" | "room"; targetId: string } | null {
  if (event.source?.type === "group" && event.source.groupId) {
    return { targetType: "group", targetId: event.source.groupId };
  }
  if (event.source?.type === "room" && event.source.roomId) {
    return { targetType: "room", targetId: event.source.roomId };
  }
  return null;
}

async function fetchLine(request: { url: string; init: RequestInit }) {
  try {
    return await fetch(request.url, request.init);
  } catch {
    return null;
  }
}

async function issueAccountLink(event: LineWebhookEvent, token: string, baseUrl: string) {
  const lineUserId = event.source?.userId;
  if (!lineUserId || !event.replyToken) return;

  const linkTokenResponse = await fetchLine(buildLineIssueLinkTokenRequest(token, lineUserId));
  if (!linkTokenResponse?.ok) return;

  const body = await linkTokenResponse.json().catch(() => null) as { linkToken?: string } | null;
  const linkToken = body?.linkToken;
  if (!linkToken) return;

  const linkUrl = new URL("/api/line/account-link/start", baseUrl);
  linkUrl.searchParams.set("linkToken", linkToken);
  await fetchLine(buildLineReplyMessageRequest(
    token,
    event.replyToken,
    `กดลิงก์นี้เพื่อผูก LINE กับ StoreOS\n${linkUrl.toString()}`,
  ));
}

async function replyLine(token: string, replyToken: string | undefined, text: string) {
  if (!replyToken) return;
  await fetchLine(buildLineReplyMessageRequest(token, replyToken, text));
}

async function bindLineGroup(event: LineWebhookEvent, token: string) {
  const lineUserId = event.source?.userId;
  const target = getLineChatTarget(event);
  if (!target) {
    await replyLine(token, event.replyToken, "ยังไม่พบ LINE group หรือ multi-person chat สำหรับผูกการแจ้งเตือน");
    return;
  }
  if (!lineUserId) {
    await replyLine(token, event.replyToken, "กรุณาพิมพ์คำสั่งจากบัญชี LINE ของ owner ที่ผูก StoreOS แล้ว");
    return;
  }

  const accountLink = await getLineOwnerAccountLinkByLineUserId(lineUserId, { useServiceRole: true });
  if (accountLink.error) {
    await replyLine(token, event.replyToken, "ผูก LINE group ไม่สำเร็จ กรุณาลองอีกครั้ง");
    return;
  }
  if (!accountLink.data) {
    await replyLine(token, event.replyToken, "ต้องเป็น owner ที่ผูกบัญชี LINE ส่วนตัวกับ StoreOS แล้ว จึงจะพิมพ์ “ผูกกลุ่ม” ใน LINE group ได้");
    return;
  }

  const result = await upsertLineNotificationTarget(
    accountLink.data.organizationId,
    accountLink.data.userId,
    target.targetType,
    target.targetId,
  );
  if (result.error) {
    await replyLine(token, event.replyToken, "ผูก LINE group ไม่สำเร็จ กรุณาตรวจสอบว่ากลุ่มนี้ยังไม่ถูกผูกกับร้านอื่น");
    return;
  }

  const targetLabel = target.targetType === "group" ? "LINE group" : "LINE multi-person chat";
  await replyLine(token, event.replyToken, `ผูก ${targetLabel} สำหรับรับ notification ของ StoreOS แล้ว`);
}

async function consumeAccountLink(event: LineWebhookEvent) {
  if (event.type !== "accountLink" || event.link?.result !== "ok") return;
  const lineUserId = event.source?.userId;
  const nonce = event.link?.nonce;
  if (!lineUserId || !nonce) return;

  const session = await consumeLineAccountLinkSession(hashNonce(nonce), { useServiceRole: true });
  if (!session.data || session.error) return;
  await upsertLineAccountLink(session.data.organizationId, session.data.userId, lineUserId);
}

function parseLineWebhookBody(rawBody: string): { events?: LineWebhookEvent[] } | null {
  try {
    return JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const baseUrl = process.env.LINE_ACCOUNT_LINK_BASE_URL;

  if (!channelSecret || !token || !baseUrl) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  if (!verifyLineSignature(rawBody, request.headers.get("x-line-signature"), channelSecret)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const body = parseLineWebhookBody(rawBody);
  if (!body) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  for (const event of events) {
    if (shouldBindGroup(event)) {
      await bindLineGroup(event, token);
      continue;
    }
    if (shouldStartLink(event)) {
      await issueAccountLink(event, token, baseUrl);
      continue;
    }
    await consumeAccountLink(event);
  }

  return NextResponse.json({ ok: true });
}
