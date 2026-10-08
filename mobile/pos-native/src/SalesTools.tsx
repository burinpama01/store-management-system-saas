import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { NativeCustomer, NativeSalesInput } from '../../../src/modules/native-pos/contracts';
import { salesAmount } from './domain/sales';
import { theme } from './theme';
import {PhoneKeypad} from './PhoneKeypad';
import {canCreateCustomer,phoneLookupReady} from './domain/loyalty';
import type {NativeCustomerDetail} from '../../../src/modules/native-pos/loyalty-contracts';
type Props = { value: NativeSalesInput; customer: NativeCustomer | null; disabled: boolean; demo: boolean; change: (value: NativeSalesInput, customer?: NativeCustomer | null) => void; request: <T>(operation: string, body?: unknown) => Promise<T>; perform: (work: () => Promise<void>) => Promise<void> };
export function SalesTools({ value, customer, disabled, demo, change, request, perform }: Props) {
  const [query,setQuery] = useState('');
  const [discount,setDiscount] = useState(((value.manualDiscountSatang ?? 0)/100).toFixed(2));
  const [coupon,setCoupon] = useState(value.couponCode ?? ''); const [searched,setSearched] = useState(false);
  const [name,setName]=useState('');const [uncertain,setUncertain]=useState(false);const [detail,setDetail]=useState<NativeCustomerDetail|null>(null);
  const [phoneNotice,setPhoneNotice]=useState('');
  const alive=useRef(true); const searchVersion=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;searchVersion.current++}},[]);
  async function lookupPhone(q:string){
    if(!phoneLookupReady(q)){setPhoneNotice('เบอร์โทรต้องเป็นตัวเลข 10 หลัก และขึ้นต้นด้วย 0');return;}
    const version=++searchVersion.current;setPhoneNotice('กำลังค้นหาลูกค้า…');setSearched(false);
    try{const result=demo?{customer:q==='0812340000'?{id:'demo-customer',name:'ลูกค้าสาธิต',phoneHint:'••••0000'}:null}:await request<{customer:NativeCustomer|null}>(`customer-phone?phone=${encodeURIComponent(q)}`);
      if(!alive.current||version!==searchVersion.current)return;
      setUncertain(false);setSearched(!result.customer);setDetail(null);
      change({...value,customerId:result.customer?.id??null},result.customer);
      setPhoneNotice(result.customer?`เลือกลูกค้า ${result.customer.name} แล้ว`:'ไม่พบลูกค้าด้วยเบอร์นี้ กรุณาตรวจเบอร์ หรือเพิ่มลูกค้าใหม่');
    }catch(error){if(!alive.current||version!==searchVersion.current)return;setPhoneNotice('ค้นหาไม่สำเร็จ กรุณาลองค้นหาเบอร์นี้อีกครั้ง');setSearched(false);throw error;}
  }
  function changePhone(text:string){if(text===query)return;searchVersion.current++;setQuery(text);setSearched(false);setDetail(null);change({...value,customerId:null},null);
    setPhoneNotice(text.length<10?`กรอกเบอร์ให้ครบ 10 หลัก (${text.length}/10)`:'');
    if(text.length===10)void perform(()=>lookupPhone(text));
  }
  const button=(label:string,work:()=>void)=> <Pressable accessibilityRole="button" disabled={disabled} onPress={work} style={{ minHeight:48,padding:14,borderRadius:12,backgroundColor:theme.soft,opacity:disabled ? 0.5 : 1 }}><Text style={{color:theme.primary,fontWeight:'700'}}>{label}</Text></Pressable>;
  const input={ borderWidth:1,borderColor:theme.border,borderRadius:12,minHeight:48,padding:12,fontSize:16,color:theme.text };
  return <View style={{gap:12}}><Text style={{color:theme.muted}}>เลือกลูกค้าและตรวจส่วนลดก่อนรับเงิน {demo?'· ข้อมูลสาธิต':''}</Text>
    <Text style={{fontWeight:'700'}}>ลูกค้า {customer ? `· ${customer.name}` : '· ไม่ระบุ'}</Text>
    <PhoneKeypad value={query} maxLength={10} disabled={disabled||uncertain} onChange={changePhone}/>
    {phoneNotice?<Text accessibilityRole="alert" style={{color:customer?theme.primary:theme.danger,lineHeight:24}}>{phoneNotice}</Text>:null}
    {button('ค้นหาเบอร์นี้อีกครั้ง',()=>void perform(()=>lookupPhone(query)))}
    {value.customerId&&button('ไม่ระบุลูกค้า',()=>change({...value,customerId:null},null))}
    {uncertain&&<Text accessibilityRole="alert" style={{color:theme.danger}}>ยังไม่ทราบผลเพิ่มลูกค้า ค้นหาเบอร์เดิมก่อนเพิ่มอีกครั้ง</Text>}
    {searched&&!uncertain&&<View style={{gap:12}}><Text>เพิ่มลูกค้าด้วยเบอร์ {query}</Text><TextInput accessibilityLabel="ชื่อลูกค้าใหม่" editable={!disabled} value={name} onChangeText={setName} maxLength={120} style={input} placeholder="ชื่อลูกค้า"/>{button('เพิ่มลูกค้าและเลือกเข้าบิล',()=>void perform(async()=>{
      if(!canCreateCustomer(name,query)||!phoneLookupReady(query))throw new Error('ระบุชื่อและเบอร์โทร 10 หลัก');
      const version=++searchVersion.current;
      try{const result=demo?{customer:{id:'demo-new-customer',name:name.trim(),phoneHint:`••••${query.slice(-4)}`}}:await request<{customer:NativeCustomer}>('customer-create',{name:name.trim(),phone:query});if(alive.current&&version===searchVersion.current){change({...value,customerId:result.customer.id},result.customer);setSearched(false);setName('');setDetail(null)}}catch(error){if(alive.current){setUncertain(true);setSearched(false)}throw error;}
    }))}</View>}
    {customer&&<View style={{gap:10}}>{button('ตรวจยอดและประวัติแต้ม',()=>void perform(async()=>{const version=++searchVersion.current;const result=demo?{customer:{...customer,pointsBalance:120},canLedger:true,ledger:[]}:await request<NativeCustomerDetail>(`customer?id=${encodeURIComponent(customer.id)}`);if(alive.current&&version===searchVersion.current)setDetail(result)}))}{detail&&detail.customer.id===customer.id&&<><Text style={{fontSize:20,fontWeight:'700',color:theme.primary}}>แต้มคงเหลือ {detail.customer.pointsBalance.toLocaleString('th-TH')}</Text><Text style={{color:theme.muted}}>{demo?'แต้มสาธิต':'ยอดจากระบบหลังบ้าน ณ เวลาที่ตรวจ'} · กดตรวจเพื่อดูยอดล่าสุด</Text>{detail.canLedger?detail.ledger.map(item=><Text key={item.id}>{new Date(item.createdAt).toLocaleString('th-TH')} · {item.pointsDelta>0?'+':''}{item.pointsDelta} แต้ม · {item.reason??item.type}{item.orderNumber?` · ${item.orderNumber}`:''}</Text>):<Text>บัญชีนี้ไม่มีสิทธิ์ดูประวัติแต้ม</Text>}</>}</View>}
    <Text style={{fontWeight:'700'}}>ส่วนลดท้ายบิล (บาท)</Text><TextInput accessibilityLabel="ส่วนลดท้ายบิล" editable={!disabled} value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" style={input}/>
    <Text style={{fontWeight:'700'}}>รหัสคูปอง</Text><TextInput accessibilityLabel="รหัสคูปอง" editable={!disabled} value={coupon} onChangeText={setCoupon} maxLength={80} autoCapitalize="characters" autoCorrect={false} placeholder={demo?'DEMO10 ลด 10%':'รหัสคูปองส่วนลด'} style={input}/>
    {button('ใช้ส่วนลด / คูปองกับบิล',()=>void perform(async()=>{const amount=salesAmount(discount.trim()||'0');change({...value,manualDiscountSatang:amount,couponCode:coupon.trim()||null})}))}
    {button('ล้างลูกค้าและส่วนลดทั้งหมด',()=>{setDiscount('0.00');setCoupon('');change({customerId:null,couponCode:null,manualDiscountSatang:0},null)})}
    <Text style={{color:theme.muted}}>กดรับชำระเพื่อให้ระบบตรวจยอดล่าสุด · คูปองแลกสินค้าฟรีให้ทำบนเว็บก่อน · การเลือกลูกค้าและส่วนลดไม่ถูกเก็บเมื่อปิดแอป แต่คำขอชำระที่ส่งแล้วจะเก็บครบเพื่อตรวจบิลเดิม</Text>
  </View>;
}
