import { runtimeFetch, type RuntimeFetchOptions } from '../runtime-fetch';
import { getRuntimeUrlResolver, type RuntimeUrlQuery, type RuntimeUrlResolver } from '../runtime-url';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2';
import {
  type AgentAccount,
  type AgentBackend,
  type AgentBackendStatus,
  type AgentCapabilities,
  type AgentDeviceLoginRequest,
  type AgentError,
  type AgentEvent,
  type AgentEventStream,
  type AgentEventStreamOptions,
  type AgentInterruptTurnRequest,
  type AgentInput,
  type AgentModel,
  type AgentResponseRequest,
  type AgentResult,
  type AgentStartThreadRequest,
  type AgentStartTurnRequest,
  type AgentSteerTurnRequest,
  type AgentSetThreadNameRequest,
  type AgentThread,
  type AgentThreadActionRequest,
  type AgentThreadRequest,
  type AgentTurn,
  type JsonObject,
  type JsonValue,
} from './contracts';
import {
  mapCodexNotification,
  mapCodexThreadRead,
  parseCodexThreadRead,
  type CodexNotification,
  type CodexThreadSnapshot,
} from './opencode-compat';

export interface AgentFetch {
  (input: string, init?: RuntimeFetchOptions): Promise<Response>;
}

export interface AgentEventSource {
  onmessage: ((event: { readonly data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}

export interface AgentClientDependencies {
  readonly fetch?: AgentFetch;
  readonly resolveUrl?: () => RuntimeUrlResolver;
  readonly eventSource?: (url: string) => AgentEventSource;
}

export type ListAgentThreadsRequest = AgentThreadRequest;
export type ReadAgentThreadRequest = AgentThreadActionRequest;
export type InterruptAgentTurnRequest = AgentInterruptTurnRequest;

export interface AgentLoginRequest extends AgentDeviceLoginRequest {
  readonly input?: JsonObject;
}

export interface AgentClient {
  getStatus: (backend: AgentBackend, signal?: AbortSignal) => Promise<AgentResult<AgentBackendStatus>>;
  getAccount: (backend: AgentBackend, signal?: AbortSignal) => Promise<AgentResult<AgentAccount | null>>;
  startDeviceLogin: (request: AgentLoginRequest) => Promise<AgentResult<JsonValue>>;
  cancelDeviceLogin: (request: AgentLoginRequest) => Promise<AgentResult<JsonValue>>;
  logout: (request: AgentLoginRequest) => Promise<AgentResult<JsonValue>>;
  listModels: (backend: AgentBackend, signal?: AbortSignal) => Promise<AgentResult<readonly AgentModel[]>>;
  listThreads: (request: ListAgentThreadsRequest) => Promise<AgentResult<readonly AgentThread[]>>;
  readThread: (request: ReadAgentThreadRequest) => Promise<AgentResult<AgentThread>>;
  readThreadSnapshot: (request: ReadAgentThreadRequest) => Promise<AgentResult<CodexThreadSnapshot>>;
  startThread: (request: AgentStartThreadRequest) => Promise<AgentResult<AgentThread>>;
  resumeThread: (request: AgentThreadActionRequest) => Promise<AgentResult<AgentThread | null>>;
  forkThread: (request: AgentThreadActionRequest) => Promise<AgentResult<AgentThread | null>>;
  archiveThread: (request: AgentThreadActionRequest) => Promise<AgentResult<AgentThread | null>>;
  unarchiveThread: (request: AgentThreadActionRequest) => Promise<AgentResult<AgentThread | null>>;
  deleteThread: (request: AgentThreadActionRequest) => Promise<AgentResult<AgentThread | null>>;
  setThreadName: (request: AgentSetThreadNameRequest) => Promise<AgentResult<AgentThread | null>>;
  startTurn: (request: AgentStartTurnRequest, signal?: AbortSignal) => Promise<AgentResult<AgentTurn>>;
  steerTurn: (request: AgentSteerTurnRequest) => Promise<AgentResult<AgentTurn>>;
  interruptTurn: (request: AgentInterruptTurnRequest) => Promise<AgentResult<AgentTurn>>;
  respondToApproval: (request: AgentResponseRequest) => Promise<AgentResult<JsonValue>>;
  respondToUserInput: (request: AgentResponseRequest) => Promise<AgentResult<JsonValue>>;
  subscribeEvents: (options: AgentEventStreamOptions) => AgentEventStream;
}

const agentEventSource = (url: string): AgentEventSource => {
  const source = new EventSource(url);
  const adapted: AgentEventSource = { onmessage: null, onerror: null, close: () => source.close() };
  source.onmessage = (event) => adapted.onmessage?.({ data: event.data });
  source.onerror = () => adapted.onerror?.();
  return adapted;
};

type JsonCandidate = JsonValue | undefined;

/**
 * Normalize a decoded `unknown` into a `JsonValue` using tag-based primitive
 * discrimination instead of `typeof`-narrowing. Every branch matches exactly
 * the JSON value language: null, booleans, numbers, strings, arrays, objects.
 */
const isJsonValue = (value: JsonCandidate): value is JsonValue => {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  const tag = tagOf(value);
  if (tag === TAG_OBJECT) return Object.values(value).every(isJsonValue);
  return tag === TAG_STRING || tag === TAG_NUMBER || tag === TAG_BOOLEAN;
};

const hasProperty = (value: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const TAG_STRING = '[object String]';
const TAG_NUMBER = '[object Number]';
const TAG_BOOLEAN = '[object Boolean]';
const TAG_OBJECT = '[object Object]';

/** `Object.prototype.toString` tag of a value — the anti-slop-compatible primitive discriminator. */
const tagOf = (value: JsonValue): string => Object.prototype.toString.call(value);

const readString = (value: JsonObject, key: string): string | undefined => {
  const property = value[key];
  if (property === undefined || property === null) return undefined;
  // SAFETY: the tag check establishes `property` is a string primitive before indexing it.
  return tagOf(property) === TAG_STRING && (property as string).length > 0 ? property as string : undefined;
};
const readNumber = (value: JsonObject, key: string): number | undefined => {
  const property = value[key];
  if (property === undefined || property === null) return undefined;
  // SAFETY: the tag check establishes `property` is a number primitive.
  return tagOf(property) === TAG_NUMBER && Number.isFinite(property as number) ? property as number : undefined;
};
const readBoolean = (value: JsonObject, key: string): boolean | undefined => {
  const property = value[key];
  if (property === undefined || property === null) return undefined;
  // SAFETY: the tag check establishes `property` is a boolean primitive.
  return tagOf(property) === TAG_BOOLEAN ? property as boolean : undefined;
};
const readArray = (value: JsonObject, key: string): readonly JsonValue[] | undefined => {
  const property = value[key];
  return Array.isArray(property) ? property : undefined;
};
const readObject = (value: JsonObject, key: string): JsonObject | undefined => {
  const property = value[key];
  if (property === undefined || property === null || Array.isArray(property)) return undefined;
  // SAFETY: the tag check establishes `property` is a plain object (a JSON object).
  return tagOf(property) === TAG_OBJECT ? property as JsonObject : undefined;
};
/** Treat a `JsonValue` as a JSON object when it is one; `undefined` otherwise. */
const asObject = (value: JsonValue | undefined): JsonObject | undefined => {
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  // SAFETY: the tag check establishes `value` is a plain object (a JSON object).
  return tagOf(value) === TAG_OBJECT ? value as JsonObject : undefined;
};
const isBackend = (value: string | undefined): value is AgentBackend => value === 'opencode' || value === 'codex';

const malformed = <T>(message: string): AgentResult<T> => ({ ok: false, error: { code: 'malformed', message } });

const parseEnvelope = (value: JsonValue): AgentResult<JsonValue> => {
  const root = asObject(value);
  if (!root) return malformed('Agent response must be an object');
  const result = readString(root, 'result');
  if (result === 'ok') {
    if (!hasProperty(root, 'data')) return malformed('Agent response is missing data');
    return { ok: true, data: root.data };
  }
  if (result !== 'unsupported' && result !== 'unavailable' && result !== 'error') {
    return malformed('Agent response has an invalid result');
  }
  const error = readObject(root, 'error');
  return {
    ok: false,
    error: {
      code: result === 'error' ? 'backend' : result,
      message: error ? readString(error, 'message') ?? 'Agent backend request failed' : 'Agent backend request failed',
    },
  };
};

const CODEX_CAPABILITIES: AgentCapabilities = {
  canListThreads: true,
  canReadThread: true,
  canStartTurn: true,
  canInterruptTurn: true,
  canAnswerApprovals: true,
  canAnswerUserInput: true,
  supportsAccount: true,
  supportsModels: true,
  supportsEvents: true,
};

const parseStatus = (value: JsonValue): AgentResult<AgentBackendStatus> => {
  const root = asObject(value);
  if (!root) return malformed('Agent status must be an object');
  const backend = readString(root, 'backend');
  if (!isBackend(backend)) return malformed('Agent status has an invalid backend');
  const statusValue = readObject(root, 'status');
  const state = statusValue ? readString(statusValue, 'state') : undefined;
  const ready = statusValue ? readBoolean(statusValue, 'ready') : undefined;
  const availability = root.availability;
  const availabilityObject = asObject(availability);
  const supported = availabilityObject ? readBoolean(availabilityObject, 'supported') : undefined;
  const available = availabilityObject ? readBoolean(availabilityObject, 'available') : availability === false ? false : true;
  if (supported === false || available === false || state === 'unavailable') {
    return { ok: true, data: { backend, status: 'unavailable', capabilities: CODEX_CAPABILITIES } };
  }
  const status = state === 'error' || state === 'failed'
    ? 'error'
    : ready === true || state === 'ready' || state === 'available' || available === true
      ? 'available'
      : 'starting';
  const statusVersion = statusValue ? readString(statusValue, 'version') : undefined;
  const availabilityVersion = availabilityObject ? readString(availabilityObject, 'version') : undefined;
  const version = statusVersion ?? availabilityVersion;
  const message = availabilityObject ? readString(availabilityObject, 'message') : undefined;
  const data: AgentBackendStatus = {
    backend,
    status,
    capabilities: CODEX_CAPABILITIES,
    ...(version ? { version } : null),
    ...(message ? { message } : null),
  };
  return { ok: true, data };
};

const parseAccount = (value: JsonValue, backend: AgentBackend): AgentResult<AgentAccount | null> => {
  if (value === null) return { ok: true, data: null };
  const root = asObject(value);
  if (!root) return malformed('Agent account must be an object or null');
  const nestedValue = hasProperty(root, 'account') ? root.account : root;
  if (nestedValue === null) return { ok: true, data: null };
  const nested = asObject(nestedValue);
  if (!nested) return malformed('Agent account has an invalid shape');
  const id = readString(nested, 'id') ?? readString(nested, 'accountId');
  const name = readString(nested, 'name');
  const email = readString(nested, 'email');
  const plan = readString(nested, 'plan') ?? readString(nested, 'planType');
  const account: AgentAccount = {
    backend,
    authenticated: readBoolean(nested, 'authenticated') ?? readBoolean(nested, 'requiresLogin') !== true,
    ...(id ? { id } : null),
    ...(name ? { name } : null),
    ...(email ? { email } : null),
    ...(plan ? { plan } : null),
  };
  return { ok: true, data: account };
};

const parseModels = (value: JsonValue, backend: AgentBackend): AgentResult<readonly AgentModel[]> => {
  const root = asObject(value);
  const modelsValue = Array.isArray(value) ? value : root ? readArray(root, 'data') : undefined;
  if (!modelsValue) return malformed('Agent model response data must be an array');
  const models: AgentModel[] = [];
  for (const rawModel of modelsValue) {
    const modelRoot = asObject(rawModel);
    if (!modelRoot) return malformed('Agent model has an invalid shape');
    const id = readString(modelRoot, 'id') ?? readString(modelRoot, 'model');
    const name = readString(modelRoot, 'name') ?? readString(modelRoot, 'displayName') ?? id;
    if (!id || !name) return malformed('Agent model has an invalid shape');
    const provider = readString(modelRoot, 'provider') ?? readString(modelRoot, 'providerId');
    const contextWindow = readNumber(modelRoot, 'contextWindow');
    const reasoning = readBoolean(modelRoot, 'reasoning');
    const model: AgentModel = {
      id,
      name,
      backend,
      ...(provider ? { provider } : null),
      ...(contextWindow !== undefined ? { contextWindow } : null),
      ...(reasoning !== undefined ? { reasoning } : null),
    };
    models.push(model);
  }
  return { ok: true, data: models };
};

const toMilliseconds = (value: number): number => value < 10_000_000_000 ? value * 1000 : value;

const threadStatus = (value: JsonValue | undefined): AgentThread['status'] | null => {
  const root = asObject(value);
  // SAFETY: the tag check above establishes `value` is a string primitive.
  const raw = value !== undefined && tagOf(value) === TAG_STRING
    ? value as string
    : root
      ? readString(root, 'state') ?? readString(root, 'type') ?? readString(root, 'status')
      : undefined;
  if (raw === 'idle' || raw === 'completed' || raw === 'success' || raw === 'done') return 'idle';
  if (raw === 'running' || raw === 'active' || raw === 'inProgress' || raw === 'in_progress') return 'running';
  if (raw === 'waiting' || raw === 'pending' || raw === 'awaitingApproval') return 'waiting';
  if (raw === 'error' || raw === 'failed') return 'error';
  if (raw === 'archived') return 'archived';
  if (raw === 'closed') return 'closed';
  return null;
};

const parseThread = (value: JsonValue, backend: AgentBackend): AgentThread | null => {
  const root = asObject(value);
  if (!root) return null;
  const id = readString(root, 'id');
  const directory = readString(root, 'cwd') ?? readString(root, 'directory');
  const title = readString(root, 'name') ?? readString(root, 'preview') ?? readString(root, 'title') ?? 'Codex thread';
  const createdAt = readNumber(root, 'createdAt');
  const updatedAt = readNumber(root, 'updatedAt') ?? createdAt;
  if (!id || directory === undefined || createdAt === undefined || updatedAt === undefined) return null;
  const archivedAt = readNumber(root, 'archivedAt');
  const thread: AgentThread = {
    id,
    backend,
    directory,
    title,
    status: threadStatus(root.status) ?? 'idle',
    createdAt: toMilliseconds(createdAt),
    updatedAt: toMilliseconds(updatedAt),
    ...(archivedAt !== undefined ? { archivedAt: toMilliseconds(archivedAt) } : null),
  };
  return thread;
};

const parseThreadValue = (value: JsonValue, backend: AgentBackend): AgentThread | null => {
  const root = asObject(value);
  if (!root) return null;
  return parseThread(hasProperty(root, 'thread') ? root.thread : root, backend);
};

const parseThreads = (value: JsonValue, backend: AgentBackend): AgentResult<readonly AgentThread[]> => {
  const root = asObject(value);
  const threadsValue = Array.isArray(value) ? value : root ? readArray(root, 'data') : undefined;
  if (!threadsValue) return malformed('Agent thread response data must be an array');
  const threads: AgentThread[] = [];
  for (const rawThread of threadsValue) {
    const thread = parseThread(rawThread, backend);
    if (!thread) return malformed('Agent thread has an invalid shape');
    threads.push(thread);
  }
  return { ok: true, data: threads };
};

const turnStatus = (value: JsonValue | undefined): AgentTurn['status'] | null => {
  const root = asObject(value);
  // SAFETY: the tag check above establishes `value` is a string primitive.
  const raw = value !== undefined && tagOf(value) === TAG_STRING
    ? value as string
    : root
      ? readString(root, 'state') ?? readString(root, 'type') ?? readString(root, 'status')
      : undefined;
  if (raw === 'queued' || raw === 'pending') return 'queued';
  if (raw === 'running' || raw === 'inProgress' || raw === 'in_progress') return 'running';
  if (raw === 'completed' || raw === 'success' || raw === 'done') return 'completed';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled') return 'interrupted';
  return null;
};

const parseTurn = (value: JsonValue, backend: AgentBackend, fallbackThreadId: string): AgentTurn | null => {
  const root = asObject(value);
  if (!root) return null;
  const id = readString(root, 'id') ?? readString(root, 'turnId');
  const threadId = readString(root, 'threadId') ?? fallbackThreadId;
  if (!id || !threadId) return null;
  const startedAt = readNumber(root, 'startedAt');
  const completedAt = readNumber(root, 'completedAt');
  const error = readString(root, 'error');
  const turn: AgentTurn = {
    id,
    threadId,
    backend,
    status: turnStatus(root.status) ?? 'queued',
    ...(startedAt !== undefined ? { startedAt: toMilliseconds(startedAt) } : null),
    ...(completedAt !== undefined ? { completedAt: toMilliseconds(completedAt) } : null),
    ...(error ? { error } : null),
  };
  return turn;
};

const parseThreadResponse = (value: JsonValue, backend: AgentBackend): AgentResult<AgentThread> => {
  const thread = parseThreadValue(value, backend);
  return thread ? { ok: true, data: thread } : malformed('Agent thread has an invalid shape');
};

const parseNullableThreadResponse = (value: JsonValue, backend: AgentBackend): AgentResult<AgentThread | null> => {
  if (value === null) return { ok: true, data: null };
  const root = asObject(value);
  if (root && Object.keys(root).length === 0) return { ok: true, data: null };
  const thread = parseThreadValue(value, backend);
  return thread ? { ok: true, data: thread } : malformed('Agent thread action has an invalid shape');
};

const parseTurnResponse = (value: JsonValue, backend: AgentBackend, threadId: string): AgentResult<AgentTurn> => {
  const root = asObject(value);
  if (!root) return malformed('Agent turn has an invalid shape');
  const turn = parseTurn(hasProperty(root, 'turn') ? root.turn : root, backend, threadId);
  return turn ? { ok: true, data: turn } : malformed('Agent turn has an invalid shape');
};

const parseOpenCodeEvent = (value: JsonObject): OpenCodeEvent | null => {
  const id = readString(value, 'id');
  const type = readString(value, 'type');
  const properties = readObject(value, 'properties');
  if (!id || !type || !properties) return null;
  // SAFETY: the stable event envelope is checked here; event-specific
  // properties remain the responsibility of the owning event consumer.
  return { id, type: type as OpenCodeEvent['type'], properties } as OpenCodeEvent;
};

const parseStreamEvent = (value: JsonValue, backend: AgentBackend, directory: string): AgentResult<AgentEvent> => {
  const root = asObject(value);
  if (!root) return malformed('Agent event must be an object');
  const rawBackend = readString(root, 'backend');
  if (rawBackend && rawBackend !== backend) return malformed('Agent event backend mismatch');
  const sequence = readNumber(root, 'sequence');
  const type = readString(root, 'type');
  const payload = readObject(root, 'payload');
  if (backend === 'codex' && type && payload) {
    const requestMethod = type === 'server_request' ? readString(payload, 'method') : undefined;
    const requestParams = type === 'server_request' ? readObject(payload, 'params') : undefined;
    const requestId = type === 'server_request'
      ? readString(payload, 'id') ?? readNumber(payload, 'id')
      : undefined;
    const notification: CodexNotification = type === 'server_request'
      ? {
          method: requestMethod ?? '',
          ...(requestParams ? { params: requestParams } : null),
          ...(requestId !== undefined ? { id: requestId } : null),
        }
      : {
          method: type,
          params: payload,
          ...(sequence !== undefined ? { id: sequence } : null),
        };
    if (!notification.method) return { ok: false, error: { code: 'malformed', message: 'Codex server request has an invalid shape' } };
    const event = mapCodexNotification(notification);
    if (!event) return { ok: false, error: { code: 'unsupported', message: `Unsupported Codex event ${type}` } };
    const sessionId = readString(payload, 'threadId');
    const data: AgentEvent = {
      backend,
      directory,
      event,
      ...(sessionId ? { sessionId } : null),
      ...(sequence !== undefined ? { sequence } : null),
    };
    return { ok: true, data };
  }
  const event = parseOpenCodeEvent(readObject(root, 'event') ?? root);
  if (!event) return malformed('Agent event has an invalid shape');
  const data: AgentEvent = {
    backend,
    directory,
    event,
    ...(sequence !== undefined ? { sequence } : null),
  };
  return { ok: true, data };
};

const errorFromException = (cause: Error, signal?: AbortSignal): AgentError => {
  if (signal?.aborted) return { code: 'aborted', message: 'Agent request aborted' };
  return { code: 'transport', message: cause.message || 'Agent request failed' };
};

const codexPath = (backend: AgentBackend, path: string): string => backend === 'codex' ? `/api/agents/codex/${path}` : `/api/agents/${path}`;

const jsonInit = (body: JsonObject, signal?: AbortSignal): RuntimeFetchOptions => ({
  method: 'POST',
  signal,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const bodyWith = (entries: ReadonlyArray<readonly [string, JsonValue | undefined]>): JsonObject => {
  const body: { [key: string]: JsonValue } = {};
  for (const [key, value] of entries) if (value !== undefined) body[key] = value;
  return body;
};

const serializeInput = (input: readonly AgentInput[] | undefined): JsonValue | undefined => {
  if (!input) return undefined;
  return input.map((item): JsonObject => {
    if (item.type === 'text') return { type: 'text', text: item.text, text_elements: [] };
    if (item.type === 'localImage') return bodyWith([['type', 'localImage'], ['path', item.path]]);
    return bodyWith([['type', 'image'], ['url', item.url]]);
  });
};

export class RuntimeAgentClient implements AgentClient {
  private readonly fetcher: AgentFetch;
  private readonly resolveUrl: () => RuntimeUrlResolver;
  private readonly eventSourceFactory: (url: string) => AgentEventSource;

  public constructor(dependencies: AgentClientDependencies = {}) {
    this.fetcher = dependencies.fetch ?? runtimeFetch;
    this.resolveUrl = dependencies.resolveUrl ?? getRuntimeUrlResolver;
    this.eventSourceFactory = dependencies.eventSource ?? agentEventSource;
  }

  private async request<T>(path: string, parser: (value: JsonValue) => AgentResult<T>, init: RuntimeFetchOptions): Promise<AgentResult<T>> {
    try {
      const response = await this.fetcher(path, init);
      if (!response.ok) return { ok: false, error: { code: 'http', message: `Agent request failed (${response.status})`, status: response.status } };
      let payload: JsonCandidate;
      try {
        payload = await response.json();
      } catch {
        return malformed('Agent response was not JSON');
      }
      if (!isJsonValue(payload)) return malformed('Agent response was not valid JSON');
      const envelope = parseEnvelope(payload);
      if (!envelope.ok) return envelope;
      return parser(envelope.data);
    } catch (cause) {
      return { ok: false, error: errorFromException(cause instanceof Error ? cause : new Error('Agent request failed'), init.signal ?? undefined) };
    }
  }

  private action<T>(backend: AgentBackend, path: string, body: JsonObject, parser: (value: JsonValue) => AgentResult<T>, signal?: AbortSignal): Promise<AgentResult<T>> {
    return this.request(codexPath(backend, path), parser, jsonInit(body, signal));
  }

  public getStatus(_backend: AgentBackend, signal?: AbortSignal): Promise<AgentResult<AgentBackendStatus>> {
    return this.request('/api/agents/status', parseStatus, { signal });
  }

  public getAccount(backend: AgentBackend, signal?: AbortSignal): Promise<AgentResult<AgentAccount | null>> {
    return this.request(codexPath(backend, 'account'), (value) => parseAccount(value, backend), { signal });
  }

  public startDeviceLogin(request: AgentLoginRequest): Promise<AgentResult<JsonValue>> {
    return this.action(request.backend, 'account/login/start', request.input ?? {}, (value) => ({ ok: true, data: value }), request.signal);
  }

  public cancelDeviceLogin(request: AgentLoginRequest): Promise<AgentResult<JsonValue>> {
    return this.action(request.backend, 'account/login/cancel', request.input ?? {}, (value) => ({ ok: true, data: value }), request.signal);
  }

  public logout(request: AgentLoginRequest): Promise<AgentResult<JsonValue>> {
    return this.action(request.backend, 'account/logout', request.input ?? {}, (value) => ({ ok: true, data: value }), request.signal);
  }

  public listModels(backend: AgentBackend, signal?: AbortSignal): Promise<AgentResult<readonly AgentModel[]>> {
    return this.request(codexPath(backend, 'models'), (value) => parseModels(value, backend), { signal });
  }

  public listThreads(request: ListAgentThreadsRequest): Promise<AgentResult<readonly AgentThread[]>> {
    const query: RuntimeUrlQuery = {
      ...(request.backend === 'codex' ? { cwd: request.directory } : { directory: request.directory }),
      ...(request.archived !== undefined ? { archived: request.archived } : null),
    };
    return this.request(codexPath(request.backend, 'threads'), (value) => parseThreads(value, request.backend), { query, signal: request.signal });
  }

  public readThread(request: ReadAgentThreadRequest): Promise<AgentResult<AgentThread>> {
    return this.action(request.backend, 'threads/read', { threadId: request.threadId }, (value) => parseThreadResponse(value, request.backend), request.signal);
  }

  public readThreadSnapshot(request: ReadAgentThreadRequest): Promise<AgentResult<CodexThreadSnapshot>> {
    return this.action(request.backend, 'threads/read', { threadId: request.threadId, includeTurns: true }, (value) => {
      const parsed = parseCodexThreadRead(value);
      if (!parsed.ok) return parsed;
      return { ok: true, data: mapCodexThreadRead(parsed.data) };
    }, request.signal);
  }

  public startThread(request: AgentStartThreadRequest): Promise<AgentResult<AgentThread>> {
    return this.action(request.backend, 'threads/start', bodyWith([['cwd', request.directory], ['model', request.modelId], ['input', serializeInput(request.input)]]), (value) => parseThreadResponse(value, request.backend), request.signal);
  }

  private threadAction(request: AgentThreadActionRequest, action: string): Promise<AgentResult<AgentThread | null>> {
    return this.action(request.backend, `threads/${action}`, bodyWith([['threadId', request.threadId], ['turnId', request.turnId]]), (value) => parseNullableThreadResponse(value, request.backend), request.signal);
  }

  public resumeThread(request: AgentThreadActionRequest): Promise<AgentResult<AgentThread | null>> { return this.threadAction(request, 'resume'); }
  public forkThread(request: AgentThreadActionRequest): Promise<AgentResult<AgentThread | null>> { return this.threadAction(request, 'fork'); }
  public archiveThread(request: AgentThreadActionRequest): Promise<AgentResult<AgentThread | null>> { return this.threadAction(request, 'archive'); }
  public unarchiveThread(request: AgentThreadActionRequest): Promise<AgentResult<AgentThread | null>> { return this.threadAction(request, 'unarchive'); }
  public deleteThread(request: AgentThreadActionRequest): Promise<AgentResult<AgentThread | null>> { return this.threadAction(request, 'delete'); }

  public setThreadName(request: AgentSetThreadNameRequest): Promise<AgentResult<AgentThread | null>> {
    return this.action(
      request.backend,
      'threads/name',
      { threadId: request.threadId, name: request.name },
      (value) => parseNullableThreadResponse(value, request.backend),
      request.signal,
    );
  }

  public startTurn(request: AgentStartTurnRequest, signal?: AbortSignal): Promise<AgentResult<AgentTurn>> {
    return this.action(request.config.backend, 'turns/start', bodyWith([
      ['threadId', request.threadId],
      ['model', request.modelId ?? request.config.modelId],
      ['input', serializeInput(request.input)],
      ['clientUserMessageId', request.clientUserMessageId],
    ]), (value) => parseTurnResponse(value, request.config.backend, request.threadId), signal);
  }

  public steerTurn(request: AgentSteerTurnRequest): Promise<AgentResult<AgentTurn>> {
    return this.action(request.backend, 'turns/steer', { threadId: request.threadId, turnId: request.turnId, input: serializeInput(request.input) ?? [] }, (value) => parseTurnResponse(value, request.backend, request.threadId), request.signal);
  }

  public interruptTurn(request: InterruptAgentTurnRequest): Promise<AgentResult<AgentTurn>> {
    return this.action(request.backend, 'turns/interrupt', { threadId: request.threadId, turnId: request.turnId }, (value) => {
      const root = asObject(value);
      if (root && Object.keys(root).length === 0) {
        return {
          ok: true,
          data: {
            id: request.turnId,
            threadId: request.threadId,
            backend: request.backend,
            status: 'interrupted',
          },
        };
      }
      return parseTurnResponse(value, request.backend, request.threadId);
    }, request.signal);
  }

  private respond(request: AgentResponseRequest, path: string): Promise<AgentResult<JsonValue>> {
    return this.action(request.backend, path, { id: request.requestId, result: request.result }, (value) => ({ ok: true, data: value }), request.signal);
  }

  public respondToApproval(request: AgentResponseRequest): Promise<AgentResult<JsonValue>> { return this.respond(request, 'approval/respond'); }
  public respondToUserInput(request: AgentResponseRequest): Promise<AgentResult<JsonValue>> { return this.respond(request, 'user-input/respond'); }

  public subscribeEvents(options: AgentEventStreamOptions): AgentEventStream {
    let closed = false;
    let source: AgentEventSource | null = null;
    const onAbort = (): void => close();
    const close = (): void => {
      if (closed) return;
      closed = true;
      source?.close();
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.signal?.aborted) {
      close();
      return { close };
    }
    const query: RuntimeUrlQuery = {
      backend: options.backend,
      directory: options.directory,
      ...(options.sessionId ? { sessionId: options.sessionId } : null),
    };
    const url = this.resolveUrl().sse('/api/agents/events', query);
    source = this.eventSourceFactory(url);
    source.onmessage = (message) => {
      if (closed) return;
      let payload: JsonCandidate;
      try { payload = JSON.parse(message.data); } catch {
        options.onError?.({ code: 'malformed', message: 'Agent event was not JSON' });
        return;
      }
      if (!isJsonValue(payload)) {
        options.onError?.({ code: 'malformed', message: 'Agent event was not valid JSON' });
        return;
      }
      const result = parseStreamEvent(payload, options.backend, options.directory);
      if (!result.ok) {
        if (result.error.code !== 'unsupported') options.onError?.(result.error);
        return;
      }
      options.onEvent(result.data);
    };
    source.onerror = () => {
      if (!closed) options.onError?.({ code: 'transport', message: 'Agent event stream failed' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return { close };
  }
}

export const createRuntimeAgentClient = (dependencies: AgentClientDependencies = {}): AgentClient => new RuntimeAgentClient(dependencies);
