import { expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

function settings() {
  const loads: string[] = [];
  const messages: unknown[] = [];
  let state = 0;
  const react = {
    createElement: (type: unknown, props: any, ...children: any[]) => ({ type, props, children }),
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => [state++ === 0 ? '192.168.1.5' : initial, (value: unknown) => messages.push(value)],
  };
  const exports: Record<string, any> = {};
  const source = fs.readFileSync(new URL('../src/printers/PrinterSettings.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, Error, require: (name: string) => {
    if (name === 'react') return react;
    if (name === 'react-native') return { Platform: { OS: 'ios' }, View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', Pressable: 'Pressable' };
    if (name === '../domain/raster') return { validateLanTarget: () => undefined };
    if (name === '../domain/printing') return {};
    loads.push(name);
    throw new Error('Printer native module unavailable');
  } });
  return { element: exports.PrinterSettings(), loads, messages };
}

it('opens printer settings without loading native printer modules', () => {
  expect(settings().loads).toEqual([]);
});

it('handles printer module load failure on print without loading TCP', async () => {
  const { element, loads, messages } = settings();
  const button = element.children.find((child: any) => child?.props?.accessibilityLabel === 'พิมพ์ทดสอบผ่าน LAN');
  button.props.onPress();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(messages).toContain('Printer native module unavailable');
  expect(loads).toEqual(['react-native-view-shot']);
  expect(messages.at(-1)).toBe(false);
});
