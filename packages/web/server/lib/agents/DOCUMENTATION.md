# Agent backend route module

## Ownership

`routes.js` owns the OpenChamber HTTP/SSE adapter for the injected Codex
runtime. It does not own Codex process management, the Codex protocol client,
or browser authentication. The existing `/api` authentication middleware must
run before this module is registered.

Register it with:

```js
registerAgentBackendRoutes(app, { codexRuntime, writeSseEvent });
```

`writeSseEvent` is optional. When omitted, the module writes normal SSE data
frames directly. The runtime is started lazily once, notifications are
subscribed once, and the returned registration's `close()` method removes all
clients and the runtime subscription.

## Result contract

Every JSON route returns one of these stable envelopes:

- `{ result: 'ok', data }`
- `{ result: 'unsupported', error: { code, message } }`
- `{ result: 'unavailable', error: { code, message } }`
- `{ result: 'error', error: { code, message } }`

Malformed request bodies, identifiers, cursors, limits, and response payloads
are rejected at the route boundary. Runtime response values and notification
payloads are copied only after JSON-safe validation; invalid notification
objects are ignored instead of being sent to clients.

## Routes

The Codex operation routes mirror the runtime method names while keeping the
HTTP surface explicit:

| HTTP route | Runtime operation |
| --- | --- |
| `GET /api/agents/status` | `getStatus()` plus `checkAvailability()` |
| `GET /api/agents/codex/account` | `account/read` |
| `POST /api/agents/codex/account/login/start` | `account/login/start` |
| `POST /api/agents/codex/account/login/cancel` | `account/login/cancel` |
| `POST /api/agents/codex/account/logout` | `account/logout` |
| `GET /api/agents/codex/models` | `model/list` |
| `GET /api/agents/codex/threads` | `thread/list` |
| `POST /api/agents/codex/threads/start` | `thread/start` |
| `POST /api/agents/codex/threads/read` | `thread/read` |
| `POST /api/agents/codex/threads/resume` | `thread/resume` |
| `POST /api/agents/codex/threads/fork` | `thread/fork` |
| `POST /api/agents/codex/threads/archive` | `thread/archive` |
| `POST /api/agents/codex/threads/unarchive` | `thread/unarchive` |
| `POST /api/agents/codex/threads/delete` or `DELETE /api/agents/codex/threads/:threadId` | `thread/delete` |
| `POST /api/agents/codex/threads/name` | `thread/name/set` |
| `POST /api/agents/codex/turns/start` | `turn/start` |
| `POST /api/agents/codex/turns/steer` | `turn/steer` |
| `POST /api/agents/codex/turns/interrupt` | `turn/interrupt` |

`thread/list` forwards the app-server parameter `cwd`. The legacy-compatible
query name `directory` is accepted, mapped to `cwd`, and never forwarded. If
both are present, `cwd` wins. The forwarded query object is built fresh and
whitelisted to `cursor`, `cwd` (from `directory` or `cwd`), `limit`, and
`archived`; any other query key is rejected with `invalid_params`.

Thread URLs with `:threadId` are also accepted for read and thread lifecycle
operations. Approval and user-input response routes call
`codexRuntime.respond(id, result)`:

- `POST /api/agents/codex/approval/respond`
- `POST /api/agents/codex/user-input/respond`

The response body must contain an `id` (or operation-specific request ID) and a
JSON object `result`. When the runtime reports the response was not delivered
(`responded: false`), the route returns the `error` envelope with code
`codex_response_not_delivered` instead of an `ok` result.

`GET /api/agents/status` performs the explicit availability probe plus
`getStatus()`. When the runtime state is `failed`/`stopped` and availability is
`available: false`, it returns the `unavailable` envelope (503) with the
sanitized status and availability data still present in the error payload;
otherwise it returns the `ok` envelope.

## SSE contract

`GET /api/agents/events` sends one data frame per valid runtime notification.
Each frame is normalized to:

```json
{
  "backend": "codex",
  "sequence": 1,
  "type": "thread/updated",
  "payload": { "threadId": "thread_1" }
}
```

Notifications using either `{ type, payload }` or `{ method, params }` are
accepted. `sequence` is process-local and strictly increases for accepted
notifications. Heartbeats are SSE comments and do not consume sequence
numbers. A request or response close/error removes its client and stops its
heartbeat timer.

The module subscribes to runtime status changes. When the runtime enters the
`failed` or `stopped` state, each connected client receives one final data
frame and is then removed (the stream closes as far as this module is
concerned):

```json
{
  "backend": "codex",
  "sequence": 2,
  "type": "backend_status",
  "payload": { "state": "failed" }
}
```

Status frames consume a sequence number like notifications but are never
emitted for other states.

There is intentionally no WebSocket route in this module. Browser and relay
transport concerns stay with the existing runtime transport layers.

## Tests

Run the focused suite with:

```bash
bun test packages/web/server/lib/agents/routes.test.js
```
