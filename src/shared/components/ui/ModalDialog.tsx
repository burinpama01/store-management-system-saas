"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

const MODAL_DIALOG_FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const SIZE_CLASS = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

interface ModalDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  description?: string;
  size?: keyof typeof SIZE_CLASS;
  closeLabel?: string;
}

export function ModalDialog({
  open,
  title,
  children,
  onClose,
  description,
  size = "md",
  closeLabel = "ปิด dialog",
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const focusableSelectors = MODAL_DIALOG_FOCUSABLE_SELECTORS;

  useEffect(() => {
    if (!open) return;
    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusDialog = window.requestAnimationFrame(() => {
      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(focusableSelectors);
      (firstFocusable ?? dialogRef.current)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusDialog);
      lastFocusedElementRef.current?.focus();
    };
  }, [focusableSelectors, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelectors) ?? [],
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [focusableSelectors, onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <div
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className={`relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl ${SIZE_CLASS[size]}`}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-gray-900">
              {title}
            </h2>
            {description && <p id={descriptionId} className="mt-1 text-xs text-gray-600">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid min-h-11 min-w-11 place-items-center rounded-md text-lg leading-none text-gray-400 hover:bg-slate-100 hover:text-gray-700"
            aria-label={closeLabel}
          >
            x
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
