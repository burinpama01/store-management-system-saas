import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { NativeCustomer, NativeSalesInput } from '../../../src/modules/native-pos/contracts';
import { salesAmount } from './domain/sales';
import { theme } from './theme';
import {PhoneKeypad} from './PhoneKeypad';
type Props = { value: NativeSalesInput; customer: NativeCustomer | null; disabled: boolean; demo: boolean; change: (value: NativeSalesInput, customer?: NativeCustomer | null) => void; request: <T>(operation: string, body?: unknown) => Promise<T>; perform: (work: () => Promise<void>) => Promise<void> };
export function SalesTools({ value, customer, disabled, demo, change, request, perform }: Props) {
  const [query,setQuery] = useState(''); const [customers,setCustomers] = useState<NativeCustomer[]>([]);
  const [discount,setDiscount] = useState(((value.manualDiscountSatang ?? 0)/100).toFixed(2));
  const [coupon,setCoupon] = useState(value.couponCode ?? ''); const [searched,setSearched] = useState(false);
  const alive=useRef(true); const searchVersion=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;searchVersion.current++}},[]);
  const button=(label:string,work:()=>void)=> <Pressable accessibilityRole="button" disabled={disabled} onPress={work} style={{ minHeight:48,padding:14,borderRadius:12,backgroundColor:theme.soft,opacity:disabled ? 0.5 : 1 }}><Text style={{color:theme.primary,fontWeight:'700'}}>{label}</Text></Pressable>;
  const input={ borderWidth:1,borderColor:theme.border,borderRadius:12,minHeight:48,padding:12,fontSize:16,color:theme.text };
  return <View style={{gap:12}}><Text style={{color:theme.muted}}>เลือกลูกค้าและตรวจส่วนลดก่อนรับเงิน {demo?'· ข้อมูลสาธิต':''}</Text>
    <Text style={{fontWeight:'700'}}>ลูกค้า {customer ? `· ${customer.name}` : '· ไม่ระบุ'}</Text>
    <PhoneKeypad value={query} disabled={disabled} onChange={text=>{setQuery(text);setCustomers([]);setSearched(false);searchVersion.current++}}/>
    {button('ค้นหาลูกค้า',()=>void perform(async()=>{const q=query.trim();if(q.length<2)throw new Error('กรอกเบอร์โทรอย่างน้อย 2 หลัก');const version=++searchVersion.current;const result=demo?{customers:[{id:'demo-customer',name:'ลูกค้าสาธิต',phoneHint:'••••0000'}]}:await request<{customers:NativeCustomer[]}>(`customers?q=${encodeURIComponent(q)}`);if(alive.current&&version===searchVersion.current){setCustomers(result.customers);setSearched(true)}}))}
    {customers.map(c=><View key={c.id}>{button(`${c.name} ${c.phoneHint}`,()=>{change({...value,customerId:c.id},c);setCustomers([]);setSearched(false)})}</View>)}
    {searched&&!customers.length&&<Text>ไม่พบลูกค้า</Text>}{value.customerId&&button('ไม่ระบุลูกค้า',()=>change({...value,customerId:null},null))}
    <Text style={{fontWeight:'700'}}>ส่วนลดท้ายบิล (บาท)</Text><TextInput accessibilityLabel="ส่วนลดท้ายบิล" editable={!disabled} value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" style={input}/>
    <Text style={{fontWeight:'700'}}>รหัสคูปอง</Text><TextInput accessibilityLabel="รหัสคูปอง" editable={!disabled} value={coupon} onChangeText={setCoupon} maxLength={80} autoCapitalize="characters" autoCorrect={false} placeholder={demo?'DEMO10 ลด 10%':'รหัสคูปองส่วนลด'} style={input}/>
    {button('ใช้ส่วนลด / คูปองกับบิล',()=>void perform(async()=>{const amount=salesAmount(discount.trim()||'0');change({...value,manualDiscountSatang:amount,couponCode:coupon.trim()||null})}))}
    {button('ล้างลูกค้าและส่วนลดทั้งหมด',()=>{setDiscount('0.00');setCoupon('');change({customerId:null,couponCode:null,manualDiscountSatang:0},null)})}
    <Text style={{color:theme.muted}}>กดรับชำระเพื่อให้ระบบตรวจยอดล่าสุด · คูปองแลกสินค้าฟรีให้ทำบนเว็บก่อน · การเลือกลูกค้าและส่วนลดไม่ถูกเก็บเมื่อปิดแอป แต่คำขอชำระที่ส่งแล้วจะเก็บครบเพื่อตรวจบิลเดิม</Text>
  </View>;
}
