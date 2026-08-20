import { EventEmitter } from 'node:events';
import { describe, expect, it, mock } from 'bun:test';
import { createCodexAppServerRuntime } from './runtime.js';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for fake child state');
};

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.destroyed = false;
  child.stdin.write = function write(value) {
    this.writes.push(String(value));
    return true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = mock((signal = 'SIGTERM') => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  return child;
};

const createDependencies = (children, options = {}) => ({
  execFile: (_file, _args, _execOptions, callback) => callback(null, 'codex-cli 0.148.0\n', ''),
  spawnProcess: mock(() => {
    const child = createFakeChild();
    children.push(child);
    return child;
  }),
  restartBaseDelayMs: 10,
  restartMaxDelayMs: 20,
  gracefulStopTimeoutMs: 50,
  ...options,
});

const respondToInitialize = async (child, result = { protocolVersion: 2 }) => {
  if (Array.isArray(child)) {
    await waitFor(() => child.length > 0);
    child = child[child.length - 1];
  }
  await waitFor(() => child.stdin.writes.length > 0);
  const request = JSON.parse(child.stdin.writes[0]);
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  await flush();
  return request;
};

describe('createCodexAppServerRuntime', () => {
  it('checks executable availability with a sanitized result without starting a child', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children));

    await expect(runtime.checkAvailability()).resolves.toEqual({
      supported: true,
      available: true,
      version: '0.148.0',
      minimumVersion: '0.148.0',
      reason: null,
    });
    expect(children).toHaveLength(0);
    expect(runtime.getStatus().state).toBe('idle');
  });

  it('sanitizes availability failures', async () => {
    const runtime = createCodexAppServerRuntime({
      execFile: (_file, _args, _execOptions, callback) => {
        const error = new Error('token=private-value');
        error.code = 'ENOENT';
        callback(error);
      },
      spawnProcess: mock(),
    });

    await expect(runtime.checkAvailability()).resolves.toEqual({
      supported: true,
      available: false,
      version: null,
      minimumVersion: '0.148.0',
      reason: {
        code: 'CODEX_EXECUTABLE_NOT_FOUND',
        message: 'Codex executable was not found',
      },
    });
  });

  it('marks a detected version below the baseline as unsupported', async () => {
    const runtime = createCodexAppServerRuntime({
      execFile: (_file, _args, _execOptions, callback) => callback(null, 'codex-cli 0.147.9\n', ''),
      spawnProcess: mock(),
    });

    await expect(runtime.checkAvailability()).resolves.toEqual({
      supported: false,
      available: false,
      version: null,
      minimumVersion: '0.148.0',
      reason: {
        code: 'CODEX_VERSION_UNSUPPORTED',
        message: 'Codex executable is below the supported version',
      },
    });
  });

  it('short-circuits availability once ready and keeps the last successful version', async () => {
    const children = [];
    let versionCalls = 0;
    const runtime = createCodexAppServerRuntime(createDependencies(children, {
      execFile: (_file, _args, _execOptions, callback) => {
        versionCalls += 1;
        callback(null, 'codex-cli 0.148.0\n', '');
      },
    }));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    expect(runtime.getStatus().state).toBe('ready');

    const startedCalls = versionCalls;
    await expect(runtime.checkAvailability()).resolves.toEqual({
      supported: true,
      available: true,
      version: '0.148.0',
      minimumVersion: '0.148.0',
      reason: null,
    });
    expect(versionCalls).toBe(startedCalls);
    expect(runtime.getStatus().version).toBe('0.148.0');
  });

  it('does not overwrite the detected version with a failed probe', async () => {
    const children = [];
    let shouldFail = false;
    const runtime = createCodexAppServerRuntime(createDependencies(children, {
      execFile: (_file, _args, _execOptions, callback) => {
        if (shouldFail) {
          const error = new Error('probe failed');
          error.code = 'ENOENT';
          callback(error);
          return;
        }
        callback(null, 'codex-cli 0.148.0\n', '');
      },
    }));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    expect(runtime.getStatus().version).toBe('0.148.0');
    await runtime.stop();

    shouldFail = true;
    await expect(runtime.checkAvailability()).resolves.toEqual({
      supported: true,
      available: false,
      version: null,
      minimumVersion: '0.148.0',
      reason: {
        code: 'CODEX_EXECUTABLE_NOT_FOUND',
        message: 'Codex executable was not found',
      },
    });
    expect(runtime.getStatus().version).toBe('0.148.0');
  });

  it('performs the experimental initialize handshake and tracks monotonic request ids', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children));
    const startPromise = runtime.start();
    const initialize = await respondToInitialize(children);
    await expect(startPromise).resolves.toEqual({ protocolVersion: 2 });

    expect(initialize).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
    expect(JSON.parse(children[0].stdin.writes[1])).toEqual({ method: 'initialized' });

    const requestPromise = runtime.request('thread/list', { limit: 1 });
    await waitFor(() => children[0].stdin.writes.length === 3);
    const request = JSON.parse(children[0].stdin.writes[2]);
    expect(request.id).toBe(2);
    children[0].stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { data: [] } })}\n`);
    await expect(requestPromise).resolves.toEqual({ data: [] });
    expect(runtime.getPendingRequestCount()).toBe(0);
  });

  it('responds to server requests and publishes notifications without logging payloads', async () => {
    const children = [];
    const serverRequest = mock(async ({ method, params }) => ({ method, accepted: params?.approval === true }));
    const notification = mock();
    const runtime = createCodexAppServerRuntime({
      ...createDependencies(children),
      onServerRequest: serverRequest,
    });
    runtime.subscribe(notification);
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;

    children[0].stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { approval: true, secret: 'must remain in the protocol only' },
    })}\n`);
    children[0].stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { status: 'completed' },
    })}\n`);
    await flush();

    expect(serverRequest).toHaveBeenCalledWith({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { approval: true, secret: 'must remain in the protocol only' },
    });
    expect(notification).toHaveBeenCalledWith({
      method: 'turn/completed',
      params: { status: 'completed' },
    });
    expect(JSON.parse(children[0].stdin.writes[2])).toEqual({
      id: 'approval-1',
      result: { method: 'item/commandExecution/requestApproval', accepted: true },
    });
    expect(runtime.getPendingServerRequestCount()).toBe(0);
  });

  it('retains unhandled server requests and responds exactly once', async () => {
    const children = [];
    const notification = mock();
    const runtime = createCodexAppServerRuntime(createDependencies(children));
    runtime.subscribe(notification);
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;

    children[0].stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'item/commandExecution/requestApproval',
      params: { decision: 'accept' },
    })}\n`);
    await flush();

    expect(notification).toHaveBeenCalledWith({
      type: 'server_request',
      payload: {
        id: 'request-1',
        method: 'item/commandExecution/requestApproval',
        params: { decision: 'accept' },
      },
    });
    expect(runtime.getPendingServerRequestCount()).toBe(1);
    expect(runtime.respond('request-1', { decision: 'accept' })).toEqual({
      id: 'request-1',
      result: { decision: 'accept' },
    });
    expect(runtime.respond('request-1', { decision: 'reject' })).toEqual({
      id: 'request-1',
      responded: false,
    });
    expect(runtime.getPendingServerRequestCount()).toBe(0);
    expect(JSON.parse(children[0].stdin.writes.at(-1))).toEqual({
      id: 'request-1',
      result: { decision: 'accept' },
    });
  });

  it('bounds unhandled server requests and returns a fixed overflow error', async () => {
    const children = [];
    const notification = mock();
    const runtime = createCodexAppServerRuntime({
      ...createDependencies(children),
      maxPendingServerRequests: 1,
    });
    runtime.subscribe(notification);
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;

    for (const id of ['request-1', 'request-2']) {
      children[0].stdout.emit('data', `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'item/commandExecution/requestApproval',
        params: { id },
      })}\n`);
    }
    await flush();

    expect(runtime.getPendingServerRequestCount()).toBe(1);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(children[0].stdin.writes.at(-1))).toEqual({
      id: 'request-2',
      error: { code: -32001, message: 'Too many pending server requests' },
    });
  });

  it('rejects pending requests on process exit and exposes only sanitized status', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children, { maxRestartAttempts: 0 }));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    const pending = runtime.request('thread/read', { prompt: 'private content' });
    await waitFor(() => children[0].stdin.writes.length === 3);
    children[0].stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'pending-server-request',
      method: 'item/commandExecution/requestApproval',
      params: { decision: 'accept' },
    })}\n`);
    await flush();
    expect(runtime.getPendingServerRequestCount()).toBe(1);
    children[0].emit('close', 17, null);

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_PROCESS_EXITED',
      exitCode: 17,
    });
    expect(runtime.getStatus()).toEqual({
      state: 'failed',
      ready: false,
      running: false,
      version: '0.148.0',
      restartAttempts: 0,
      totalRestartCount: 0,
      maxRestartAttempts: 0,
      lastError: {
        code: 'CODEX_RESTART_LIMIT',
        message: 'Codex app-server restart limit reached',
      },
    });
    expect(runtime.getPendingServerRequestCount()).toBe(0);
    expect(runtime.respond('pending-server-request', { decision: 'accept' })).toEqual({
      id: 'pending-server-request',
      responded: false,
    });
  });

  it('settles pending requests when the input stream errors without the process exiting', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children, { maxRestartAttempts: 0 }));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    const pending = runtime.request('thread/read', { prompt: 'private content' });
    await waitFor(() => children[0].stdin.writes.length === 3);

    children[0].stdin.emit('error', new Error('stdin broke'));

    await expect(pending).rejects.toMatchObject({
      code: 'CODEX_PROCESS_EXITED',
    });
    expect(runtime.getStatus().state).toBe('failed');
    expect(runtime.getPendingRequestCount()).toBe(0);
  });

  it('uses bounded exponential restart backoff', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children, {
      maxRestartAttempts: 2,
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 15,
    }));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    children[0].emit('close', 1, null);
    expect(runtime.getStatus().restartAttempts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitFor(() => children.length === 2);
    expect(children).toHaveLength(2);
    await respondToInitialize(children[1]);
    children[1].emit('close', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await waitFor(() => children.length === 3);
    expect(children).toHaveLength(3);
    await respondToInitialize(children[2]);
    children[2].emit('close', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(children).toHaveLength(3);
    expect(runtime.getStatus().lastError).toMatchObject({ code: 'CODEX_RESTART_LIMIT' });
  });

  it('stops gracefully, rejects work, and cancels pending restart', async () => {
    const children = [];
    const runtime = createCodexAppServerRuntime(createDependencies(children));
    const startPromise = runtime.start();
    await respondToInitialize(children);
    await startPromise;
    const pending = runtime.request('thread/read');
    await waitFor(() => children[0].stdin.writes.length === 3);
    children[0].stdout.emit('data', `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'stopped-server-request',
      method: 'item/commandExecution/requestApproval',
    })}\n`);
    await flush();
    expect(runtime.getPendingServerRequestCount()).toBe(1);
    await runtime.stop();
    await expect(pending).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_STOPPED' });
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(runtime.getStatus().state).toBe('stopped');
    expect(runtime.getPendingServerRequestCount()).toBe(0);
    expect(runtime.respond('stopped-server-request', {})).toEqual({
      id: 'stopped-server-request',
      responded: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(1);
  });
});
