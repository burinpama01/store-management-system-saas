import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function component() {
  const exports: Record<string, any> = {};
  let failed = false;
  const react = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props, children }), useState:()=>[failed,(value:boolean)=>{failed=value}],useEffect:()=>{} };
  const source = fs.readFileSync(new URL('../src/MenuCard.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (name === 'react') return react;
    if (name === './theme') return { theme: {} };
    if (name === 'react-native') return { Image:'Image',View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles } };
    throw new Error(name);
  } });
  return exports.MenuCard;
}
it('favorite and sale actions are independent even when sale is disabled', () => {
  const MenuCard=component();
  const onAdd = vi.fn(), onFavorite = vi.fn();
  const card = MenuCard({ name: 'บราวนี', price: '฿75', width: 170, favorite: false, available: false, disabled: true, onAdd, onFavorite });
  const favorite = card.children[0].children[1], sale = card.children[1];
  expect(favorite.props.disabled).toBeUndefined();
  expect(sale.props.disabled).toBe(true);
  favorite.props.onPress();
  expect(onFavorite).toHaveBeenCalledOnce();
  expect(onAdd).not.toHaveBeenCalled();
});
it('keeps selling by name after product image fails without adding auth headers',()=>{
  const MenuCard=component(), onAdd=vi.fn();
  const props={name:'ชา',price:'฿40',imageUrl:'https://cdn.example.test/tea.jpg',width:170,favorite:false,available:true,disabled:false,onAdd,onFavorite:vi.fn()};
  const image=MenuCard(props).children[1].children[0];
  expect(image.props.source).toEqual({uri:props.imageUrl});
  image.props.onError();
  const sale=MenuCard(props).children[1];
  expect(sale.children[0]).toBe(false);
  expect(sale.children[1].children[0]).toBe('ชา');
  sale.props.onPress();expect(onAdd).toHaveBeenCalledOnce();
});
