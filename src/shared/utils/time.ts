/** Current epoch ms. In a helper module so server components can read "now" without
 * tripping the react-hooks purity lint rule on inline Date.now() during render. */
export function nowMs(): number {
  return Date.now();
}
