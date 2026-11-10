import React,{useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Image,Pressable,ScrollView,Text,View} from 'react-native';
import type {NativeOrderDetail} from '../../../src/modules/native-pos/workflow-contracts';
import type {NativeReceiptClaim} from '../../../src/modules/native-pos/loyalty-contracts';
import {receiptClaimVisible} from './domain/loyalty';
import {theme} from './theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {loadLanPrinter,lanPrinterLabel,lanPrintMessage,type SavedLanPrinter} from './domain/lan-printer';
import {ReceiptPaper} from './printers/ReceiptPaper';
type Request=<T>(operation:string,body?:unknown)=>Promise<T>;
const money=(n:number)=>`฿${(n/100).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export function Receipt({orderId,request,demo,storeName}:{orderId:string;request:Request;demo:boolean;storeName:string}){
 const [order,setOrder]=useState<NativeOrderDetail|null>(null);const [receipt,setReceipt]=useState<NativeReceiptClaim|null>(null);const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [now,setNow]=useState(Date.now());
 const generation=useRef(0);const lock=useRef(false);
 // Printing state is declared after the receipt state on purpose (UI tests rely on hook order).
 const [printer,setPrinter]=useState<SavedLanPrinter|null>(null);const [printing,setPrinting]=useState(false);const [printMessage,setPrintMessage]=useState('');const [qrReady,setQrReady]=useState(false);
 const paper=useRef<View>(null);const printLock=useRef(false);const alive=useRef(true);
 // If the QR image never reports load/error, do not leave printing disabled forever.
 const qrUri=receipt?.claim?.imageUri;
 useEffect(()=>{if(!qrUri)return;const t=setTimeout(()=>{if(alive.current)setQrReady(true)},3000);return()=>clearTimeout(t);},[qrUri]);
 useEffect(()=>{alive.current=true;void loadLanPrinter(AsyncStorage).then(p=>{if(alive.current)setPrinter(p)});return()=>{alive.current=false};},[]);
 async function printLan(){
  if(!printer||!order||order.status!=='paid'||printLock.current)return;printLock.current=true;setPrinting(true);setPrintMessage('');
  try{const {printViewToLan}=await import('./printers/lan-print');const result=await printViewToLan(paper,printer);if(alive.current)setPrintMessage(lanPrintMessage(result.state,result.error));}
  catch(e){if(alive.current)setPrintMessage(e instanceof Error?e.message:'พิมพ์ใบเสร็จไม่สำเร็จ');}
  finally{printLock.current=false;if(alive.current)setPrinting(false);}
 }
 async function load(){if(lock.current)return;lock.current=true;const version=++generation.current;setLoading(true);setError('');setReceipt(null);setQrReady(false);
  try{const result=await request<{order:NativeOrderDetail}>(`order-detail?id=${encodeURIComponent(orderId)}`);if(version!==generation.current)return;if(result.order.id!==orderId)throw new Error('ใบเสร็จไม่ตรงกับบิล');setOrder(result.order);
   if(result.order.status==='paid'&&!demo){try{const claim=await request<NativeReceiptClaim>('receipt',{orderId});if(version===generation.current)setReceipt(claim);}catch(e){if(version===generation.current)setError(e instanceof Error?e.message:'โหลด QR รับแต้มไม่ได้');}}
  }catch(e){if(version===generation.current)setError(e instanceof Error?e.message:'โหลดใบเสร็จไม่ได้');}finally{if(version===generation.current){setLoading(false);lock.current=false;}}
 }
 useEffect(()=>{void load();const timer=setInterval(()=>setNow(Date.now()),30000);return()=>{generation.current++;lock.current=false;clearInterval(timer)};},[orderId]);
 return <View style={{backgroundColor:'#fff',padding:20,borderRadius:16,gap:14}}>
  <Text style={{color:theme.text,fontSize:24,fontWeight:'700'}}>ใบเสร็จ · {storeName}</Text>{demo&&<Text>สาธิตเท่านั้น ไม่มีแต้มจริงหรือ QR รับแต้ม</Text>}
  {loading&&<ActivityIndicator color={theme.primary}/>}
  {order&&<><Text style={{fontSize:20,fontWeight:'700'}}>{order.number}</Text><Text>{new Date(order.createdAt).toLocaleString('th-TH')} · {order.status}</Text>
   {order.lines.map(l=><View key={l.key} style={{gap:4}}><Text>{l.name} × {l.quantity}</Text>{l.choiceLabel?<Text>{l.choiceLabel}</Text>:null}<Text>{money(l.unitSatang*l.quantity)}</Text>{l.note?<Text>{l.note}</Text>:null}</View>)}
   <Text>รวมสินค้า {money(order.subtotalSatang)}</Text><Text>ส่วนลด {money(order.discountSatang)}</Text><Text style={{fontSize:24,fontWeight:'700'}}>ยอดสุทธิ {money(order.totalSatang)}</Text>
   {order.payments.map((p,i)=><Text key={i}>{p.method} · {p.status} · {money(p.amountSatang)}{p.receivedSatang!==undefined?` · รับ ${money(p.receivedSatang)} ทอน ${money(p.changeSatang??0)}`:''}</Text>)}
   {receiptClaimVisible(order,receipt,now)&&receipt?.claim&&<View style={{gap:10,alignItems:'center'}}><Text style={{fontSize:20,fontWeight:'700'}}>สแกนรับ {receipt.claim.points} แต้ม</Text><Image accessibilityLabel="QR รับแต้มบนใบเสร็จ" source={{uri:receipt.claim.imageUri}} resizeMode="contain" style={{width:'100%',maxWidth:320,height:320}}/><Text>ใช้ได้ถึง {new Date(receipt.claim.expiresAt).toLocaleString('th-TH')}</Text></View>}
   {receipt&&(!receipt.claim||!receiptClaimVisible(order,receipt,now))&&<Text style={{color:theme.muted}}>ไม่มี QR รับแต้มที่ใช้ได้สำหรับใบเสร็จนี้ · บิลผูกลูกค้าจะรับแต้มผ่านระบบเดิม</Text>}
  </>}
  {order&&printer&&order.status==='paid'&&(()=>{const claim=receiptClaimVisible(order,receipt,now)&&receipt?.claim?receipt.claim:null;const waitQr=!!claim&&!qrReady;
   return <View style={{gap:10,borderTopWidth:1,borderColor:theme.border,paddingTop:12}}>
    <Text style={{color:theme.text,fontWeight:'700'}}>พิมพ์ผ่าน WiFi · {lanPrinterLabel(printer)}</Text>
    <ScrollView horizontal><ReceiptPaper ref={paper} order={order} storeName={storeName} dots={printer.dots} claim={claim} onQrLoad={()=>setQrReady(true)}/></ScrollView>
    <Pressable accessibilityRole="button" accessibilityLabel="พิมพ์ใบเสร็จผ่าน WiFi" disabled={printing||loading||waitQr} onPress={()=>void printLan()} style={{minHeight:52,padding:16,borderRadius:12,backgroundColor:printing||loading||waitQr?theme.soft:theme.primary}}><Text style={{color:printing||loading||waitQr?theme.muted:'#fff',fontWeight:'700'}}>{printing?'กำลังส่งงานพิมพ์…':waitQr?'กำลังเตรียม QR…':'พิมพ์ใบเสร็จ (WiFi)'}</Text></Pressable>
    {printMessage?<Text accessibilityRole="alert" style={{color:theme.text,lineHeight:22}}>{printMessage}</Text>:null}
   </View>;})()}
  {error?<Text accessibilityRole="alert" style={{color:theme.danger}}>โหลดใบเสร็จหรือ QR รับแต้มไม่ครบ: {error} · ไม่เปลี่ยนผลชำระของบิล</Text>:null}
  <Pressable accessibilityRole="button" disabled={loading} onPress={()=>void load()} style={{minHeight:52,padding:16,borderRadius:12,backgroundColor:theme.soft}}><Text style={{color:theme.primary,fontWeight:'700'}}>โหลดใบเสร็จล่าสุด</Text></Pressable>
 </View>;
}
