export function validateLanTarget(host: string, port: number) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) throw new Error('กรุณาระบุ IPv4 ของเครื่องพิมพ์ในร้าน');
  const [a, b] = parts.map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw new Error('รองรับ IP ภายในเครือข่ายร้านเท่านั้น');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port ไม่ถูกต้อง');
}
export function rasterEscPos(input: { width: number; height: number; channels: number; depth: number; data: ArrayLike<number> }, cut = false): Uint8Array {
  const { width, height, channels, depth, data } = input;
  if (depth !== 8 || ![1, 2, 3, 4].includes(channels) || !Number.isInteger(width) || width < 1 || width > 832 || !Number.isInteger(height) || height < 1 || height > 10000 || data.length !== width * height * channels) throw new Error('ภาพใบพิมพ์ไม่ถูกต้อง');
  const stride = Math.ceil(width / 8); const chunks: number[] = [27, 64];
  for (let start = 0; start < height; start += 128) {
    const rows = Math.min(128, height - start);
    chunks.push(29, 118, 48, 0, stride & 255, stride >> 8, rows & 255, rows >> 8);
    for (let y = start; y < start + rows; y++) for (let byte = 0; byte < stride; byte++) {
      let bits = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = byte * 8 + bit; if (x >= width) continue;
        const offset = (y * width + x) * channels;
        const alpha = channels === 2 || channels === 4 ? data[offset + channels - 1] / 255 : 1;
        const gray = channels < 3 ? data[offset] : .299 * data[offset] + .587 * data[offset + 1] + .114 * data[offset + 2];
        if (gray * alpha + 255 * (1 - alpha) < 160) bits |= 128 >> bit;
      }
      chunks.push(bits);
    }
  }
  chunks.push(27, 100, 4); if (cut) chunks.push(29, 86, 1);
  return Uint8Array.from(chunks);
}
