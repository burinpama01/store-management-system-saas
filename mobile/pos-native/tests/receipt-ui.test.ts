import {expect,it,vi} from 'vitest';
import fs from 'node:fs';import ts from 'typescript';import vm from 'node:vm';
import {receiptClaimVisible} from '../src/domain/loyalty';
const order={id:'a',number:'B001',status:'paid',createdAt:'2026-10-08',subtotalSatang:4500,discountSatang:0,totalSatang:4500,lines:[],payments:[]};
function render(status:string,claimOrder='a',printer:any=undefined){
 const exports:any={};const states=[{...order,status},{orderId:claimOrder,claim:{points:5,expiresAt:'2099-01-01',imageUri:'data:image/png;base64,AA=='}},'',false,0,printer,false,'',false];let index=0;
 const source=fs.readFileSync(new URL('../src/Receipt.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports,require:(name:string)=>{
  if(name==='react')return {createElement:(type:any,props:any,...children:any[])=>({type,props,children}),useState:()=>[states[index++],vi.fn()],useRef:(v:any)=>({current:v}),useEffect:vi.fn()};
  if(name==='react-native')return {Text:'Text',View:'View',Image:'Image',Pressable:'Pressable',ActivityIndicator:'ActivityIndicator',ScrollView:'ScrollView'};
  if(name==='@react-native-async-storage/async-storage')return {default:{}};
  if(name==='./domain/lan-printer')return {loadLanPrinter:async()=>null,lanPrinterLabel:()=>'192.168.1.20:9100 · 58 mm',lanPrintMessage:()=>''};
  if(name==='./printers/ReceiptPaper')return {ReceiptPaper:'ReceiptPaper'};
  if(name==='./domain/loyalty')return {receiptClaimVisible};if(name==='./theme')return {theme:{}};throw Error(name);
 }});
 return exports.Receipt({orderId:'a',request:vi.fn(),demo:false,storeName:'ร้านสาธิต'});
}
function flatten(n:any):any[]{return !n?[]:[n,...(n.children??[]).flat(Infinity).flatMap(flatten)];}
it('contains the loyalty QR inside the paid receipt with order number and total',()=>{
 const nodes=flatten(render('paid'));expect(nodes.filter(n=>n.type==='Image')).toHaveLength(1);
 expect(nodes.filter(n=>n.type==='View').some(n=>(n.children??[]).flat(Infinity).some((c:any)=>typeof c==='string'))).toBe(false);
 const text=nodes.filter(n=>n.type==='Text').map(n=>n.children.flat(Infinity).join('')).join(' ');expect(text).toContain('ใบเสร็จ');expect(text).toContain('B001');expect(text).toContain('45.00');expect(text).toContain('5');
});
it('does not render loyalty QR for unpaid or mismatched receipts',()=>{expect(flatten(render('pending')).some(n=>n.type==='Image')).toBe(false);expect(flatten(render('paid','b')).some(n=>n.type==='Image')).toBe(false);});

it('shows no WiFi print button until a LAN printer is saved',()=>{
 expect(flatten(render('paid')).some(n=>n.props?.accessibilityLabel==='พิมพ์ใบเสร็จผ่าน WiFi')).toBe(false);
});
it('renders the paper at printer width and waits for the loyalty QR before printing',()=>{
 const nodes=flatten(render('paid','a',{host:'192.168.1.20',port:9100,dots:576,cut:false}));
 const paper=nodes.find(n=>n.type==='ReceiptPaper');expect(paper.props.dots).toBe(576);expect(paper.props.claim.points).toBe(5);
 const button=nodes.find(n=>n.props?.accessibilityLabel==='พิมพ์ใบเสร็จผ่าน WiFi');expect(button.props.disabled).toBe(true);
});
it('enables WiFi printing for a paid receipt without a loyalty QR',()=>{
 const nodes=flatten(render('paid','other',{host:'192.168.1.20',port:9100,dots:384,cut:false}));
 expect(nodes.find(n=>n.type==='ReceiptPaper').props.claim).toBeNull();
 expect(nodes.find(n=>n.props?.accessibilityLabel==='พิมพ์ใบเสร็จผ่าน WiFi').props.disabled).toBe(false);
});
it('does not offer WiFi printing for an unpaid bill',()=>{
 expect(flatten(render('pending','other',{host:'192.168.1.20',port:9100,dots:384,cut:false})).some(n=>n.props?.accessibilityLabel==='พิมพ์ใบเสร็จผ่าน WiFi')).toBe(false);
});
