import { expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function startup(failStorage = false) {
  const writes: string[] = [];
  class Component {}
  const react = { Component, createElement: (type: unknown, props: unknown) => ({ type, props }) };
  const exports: Record<string, any> = {};
  const source = fs.readFileSync(new URL('../src/Startup.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, Error, require: (name: string) => {
    if (name === '../package.json') return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (name === 'react') return react;
    if (name === 'react-native') return { View: 'View', Text: 'Text', ScrollView: 'ScrollView' };
    if (name === '../App') throw new Error('new NativeEventEmitter() requires a non-null argument. secret-token');
    if (failStorage) throw new Error('storage unavailable');
    return { default: { setItem: (_key: string, value: string) => { writes.push(value); return Promise.resolve(); } } };
  } });
  return { element: exports.Startup(), writes };
}
it('shows a diagnostic after App import fails, without storing raw private exception text', () => {
  const { element, writes } = startup();
  expect(element.props.diagnostic.code).toBe('NATIVE_EVENT_EMITTER_UNAVAILABLE');
  expect(element.props.diagnostic.phase).toBe('load-app-module');
  expect(writes).toHaveLength(1);
  expect(element.props.diagnostic.version).toBe(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  expect(writes[0]).not.toContain('secret-token');
});
it('still shows diagnostic when storage module cannot load', () => {
  expect(startup(true).element.props.diagnostic.phase).toBe('load-app-module');
});
