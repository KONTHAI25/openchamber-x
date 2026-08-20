import type { Event } from '@opencode-ai/sdk/v2';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type AgentBackend = 'opencode' | 'codex';
export const DEFAULT_AGENT_BACKEND: AgentBackend = 'opencode';

export type AgentBackendStatusKind = 'available' | 'unavailable' | 'starting' | 'error';

export interface AgentCapabilities {
  readonly canListThreads: boolean;
  readonly canReadThread: boolean;
  readonly canStartTurn: boolean;
  readonly canInterruptTurn: boolean;
  readonly canAnswerApprovals: boolean;
  readonly canAnswerUserInput: boolean;
  readonly supportsAccount: boolean;
  readonly supportsModels: boolean;
  readonly supportsEvents: boolean;
}

export interface AgentBackendStatus {
  readonly backend: AgentBackend;
  readonly status: AgentBackendStatusKind;
  readonly message?: string;
  readonly version?: string;
  readonly capabilities: AgentCapabilities;
}

export interface AgentAccount {
  readonly backend: AgentBackend;
  readonly authenticated: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly email?: string;
  readonly plan?: string;
}

export interface AgentModel {
  readonly id: string;
  readonly name: string;
  readonly backend: AgentBackend;
  readonly provider?: string;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
}

export type AgentThreadStatus = 'idle' | 'running' | 'waiting' | 'error' | 'archived' | 'closed';

export interface AgentThread {
  readonly id: string;
  readonly backend: AgentBackend;
  readonly directory: string;
  readonly title: string;
  readonly status: AgentThreadStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt?: number;
}

export interface AgentThreadRequest {
  readonly backend: AgentBackend;
  readonly directory: string;
  readonly archived?: boolean;
  readonly signal?: AbortSignal;
}

export interface AgentStartThreadRequest extends AgentThreadRequest {
  readonly modelId?: string;
  readonly input?: readonly AgentInput[];
}

export interface AgentThreadActionRequest extends AgentThreadRequest {
  readonly threadId: string;
  readonly turnId?: string;
}

export interface AgentSetThreadNameRequest extends AgentThreadActionRequest {
  readonly name: string;
}

export type AgentTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface AgentTurn {
  readonly id: string;
  readonly threadId: string;
  readonly backend: AgentBackend;
  readonly status: AgentTurnStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface AgentTurnRequest extends AgentThreadRequest {
  readonly threadId: string;
  readonly input: readonly AgentInput[];
  readonly modelId?: string;
}

export interface AgentSteerTurnRequest extends AgentThreadRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: readonly AgentInput[];
}

export interface AgentInterruptTurnRequest extends AgentThreadRequest {
  readonly threadId: string;
  readonly turnId: string;
}

export interface AgentResponseRequest {
  readonly backend: AgentBackend;
  readonly directory?: string;
  readonly requestId: string;
  readonly result: JsonObject;
  readonly signal?: AbortSignal;
}

export interface AgentDeviceLoginRequest extends AgentRequestConfig {
  readonly signal?: AbortSignal;
}

export interface AgentTextInput {
  readonly type: 'text';
  readonly text: string;
}

export interface AgentImageInput {
  readonly type: 'image' | 'localImage';
  readonly url?: string;
  readonly path?: string;
}

export type AgentInput = AgentTextInput | AgentImageInput;

export interface AgentSessionIdentity {
  readonly runtimeKey: string;
  readonly directory: string;
  readonly backend: AgentBackend;
  readonly sessionId: string;
}

export type AgentSessionKey = string & { readonly __agentSessionKey: unique symbol };

const AGENT_SESSION_KEY_PREFIX = 'agent-session:v1:';

const encodeKeySegment = (value: string): string => encodeURIComponent(value);

const decodeKeySegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const createAgentSessionKey = (identity: AgentSessionIdentity): AgentSessionKey => {
  const segments = [identity.runtimeKey, identity.directory, identity.backend, identity.sessionId]
    .map(encodeKeySegment)
    .join(':');
  // SAFETY: the value is constructed only from the four encoded identity segments above.
  return `${AGENT_SESSION_KEY_PREFIX}${segments}` as AgentSessionKey;
};

export const decodeAgentSessionKey = (key: AgentSessionKey | string): AgentSessionIdentity | null => {
  if (!key.startsWith(AGENT_SESSION_KEY_PREFIX)) return null;
  const encodedSegments = key.slice(AGENT_SESSION_KEY_PREFIX.length).split(':');
  if (encodedSegments.length !== 4) return null;
  const segments = encodedSegments.map(decodeKeySegment);
  if (segments.some((segment) => segment === null)) return null;
  const [runtimeKey, directory, backend, sessionId] = segments;
  if (!runtimeKey || !directory || !sessionId || (backend !== 'opencode' && backend !== 'codex')) return null;
  return { runtimeKey, directory, backend, sessionId };
};

export interface AgentRequestConfig {
  readonly runtimeKey: string;
  readonly directory: string;
  readonly backend: AgentBackend;
  readonly sessionId?: string;
  readonly modelId?: string;
}

export interface AgentStartTurnRequest {
  readonly config: AgentRequestConfig;
  readonly threadId: string;
  readonly input: readonly AgentInput[];
  readonly modelId?: string;
  readonly clientUserMessageId?: string;
}

export type AgentErrorCode = 'aborted' | 'backend' | 'http' | 'malformed' | 'transport' | 'unavailable' | 'unsupported';

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly status?: number;
}

export type AgentResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: AgentError };

export interface AgentEvent {
  readonly backend: AgentBackend;
  readonly directory: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly event: Event;
}

export interface AgentEventStreamOptions {
  readonly backend: AgentBackend;
  readonly directory: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onError?: (error: AgentError) => void;
}

export interface AgentEventStream {
  readonly close: () => void;
}

export interface AgentQueuedRequestInput {
  readonly runtimeKey: string;
  readonly directory: string;
  readonly backend?: AgentBackend;
  readonly sessionId?: string;
  readonly modelId?: string;
}

export type AgentBackendPreference = AgentBackend;
