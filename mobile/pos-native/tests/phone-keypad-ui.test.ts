import {expect,it,vi} from 'vitest';
import fs from 'node:fs';import ts from 'typescript';import vm from 'node:vm';
import {phoneKey} from '../src/domain/phone-keypad';
function component(){const exports:any={};const source=fs.readFileSync(new URL('../src/PhoneKeypad.tsx',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,{exports,require:(name:string)=>{if(name==='react')return {createElement:(type:any,props:any,...children:any[])=>({type,props,children})};if(name==='./theme')return{theme:{}};if(name==='./domain/phone-keypad')return{phoneKey};if(name==='react-native')return{View:'View',Text:'Text',Pressable:'Pressable',StyleSheet:{create:(x:any)=>x}};throw Error(name);}});return exports.PhoneKeypad;}
function flatten(node:any):any[]{return !node?[]:[node,...(node.children??[]).flat(Infinity).flatMap(flatten)];}
it('renders 12 custom keys with no TextInput and updates the phone through buttons',()=>{
 const change=vi.fn();const nodes=flatten(component()({value:'0',onChange:change}));
 const keys=nodes.filter(n=>n.type==='Pressable');expect(keys).toHaveLength(12);
 expect(nodes.some(n=>n.type==='TextInput')).toBe(false);
 keys.find(n=>n.props.accessibilityLabel==='เลข 8').props.onPress();expect(change).toHaveBeenLastCalledWith('08');
 keys.find(n=>n.props.accessibilityLabel==='ลบเลขท้าย').props.onPress();expect(change).toHaveBeenLastCalledWith('');
});
it('disables every key while the bill is locked',()=>{
 const keys=flatten(component()({value:'081',onChange:vi.fn(),disabled:true})).filter(n=>n.type==='Pressable');
 expect(keys.every(n=>n.props.disabled===true)).toBe(true);
});
