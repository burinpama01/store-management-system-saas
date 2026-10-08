import React from 'react';
import {View,Text,Image,Pressable,StyleSheet} from 'react-native';
import type {PendingPayment} from './domain/beam';
import {theme} from './theme';
import {canAutoCheckBeam} from './domain/beam-polling';
const statusLabels:Record<string,string>={PENDING:'รอลูกค้าชำระ',CREATED:'กำลังสร้าง QR',REQUIRES_ACTION:'รอลูกค้าชำระ',PROCESSING:'กำลังตรวจการชำระ',PAID:'Beam ยืนยันรับเงินแล้ว · กำลังตรวจบิล',EXPIRED:'QR หมดอายุ · ตรวจรายการใน StoreOS',CANCELLED:'QR ถูกยกเลิก · ตรวจรายการใน StoreOS',FAILED:'ไม่สำเร็จ · ตรวจรายการเดิมก่อนเริ่มใหม่',LATE_PAID:'รับเงินหลังหมดเวลา · ตรวจรายการใน StoreOS',REVIEW_REQUIRED:'ต้องตรวจรายการใน StoreOS'};
export function BeamPayment({pending,busy,demo,onCheck}:{pending:PendingPayment;busy:boolean;demo:boolean;onCheck:()=>void}){
 const qr=pending.beam;
 return <View style={s.panel}>
  <Text style={s.title}>Beam QR · ฿{(pending.input.expectedTotalSatang/100).toFixed(2)}</Text>
  <Text style={s.text}>{demo?'สาธิตเท่านั้น · ไม่มีการรับเงินจริง':'ยอดและสถานะยืนยันจากระบบหลังบ้าน'}</Text>
  {qr?.imageUri&&<Image accessibilityLabel="QR สำหรับรายการชำระเดิม" source={{uri:qr.imageUri}} resizeMode="contain" style={s.qr}/>}
  <Text accessibilityRole="alert" style={s.text}>{qr?statusLabels[qr.status]??'ตรวจรายการเดิมใน StoreOS':'ยังไม่ทราบผลสร้าง QR · ตรวจคำขอเดิม'}</Text>
  {canAutoCheckBeam(pending,demo)&&<Text style={s.text}>ตรวจสถานะอัตโนมัติขณะเปิดแอป · เมื่อยืนยันรับเงินจะปิดบิลเดิม</Text>}
  {qr?.expiresAt&&<Text style={s.text}>ใช้ได้ถึง {new Date(qr.expiresAt).toLocaleTimeString('th-TH')}</Text>}
  <Pressable accessibilityRole="button" accessibilityLabel="ตรวจสถานะ Beam" disabled={busy} onPress={onCheck} style={[s.button,busy&&{opacity:.5}]}><Text style={s.buttonText}>{demo?'จำลอง Beam ยืนยันชำระ':'ตรวจสถานะ Beam'}</Text></Pressable>
  <Text style={s.text}>รายการสินค้าและยอดถูกล็อกไว้ หากเน็ตหลุดให้ตรวจรายการนี้ต่อ ไม่สร้าง QR ใหม่หรือเปลี่ยนวิธีชำระ</Text>
 </View>;
}
const s=StyleSheet.create({panel:{gap:14,padding:18,borderRadius:16,backgroundColor:theme.soft},title:{fontSize:24,fontWeight:'700',color:theme.text},text:{fontSize:15,lineHeight:23,color:theme.muted},qr:{width:'100%',height:260,backgroundColor:'#fff'},button:{backgroundColor:theme.primary,borderRadius:12,minHeight:52,padding:16,alignItems:'center'},buttonText:{fontSize:17,fontWeight:'700',color:'#fff'}});
