import { describe, expect, test } from 'bun:test';
import type { RuntimeFetchOptions } from '../runtime-fetch';
import type { RuntimeUrlQuery, RuntimeUrlResolver } from '../runtime-url';
import { RuntimeAgentClient, type AgentClientDependencies, type AgentEventSource, type AgentFetch } from './client';
import type { AgentBackend } from './contracts';

const statusBody = (backend: AgentBackend) => JSON.stringify({
  result: 'ok',
  data: {
    backend,
    status: { state: 'ready', ready: true, version: '1.0.0' },
    availability: { supported: true, available: true },
  },
});

const makeResolver = (base: string): RuntimeUrlResolver => {
  const make = (path: string, query?: RuntimeUrlQuery): string => {
    const url = new URL(path, base);
    const entries = query instanceof URLSearchParams ? Array.from(query.entries()) : Object.entries(query ?? {});
    for (const [key, value] of entries) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  };
  return {
    api: (path, query) => make(path, query),
    authenticatedAsset: (path, query) => make(path, query),
    auth: (path, query) => make(path, query),
    health: (query) => make('/health', query),
    rawFile: (path) => make(path),
    sse: (path, query) => make(path, query),
    websocket: (path, query) => make(path, query),
  };
};

const makeDependencies = (
  fetcher: AgentFetch,
  resolveUrl?: AgentClientDependencies['resolveUrl'],
  eventSource?: AgentClientDependencies['eventSource'],
): AgentClientDependencies => ({ fetch: fetcher, resolveUrl, eventSource });

describe('RuntimeAgentClient', () => {
  test('returns a discriminated malformed result for invalid JSON contracts', async () => {
    const client = new RuntimeAgentClient(makeDependencies(async () => new Response(JSON.stringify({ status: 'available' }))));
    const result = await client.getStatus('opencode');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('malformed');
  });

  test('uses encoded path segments and runtime query values', async () => {
    const calls: Array<{ path: string; query: RuntimeUrlQuery | undefined; body: string | undefined }> = [];
    const client = new RuntimeAgentClient(makeDependencies(async (path: string, init?: RuntimeFetchOptions) => {
      calls.push({ path, query: init?.query, body: init?.body == null ? undefined : String(init.body) });
      return new Response(JSON.stringify({
        result: 'ok',
        data: {
          id: 'thread-1',
          cwd: '/work/project',
          name: 'Thread',
          status: { state: 'idle' },
          createdAt: 1,
        },
      }));
    }));

    await client.readThread({
      backend: 'codex',
      directory: '/work/space name/é',
      threadId: 'thread/id with space',
    });

    expect(calls[0]?.path).toBe('/api/agents/codex/threads/read');
    expect(calls[0]?.query).toBe(undefined);
    expect(calls[0]?.body).toBe(JSON.stringify({ threadId: 'thread/id with space' }));
  });

  test('unwraps model/thread data objects and serializes app-server turn input', async () => {
    const calls: Array<{ path: string; body: string | undefined; query: RuntimeUrlQuery | undefined }> = [];
    const client = new RuntimeAgentClient(makeDependencies(async (path: string, init?: RuntimeFetchOptions) => {
      calls.push({ path, body: init?.body == null ? undefined : String(init.body), query: init?.query });
      if (path.endsWith('/models')) {
        return new Response(JSON.stringify({ result: 'ok', data: { data: [{ id: 'model-1', displayName: 'Model 1' }], nextCursor: null } }));
      }
      return new Response(JSON.stringify({ result: 'ok', data: { id: 'turn-1', threadId: 'thread-1', status: { state: 'running' } } }));
    }));

    const models = await client.listModels('codex');
    const turn = await client.startTurn({
      config: { runtimeKey: 'runtime-1', directory: '/repo', backend: 'codex' },
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello' }],
      modelId: 'model-1',
      clientUserMessageId: 'codex:user-1',
    });

    expect(models.ok).toBe(true);
    if (models.ok) expect(models.data[0]?.id).toBe('model-1');
    expect(turn.ok).toBe(true);
    expect(calls[0]?.path).toBe('/api/agents/codex/models');
    expect(calls[1]?.path).toBe('/api/agents/codex/turns/start');
    expect(calls[1]?.body).toBe(JSON.stringify({
      threadId: 'thread-1',
      model: 'model-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      clientUserMessageId: 'codex:user-1',
    }));
  });

  test('hydrates a Codex thread snapshot with turns', async () => {
    let body: string | undefined;
    const client = new RuntimeAgentClient(makeDependencies(async (_path: string, init?: RuntimeFetchOptions) => {
      body = init?.body == null ? undefined : String(init.body);
      return new Response(JSON.stringify({ result: 'ok', data: { thread: {
        id: 'thread-1',
        cwd: '/repo',
        name: 'Thread',
        createdAt: 1,
        turns: [{ id: 'turn-1', items: [{ id: 'item-1', type: 'agentMessage', text: 'hello' }] }],
      } } }));
    }));

    const result = await client.readThreadSnapshot({ backend: 'codex', directory: '/repo', threadId: 'thread-1' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.messages[0]?.parts[0]?.type).toBe('text');
    expect(body).toBe(JSON.stringify({ threadId: 'thread-1', includeTurns: true }));
  });

  test('normalizes the empty app-server interrupt response', async () => {
    const client = new RuntimeAgentClient(makeDependencies(async () => (
      new Response(JSON.stringify({ result: 'ok', data: {} }))
    )));

    const result = await client.interruptTurn({
      backend: 'codex',
      directory: '/repo',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        id: 'turn-1',
        threadId: 'thread-1',
        backend: 'codex',
        status: 'interrupted',
      },
    });
  });

  test('resolves the SSE URL at each subscription instead of caching a base URL', () => {
    const urls: string[] = [];
    const sources: AgentEventSource[] = [];
    let base = 'https://runtime-one.example';
    const eventSource = (url: string): AgentEventSource => {
      const source: AgentEventSource = { onmessage: null, onerror: null, close: () => undefined };
      urls.push(url);
      sources.push(source);
      return source;
    };
    const client = new RuntimeAgentClient(makeDependencies(
      async () => new Response(statusBody('opencode')),
      () => makeResolver(base),
      eventSource,
    ));

    const first = client.subscribeEvents({ backend: 'opencode', directory: '/work/one', onEvent: () => undefined });
    base = 'https://runtime-two.example';
    const second = client.subscribeEvents({ backend: 'opencode', directory: '/work/one', onEvent: () => undefined });

    expect(urls[0]).toContain('runtime-one.example');
    expect(urls[0]).toContain('directory=%2Fwork%2Fone');
    expect(urls[1]).toContain('runtime-two.example');
    first.close();
    second.close();
    expect(sources).toHaveLength(2);
  });

  test('parses SSE events and closes on AbortSignal', () => {
    let source: AgentEventSource | undefined;
    const events: string[] = [];
    let closed = 0;
    const client = new RuntimeAgentClient(makeDependencies(
      async () => new Response(statusBody('codex')),
      () => makeResolver('https://runtime.example'),
      () => {
        const nextSource: AgentEventSource = {
          onmessage: null,
          onerror: null,
          close: () => {
            closed += 1;
          },
        };
        source = nextSource;
        return nextSource;
      },
    ));
    const controller = new AbortController();

    client.subscribeEvents({
      backend: 'codex',
      directory: '/work/project',
      signal: controller.signal,
      onEvent: (event) => events.push(event.event.type),
    });
    source?.onmessage?.({
      data: JSON.stringify({
        backend: 'codex',
        sequence: 1,
        type: 'item/agentMessage/delta',
        payload: { threadId: 'thread-1', itemId: 'item-1', delta: 'hello' },
      }),
    });
    controller.abort();

    expect(events).toEqual(['message.part.delta']);
    expect(closed).toBe(1);
  });
});
