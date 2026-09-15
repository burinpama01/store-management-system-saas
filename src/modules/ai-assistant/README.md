# ai-assistant

Provider-agnostic Natural Language Control Layer for StoreOS.

**Status:** stub only — see Phase 0 docs before implementing.

- Plan: `Plan/StoreOS AI Assistant OpenAI Live Implementation Plan v2.html`
- Audit: `docs/ai-assistant/repo-audit.md`
- Coexistence: `docs/ai-assistant/VOICE_COEXISTENCE.md`
- Handoff: `docs/ai-assistant/AGENT_HANDOFF.md`

Rules: StoreOS owns execution; OpenAI is interpreter only; reuse `voice-pos` resolver/cart; never query Supabase from the model.
