import React, { forwardRef } from 'react';
import { Image, Text, View } from 'react-native';
import type { NativeOrderDetail } from '../../../../src/modules/native-pos/workflow-contracts';

const money = (n: number) => `฿${(n / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD: Record<string, string> = { cash: 'เงินสด', bank_transfer: 'โอนธนาคาร', beam: 'Beam QR', promptpay: 'พร้อมเพย์', card: 'บัตร' };

export interface ReceiptPaperProps {
  order: NativeOrderDetail; storeName: string; dots: number;
  claim?: { points: number; expiresAt: string; imageUri: string } | null;
  onQrLoad?: () => void;
}

/**
 * Black-on-white receipt laid out at the printer's dot width. It is captured as an
 * image and rasterised, so it must use only black text on white with no theme colours.
 */
export const ReceiptPaper = forwardRef<View, ReceiptPaperProps>(function ReceiptPaper({ order, storeName, dots, claim, onQrLoad }, ref) {
  const big = dots >= 576 ? 30 : 26; const body = dots >= 576 ? 24 : 20; const small = dots >= 576 ? 20 : 17;
  const row = (left: string, right: string, size = body, bold = false) => <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
    <Text style={{ color: '#000', fontSize: size, lineHeight: size * 1.45, fontWeight: bold ? '700' : '400', flexShrink: 1 }}>{left}</Text>
    <Text style={{ color: '#000', fontSize: size, lineHeight: size * 1.45, fontWeight: bold ? '700' : '400' }}>{right}</Text>
  </View>;
  const rule = <View style={{ borderBottomWidth: 2, borderColor: '#000', borderStyle: 'dashed', marginVertical: 8 }} />;
  return <View ref={ref} collapsable={false} style={{ width: dots, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 16 }}>
    <Text style={{ color: '#000', fontSize: big, lineHeight: big * 1.4, fontWeight: '700', textAlign: 'center' }}>{storeName}</Text>
    <Text style={{ color: '#000', fontSize: small, lineHeight: small * 1.5, textAlign: 'center' }}>ใบเสร็จรับเงิน</Text>
    {rule}
    {row(`บิล ${order.number}`, new Date(order.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }), small)}
    {rule}
    {order.lines.map(line => <View key={line.key}>
      {row(`${line.name} × ${line.quantity}`, money(line.unitSatang * line.quantity))}
      {line.choiceLabel ? <Text style={{ color: '#000', fontSize: small, lineHeight: small * 1.45, paddingLeft: 12 }}>{line.choiceLabel}</Text> : null}
      {line.note ? <Text style={{ color: '#000', fontSize: small, lineHeight: small * 1.45, paddingLeft: 12 }}>หมายเหตุ: {line.note}</Text> : null}
    </View>)}
    {rule}
    {row('รวมสินค้า', money(order.subtotalSatang))}
    {order.discountSatang ? row('ส่วนลด', `-${money(order.discountSatang)}`) : null}
    {row('ยอดสุทธิ', money(order.totalSatang), big, true)}
    {order.payments.map((p, i) => <View key={i}>
      {row(METHOD[p.method] ?? p.method, money(p.amountSatang))}
      {p.receivedSatang !== undefined ? row('รับเงิน / ทอน', `${money(p.receivedSatang)} / ${money(p.changeSatang ?? 0)}`, small) : null}
    </View>)}
    {claim ? <View style={{ alignItems: 'center', marginTop: 12, gap: 6 }}>
      {rule}
      <Text style={{ color: '#000', fontSize: body, lineHeight: body * 1.45, fontWeight: '700', textAlign: 'center' }}>สแกนรับ {claim.points} แต้ม</Text>
      <Image source={{ uri: claim.imageUri }} onLoad={onQrLoad} onError={onQrLoad} resizeMode="contain" style={{ width: Math.min(dots - 48, 300), height: Math.min(dots - 48, 300) }} />
      <Text style={{ color: '#000', fontSize: small, lineHeight: small * 1.45, textAlign: 'center' }}>ใช้ได้ถึง {new Date(claim.expiresAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</Text>
    </View> : null}
    <Text style={{ color: '#000', fontSize: small, lineHeight: small * 1.5, textAlign: 'center', marginTop: 14 }}>ขอบคุณที่ใช้บริการ</Text>
  </View>;
});
