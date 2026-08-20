# Codex App-Server Runtime

## Purpose

This module owns the server-side process and protocol boundary for the Codex
CLI app-server. It starts `codex app-server --listen stdio://`, performs the
JSONL RPC initialization handshake, and exposes a dependency-injected runtime
that route modules can compose without owning child-process or stream details.

The module is intentionally independent of HTTP routes, UI state, and Codex
domain methods. A caller subscribes to notifications and handles server-
initiated requests (for example approval requests); it decides how those
messages map to its own route or session contract.

## Entrypoint

Import `createCodexAppServerRuntime` from `index.js`:

```js
const runtime = createCodexAppServerRuntime({
  executable: 'codex',
  onServerRequest: async ({ method, params }) => resolveServerRequest(method, params),
});

await runtime.start();
const result = await runtime.request('thread/list', { limit: 25 });
const unsubscribe = runtime.subscribeNotifications(({ method, params }) => {
  onCodexNotification(method, params);
});
```

The runtime also exports `checkAvailability`, `subscribeStatus`, `getStatus`,
`notify`, `respond`, `stop`, and `restart`. `checkAvailability()` runs the
sanitized executable/version probe and returns `{ available, version,
minimumVersion, reason }`; it does not start the app-server. When the runtime
is already `ready` with a known version it returns the cached version without
re-running the probe, and a failed probe never overwrites the last successful
detected version. `stop()` is
graceful and bounded: it rejects pending work, clears server requests, sends a
termination signal, waits for the child to close, and then force-terminates if
the close does not arrive before the configured timeout.

## Process and version contract

Before each launch the runtime executes `<executable> --version` and requires
Codex `>= 0.148.0` by default. The executable check and process spawn are
injected dependencies, so route tests can use fake child streams without
starting Codex. The app-server is spawned with exactly:

```text
codex app-server --listen stdio://
```

The runtime does not expose the executable path, environment, working
directory, stderr, process object, or raw startup errors through `getStatus()`.

## Protocol contract

Stdout is parsed as UTF-8 JSONL. Codex uses JSON-RPC semantics but omits the
`jsonrpc` member on the wire; OpenChamber therefore emits `{ id, method,
params }` and accepts the optional member only on input for compatibility.
Blank lines are ignored; malformed RPC
messages and frames larger than the bounded line size fail the transport. The
client sends monotonically increasing numeric request IDs. Startup sends:

1. `initialize` with `clientInfo` and `capabilities.experimentalApi: true`.
2. The `initialized` notification after a successful response.

Responses settle the pending RPC map. Notifications are delivered to all
notification subscribers. Server-initiated requests are passed to
`onServerRequest` when configured; the returned value is sent as the matching
RPC result. Without a configured handler, requests are retained in a
bounded map and published to the existing `subscribe`/
`subscribeNotifications` channel as the stable event
`{ type: 'server_request', payload: { id, method, params } }`. The route
answers exactly once with `respond(id, result)`, which returns `{ id, result }`
when it sent a result. Duplicate, unknown, or already-cleared IDs return
`{ id, responded: false }`. Requests
are cleared on process exit, stop, or restart, and overflow receives a fixed
RPC error without forwarding payload or handler error text.

## Lifecycle and status

`getStatus()` returns only sanitized state:

```js
{
  state: 'idle' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'stopped' | 'failed',
  ready: boolean,
  running: boolean,
  version: string | null,
  restartAttempts: number,
  totalRestartCount: number,
  maxRestartAttempts: number,
  lastError: { code: string, message: string, ... } | null,
}
```

`getPendingServerRequestCount()` exposes the bounded unhandled-request count
without exposing process state or request payloads through status.

An unexpected process exit rejects every pending RPC. Automatic restarts are
limited to a bounded budget per explicit start/restart cycle and use capped
exponential backoff. A successful restart does not silently expand that
budget; an operator or owning runtime can call `restart()` to begin a fresh
bounded cycle.

No module in this runtime logs stdout, stderr, RPC params/results, notification
payloads, environment values, credentials, or raw errors. Consumers should
apply their own privacy policy if they expose protocol payloads to a client.

## Testing

Focused tests use fake child streams and cover JSONL framing, version gating,
the experimental handshake, request IDs, pending-request rejection, server
request responses, notification subscriptions, sanitized status, graceful
stop, and capped restart backoff.

The integration smoke check also starts the installed CLI, completes the
handshake, and reads `model/list` and `thread/list`; this catches wire-shape
drift that a fake child cannot detect.
