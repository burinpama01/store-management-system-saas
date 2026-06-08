// PromptPay QR payload encoder — Thai EMV QR Code specification (BOT standard)

const PROMPTPAY_APP_ID = "A000000677010111"; // PromptPay application identifier

function tlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${tag}${len}${value}`;
}

function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function normalizePhoneNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  // Convert local format (0812345678) → international (66812345678)
  if (digits.startsWith("0") && digits.length === 10) return "66" + digits.slice(1);
  // Already international
  if (digits.startsWith("66") && digits.length === 11) return digits;
  return null;
}

function normalizeTaxId(id: string): string | null {
  const digits = id.replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

export interface PromptPayOptions {
  /** Phone number (0812345678) or 13-digit national/tax ID */
  recipientId: string;
  /** Amount in baht (undefined = open amount) */
  amount?: number;
}

/**
 * Generates a PromptPay EMV QR payload string.
 * Encode this string into a QR code image using any QR library.
 */
export function buildPromptPayPayload(opts: PromptPayOptions): string {
  const normalizedPhone = normalizePhoneNumber(opts.recipientId);
  const normalizedTaxId = normalizedPhone ? null : normalizeTaxId(opts.recipientId);
  const normalized = normalizedPhone ?? normalizedTaxId;
  if (!normalized) throw new Error("Invalid PromptPay recipient ID");
  const recipientTag = normalizedPhone ? "01" : "02";

  // Merchant account: sub-tag 00 (app ID) + sub-tag 01 (recipient ID)
  const merchantAccount = tlv("00", PROMPTPAY_APP_ID) + tlv(recipientTag, normalized);

  const parts: string[] = [
    tlv("00", "01"),                     // Payload format indicator
    tlv("01", "12"),                     // Dynamic QR (includes amount) or "11" for static
    tlv("29", merchantAccount),          // PromptPay merchant account info
    tlv("52", "0000"),                   // Merchant category code
    tlv("53", "764"),                    // Currency: THB
  ];

  if (opts.amount !== undefined && opts.amount > 0) {
    parts.push(tlv("54", opts.amount.toFixed(2)));
  }

  parts.push(
    tlv("58", "TH"),                     // Country code
    tlv("59", "PROMPTPAY"),              // Merchant name
    tlv("60", "BANGKOK"),               // Merchant city
  );

  // CRC placeholder (6304) + actual checksum
  const payload = parts.join("") + "6304";
  const checksum = crc16(payload);
  return payload + checksum;
}
