import { describe, expect, test } from 'bun:test';
import {
  createAgentBackendPreferenceStore,
  captureQueuedAgentRequestConfig,
  type AgentPreferenceStorage,
  type AgentPreferenceEventTarget,
} from './preferences';
import { createAgentSessionKey, decodeAgentSessionKey } from './contracts';

const makeStorage = (): AgentPreferenceStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

const makeEventTarget = (): AgentPreferenceEventTarget & { fire: () => void } => {
  const listeners = new Set<(event: { readonly key: string | null }) => void>();
  return {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    fire: () => { for (const listener of listeners) listener({ key: 'openchamber.agent-backend-preferences.v1' }); },
  };
};

describe('agent backend preferences and identities', () => {
  test('uses OpenCode as the project-directory default and persists overrides', () => {
    const storage = makeStorage();
    const first = createAgentBackendPreferenceStore(storage);
    expect(first.get('/work/project')).toBe('opencode');
    first.set('/work/project', 'codex');

    const second = createAgentBackendPreferenceStore(storage);
    expect(second.get('/work/project')).toBe('codex');
    second.remove('/work/project');
    expect(second.get('/work/project')).toBe('opencode');
  });

  test('captures backend in queued request configuration', () => {
    const storage = makeStorage();
    const preferences = createAgentBackendPreferenceStore(storage);
    preferences.set('/work/project', 'codex');

    const queued = captureQueuedAgentRequestConfig({
      runtimeKey: 'runtime-a',
      directory: '/work/project',
      sessionId: 'session-1',
    }, preferences);
    preferences.set('/work/project', 'opencode');

    expect(queued).toEqual({
      runtimeKey: 'runtime-a',
      directory: '/work/project',
      backend: 'codex',
      sessionId: 'session-1',
    });
  });

  test('keys identities by runtime, directory, backend, and session', () => {
    const key = createAgentSessionKey({
      runtimeKey: 'runtime:a',
      directory: '/work/project:one',
      backend: 'codex',
      sessionId: 'session/one',
    });
    expect(decodeAgentSessionKey(key)).toEqual({
      runtimeKey: 'runtime:a',
      directory: '/work/project:one',
      backend: 'codex',
      sessionId: 'session/one',
    });
    expect(decodeAgentSessionKey(createAgentSessionKey({
      runtimeKey: 'runtime:b',
      directory: '/work/project:one',
      backend: 'codex',
      sessionId: 'session/one',
    }))).not.toBe(key);
  });

  test('notifies normalized directories and observes storage changes', () => {
    const storage = makeStorage();
    const eventTarget = makeEventTarget();
    const store = createAgentBackendPreferenceStore(storage, eventTarget);
    const changed: string[] = [];
    const unsubscribe = store.subscribe((directory) => changed.push(directory));

    store.set('  /work/project  ', 'codex');
    store.set('/work/project', 'codex');
    expect(changed).toEqual(['/work/project']);

    storage.setItem('openchamber.agent-backend-preferences.v1', JSON.stringify({
      version: 1,
      entries: [{ directory: '/work/other', backend: 'codex' }],
    }));
    eventTarget.fire();
    expect(changed).toEqual(['/work/project', '/work/project', '/work/other']);

    store.remove(' /work/other ');
    expect(changed).toEqual(['/work/project', '/work/project', '/work/other', '/work/other']);
    unsubscribe();
  });
});
