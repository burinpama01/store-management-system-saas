"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./Button";
import type { ComponentProps } from "react";

type SubmitButtonProps = Omit<ComponentProps<typeof Button>, "type" | "loading" | "onClick">;

/**
 * Submit button for plain `<form action={serverAction}>` forms that don't track
 * their own pending state. Reads the enclosing form's pending status via
 * useFormStatus so the button auto-disables and shows a spinner while the
 * server action runs — preventing double submits. Must be rendered inside a
 * <form>.
 */
export function SubmitButton({ children, ...rest }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...rest}>
      {children}
    </Button>
  );
}
