# StoreOS AI Assistant — Repository Audit (Phase 0)

> Date: 2026-09-15  
> Branch purpose: handoff for other agents  
> Plan: `Plan/StoreOS AI Assistant OpenAI Live Implementation Plan v2.html`  
> Status: audit only — no production AI Assistant behavior yet

## 1. Existing surfaces to reuse

| Area | Path | Notes |
|---|---|---|
| Command palette allowlist | `src/modules/assistant/command-index.ts` | Deterministic-first; AI must not invent URLs/actions |
| AI gateway | `src/modules/ai/gateway.ts` | Server-only, model allowlist, `store: false`, fail closed |
| AI quota / credits | `src/modules/ai/quota.ts`, `src/modules/ai/credits.ts` | `reserveQuota` / `settleUsage` / credit packs |
| Redaction | `src/modules/ai/redaction.ts` | Reuse patterns before any prompt/context |
| Voice POS | `src/modules/voice-pos/*` | intent-resolver, alias-*, cart, undo, command-queue, multi-command, standby-* |
| POS cart source of truth (pure) | `src/modules/pos/cart.ts` | `addToCart` / `updateQuantity` / `removeFromCart` — Voice POS cart wraps this |
| Auth / permissions | `src/modules/auth/guards.ts`, `permission-resolver.ts` | `getResolvedCurrentPermissions`, `requirePermission`, `requireFeature` |
| Billing feature gate | `src/modules/billing/types.ts` | `canUseFeature(state, feature)`; `PlanFeatures.aiAssistant` already exists |
| System event log | `src/modules/system/event-log.ts` | `logSystemEvent` — fail-soft, secret redaction |

`src/modules/ai-assistant/` did **not** exist before this handoff PR (only README stub added).

## 2. Answers to plan Phase 0 questions

1. **POS cart source of truth:** Pure cart mutations live in `src/modules/pos/cart.ts`. Voice cart adapter: `src/modules/voice-pos/cart.ts` (imports pos/cart; local cart only; ambiguous match must not mutate).
2. **Active terminal / cart / order:** Voice POS treats cart as in-memory/local terminal cart. Do not use “latest order in DB” as “current order”. Confirm UI session → server validation in PR1/PR2. No solid global `terminalId` registry found as a single source of truth in this audit pass — MVP should validate `activeCartId`/`activeOrderId` from authenticated session scope.
3. **Store context:** Derive from auth session / `getResolvedCurrentPermissions()` (organization + store), not from model arguments.
4. **Server permission helper:** `getResolvedCurrentPermissions`, `requirePermission`, `requireFeature` in `src/modules/auth/guards.ts`.
5. **Package entitlement:** `canUseFeature(BillingState, FeatureKey)`. Existing boolean: `aiAssistant` (also `aiVision`, `aiForecast`). Prefer extending this pattern rather than a parallel flag system. Plan v2 capabilities (`ai_assistant.voice`, `.text`, `.pos_tools`) may map as sub-flags later — decide in PR1 without inventing a second billing engine.
6. **Event log:** `logSystemEvent` in `src/modules/system/event-log.ts`.
7. **AI quota:** `reserveQuota` / `settleUsage` in `src/modules/ai/quota.ts`; credits in `credits.ts`. New Live meters (audio seconds, session seconds) are **not** present yet — log in PR3; bill later.
8. **Voice undo:** `src/modules/voice-pos/undo.ts` — `VOICE_UNDO_WINDOW_MS = 6000`, snapshot previous cart. Reuse for AI Assistant safe mutations.
9. **Product resolver / alias:** `intent-resolver.ts` + alias-* + `resolveVoiceProductPhrase` in voice-pos cart. **Mandatory shared path for AI Assistant tools (ADR-009).**
10. **Cart mutation idempotency:** Voice path relies on UI undo + resolver rules; do not assume DB idempotency keys exist for cart lines. PR1 must add assistant-level idempotency for tool calls.
11. **POS mutation services:** Prefer `pos/cart` + `voice-pos/cart` for MVP add/remove/qty. Server cart helpers exist (`server-cart.ts`) — verify before any server-side order write.
12. **RLS:** Follow existing order/cart RLS; AI tables must be additive with RLS (see plan v2). Do not weaken POS RLS.
13. **Device / terminal ID:** Partial — devices capability / form factor exist (`classifyFormFactor`). Treat terminal binding as soft for MVP (session-validated active cart).
14. **Audit append-only:** System logs are write-oriented with redaction; treat AI action log as append-only in new tables.
15. **PIN / reauth:** No dedicated staff PIN/reauth flow found in this audit search. **MVP must block all critical tools** (refund, void closed bill, etc.).

## 3. Risks / conflicts with plan v2

- Two voice stacks already: Voice POS + Windows Voice Standby — see `VOICE_COEXISTENCE.md`.
- `aiAssistant` entitlement exists but is coarse; Live/text/pos sub-capabilities need careful mapping.
- Dirty local working tree on laptop often has many untracked Plan/Design/artifacts files — do not sweep them into AI PRs.

## 4. Proposed PR1 file touch list (next agent)

```
src/modules/ai-assistant/
  config/, policy/, tools/, orchestrator/, audit/, session/
tests/unit/ai-assistant/
```

No OpenAI Live / WebRTC in PR1.

## 5. Validation commands

```bash
npm run lint
npm run typecheck
npm run test
```

## 6. Out of scope for this audit PR

- Implementing tool dispatcher or Live
- Changing POS payment / billing production behavior
- Merging Voice POS into ai-assistant modules
