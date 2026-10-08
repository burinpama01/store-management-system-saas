import {expect,it,vi} from 'vitest';
import fs from 'node:fs';import ts from 'typescript';import vm from 'node:vm';
import {receiptClaimVisible} from '../src/domain/loyalty';
const order={id:'a',number:'B001',status:'paid',createdAt:'2026-10-08',subtotalSatang:4500,discountSatang:0,totalSatang:4500,lines:[],payments:[]};
function render(status:string,claimOrder='a'){
 const exports:any={};const states=[{...order,status},{orderId:claimOrder,claim:{points:5,expiresAt:'2099-01-01',imageUri:'data:image/png;base64,AA=='}},'',false,0];let index=0;
 const source=fs.readFileSync(new URL('../src/Receipt.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports,require:(name:string)=>{
  if(name==='react')return {createElement:(type:any,props:any,...children:any[])=>({type,props,children}),useState:()=>[states[index++],vi.fn()],useRef:(v:any)=>({current:v}),useEffect:vi.fn()};
  if(name==='react-native')return {Text:'Text',View:'View',Image:'Image',Pressable:'Pressable',ActivityIndicator:'ActivityIndicator'};
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
