# Agent backend integration

`lib/agents` is the typed UI boundary shared by web, Electron, and remote/mobile
surfaces. OpenCode remains the default. A per-project preference selects Codex
for ordinary new-chat drafts; automation that does not opt in continues to use
OpenCode. VS Code always uses OpenCode because its embedded runtime does not own
the host-side Codex process.

Codex thread IDs are encoded as synthetic OpenCode session IDs. The compatibility
mapper turns app-server threads, turns, items, diffs, approvals, questions, and
notifications into the existing OpenCode `Session`, `Message`, `Part`, and
`Event` shapes. This keeps one reducer and one rendering path. Queue identities
include runtime, directory, backend, and session ID.

The UI calls only the explicit `/api/agents/codex/*` HTTP routes and the
`/api/agents/events` SSE stream through runtime URL/fetch helpers. It never opens
a Codex WebSocket and never receives CLI credentials. The OpenChamber host owns
the Codex stdio app-server process.

Project preferences are stored by normalized directory and exposed through a
singleton store with same-window and cross-tab subscriptions. New-session
composer selectors can override the captured draft backend without changing the
project default.

Focused coverage lives beside the client, mapper, preferences, queue, and
message loader. Run it with Bun's test runner; the full package TypeScript check
validates the cross-feature integration.
