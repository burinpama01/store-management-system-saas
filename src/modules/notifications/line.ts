import { createHmac, timingSafeEqual } from "node:crypto";
import type { NotificationPayload } from "./types";

export interface LineRequest {
  url: string;
  init: RequestInit;
}

const LINE_PUSH_MESSAGE_URL = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_MESSAGE_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_USER_API_BASE_URL = "https://api.line.me/v2/bot/user/";

export function verifyLineSignature(rawBody: string, signature: string | null, channelSecret: string) {
  if (!signature || !channelSecret) return false;

  const expected = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function formatLineText(input: NotificationPayload) {
  const title = input.title?.trim();
  return [title, input.message.trim()].filter(Boolean).join("\n");
}

function lineHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function buildLinePushMessageRequest(
  token: string,
  targetId: string,
  input: NotificationPayload,
): LineRequest {
  return {
    url: LINE_PUSH_MESSAGE_URL,
    init: {
      method: "POST",
      headers: lineHeaders(token),
      body: JSON.stringify({
        to: targetId,
        messages: [{ type: "text", text: formatLineText(input) }],
      }),
    },
  };
}

export function buildLineReplyMessageRequest(
  token: string,
  replyToken: string,
  text: string,
): LineRequest {
  return {
    url: LINE_REPLY_MESSAGE_URL,
    init: {
      method: "POST",
      headers: lineHeaders(token),
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }],
      }),
    },
  };
}

export function buildLineIssueLinkTokenRequest(token: string, userId: string): LineRequest {
  return {
    url: `${LINE_USER_API_BASE_URL}${encodeURIComponent(userId)}/linkToken`,
    init: {
      method: "POST",
      headers: lineHeaders(token),
    },
  };
}
