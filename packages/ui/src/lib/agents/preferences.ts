import {
  DEFAULT_AGENT_BACKEND,
  type AgentBackend,
  type AgentBackendPreference,
  type AgentQueuedRequestInput,
  type AgentRequestConfig,
  type JsonObject,
  type JsonValue,
} from './contracts';

export interface AgentPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface AgentPreferenceStorageEvent {
  readonly key: string | null;
}

export interface AgentPreferenceEventTarget {
  addEventListener: (type: 'storage', listener: (event: AgentPreferenceStorageEvent) => void) => void;
  removeEventListener: (type: 'storage', listener: (event: AgentPreferenceStorageEvent) => void) => void;
}

export type AgentPreferenceListener = (directory: string) => void;

export interface AgentBackendPreferenceStore {
  get: (directory: string) => AgentBackend;
  set: (directory: string, backend: AgentBackend) => void;
  remove: (directory: string) => void;
  subscribe: (listener: AgentPreferenceListener) => () => void;
}

interface StoredPreference {
  readonly directory: string;
  readonly backend: AgentBackend;
}

interface StoredPreferences {
  readonly version: 1;
  readonly entries: readonly StoredPreference[];
}

const STORAGE_KEY = 'openchamber.agent-backend-preferences.v1';
const CODEX_USED_DIRECTORIES_KEY = 'openchamber.codex-used-directories.v1';
const MEMORY_STORAGE = new Map<string, string>();
const memoryStorage: AgentPreferenceStorage = {
  getItem: (key) => MEMORY_STORAGE.get(key) ?? null,
  setItem: (key, value) => { MEMORY_STORAGE.set(key, value); },
  removeItem: (key) => { MEMORY_STORAGE.delete(key); },
};

const getDefaultStorage = (): AgentPreferenceStorage => {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    return memoryStorage;
  }
  return memoryStorage;
};

const getDefaultEventTarget = (): AgentPreferenceEventTarget | undefined => {
  // SAFETY: the cast only widens `globalThis` with the two optional storage-event
  // members; the subsequent tag checks verify they are present before use.
  const candidate = globalThis as typeof globalThis & Partial<AgentPreferenceEventTarget>;
  return candidate.addEventListener instanceof Function && candidate.removeEventListener instanceof Function
    ? candidate
    : undefined;
};

const TAG_OBJECT = '[object Object]';
const TAG_STRING = '[object String]';

/** `Object.prototype.toString` tag of a JSON value — the primitive discriminator used by the readers here. */
const tagOf = (value: JsonValue): string => Object.prototype.toString.call(value);

const isJsonObject = (value: JsonValue): value is JsonObject => value !== null && !Array.isArray(value) && tagOf(value) === TAG_OBJECT;

const stringProperty = (value: JsonObject, key: string): string | null => {
  const property = value[key];
  // SAFETY: the tag check just above establishes `property` is a string primitive.
  return property !== undefined && property !== null && tagOf(property) === TAG_STRING ? property as string : null;
};

const normalizeDirectory = (directory: string): string => directory.trim();

const parseStoredPreferences = (value: JsonValue): StoredPreferences | null => {
  if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.entries)) return null;
  const entries: StoredPreference[] = [];
  for (const entry of value.entries) {
    if (!isJsonObject(entry)) continue;
    const directory = stringProperty(entry, 'directory');
    const backend = stringProperty(entry, 'backend');
    if (!directory || (backend !== 'opencode' && backend !== 'codex')) continue;
    entries.push({ directory, backend });
  }
  return { version: 1, entries };
};

const readStoredPreferences = (storage: AgentPreferenceStorage): StoredPreferences => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, entries: [] };
    const parsed: JsonValue = JSON.parse(raw);
    return parseStoredPreferences(parsed) ?? { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
};

const writeStoredPreferences = (storage: AgentPreferenceStorage, preferences: StoredPreferences): void => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preference persistence is best effort and never blocks an agent request.
  }
};

const preferenceMap = (preferences: StoredPreferences): Map<string, AgentBackend> => {
  return new Map(preferences.entries.map((entry) => [entry.directory, entry.backend]));
};

const changedDirectories = (before: StoredPreferences, after: StoredPreferences): readonly string[] => {
  const oldMap = preferenceMap(before);
  const newMap = preferenceMap(after);
  const directories = new Set([...oldMap.keys(), ...newMap.keys()]);
  return [...directories].filter((directory) => oldMap.get(directory) !== newMap.get(directory));
};

export const createAgentBackendPreferenceStore = (
  storage: AgentPreferenceStorage = getDefaultStorage(),
  eventTarget: AgentPreferenceEventTarget | undefined = getDefaultEventTarget(),
): AgentBackendPreferenceStore => {
  const listeners = new Set<AgentPreferenceListener>();
  let snapshot = readStoredPreferences(storage);

  const emit = (directories: readonly string[]): void => {
    for (const directory of directories) {
      for (const listener of listeners) listener(directory);
    }
  };

  const handleStorage = (event: AgentPreferenceStorageEvent): void => {
    if (event.key !== STORAGE_KEY) return;
    const next = readStoredPreferences(storage);
    const changed = changedDirectories(snapshot, next);
    snapshot = next;
    emit(changed);
  };

  eventTarget?.addEventListener('storage', handleStorage);

  const get = (directory: string): AgentBackend => {
    const normalizedDirectory = normalizeDirectory(directory);
    if (!normalizedDirectory) return DEFAULT_AGENT_BACKEND;
    const current = readStoredPreferences(storage);
    snapshot = current;
    return preferenceMap(current).get(normalizedDirectory) ?? DEFAULT_AGENT_BACKEND;
  };

  const set = (directory: string, backend: AgentBackend): void => {
    const normalizedDirectory = normalizeDirectory(directory);
    if (!normalizedDirectory) return;
    const before = readStoredPreferences(storage);
    const entries = before.entries.filter((entry) => entry.directory !== normalizedDirectory);
    entries.push({ directory: normalizedDirectory, backend });
    writeStoredPreferences(storage, { version: 1, entries });
    const after = readStoredPreferences(storage);
    snapshot = after;
    emit(changedDirectories(before, after));
  };

  const remove = (directory: string): void => {
    const normalizedDirectory = normalizeDirectory(directory);
    if (!normalizedDirectory) return;
    const before = readStoredPreferences(storage);
    const entries = before.entries.filter((entry) => entry.directory !== normalizedDirectory);
    if (entries.length === before.entries.length) return;
    writeStoredPreferences(storage, { version: 1, entries });
    const after = readStoredPreferences(storage);
    snapshot = after;
    emit(changedDirectories(before, after));
  };

  const subscribe = (listener: AgentPreferenceListener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { get, set, remove, subscribe };
};

export const agentBackendPreferenceStore = createAgentBackendPreferenceStore();
export const captureQueuedAgentRequestConfig = (
  input: AgentQueuedRequestInput,
  preferences: AgentBackendPreferenceStore = agentBackendPreferenceStore,
): AgentRequestConfig => {
  const backend: AgentBackendPreference = input.backend ?? preferences.get(input.directory);
  const config: AgentRequestConfig = {
    runtimeKey: input.runtimeKey,
    directory: input.directory,
    backend,
    ...(input.sessionId ? { sessionId: input.sessionId } : null),
    ...(input.modelId ? { modelId: input.modelId } : null),
  };
  return config;
};

export const getAgentBackendPreference = (directory: string, storage?: AgentPreferenceStorage): AgentBackend => {
  return storage ? createAgentBackendPreferenceStore(storage).get(directory) : agentBackendPreferenceStore.get(directory);
};

export const setAgentBackendPreference = (directory: string, backend: AgentBackend, storage?: AgentPreferenceStorage): void => {
  if (storage) createAgentBackendPreferenceStore(storage).set(directory, backend);
  else agentBackendPreferenceStore.set(directory, backend);
};

const readCodexUsedDirectories = (storage: AgentPreferenceStorage): string[] => {
  try {
    const parsed: JsonValue = JSON.parse(storage.getItem(CODEX_USED_DIRECTORIES_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => {
          // SAFETY: the tag check establishes `entry` is a string primitive.
          return entry !== null && tagOf(entry) === TAG_STRING && (entry as string).length > 0;
        })
      : [];
  } catch {
    return [];
  }
};

export const markCodexDirectoryUsed = (directory: string, storage: AgentPreferenceStorage = getDefaultStorage()): void => {
  const normalized = normalizeDirectory(directory);
  if (!normalized) return;
  const directories = new Set(readCodexUsedDirectories(storage));
  if (directories.has(normalized)) return;
  directories.add(normalized);
  try {
    storage.setItem(CODEX_USED_DIRECTORIES_KEY, JSON.stringify([...directories].slice(-200)));
  } catch {
    // Discovery remains best-effort; creating the thread already succeeded.
  }
};

export const hasCodexDirectoryBeenUsed = (
  directory: string,
  storage: AgentPreferenceStorage = getDefaultStorage(),
): boolean => readCodexUsedDirectories(storage).includes(normalizeDirectory(directory));
