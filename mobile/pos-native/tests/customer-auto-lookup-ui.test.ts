import {expect,it,vi} from 'vitest';
import fs from 'node:fs';import ts from 'typescript';import vm from 'node:vm';
import {canCreateCustomer,phoneLookupReady} from '../src/domain/loyalty';
function harness(request:any){const exports:any={};const slots:any[]=[];let cursor=0;let cleanup=()=>{};let mounted=false;
 const change=vi.fn();const perform=vi.fn(async(work:()=>Promise<void>)=>work());
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/SalesTools.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports,require:(name:string)=>{
  if(name==='react')return {createElement:(type:any,props:any,...children:any[])=>({type,props,children}),useState:(v:any)=>{const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],(v:any)=>{slots[i]=v}]},useRef:(v:any)=>{const i=cursor++;return slots[i]??(slots[i]={current:v})},useEffect:(fn:any)=>{if(!mounted){cleanup=fn();mounted=true}}};
  if(name==='react-native')return {View:'View',Text:'Text',TextInput:'TextInput',Pressable:'Pressable'};
  if(name==='./PhoneKeypad')return {PhoneKeypad:'PhoneKeypad'};if(name==='./domain/loyalty')return {canCreateCustomer,phoneLookupReady};if(name==='./domain/sales')return {salesAmount:()=>0};if(name==='./theme')return {theme:{}};throw Error(name);
 }});
 function render(){cursor=0;return exports.SalesTools({value:{couponCode:'SAVE'},customer:null,disabled:false,demo:false,change,request,perform})}
 const flat=(n:any):any[]=>!n?[]:[n,...(n.children??[]).flat(Infinity).flatMap(flat)];
 return {change,perform,type:(phone:string)=>{flat(render()).find(n=>n.type==='PhoneKeypad').props.onChange(phone)},invalidText:()=>flat(render()).filter(n=>n.type==='View').some(n=>(n.children??[]).flat(Infinity).some((c:any)=>typeof c==='string')),text:()=>flat(render()).filter(n=>n.type==='Text').map(n=>n.children.flat(Infinity).join('')).join(' '),unmount:()=>cleanup()};
}
it('searches once at ten digits, selects the exact customer and clears selection when correcting the phone',async()=>{
 const customer={id:'a',name:'ลูกค้าทดสอบ',phoneHint:'••••5678'};const request=vi.fn().mockResolvedValue({customer});const h=harness(request);
 expect(h.invalidText()).toBe(false);
 h.type('081234567');expect(request).not.toHaveBeenCalled();h.type('0812345678');await h.perform.mock.results[0].value;
 expect(request).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledWith('customer-phone?phone=0812345678');expect(h.change).toHaveBeenLastCalledWith({couponCode:'SAVE',customerId:'a'},customer);
 h.type('0812345678');expect(request).toHaveBeenCalledOnce();
 h.type('081234567');expect(h.change).toHaveBeenLastCalledWith({couponCode:'SAVE',customerId:null},null);
});
it('warns on missing/invalid phone and ignores a response superseded by a correction',async()=>{
 const h=harness(vi.fn().mockResolvedValue({customer:null}));h.type('0812345678');await h.perform.mock.results[0].value;expect(h.text()).toContain('ไม่พบลูกค้า');
 h.type('9812345678');await h.perform.mock.results[1].value;expect(h.text()).toContain('ขึ้นต้นด้วย 0');
 let resolve:any;const pending=harness(vi.fn(()=>new Promise(r=>resolve=r)));pending.type('0812345678');pending.type('081234567');resolve({customer:{id:'old',name:'เก่า',phoneHint:''}});await pending.perform.mock.results[0].value;
 expect(pending.change.mock.calls.some(c=>c[0].customerId==='old')).toBe(false);
});
