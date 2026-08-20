import { describe, expect, it, vi } from 'vitest';

import { registerAgentBackendRoutes } from './routes.js';

const createJsonResponse = () => {
  const response = {
    body: undefined,
    headers: new Map(),
    statusCode: 200,
    setHeader(name, value) {
      response.headers.set(name.toLowerCase(), value);
    },
    status(code) {
      response.statusCode = code;
      return response;
    },
    json(payload) {
      response.body = payload;
      return response;
    },
  };
  return response;
};

const createRequest = (app, method, path) => {
  const state = {
    body: undefined,
    headers: {},
    method,
    path,
    query: undefined,
  };
  const builder = {
    query(values) {
      state.query = values;
      return builder;
    },
    send(value) {
      state.body = value;
      if (!state.headers['Content-Type']) {
        state.headers['Content-Type'] = 'application/json';
      }
      return builder;
    },
    set(name, value) {
      state.headers[name] = value;
      return builder;
    },
    async expect(expectedStatus) {
      const handler = app.getRoute(state.method, state.path);
      expect(handler).toBeTypeOf('function');
      const req = {
        body: state.body,
        headers: state.headers,
        on() {},
        params: {},
        query: state.query ?? {},
      };
      const response = createJsonResponse();
      await handler(req, response);
      expect(response.statusCode).toBe(expectedStatus);
      return { body: response.body, status: response.statusCode };
    },
  };
  return builder;
};

const request = (app) => ({
  delete: (path) => createRequest(app, 'DELETE', path),
  get: (path) => createRequest(app, 'GET', path),
  post: (path) => createRequest(app, 'POST', path),
});

const createRuntime = (overrides = {}) => {
  let listener = null;
  let statusListener = null;
  const runtime = {
    start: vi.fn(async () => {}),
    request: vi.fn(async (method, params) => ({ method, params })),
    respond: vi.fn(async (id, result) => ({ id, result })),
    subscribe: vi.fn((next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    subscribeStatus: vi.fn((next) => {
      statusListener = next;
      next({ state: 'idle', version: null });
      return () => {
        statusListener = null;
      };
    }),
    getStatus: vi.fn(async () => ({ state: 'ready' })),
    checkAvailability: vi.fn(async () => ({ supported: true, available: true })),
    ...overrides,
  };
  return {
    runtime,
    emit(notification) {
      listener?.(notification);
    },
    emitStatus(status) {
      statusListener?.(status);
    },
  };
};

const createApp = (runtime, options = {}) => {
  const routeRegistry = createRouteRegistry();
  const registration = registerAgentBackendRoutes(routeRegistry.app, {
    codexRuntime: runtime,
    ...options,
  });
  return { app: routeRegistry, registration, routeRegistry };
};

const createRouteRegistry = () => {
  const routes = new Map();
  const middleware = [];
  const register = (method) => (path, handler) => {
    routes.set(`${method} ${path}`, handler);
  };
  return {
    app: {
      use(...handlers) {
        middleware.push(handlers.at(-1));
      },
      get: register('GET'),
      post: register('POST'),
      delete: register('DELETE'),
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
    getMiddleware(index) {
      return middleware[index];
    },
  };
};

const createEventRequest = () => {
  const listeners = new Map();
  return {
    on(event, handler) {
      listeners.set(event, handler);
    },
    emit(event) {
      listeners.get(event)?.();
    },
  };
};

const createEventResponse = () => {
  const listeners = new Map();
  return {
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    flush() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
    emit(event) {
      listeners.get(event)?.();
    },
  };
};

describe('registerAgentBackendRoutes', () => {
  it('starts once and maps action routes to the Codex runtime', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    const modelResponse = await request(app)
      .get('/api/agents/codex/models')
      .query({ directory: '/repo' })
      .expect(200);
    expect(modelResponse.body).toEqual({
      result: 'ok',
      data: { method: 'model/list', params: { directory: '/repo' } },
    });

    const turnResponse = await request(app)
      .post('/api/agents/codex/turns/start')
      .send({ threadId: 'thread_1', model: 'gpt-5.6-luna', effort: 'xhigh' })
      .expect(200);
    expect(turnResponse.body.data).toEqual({
      method: 'turn/start',
      params: { threadId: 'thread_1', model: 'gpt-5.6-luna', effort: 'xhigh' },
    });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.request).toHaveBeenNthCalledWith(1, 'model/list', { directory: '/repo' });
    expect(runtime.request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread_1',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    });
  });

  it('returns stable status and availability unions', async () => {
    const unavailable = createRuntime({
      checkAvailability: vi.fn(async () => ({ supported: true, available: false })),
    });
    const { app } = createApp(unavailable.runtime);

    const status = await request(app).get('/api/agents/status').expect(200);
    expect(status.body).toEqual({
      result: 'ok',
      data: {
        backend: 'codex',
        status: { state: 'ready' },
        availability: { supported: true, available: false },
      },
    });

    const models = await request(app).get('/api/agents/codex/models').expect(503);
    expect(models.body).toEqual({
      result: 'unavailable',
      error: { code: 'unavailable', message: 'Codex is unavailable' },
    });
  });

  it('maps the thread list directory compatibility query to cwd only', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    await request(app)
      .get('/api/agents/codex/threads')
      .query({ directory: '/repo', cursor: 'next', limit: '10' })
      .expect(200);

    expect(runtime.request).toHaveBeenCalledWith('thread/list', {
      cwd: '/repo',
      cursor: 'next',
      limit: 10,
    });
    expect(runtime.request.mock.calls[0][1].directory).toBeUndefined();
  });

  it('prefers cwd when both thread list query names are provided', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    await request(app)
      .get('/api/agents/codex/threads')
      .query({ cwd: '/authoritative', directory: '/compatibility' })
      .expect(200);

    expect(runtime.request).toHaveBeenCalledWith('thread/list', { cwd: '/authoritative' });
  });

  it('rejects unknown thread list query keys instead of forwarding them', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    const response = await request(app)
      .get('/api/agents/codex/threads')
      .query({ cursor: 'next', page: '2' })
      .expect(400);

    expect(response.body).toEqual({
      result: 'error',
      error: { code: 'invalid_params', message: 'page is not a supported query parameter' },
    });
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it('does not re-probe availability once the runtime is ready with a known version', async () => {
    const { runtime } = createRuntime({
      getStatus: vi.fn(async () => ({ state: 'ready', version: '0.148.0' })),
    });
    const { app } = createApp(runtime);

    await request(app).get('/api/agents/codex/models').expect(200);
    await request(app).get('/api/agents/codex/models').expect(200);

    expect(runtime.checkAvailability).toHaveBeenCalledTimes(0);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('treats an undelivered response as an error instead of ok', async () => {
    const { runtime } = createRuntime({
      respond: vi.fn(async (id, result) => ({ id, responded: false })),
    });
    const { app } = createApp(runtime);

    const response = await request(app)
      .post('/api/agents/codex/approval/respond')
      .send({ id: 'approval_1', result: { decision: 'accept' } })
      .expect(500);

    expect(response.body).toEqual({
      result: 'error',
      error: { code: 'codex_response_not_delivered', message: 'Codex response was not delivered' },
    });
  });

  it('maps thread names without treating display text as an identifier', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    await request(app)
      .post('/api/agents/codex/threads/name')
      .send({ threadId: 'thread_1', name: 'Fix the mobile composer' })
      .expect(200);

    expect(runtime.request).toHaveBeenCalledWith('thread/name/set', {
      threadId: 'thread_1',
      name: 'Fix the mobile composer',
    });
  });

  it('rejects invalid network parameters before touching the runtime', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    const response = await request(app)
      .post('/api/agents/codex/threads/read')
      .send({ threadId: '../outside' })
      .expect(400);

    expect(response.body).toEqual({
      result: 'error',
      error: { code: 'invalid_params', message: 'threadId must be a non-empty identifier' },
    });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it('returns the same result union for malformed JSON bodies', async () => {
    const { runtime } = createRuntime();
    const { routeRegistry } = createApp(runtime);
    const response = createJsonResponse();
    await routeRegistry.getMiddleware(1)(
      { type: 'entity.parse.failed' },
      {},
      response,
      vi.fn(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      result: 'error',
      error: { code: 'invalid_params', message: 'Request body must be valid JSON' },
    });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('uses respond for approval and user-input replies after validating result objects', async () => {
    const { runtime } = createRuntime();
    const { app } = createApp(runtime);

    await request(app)
      .post('/api/agents/codex/approval/respond')
      .send({ id: 'approval_1', result: { decision: 'accept' } })
      .expect(200);
    await request(app)
      .post('/api/agents/codex/user-input/respond')
      .send({ requestId: 'question_1', result: { answers: ['yes'] } })
      .expect(200);

    expect(runtime.respond).toHaveBeenNthCalledWith(1, 'approval_1', { decision: 'accept' });
    expect(runtime.respond).toHaveBeenNthCalledWith(2, 'question_1', { answers: ['yes'] });

    const invalid = await request(app)
      .post('/api/agents/codex/user-input/respond')
      .send({ requestId: 'question_1', result: 'yes' })
      .expect(400);
    expect(invalid.body.result).toBe('error');
    expect(runtime.respond).toHaveBeenCalledTimes(2);
  });

  it('subscribes once, normalizes notifications, and removes disconnected SSE clients', async () => {
    const { runtime, emit } = createRuntime();
    const writes = [];
    const routeRegistry = createRouteRegistry();
    const registration = registerAgentBackendRoutes(routeRegistry.app, {
      codexRuntime: runtime,
      writeSseEvent: (_res, payload) => writes.push(payload),
    });

    expect(runtime.subscribe).toHaveBeenCalledTimes(1);

    const req = createEventRequest();
    const res = createEventResponse();
    await routeRegistry.getRoute('GET', '/api/agents/events')(req, res);
    emit({ method: 'thread/updated', params: { threadId: 'thread_1' } });

    expect(writes).toEqual([{
      backend: 'codex',
      sequence: 1,
      type: 'thread/updated',
      payload: { threadId: 'thread_1' },
    }]);
    expect(registration.getConnectedClientCount()).toBe(1);

    req.emit('close');
    expect(registration.getConnectedClientCount()).toBe(0);
    emit({ type: 'ignored', payload: ['not', 'an', 'object'] });
    expect(writes).toHaveLength(1);
  });

  it('maps runtime unsupported errors without leaking the raw exception', async () => {
    const error = Object.assign(new Error('private upstream detail'), { code: 'unsupported' });
    const { runtime } = createRuntime({
      request: vi.fn(async () => { throw error; }),
    });
    const { app } = createApp(runtime);

    const response = await request(app).get('/api/agents/codex/account').expect(501);
    expect(response.body).toEqual({
      result: 'unsupported',
      error: { code: 'unsupported', message: 'Codex does not support this operation' },
    });
  });

  it('writes a final backend_status frame when the runtime fails or stops', async () => {
    const { runtime, emit, emitStatus } = createRuntime();
    const writes = [];
    const routeRegistry = createRouteRegistry();
    const registration = registerAgentBackendRoutes(routeRegistry.app, {
      codexRuntime: runtime,
      writeSseEvent: (_res, payload) => writes.push(payload),
    });

    const req = createEventRequest();
    const res = createEventResponse();
    await routeRegistry.getRoute('GET', '/api/agents/events')(req, res);
    emit({ method: 'thread/updated', params: { threadId: 'thread_1' } });
    expect(writes).toHaveLength(1);

    emitStatus({ state: 'failed', version: '0.148.0' });

    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      backend: 'codex',
      sequence: 2,
      type: 'backend_status',
      payload: { state: 'failed' },
    });
    expect(registration.getConnectedClientCount()).toBe(0);

    emitStatus({ state: 'ready', version: '0.148.0' });
    expect(writes).toHaveLength(2);
  });

  it('reports an unavailable envelope when status is failed and availability is false', async () => {
    const { runtime } = createRuntime({
      checkAvailability: vi.fn(async () => ({ supported: true, available: false })),
      getStatus: vi.fn(async () => ({ state: 'failed', version: null })),
    });
    const { app } = createApp(runtime);

    const response = await request(app).get('/api/agents/status').expect(503);

    expect(response.body.result).toBe('unavailable');
    expect(response.body.error.code).toBe('unavailable');
    expect(response.body.error.backend).toBe('codex');
    expect(response.body.error.status).toEqual({ state: 'failed', version: null });
    expect(response.body.error.availability).toEqual({ supported: true, available: false });
  });
});
