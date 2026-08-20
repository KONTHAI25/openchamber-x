import type {
  Event,
  EventPermissionAsked,
  EventQuestionAsked,
  Message,
  Part,
  QuestionInfo,
  Session,
  SnapshotFileDiff,
} from '@opencode-ai/sdk/v2';
import {
  type AgentError,
  type AgentResult,
  type JsonObject,
  type JsonValue,
} from './contracts';

export interface CodexContentRecord {
  readonly type: string;
  readonly text?: string;
  readonly url?: string;
  readonly path?: string;
}

export interface CodexFileChangeRecord {
  readonly path: string;
  readonly kind?: string;
  readonly diff?: string;
}

export interface CodexItemRecord {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly summary?: string | readonly string[];
  readonly content?: readonly CodexContentRecord[];
  readonly command?: string;
  readonly cwd?: string;
  readonly status?: string;
  readonly aggregatedOutput?: string;
  readonly exitCode?: number;
  readonly changes?: readonly CodexFileChangeRecord[];
}

export interface CodexTurnRecord {
  readonly id: string;
  readonly status?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly items: readonly CodexItemRecord[];
}

export interface CodexThreadRecord {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly preview?: string;
  readonly projectId?: string;
  readonly modelProvider?: string;
  readonly model?: string;
  readonly cliVersion?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly status?: string;
  readonly archivedAt?: number;
  readonly forkedFromId?: string;
  readonly turns?: readonly CodexTurnRecord[];
}

export interface CodexThreadReadResult {
  readonly thread: CodexThreadRecord;
}

export interface OpenCodeMessageRecord {
  readonly info: Message;
  readonly parts: Part[];
}

export interface CodexThreadSnapshot {
  readonly session: Session;
  readonly messages: readonly OpenCodeMessageRecord[];
}

export interface CodexNotification {
  readonly method: string;
  readonly params?: JsonObject;
  readonly id?: string | number;
}

const CODEX_ID_PREFIX = 'codex:';
const CODEX_PROVIDER_ID = 'codex';
const CODEX_AGENT = 'codex';
const CODEX_VERSION = 'codex-app-server';

const errorResult = (code: AgentError['code'], message: string): AgentResult<never> => ({
  ok: false,
  error: { code, message },
});

const successResult = <T>(data: T): AgentResult<T> => ({ ok: true, data });

const isJsonObject = (value: JsonValue): value is JsonObject => {
  return value !== null && !Array.isArray(value) && tagOf(value) === TAG_OBJECT;
};

const isStringValue = (value: JsonValue | undefined): value is string => value !== undefined && tagOf(value) === TAG_STRING;
const isNumberValue = (value: JsonValue | undefined): value is number => value !== undefined && tagOf(value) === TAG_NUMBER;
const isSummaryString = (value: string | readonly string[] | undefined): value is string => {
  return value !== undefined && Object.prototype.toString.call(value) === TAG_STRING;
};

/** `Object.prototype.toString` tag of a JSON value — the primitive discriminator used by all readers here. */
const tagOf = (value: JsonValue): string => Object.prototype.toString.call(value);

const TAG_STRING = '[object String]';
const TAG_NUMBER = '[object Number]';
const TAG_OBJECT = '[object Object]';

const getString = (value: JsonObject, key: string): string | undefined => {
  const property = value[key];
  return isStringValue(property) && property.length > 0 ? property : undefined;
};

const getNumber = (value: JsonObject, key: string): number | undefined => {
  const property = value[key];
  return isNumberValue(property) && Number.isFinite(property) ? property : undefined;
};

const getObject = (value: JsonObject, key: string): JsonObject | undefined => {
  const property = value[key];
  return isJsonObject(property) ? property : undefined;
};

const getArray = (value: JsonObject, key: string): readonly JsonValue[] | undefined => {
  const property = value[key];
  return Array.isArray(property) ? property : undefined;
};

const summaryText = (summary: string | readonly string[] | undefined): string | undefined => {
  if (isSummaryString(summary)) return summary;
  return summary?.join('\n');
};

const toMilliseconds = (timestamp: number | undefined): number => {
  if (timestamp === undefined) return 0;
  return Math.abs(timestamp) < 10_000_000_000 ? timestamp * 1000 : timestamp;
};

export const isCodexSessionId = (value: string): boolean => value.startsWith(CODEX_ID_PREFIX);

export const encodeCodexSessionId = (threadId: string): string => {
  return isCodexSessionId(threadId) ? threadId : `${CODEX_ID_PREFIX}${threadId}`;
};

export const decodeCodexSessionId = (sessionId: string): string | null => {
  return isCodexSessionId(sessionId) ? sessionId.slice(CODEX_ID_PREFIX.length) : null;
};

const encodeCodexReferenceId = (referenceId: string): string => {
  return isCodexSessionId(referenceId) ? referenceId : `${CODEX_ID_PREFIX}${referenceId}`;
};

export const decodeCodexReferenceId = (referenceId: string): string | null => {
  return isCodexSessionId(referenceId) ? referenceId.slice(CODEX_ID_PREFIX.length) : null;
};

/**
 * Encode a segment of a synthetic composite id so that raw values containing
 * ':' cannot collide with the ':' used to join segments (see
 * `createAgentSessionKey` in `contracts.ts`, which uses the same encoding).
 */
const encodeIdSegment = (value: string): string => encodeURIComponent(value);

/**
 * Join notification-derived segments into one composite id. Each segment is
 * encoded with {@link encodeIdSegment} before the ':' join so a raw value
 * containing ':' (e.g. a thread id like `a:b`) cannot be parsed as two
 * segments of a different composite id.
 */
const joinIdSegments = (segments: readonly string[]): string => segments.map(encodeIdSegment).join(':');

const getSessionId = (value: JsonObject): string | undefined => {
  return getString(value, 'threadId') ?? getString(value, 'sessionId');
};

const parseContentRecord = (value: JsonValue): CodexContentRecord | null => {
  if (!isJsonObject(value)) return null;
  const type = getString(value, 'type');
  if (!type) return null;
  const text = getString(value, 'text');
  const url = getString(value, 'url');
  const path = getString(value, 'path');
  if (type === 'text' && !text) return null;
  if ((type === 'image' || type === 'localImage') && !url && !path) return null;
  const record: CodexContentRecord = {
    type,
    ...(text ? { text } : null),
    ...(url ? { url } : null),
    ...(path ? { path } : null),
  };
  return record;
};

const parseFileChangeRecord = (value: JsonValue): CodexFileChangeRecord | null => {
  if (!isJsonObject(value)) return null;
  const path = getString(value, 'path');
  if (!path) return null;
  const kind = getString(value, 'kind');
  const diff = getString(value, 'diff');
  const record: CodexFileChangeRecord = {
    path,
    ...(kind ? { kind } : null),
    ...(diff ? { diff } : null),
  };
  return record;
};

const parseItemRecord = (value: JsonValue): CodexItemRecord | null => {
  if (!isJsonObject(value)) return null;
  const id = getString(value, 'id');
  const type = getString(value, 'type');
  if (!id || !type) return null;
  const content = getArray(value, 'content')
    ?.map(parseContentRecord)
    .filter((item): item is CodexContentRecord => item !== null);
  const changes = getArray(value, 'changes')
    ?.map(parseFileChangeRecord)
    .filter((item): item is CodexFileChangeRecord => item !== null);
  const rawContent = getArray(value, 'content');
  const rawChanges = getArray(value, 'changes');
  if (rawContent && content && content.length !== rawContent.length) return null;
  if (rawChanges && changes && changes.length !== rawChanges.length) return null;
  const text = getString(value, 'text');
  const summary = getString(value, 'summary');
  const summaryList = Array.isArray(value.summary)
    ? value.summary.filter((item): item is string => isStringValue(item))
    : undefined;
  const command = getString(value, 'command');
  const cwd = getString(value, 'cwd');
  const status = getString(value, 'status');
  const aggregatedOutput = getString(value, 'aggregatedOutput');
  const exitCode = getNumber(value, 'exitCode');
  const record: CodexItemRecord = {
    id,
    type,
    ...(text ? { text } : null),
    ...(summary ? { summary } : summaryList ? { summary: summaryList } : null),
    ...(content && content.length > 0 ? { content } : null),
    ...(command ? { command } : null),
    ...(cwd ? { cwd } : null),
    ...(status ? { status } : null),
    ...(aggregatedOutput ? { aggregatedOutput } : null),
    ...(exitCode !== undefined ? { exitCode } : null),
    ...(changes && changes.length > 0 ? { changes } : null),
  };
  return record;
};

const parseTurnRecord = (value: JsonValue): CodexTurnRecord | null => {
  if (!isJsonObject(value)) return null;
  const id = getString(value, 'id');
  const rawItems = getArray(value, 'items');
  if (!id || !rawItems) return null;
  const parsedItems = rawItems
    .map(parseItemRecord)
  if (parsedItems.some((item) => item === null)) return null;
  const items = parsedItems.filter((item): item is CodexItemRecord => item !== null);
  const status = getString(value, 'status');
  const startedAt = getNumber(value, 'startedAt');
  const completedAt = getNumber(value, 'completedAt');
  const record: CodexTurnRecord = {
    id,
    items,
    ...(status ? { status } : null),
    ...(startedAt !== undefined ? { startedAt } : null),
    ...(completedAt !== undefined ? { completedAt } : null),
  };
  return record;
};

export const parseCodexThread = (value: JsonValue): AgentResult<CodexThreadRecord> => {
  if (!isJsonObject(value)) return errorResult('malformed', 'Codex thread must be an object');
  const id = getString(value, 'id');
  const cwd = getString(value, 'cwd');
  if (!id || !cwd) return errorResult('malformed', 'Codex thread is missing id or cwd');
  const rawTurns = getArray(value, 'turns');
  const parsedTurns = rawTurns
    ?.map(parseTurnRecord)
  if (parsedTurns?.some((turn) => turn === null)) return errorResult('malformed', 'Codex thread contains an invalid turn');
  const turns = parsedTurns?.filter((turn): turn is CodexTurnRecord => turn !== null);
  const name = getString(value, 'name');
  const preview = getString(value, 'preview');
  const projectId = getString(value, 'projectId');
  const modelProvider = getString(value, 'modelProvider');
  const model = getString(value, 'model');
  const cliVersion = getString(value, 'cliVersion');
  const createdAt = getNumber(value, 'createdAt');
  const updatedAt = getNumber(value, 'updatedAt');
  const status = getString(value, 'status');
  const archivedAt = getNumber(value, 'archivedAt');
  const forkedFromId = getString(value, 'forkedFromId');
  const thread: CodexThreadRecord = {
    id,
    cwd,
    ...(name ? { name } : null),
    ...(preview ? { preview } : null),
    ...(projectId ? { projectId } : null),
    ...(modelProvider ? { modelProvider } : null),
    ...(model ? { model } : null),
    ...(cliVersion ? { cliVersion } : null),
    ...(createdAt !== undefined ? { createdAt } : null),
    ...(updatedAt !== undefined ? { updatedAt } : null),
    ...(status ? { status } : null),
    ...(archivedAt !== undefined ? { archivedAt } : null),
    ...(forkedFromId ? { forkedFromId } : null),
    ...(turns ? { turns } : null),
  };
  return successResult(thread);
};

const getThreadsFromResult = (value: JsonValue): readonly JsonValue[] | null => {
  if (Array.isArray(value)) return value;
  if (!isJsonObject(value)) return null;
  const directThreads = getArray(value, 'threads');
  if (directThreads) return directThreads;
  const data = getObject(value, 'data');
  return data ? getArray(data, 'threads') ?? null : null;
};

export const parseCodexThreadList = (value: JsonValue): AgentResult<readonly CodexThreadRecord[]> => {
  const rawThreads = getThreadsFromResult(value);
  if (!rawThreads) return errorResult('malformed', 'Codex thread list must contain threads');
  const threads: CodexThreadRecord[] = [];
  for (const rawThread of rawThreads) {
    const parsed = parseCodexThread(rawThread);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    threads.push(parsed.data);
  }
  return successResult(threads);
};

export const parseCodexThreadRead = (value: JsonValue): AgentResult<CodexThreadReadResult> => {
  if (!isJsonObject(value)) return errorResult('malformed', 'Codex thread read must be an object');
  const directThread = getObject(value, 'thread');
  const data = getObject(value, 'data');
  const dataThread = data ? getObject(data, 'thread') : undefined;
  const parsed = parseCodexThread(directThread ?? dataThread ?? value);
  return 'error' in parsed ? { ok: false, error: parsed.error } : successResult({ thread: parsed.data });
};

const sessionStatus = (thread: CodexThreadRecord): string => thread.status ?? 'idle';

const makeSession = (thread: CodexThreadRecord): Session => {
  const id = encodeCodexSessionId(thread.id);
  const archived = thread.archivedAt ?? (sessionStatus(thread) === 'archived' ? toMilliseconds(thread.updatedAt) : undefined);
  const modelID = thread.model ?? CODEX_PROVIDER_ID;
  const time: Session['time'] = {
    created: toMilliseconds(thread.createdAt),
    updated: toMilliseconds(thread.updatedAt ?? thread.createdAt),
    ...(archived !== undefined ? { archived: toMilliseconds(archived) } : null),
  };
  return {
    id,
    slug: id,
    projectID: thread.projectId ?? `${CODEX_ID_PREFIX}${encodeIdSegment(thread.cwd)}`,
    directory: thread.cwd,
    parentID: thread.forkedFromId ? encodeCodexSessionId(thread.forkedFromId) : undefined,
    title: thread.name ?? thread.preview ?? 'Codex thread',
    version: thread.cliVersion ?? CODEX_VERSION,
    agent: CODEX_AGENT,
    model: { id: modelID, providerID: thread.modelProvider ?? CODEX_PROVIDER_ID },
    metadata: {
      openchamberBackend: CODEX_PROVIDER_ID,
      codexThreadId: thread.id,
    },
    time,
  };
};

const modelForThread = (thread: CodexThreadRecord) => ({
  providerID: thread.modelProvider ?? CODEX_PROVIDER_ID,
  modelID: thread.model ?? CODEX_PROVIDER_ID,
});

const createUserMessage = (thread: CodexThreadRecord, turn: CodexTurnRecord, item: CodexItemRecord): Message => ({
  id: encodeCodexReferenceId(item.id),
  sessionID: encodeCodexSessionId(thread.id),
  role: 'user',
  time: { created: toMilliseconds(turn.startedAt) },
  agent: CODEX_AGENT,
  model: modelForThread(thread),
});

const createAssistantMessage = (
  thread: CodexThreadRecord,
  turn: CodexTurnRecord,
  item: CodexItemRecord,
): Message => {
  const time: Message['time'] = {
    created: toMilliseconds(turn.startedAt),
    ...(turn.completedAt !== undefined ? { completed: toMilliseconds(turn.completedAt) } : null),
  };
  const message: Message = {
    id: encodeCodexReferenceId(item.id),
    sessionID: encodeCodexSessionId(thread.id),
    role: 'assistant',
    time,
    parentID: encodeCodexReferenceId(turn.id),
    modelID: thread.model ?? CODEX_PROVIDER_ID,
    providerID: thread.modelProvider ?? CODEX_PROVIDER_ID,
    mode: CODEX_AGENT,
    agent: CODEX_AGENT,
    path: { cwd: thread.cwd, root: thread.cwd },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(turn.status === 'failed' ? { error: { name: 'UnknownError', data: { message: 'Codex turn failed' } } } : null),
  };
  return message;
};

const basePart = (thread: CodexThreadRecord, item: CodexItemRecord, messageId: string) => ({
  id: encodeCodexReferenceId(item.id),
  sessionID: encodeCodexSessionId(thread.id),
  messageID: messageId,
});

const textPart = (thread: CodexThreadRecord, item: CodexItemRecord, messageId: string, text: string, synthetic = false): Part => ({
  ...basePart(thread, item, messageId),
  type: 'text',
  text,
  ...(synthetic ? { synthetic: true } : null),
});

const reasoningPart = (thread: CodexThreadRecord, item: CodexItemRecord, messageId: string, text: string): Part => ({
  ...basePart(thread, item, messageId),
  type: 'reasoning',
  text,
  time: { start: 0 },
});

const toolPart = (thread: CodexThreadRecord, item: CodexItemRecord, messageId: string): Part => {
  const input = item.command ? { command: item.command, cwd: item.cwd ?? thread.cwd } : {};
  const output = item.aggregatedOutput ?? '';
  const completed = item.status === 'completed';
  const failed = item.status === 'failed' || item.status === 'declined';
  const state: Extract<Part, { type: 'tool' }>['state'] = completed
    ? { status: 'completed', input, output, title: item.command ?? 'Command', metadata: {}, time: { start: 0, end: 0 } }
    : failed
      ? { status: 'error', input, error: output || 'Command was declined', time: { start: 0, end: 0 } }
      : { status: 'running', input, time: { start: 0 } };
  return { ...basePart(thread, item, messageId), type: 'tool', callID: encodeCodexReferenceId(item.id), tool: 'command', state };
};

const patchPart = (thread: CodexThreadRecord, item: CodexItemRecord, messageId: string): Part => ({
  ...basePart(thread, item, messageId),
  type: 'patch',
  hash: encodeCodexReferenceId(item.id),
  files: item.changes?.map((change) => change.path) ?? [],
});

const itemRecord = (
  thread: CodexThreadRecord,
  turn: CodexTurnRecord,
  item: CodexItemRecord,
): OpenCodeMessageRecord | null => {
  if (item.type === 'userMessage') {
    const info = createUserMessage(thread, turn, item);
    const parts = item.content
      ?.filter((content) => content.type === 'text' && Boolean(content.text))
      .map((content) => textPart(thread, item, info.id, content.text ?? '')) ?? [];
    return { info, parts };
  }

  const info = createAssistantMessage(thread, turn, item);
  if (item.type === 'agentMessage' && item.text) return { info, parts: [textPart(thread, item, info.id, item.text)] };
  if (item.type === 'plan' && item.text) return { info, parts: [textPart(thread, item, info.id, item.text, true)] };
  if (item.type === 'reasoning') {
    const text = summaryText(item.summary);
    if (text) return { info, parts: [reasoningPart(thread, item, info.id, text)] };
  }
  if (item.type === 'commandExecution') return { info, parts: [toolPart(thread, item, info.id)] };
  if (item.type === 'fileChange') return { info, parts: [patchPart(thread, item, info.id)] };
  return null;
};

export const mapCodexThread = (thread: CodexThreadRecord): Session => makeSession(thread);

export const mapCodexThreadRead = (result: CodexThreadReadResult): CodexThreadSnapshot => {
  const messages: OpenCodeMessageRecord[] = [];
  for (const turn of [...(result.thread.turns ?? [])].sort((left, right) => {
    return (left.startedAt ?? 0) - (right.startedAt ?? 0);
  })) {
    for (const item of turn.items) {
      const record = itemRecord(result.thread, turn, item);
      if (record) messages.push(record);
    }
  }
  messages.sort((left, right) => left.info.time.created - right.info.time.created);
  return { session: makeSession(result.thread), messages };
};

const eventId = (notification: CodexNotification, ...segments: readonly string[]): string => {
  const idSegments = notification.id === undefined ? segments : [String(notification.id)];
  return encodeCodexReferenceId(joinIdSegments([notification.method, ...idSegments]));
};

const sessionReference = (threadId: string, params: JsonObject): Session => makeSession({
  id: threadId,
  cwd: getString(params, 'cwd') ?? '',
  name: getString(params, 'name'),
  projectId: getString(params, 'projectId'),
  modelProvider: getString(params, 'modelProvider'),
  model: getString(params, 'model'),
  updatedAt: getNumber(params, 'updatedAt'),
  status: getString(params, 'status'),
});

const getItem = (params: JsonObject): JsonObject | undefined => getObject(params, 'item');

const getItemId = (params: JsonObject, item?: JsonObject): string | undefined => {
  return getString(params, 'itemId') ?? (item ? getString(item, 'id') : undefined);
};

const getAssistantMessageId = (params: JsonObject, itemId: string): string => {
  return encodeCodexReferenceId(getString(params, 'assistantMessageId') ?? itemId);
};

const makeAssistantMessageFromItem = (params: JsonObject, item: JsonObject): Message | null => {
  const threadId = getSessionId(params);
  const itemId = getString(item, 'id');
  if (!threadId || !itemId) return null;
  const messageId = getAssistantMessageId(params, itemId);
  const thread = sessionReference(threadId, params);
  const info: Message = {
    id: messageId,
    sessionID: encodeCodexSessionId(threadId),
    role: 'assistant',
    time: { created: toMilliseconds(getNumber(params, 'timestamp')) },
    parentID: encodeCodexReferenceId(getString(params, 'turnId') ?? itemId),
    modelID: thread.model?.id ?? CODEX_PROVIDER_ID,
    providerID: thread.model?.providerID ?? CODEX_PROVIDER_ID,
    mode: CODEX_AGENT,
    agent: CODEX_AGENT,
    path: { cwd: thread.directory, root: thread.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return info;
};

const makePartFromItem = (params: JsonObject, item: JsonObject): Part | null => {
  const threadId = getSessionId(params);
  const itemId = getString(item, 'id');
  if (!threadId || !itemId) return null;
  const thread = sessionReference(threadId, params);
  const messageId = getAssistantMessageId(params, itemId);
  const typedItem = parseItemRecord(item);
  if (!typedItem) return null;
  if (typedItem.type === 'agentMessage' || typedItem.type === 'plan') {
    return textPart(threadRecordFromSession(thread), typedItem, messageId, typedItem.text ?? '', typedItem.type === 'plan');
  }
  if (typedItem.type === 'reasoning') {
    const text = summaryText(typedItem.summary) ?? '';
    return reasoningPart(threadRecordFromSession(thread), typedItem, messageId, text);
  }
  if (typedItem.type === 'commandExecution') return toolPart(threadRecordFromSession(thread), typedItem, messageId);
  if (typedItem.type === 'fileChange') return patchPart(threadRecordFromSession(thread), typedItem, messageId);
  return null;
};

const threadRecordFromSession = (session: Session): CodexThreadRecord => ({
  id: decodeCodexSessionId(session.id) ?? session.id,
  cwd: session.directory,
  model: session.model?.id,
  modelProvider: session.model?.providerID,
});

const deltaEvent = (
  notification: CodexNotification,
  field: string,
  delta: string,
): Event | null => {
  const sessionId = getSessionId(notification.params ?? {});
  const itemId = getItemId(notification.params ?? {});
  if (!sessionId || !itemId || !delta) return null;
  const messageID = getAssistantMessageId(notification.params ?? {}, itemId);
  return {
    id: eventId(notification, sessionId, itemId, field, delta),
    type: 'message.part.delta',
    properties: {
      sessionID: encodeCodexSessionId(sessionId),
      messageID,
      partID: encodeCodexReferenceId(itemId),
      field,
      delta,
    },
  };
};

const snapshotDiffs = (item: JsonObject): SnapshotFileDiff[] => {
  const rawChanges = getArray(item, 'changes') ?? [];
  const diffs: SnapshotFileDiff[] = [];
  for (const rawChange of rawChanges) {
    if (!isJsonObject(rawChange)) continue;
    const file = getString(rawChange, 'path');
    if (!file) continue;
    const kind = getString(rawChange, 'kind');
    const status = kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : kind === 'modify' ? 'modified' : undefined;
    const patch = getString(rawChange, 'diff');
    const diff: SnapshotFileDiff = {
      file,
      additions: 0,
      deletions: 0,
      ...(status ? { status } : null),
      ...(patch ? { patch } : null),
    };
    diffs.push(diff);
  }
  return diffs;
};

const mapItemLifecycle = (notification: CodexNotification): Event | null => {
  const params = notification.params ?? {};
  const item = getItem(params);
  const sessionId = getSessionId(params);
  if (!item || !sessionId) return null;
  const itemId = getItemId(params, item);
  if (!itemId) return null;
  const type = getString(item, 'type');
  if (type === 'userMessage') {
    const info = parseItemRecord(item);
    if (!info) return null;
    const thread = sessionReference(sessionId, params);
    const message = createUserMessage(threadRecordFromSession(thread), {
      id: getString(params, 'turnId') ?? itemId,
      items: [],
      startedAt: getNumber(params, 'timestamp'),
    }, info);
    return {
      id: eventId(notification, sessionId, itemId),
      type: 'message.updated',
      properties: { sessionID: encodeCodexSessionId(sessionId), info: message },
    };
  }
  const info = makeAssistantMessageFromItem(params, item);
  if (!info) return null;
  const part = makePartFromItem(params, item);
  if (!part) {
    return {
      id: eventId(notification, sessionId, itemId),
      type: 'message.updated',
      properties: { sessionID: encodeCodexSessionId(sessionId), info },
    };
  }
  return {
    id: eventId(notification, sessionId, itemId),
    type: 'message.part.updated',
    properties: {
      sessionID: encodeCodexSessionId(sessionId),
      part,
      time: toMilliseconds(getNumber(params, 'timestamp')),
    },
  };
};

const mapPermissionRequest = (notification: CodexNotification): Event | null => {
  const params = notification.params ?? {};
  const sessionId = getSessionId(params);
  if (!sessionId) return null;
  const requestId = getString(params, 'approvalId') ?? (notification.id === undefined ? undefined : String(notification.id));
  if (!requestId) return null;
  const method = notification.method;
  const item = getItem(params);
  const permission = method.includes('fileChange') ? 'edit' : 'command';
  const patterns: string[] = [];
  const command = getString(params, 'command') ?? (item ? getString(item, 'command') : undefined);
  if (command) patterns.push(command);
  const cwd = getString(params, 'cwd');
  if (cwd) patterns.push(cwd);
  if (item) {
    for (const diff of snapshotDiffs(item)) {
      if (diff.file) patterns.push(diff.file);
    }
  }
  const properties: EventPermissionAsked['properties'] = {
    id: encodeCodexReferenceId(requestId),
    sessionID: encodeCodexSessionId(sessionId),
    permission,
    patterns,
    metadata: { backend: CODEX_PROVIDER_ID },
    always: [],
  };
  const reason = getString(params, 'reason');
  if (reason) properties.metadata.reason = reason;
  if (item) {
    properties.tool = {
      messageID: getAssistantMessageId(params, getItemId(params, item) ?? requestId),
      callID: encodeCodexReferenceId(getItemId(params, item) ?? requestId),
    };
  }
  return {
    id: eventId(notification, sessionId, requestId),
    type: 'permission.asked',
    properties,
  };
};

const mapQuestionRequest = (notification: CodexNotification): Event | null => {
  const params = notification.params ?? {};
  const sessionId = getSessionId(params);
  const rawQuestions = getArray(params, 'questions');
  if (!sessionId || !rawQuestions || rawQuestions.length === 0) return null;
  type CodexQuestionInfo = QuestionInfo & { readonly id?: string };
  const questions = rawQuestions.flatMap((rawQuestion): CodexQuestionInfo[] => {
    if (!isJsonObject(rawQuestion)) return [];
    const question = getString(rawQuestion, 'question');
    const header = getString(rawQuestion, 'header') ?? 'Question';
    const rawOptions = getArray(rawQuestion, 'options') ?? [];
    if (!question) return [];
    const options = rawOptions.flatMap((rawOption) => {
      if (!isJsonObject(rawOption)) return [];
      const label = getString(rawOption, 'label');
      if (!label) return [];
      return [{ label, description: getString(rawOption, 'description') ?? '' }];
    });
    const id = getString(rawQuestion, 'id');
    const custom = getString(rawQuestion, 'isOther') === 'true';
    const questionInfo: CodexQuestionInfo = {
      question,
      header,
      options,
      ...(id ? { id } : null),
      ...(custom ? { custom: true } : null),
    };
    return [questionInfo];
  });
  if (questions.length === 0) return null;
  const requestId = notification.id === undefined ? getString(params, 'requestId') : String(notification.id);
  if (!requestId) return null;
  const itemId = getString(params, 'itemId');
  const properties: EventQuestionAsked['properties'] = {
    id: encodeCodexReferenceId(requestId),
    sessionID: encodeCodexSessionId(sessionId),
    questions,
  };
  if (itemId) {
    properties.tool = {
      messageID: getAssistantMessageId(params, itemId),
      callID: encodeCodexReferenceId(itemId),
    };
  }
  return {
    id: eventId(notification, sessionId, requestId),
    type: 'question.asked',
    properties,
  };
};

export const mapCodexNotification = (notification: CodexNotification): Event | null => {
  const params = notification.params ?? {};
  const sessionId = getSessionId(params);

  if (notification.method === 'thread/started') {
    const threadValue = getObject(params, 'thread');
    if (!threadValue) return null;
    const parsed = parseCodexThread(threadValue);
    if (!parsed.ok) return null;
    const session = makeSession(parsed.data);
    return {
      id: eventId(notification, parsed.data.id),
      type: 'session.created',
      properties: { sessionID: session.id, info: session },
    };
  }

  if (notification.method === 'thread/archived' || notification.method === 'thread/unarchived' || notification.method === 'thread/name/updated') {
    if (!sessionId) return null;
    const info = sessionReference(sessionId, params);
    const archived = notification.method === 'thread/archived';
    const session: Session = {
      ...info,
      title: getString(params, 'threadName') ?? getString(params, 'name') ?? info.title,
      time: {
        ...info.time,
        ...(archived
          ? { archived: toMilliseconds(getNumber(params, 'archivedAt') ?? getNumber(params, 'timestamp')) || Date.now() }
          : { archived: 0 }),
      },
    };
    return {
      id: eventId(notification, sessionId),
      type: 'session.updated',
      properties: { sessionID: session.id, info: session },
    };
  }

  if (notification.method === 'thread/closed' || notification.method === 'thread/deleted') {
    if (!sessionId) return null;
    return {
      id: eventId(notification, sessionId),
      type: 'session.deleted',
      properties: { sessionID: encodeCodexSessionId(sessionId), info: sessionReference(sessionId, params) },
    };
  }

  if (notification.method === 'turn/started') {
    if (!sessionId) return null;
    return {
      id: eventId(notification, sessionId),
      type: 'session.status',
      properties: { sessionID: encodeCodexSessionId(sessionId), status: { type: 'busy' } },
    };
  }

  if (notification.method === 'turn/completed') {
    if (!sessionId) return null;
    const turn = getObject(params, 'turn');
    const status = turn ? getString(turn, 'status') : getString(params, 'status');
    if (status === 'failed') {
      const error = turn ? getObject(turn, 'error') : getObject(params, 'error');
      const message = error ? getString(error, 'message') : undefined;
      return {
        id: eventId(notification, sessionId),
        type: 'session.error',
        properties: {
          sessionID: encodeCodexSessionId(sessionId),
          error: { name: 'UnknownError', data: { message: message ?? 'Codex turn failed' } },
        },
      };
    }
    if (status === 'completed' || status === 'interrupted') {
      return {
        id: eventId(notification, sessionId),
        type: 'session.idle',
        properties: { sessionID: encodeCodexSessionId(sessionId) },
      };
    }
    return null;
  }

  if (notification.method === 'error') {
    if (!sessionId) return null;
    const error = getObject(params, 'error');
    return {
      id: eventId(notification, sessionId),
      type: 'session.error',
      properties: {
        sessionID: encodeCodexSessionId(sessionId),
        error: { name: 'UnknownError', data: { message: error ? getString(error, 'message') ?? 'Codex error' : 'Codex error' } },
      },
    };
  }

  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    return mapItemLifecycle(notification);
  }

  if (notification.method === 'item/agentMessage/delta') return deltaEvent(notification, 'text', getString(params, 'delta') ?? '');
  if (notification.method === 'item/plan/delta') return deltaEvent(notification, 'text', getString(params, 'delta') ?? '');
  if (notification.method === 'item/reasoning/summaryTextDelta' || notification.method === 'item/reasoning/textDelta') {
    return deltaEvent(notification, 'text', getString(params, 'delta') ?? '');
  }
  if (notification.method === 'item/commandExecution/outputDelta') {
    return deltaEvent(notification, 'output', getString(params, 'delta') ?? '');
  }
  if (notification.method === 'item/fileChange/outputDelta') {
    return deltaEvent(notification, 'output', getString(params, 'delta') ?? '');
  }

  if (notification.method === 'item/fileChange/patchUpdated') {
    if (!sessionId) return null;
    const item = getItem(params);
    if (!item) return null;
    return {
      id: eventId(notification, sessionId),
      type: 'session.diff',
      properties: { sessionID: encodeCodexSessionId(sessionId), diff: snapshotDiffs(item) },
    };
  }

  if (notification.method === 'item/commandExecution/requestApproval' || notification.method === 'item/fileChange/requestApproval') {
    return mapPermissionRequest(notification);
  }

  if (notification.method === 'item/tool/requestUserInput') return mapQuestionRequest(notification);

  return null;
};
