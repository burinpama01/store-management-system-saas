/**
 * จำนวนเงินเป็นตัวอักษรภาษาไทย เช่น 1,250.50 → "หนึ่งพันสองร้อยห้าสิบบาทห้าสิบสตางค์"
 * ใช้บนใบกำกับภาษี/ใบลดหนี้ (ธรรมเนียมเอกสารไทย)
 */
const DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const POSITIONS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

function readUnderMillion(n: number, hasHigher = false): string {
  // n: 0..999999 · hasHigher = มีหลักล้านนำหน้า (1,000,001 = "หนึ่งล้านเอ็ด")
  const digits = String(n).split("").map(Number);
  const len = digits.length;
  let out = "";
  digits.forEach((d, i) => {
    const pos = len - 1 - i;
    if (d === 0) return;
    if (pos === 0) {
      // หลักหน่วยเป็น 1 และมีหลักอื่นนำหน้า = "เอ็ด" (11 สิบเอ็ด, 101 หนึ่งร้อยเอ็ด)
      out += d === 1 && (len > 1 || hasHigher) ? "เอ็ด" : DIGITS[d];
    } else if (pos === 1) {
      out += d === 1 ? "สิบ" : d === 2 ? "ยี่สิบ" : DIGITS[d] + "สิบ";
    } else {
      out += DIGITS[d] + POSITIONS[pos];
    }
  });
  return out;
}

function readInteger(n: number): string {
  if (n === 0) return "ศูนย์";
  const millions: number[] = [];
  let rest = n;
  while (rest > 0) {
    millions.unshift(rest % 1_000_000);
    rest = Math.floor(rest / 1_000_000);
  }
  return millions
    .map((chunk, i) => {
      const isLast = i === millions.length - 1;
      const text = chunk === 0 ? "" : readUnderMillion(chunk, i > 0);
      return isLast ? text : text + "ล้าน";
    })
    .join("");
}

export function bahtText(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const negative = amount < 0;
  const satangTotal = Math.round(Math.abs(amount) * 100);
  const baht = Math.floor(satangTotal / 100);
  const satang = satangTotal % 100;
  let text = "";
  if (baht > 0 || satang === 0) text += readInteger(baht) + "บาท";
  text += satang === 0 ? "ถ้วน" : readUnderMillion(satang) + "สตางค์";
  return (negative ? "ลบ" : "") + text;
}
