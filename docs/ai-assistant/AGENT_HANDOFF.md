# Agent handoff — StoreOS AI Assistant

> For the next coding agent. Chat context is NOT required if you read this + plan v2 + repo-audit.

## Why this PR exists

Credits were low; Cloud Agents are unavailable on the current Cursor plan. This PR parks Phase 0 docs + plan v2 so another agent can continue.

## Read first

1. `Plan/StoreOS AI Assistant OpenAI Live Implementation Plan v2.html`
2. `docs/ai-assistant/repo-audit.md`
3. `docs/ai-assistant/VOICE_COEXISTENCE.md`
4. `AGENTS.md` (repo root)

## Hard constraints (do not violate)

- AI never touches Supabase/service role directly — tools only
- Shared Voice POS resolver/alias + `pos/cart` for product/cart (no duplicate search)
- Entitlements via `canUseFeature` / existing `aiAssistant` (extend carefully; no parallel billing flag system)
- Critical tools **blocked** in MVP (no PIN/reauth found)
- Text / tool foundation **before** OpenAI Live
- Live PR must include session/minute hard caps + `AI_ASSISTANT_LIVE_ENABLED` kill switch from day one
- Verify Live sideband/delegation; if missing, session-bound signed tool channel (no free-form browser execute)
- AI outage must not break POS checkout

## Ordered work

### PR1 — Tool foundation (NEXT)

Title suggestion: `feat(ai-assistant): add provider-agnostic tool foundation`

Build:

- `src/modules/ai-assistant` config, types, feature gate, registry, Zod, risk policy, idempotency, dispatcher, audit wrapper
- Mock `system.echo` in dev/test only
- Unit tests for registry / deny paths / idempotency

Do **not** include: Live, WebRTC, mic, billing meters beyond stubs

Done when: unknown tool / bad args / permission deny fail closed; tests + lint + typecheck pass

### PR2 — Text POS

Title: `feat(ai-assistant): add text command interface for POS`

Tools: `pos.get_current_order`, `pos.search_product`, `pos.add_item`, `pos.remove_item`, `pos.change_quantity`, `catalog.search` — all via shared resolver

Include clarification, undo (reuse 6s window concept), e2e text path, cross-tenant tests

### PR3 — OpenAI Live PTT

Only after PR2 e2e green + coexistence UI rules implemented

Include caps, kill switch, usage metering (audio/session/tools), disconnect isolation

## Commands

```bash
npm run lint
npm run typecheck
npm run test
```

## Do not

- Start from Live API first
- Commit unrelated Plan/Design/artifacts noise from a dirty laptop tree
- Invent product IDs in the model
- Trust client permissions or model `confirmed: true`
