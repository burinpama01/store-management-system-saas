# ADR-008 — Voice POS / Standby / AI Assistant coexistence

> Status: Accepted for pilot  
> Date: 2026-09-15  
> Related: Plan v2 § ADR-008, ADR-009

## Decision

During pilot, **three systems may coexist** but must not share a microphone capture pipeline or invent separate cart logic:

| System | Role in pilot | UI entry |
|---|---|---|
| Voice POS (`src/modules/voice-pos`) | **Primary** intent → resolver → local cart | Existing Voice POS controls |
| Windows Voice Standby / Launcher TTS | Optional host channel; **not** required for AI Assistant MVP | Standby / Launcher flows (separate plans) |
| AI Assistant (`src/modules/ai-assistant`) | Opt-in overlay; **text first**, then push-to-talk | Separate AI button — does **not** replace Voice POS button |

## Rules

1. **One mic owner at a time.** If AI Assistant PTT is active, Voice POS must not also capture/process the same utterance (and vice versa).
2. **Shared domain only.** Product resolve + cart mutate must go through Voice POS resolver/alias + `pos/cart` (ADR-009). No second catalog searcher inside `ai-assistant`.
3. **No dual execution.** A single user utterance must not run Voice POS pipeline and AI Assistant tool pipeline in parallel.
4. **Standby stays optional.** AI Assistant text mode must work without Windows Standby.
5. **Sunset decision later.** After pilot metrics, choose absorb vs keep separate — do not merge modules in MVP.

## Implementation checklist (PR2/PR3 UI)

- [ ] Distinct AI entry control on POS
- [ ] Mutual exclusion flag/session for mic capture
- [ ] Clarification/undo UI can reuse Voice POS patterns without importing Standby
- [ ] Documented for staff: which button does what

## Non-goals

- Wake word / always-listen
- Replacing Voice POS in the same release as AI Assistant MVP
