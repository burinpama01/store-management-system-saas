import { expect, it } from 'vitest';
import { initialEntryScreen, homeScreen, productionBase } from '../src/domain/entry';
it('starts restored production sessions at sale and exposes store choice before a cart is restored', () => {
  expect(productionBase).toBe('https://store-os-manage.vercel.app');
  expect(initialEntryScreen(false)).toBe('store-picker');
  expect(initialEntryScreen(true)).toBe('sale');
});
it('opening home preserves cart and unresolved checkout by changing navigation only', () => {
  const state = { screen: 'sale', cart: { lines: ['saved-item'] }, pending: { state: 'unknown' } };
  const next = homeScreen(state);
  expect(next.screen).toBe('home');
  expect(next.cart).toBe(state.cart);
  expect(next.pending).toBe(state.pending);
});
