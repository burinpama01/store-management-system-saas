import type { NativeLine, NativeProduct } from '../../../../src/modules/native-pos/contracts';
// Native supports add proposals only. Match exact catalog names; ambiguity never guesses.
export function resolveAiLines(raw: unknown, products: NativeProduct[]): NativeLine[] {
  const envelope = raw as { outcome?: unknown; confidence?: unknown; commands?: unknown } | null;
  if (!envelope || envelope.outcome !== 'command_batch' || envelope.confidence !== 'high' || !Array.isArray(envelope.commands) || envelope.commands.length < 1 || envelope.commands.length > 8) throw new Error('AI ยังไม่แน่ใจ กรุณาระบุสินค้าและจำนวนให้ชัดเจน');
  return envelope.commands.map(command => {
    if (!command || command.intent !== 'pos.add_item' || typeof command.productPhrase !== 'string' || !Number.isSafeInteger(command.quantity) || command.quantity < 1 || command.quantity > 99 || !Array.isArray(command.optionPhrases) || !command.optionPhrases.every((phrase: unknown) => typeof phrase === 'string')) throw new Error('รองรับ AI เสนอเพิ่มสินค้าเท่านั้น กรุณาระบุจำนวน');
    const matches = products.filter(p => p.available && p.name.trim().toLocaleLowerCase() === command.productPhrase.trim().toLocaleLowerCase());
    if (matches.length !== 1) throw new Error('ชื่อสินค้าไม่ตรงหรือมีหลายรายการ กรุณาเลือกด้วยตนเอง');
    const product = matches[0];
    if (product.variants.length) throw new Error('สินค้านี้มีตัวเลือก กรุณาเลือกด้วยตนเอง');
    const optionIds: string[] = [];
    for (const phrase of command.optionPhrases as string[]) {
      const options = product.groups.flatMap(g => g.options).filter(o => o.name === phrase);
      if (options.length !== 1 || optionIds.includes(options[0].id)) throw new Error('ตัวเลือกไม่ชัดเจน กรุณาเลือกด้วยตนเอง');
      optionIds.push(options[0].id);
    }
    for (const group of product.groups) { const count = group.options.filter(o => optionIds.includes(o.id)).length; if (count < group.min || count > group.max) throw new Error('กรุณาระบุตัวเลือกสินค้าให้ครบ'); }
    const options = product.groups.flatMap(g => g.options).filter(o => optionIds.includes(o.id));
    return { key: JSON.stringify([product.id, null, [...optionIds].sort(), '']), productId: product.id, name: product.name, quantity: command.quantity, unitSatang: product.priceSatang + options.reduce((sum, o) => sum + o.priceSatang, 0), variantId: null, optionIds, note: '', choiceLabel: options.map(o => o.name).join(' · ') };
  });
}
