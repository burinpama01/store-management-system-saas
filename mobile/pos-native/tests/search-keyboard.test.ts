import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

it('uses keyboard events only while searching and removes listeners on unmount', () => {
  const states: any[] = []; const handlers: Record<string, () => void> = {};
  const removals = vi.fn(); let index = 0; let cleanup: (() => void) | undefined;
  const exports: Record<string, any> = {};
  const source = fs.readFileSync(new URL('../src/useSearchKeyboard.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (name === 'react') return {
      useState: (initial: unknown) => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], (value: unknown) => { states[slot] = value; }]; },
      useEffect: (effect: () => () => void) => { if (!cleanup) cleanup = effect(); },
    };
    if (name === 'react-native') return { Platform: { OS: 'ios' }, Keyboard: { addListener: (event: string, handler: () => void) => { handlers[event] = handler; return { remove: removals }; } } };
    throw new Error(name);
  } });
  const render = () => { index = 0; return exports.useSearchKeyboard(); };
  expect(render().active).toBe(false);
  handlers.keyboardWillShow();
  expect(render().active).toBe(false); // A payment or other input must not change sale layout.
  render().focus();
  expect(render().active).toBe(true);
  handlers.keyboardDidHide();
  expect(render().active).toBe(false);
  handlers.keyboardDidShow();
  expect(render().active).toBe(true);
  render().blur();
  expect(render().active).toBe(false);
  cleanup?.();
  expect(removals).toHaveBeenCalledTimes(4);
});
