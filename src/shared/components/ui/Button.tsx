"use client";

import {
  forwardRef,
  useCallback,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

type Variant = "primary" | "secondary" | "danger";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Style preset. Maps to the .btn-* utility classes. Omit for a fully custom-styled button. */
  variant?: Variant;
  /** Externally-controlled loading state (e.g. from useTransition's isPending). */
  loading?: boolean;
  /** Click handler. If it returns a Promise, the button auto-shows a spinner and
   *  blocks repeat clicks until the Promise settles — prevents double submits. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  /** Text shown next to the spinner while loading. Defaults to the normal children. */
  loadingText?: ReactNode;
  children?: ReactNode;
}

/**
 * Shared action button with built-in double-click protection.
 *
 * While loading (either the `loading` prop is true, or an async `onClick` is
 * still running) the button is disabled and shows a spinner, so a user cannot
 * trigger the same action twice. Existing `.btn-*` styling is preserved.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    loading = false,
    onClick,
    loadingText,
    children,
    className = "",
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  const [running, setRunning] = useState(false);
  const isLoading = loading || running;

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (isLoading || disabled) {
        event.preventDefault();
        return;
      }
      if (!onClick) return;
      const result = onClick(event);
      if (result instanceof Promise) {
        setRunning(true);
        result.finally(() => setRunning(false));
      }
    },
    [isLoading, disabled, onClick],
  );

  const variantClass = variant ? `btn-${variant}` : "";
  const classes = [variantClass, isLoading ? "is-loading" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {isLoading && <span className="btn-spinner" aria-hidden="true" />}
      {isLoading && loadingText ? loadingText : children}
    </button>
  );
});
