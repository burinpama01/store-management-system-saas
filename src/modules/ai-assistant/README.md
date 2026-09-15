# ai-assistant

Provider-agnostic Natural Language Control Layer for StoreOS.

**Status:** PR1 tool foundation implemented (config, foundation, server adapter) — uncommitted, awaiting review. No API route / UI / Live yet.

- Plan: `Plan/StoreOS AI Assistant OpenAI Live Implementation Plan v2.html`
- Audit: `docs/ai-assistant/repo-audit.md`
- Coexistence: `docs/ai-assistant/VOICE_COEXISTENCE.md`
- Handoff: `docs/ai-assistant/AGENT_HANDOFF.md`

Rules: StoreOS owns execution; OpenAI is interpreter only; reuse `voice-pos` resolver/cart; never query Supabase from the model.
