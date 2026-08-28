"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { classifyFormFactor } from "@/modules/devices/capability";
import {
  fuzzyFilterCommands,
  matchCommandFromText,
  visibleCommands,
  type CommandItem,
  type FormFactor,
} from "@/modules/assistant/command-index";

/**
 * Ctrl+K / ⌘K command palette (F5-adjacent, Task 12 ชั้น 1).
 * ชั้น 1 = deterministic fuzzy search over allowlisted routes (no AI).
 * ชั้น 2 (deterministic-first): Thai keyword → command mapping via
 * matchCommandFromText when fuzzy search finds nothing — never invents URLs.
 */
export function CommandPalette({ commands }: { commands: ReadonlyArray<CommandItem> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [formFactor, setFormFactor] = useState<FormFactor>("desktop");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setFormFactor(classifyFormFactor(window.innerWidth));
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(
    () => visibleCommands(fuzzyFilterCommands(commands, query), () => true, formFactor),
    [commands, query, formFactor],
  );

  const go = useCallback(
    (item: CommandItem) => {
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[active] ?? (query.trim() ? matchCommandFromText(query, commands) : null);
      if (target) go(target);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" role="dialog" aria-label="ค้นหาหน้าจอ">
      <div className="w-full max-w-xl rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="ค้นหาหน้าจอ... (Esc ปิด)"
          className="w-full rounded-t-[var(--radius-lg)] border-0 bg-transparent px-4 py-3 text-sm text-[var(--ink)] outline-none"
          aria-label="ค้นหาหน้าจอ"
        />
        <div className="max-h-80 overflow-y-auto border-t border-[var(--border)]">
          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-sm text-[var(--muted)]">
              {query.trim() && matchCommandFromText(query, commands) ? (
                <button
                  type="button"
                  onClick={() => {
                    const hit = matchCommandFromText(query, commands);
                    if (hit) go(hit);
                  }}
                  className="text-left"
                >
                  กด Enter เพื่อไปที่ “{matchCommandFromText(query, commands)?.label}”
                </button>
              ) : (
                "ไม่พบหน้าจอที่ตรงกับคำค้น"
              )}
            </div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onClick={() => go(item)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm ${
                  i === active ? "bg-[var(--tenant-primary-soft)] text-[var(--tenant-primary-strong)]" : "text-[var(--ink)]"
                }`}
              >
                <span className="font-semibold">{item.label}</span>
                <span className="text-xs text-[var(--muted)]">{item.href}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}