import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

it('favorite and sale actions are independent even when sale is disabled', () => {
  const exports: Record<string, any> = {};
  const react = { createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props, children }) };
  const source = fs.readFileSync(new URL('../src/MenuCard.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (name === 'react') return react;
    if (name === './theme') return { theme: {} };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: (styles: unknown) => styles } };
    throw new Error(name);
  } });
  const onAdd = vi.fn(), onFavorite = vi.fn();
  const card = exports.MenuCard({ name: 'บราวนี', price: '฿75', width: 170, favorite: false, available: false, disabled: true, onAdd, onFavorite });
  const favorite = card.children[0].children[1], sale = card.children[1];
  expect(favorite.props.disabled).toBeUndefined();
  expect(sale.props.disabled).toBe(true);
  favorite.props.onPress();
  expect(onFavorite).toHaveBeenCalledOnce();
  expect(onAdd).not.toHaveBeenCalled();
});
