"use client";

import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Promise-based replacement for `window.confirm`.
 *
 * The native dialog never opens inside the mobile app WebView or a cross-origin
 * iframe — it returns false immediately, so the guarded action silently does
 * nothing and the user sees no feedback at all. This renders the in-app
 * ConfirmDialog instead and resolves with the user's choice, so the call site
 * keeps reading like `if (!(await confirm({...}))) return;`.
 *
 * Render `confirmDialog` somewhere in the component's tree.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // A dialog still waiting for an answer is cancelled before the new one opens,
    // so its caller never hangs on an unresolved promise.
    resolverRef.current?.(false);
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(ok);
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      open={options !== null}
      title={options?.title ?? ""}
      message={options?.message ?? ""}
      confirmLabel={options?.confirmLabel}
      cancelLabel={options?.cancelLabel}
      danger={options?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}
