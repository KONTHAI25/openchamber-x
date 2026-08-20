import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import {
  encodeJsonRpcError,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeJsonRpcResult,
  createJsonlDecoder,
} from './jsonl.js';
import {
  CODEX_ERROR_CODES,
  CodexAppServerError,
  CodexAppServerProcessExitError,
  CodexAppServerRpcError,
} from './errors.js';
import {
  detectCodexExecutable,
  MIN_CODEX_APP_SERVER_VERSION,
} from './version.js';

export const CODEX_APP_SERVER_COMMAND = Object.freeze(['app-server', '--listen', 'stdio://']);
export const CODEX_SERVER_REQUEST_EVENT = 'server_request';
export const CODEX_APP_SERVER_STATES = Object.freeze([
  'idle',
  'starting',
  'ready',
  'restarting',
  'stopping',
  'stopped',
  'failed',
]);

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: 'openchamber',
  title: 'OpenChamber',
  version: '0.0.0',
});
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_RESTART_MAX_DELAY_MS = 5000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 2000;
const DEFAULT_MAX_PENDING_SERVER_REQUESTS = 64;
const SERVER_REQUEST_QUEUE_FULL_ERROR_CODE = -32001;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]';
// Decode a value that must be a non-empty method name; the decoder upstream
// already validates the wire shape, so this branch is only reached with parsed
// JSON. Anything else is rejected here rather than narrowed at use sites.
const readMethodName = (value) => {
  const method = value.method;
  if (Object.prototype.toString.call(method) !== '[object String]' || method.length === 0) return { ok: false };
  return { ok: true, method };
};

const statusMessageFor = (error) => {
  switch (error?.code) {
    case CODEX_ERROR_CODES.EXECUTABLE_NOT_FOUND:
      return 'Codex executable was not found';
    case CODEX_ERROR_CODES.VERSION_UNAVAILABLE:
      return 'Codex executable version could not be detected';
    case CODEX_ERROR_CODES.VERSION_UNSUPPORTED:
      return 'Codex executable is below the supported version';
    case CODEX_ERROR_CODES.PROCESS_START_FAILED:
      return 'Codex app-server process could not be started';
    case CODEX_ERROR_CODES.PROCESS_EXITED:
      return 'Codex app-server process exited';
    case CODEX_ERROR_CODES.PROCESS_ERROR:
      return 'Codex app-server process reported an error';
    case CODEX_ERROR_CODES.PROTOCOL_ERROR:
      return 'Codex app-server protocol error';
    case CODEX_ERROR_CODES.RPC_ERROR:
      return 'Codex app-server RPC request failed';
    case CODEX_ERROR_CODES.RESTART_LIMIT:
      return 'Codex app-server restart limit reached';
    case CODEX_ERROR_CODES.STOPPED:
      return 'Codex app-server is stopped';
    default:
      return 'Codex app-server runtime error';
  }
};

const statusErrorFor = (error) => {
  const candidateCode = error instanceof Error && Object.prototype.toString.call(error.code) === '[object String]'
    ? error.code
    : null;
  const code = Object.values(CODEX_ERROR_CODES).includes(candidateCode)
    ? candidateCode
    : CODEX_ERROR_CODES.PROCESS_ERROR;
  const result = { code, message: statusMessageFor(error) };
  if (error instanceof CodexAppServerRpcError && Number.isFinite(error.rpcCode)) {
    result.rpcCode = error.rpcCode;
  }
  if (error instanceof CodexAppServerProcessExitError) {
    result.exitCode = error.exitCode;
    result.signal = error.signal;
  }
  return result;
};

const normalizeOptions = (options) => {
  const maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
  const restartBaseDelayMs = options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
  const restartMaxDelayMs = options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
  const gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS;
  const maxPendingServerRequests = options.maxPendingServerRequests ?? DEFAULT_MAX_PENDING_SERVER_REQUESTS;
  if (!isPositiveInteger(maxRestartAttempts) && maxRestartAttempts !== 0) {
    throw new TypeError('maxRestartAttempts must be a non-negative integer');
  }
  if (!Number.isInteger(restartBaseDelayMs) || restartBaseDelayMs < 0) {
    throw new TypeError('restartBaseDelayMs must be a non-negative integer');
  }
  if (!Number.isInteger(restartMaxDelayMs) || restartMaxDelayMs < 0) {
    throw new TypeError('restartMaxDelayMs must be a non-negative integer');
  }
  if (!isPositiveInteger(gracefulStopTimeoutMs)) {
    throw new TypeError('gracefulStopTimeoutMs must be a positive integer');
  }
  if (!isPositiveInteger(maxPendingServerRequests)) {
    throw new TypeError('maxPendingServerRequests must be a positive integer');
  }
  return {
    maxRestartAttempts,
    restartBaseDelayMs,
    restartMaxDelayMs: Math.max(restartBaseDelayMs, restartMaxDelayMs),
    gracefulStopTimeoutMs,
    maxPendingServerRequests,
  };
};

export const createCodexAppServerRuntime = (options = {}) => {
  if (!isObject(options)) throw new TypeError('Codex runtime options must be an object');

  const {
    executable = 'codex',
    minimumVersion = MIN_CODEX_APP_SERVER_VERSION,
    clientInfo = DEFAULT_CLIENT_INFO,
    cwd: configuredCwd,
    env: configuredEnv,
    spawnProcess = nodeSpawn,
    execFile = nodeExecFile,
    detectExecutable = null,
    onServerRequest: configuredServerRequestHandler = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    maxJsonlLineBytes,
  } = options;
  const lifecycleOptions = normalizeOptions(options);

  if (Object.prototype.toString.call(executable) !== '[object String]' || executable.length === 0) {
    throw new TypeError('executable must be a non-empty string');
  }
  if (!(spawnProcess instanceof Function) || !(execFile instanceof Function)) {
    throw new TypeError('spawnProcess and execFile must be functions');
  }
  if (!(setTimeoutImpl instanceof Function) || !(clearTimeoutImpl instanceof Function)) {
    throw new TypeError('timer dependencies must be functions');
  }

  let state = 'idle';
  let childRecord = null;
  let startPromise = null;
  let restartTimer = null;
  let manualStopRequested = false;
  let automaticStartInProgress = false;
  let restartAttempts = 0;
  let totalRestartCount = 0;
  let nextRequestId = 1;
  let detectedVersion = null;
  let lastError = null;
  let lastInitializeResult = null;
  let serverRequestHandler = configuredServerRequestHandler;
  let launchOptions = { cwd: configuredCwd, env: configuredEnv };

  const pendingRequests = new Map();
  const pendingServerRequests = new Map();
  const notificationSubscribers = new Set();
  const statusSubscribers = new Set();

  const getStatus = () => ({
    state,
    ready: state === 'ready',
    running: childRecord !== null && !childRecord.finalized,
    version: detectedVersion,
    restartAttempts,
    totalRestartCount,
    maxRestartAttempts: lifecycleOptions.maxRestartAttempts,
    lastError: lastError ? { ...lastError } : null,
  });

  const publishStatus = () => {
    const snapshot = getStatus();
    for (const subscriber of statusSubscribers) {
      try {
        const result = subscriber(snapshot);
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // Subscriber failures must not affect process or protocol ownership.
      }
    }
  };

  const transition = (nextState, error = null) => {
    state = nextState;
    if (error) lastError = statusErrorFor(error);
    publishStatus();
  };

  const subscribeStatus = (subscriber) => {
    if (!(subscriber instanceof Function)) throw new TypeError('status subscriber must be a function');
    statusSubscribers.add(subscriber);
    subscriber(getStatus());
    return () => statusSubscribers.delete(subscriber);
  };

  const subscribeNotifications = (subscriber) => {
    if (!(subscriber instanceof Function)) throw new TypeError('notification subscriber must be a function');
    notificationSubscribers.add(subscriber);
    return () => notificationSubscribers.delete(subscriber);
  };

  const publishNotification = (notification) => {
    for (const subscriber of notificationSubscribers) {
      try {
        const result = subscriber(notification);
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        // Subscriber failures must not affect process or protocol ownership.
      }
    }
  };

  const rejectPendingRequests = (error) => {
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
  };

  const getServerRequestKey = (id) => {
    // The request id is a JSON-RPC id already validated as string, finite
    // number, or null; prefix with the representation so ids of different
    // types never collide in the pending map.
    const tag = Object.prototype.toString.call(id);
    if (tag === '[object String]') return `string:${id}`;
    if (tag === '[object Number]') return `number:${id}`;
    return `null:${String(id)}`;
  };

  const clearPendingServerRequests = () => {
    pendingServerRequests.clear();
  };

  const getChild = () => childRecord?.child ?? null;

  const writeToChild = (line) => {
    const record = childRecord;
    const child = getChild();
    if (!record || record.finalized || !child || !child.stdin || child.stdin.destroyed) {
      throw new CodexAppServerError('Codex app-server is not running', CODEX_ERROR_CODES.PROCESS_EXITED);
    }
    try {
      child.stdin.write(line);
    } catch {
      throw new CodexAppServerError('Codex app-server write failed', CODEX_ERROR_CODES.REQUEST_FAILED);
    }
  };

  const sendResponse = (id, result) => {
    writeToChild(encodeJsonRpcResult(id, result));
  };

  const sendErrorResponse = (id, code, message) => {
    writeToChild(encodeJsonRpcError(id, code, message));
  };

  const respond = (id, result) => {
    const key = getServerRequestKey(id);
    const pending = pendingServerRequests.get(key);
    if (!pending) return { id, responded: false };
    pendingServerRequests.delete(key);
    if (pending.record.finalized || childRecord !== pending.record) return { id, responded: false };
    const response = { id: pending.id, result: result === undefined ? null : result };
    try {
      sendResponse(pending.id, response.result);
      return response;
    } catch {
      return { id, responded: false };
    }
  };

  const handleServerRequest = async (message, record) => {
    const methodResult = readMethodName(message);
    if (!methodResult.ok) {
      try {
        if (!record.finalized && childRecord === record) {
          sendErrorResponse(message.id, -32600, 'Invalid server request');
        }
      } catch {
        // Process termination owns the pending transport failure.
      }
      return;
    }
    if (!(serverRequestHandler instanceof Function)) {
      const key = getServerRequestKey(message.id);
      if (
        pendingServerRequests.size >= lifecycleOptions.maxPendingServerRequests
        || pendingServerRequests.has(key)
      ) {
        try {
          if (!record.finalized && childRecord === record) {
            sendErrorResponse(message.id, SERVER_REQUEST_QUEUE_FULL_ERROR_CODE, 'Too many pending server requests');
          }
        } catch {
          // Process termination owns the pending transport failure.
        }
        return;
      }

      pendingServerRequests.set(key, {
        id: message.id,
        method: methodResult.method,
        params: message.params,
        record,
      });
      const payload = {
        id: message.id,
        method: methodResult.method,
      };
      if (message.params !== undefined) payload.params = message.params;
      publishNotification({
        type: CODEX_SERVER_REQUEST_EVENT,
        payload,
      });
      return;
    }

    try {
      const request = {
        id: message.id,
        method: methodResult.method,
      };
      if (message.params !== undefined) request.params = message.params;
      const result = await serverRequestHandler(request);
      if (!record.finalized && childRecord === record) sendResponse(message.id, result);
    } catch {
      try {
        if (!record.finalized && childRecord === record) {
          sendErrorResponse(message.id, -32000, 'Server request failed');
        }
      } catch {
        // Process termination owns the pending transport failure.
      }
    }
  };

  const dispatchMessage = (message, record) => {
    if (message.kind === 'response') {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerRpcError(message.error.code, message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.kind === 'request') {
      void handleServerRequest(message, record);
      return;
    }

    const notification = { method: message.method };
    if (message.params !== undefined) notification.params = message.params;
    publishNotification(notification);
  };

  const failTransport = (record, error) => {
    if (record.finalized || childRecord !== record) return;
    transition('failed', error);
    void terminateRecord(record, { intentional: false, signal: 'SIGTERM' });
  };

  const createRecord = (child) => {
    const record = {
      child,
      finalized: false,
      intentional: false,
      exitCode: null,
      signal: null,
      processError: null,
      closedPromise: null,
      resolveClosed: null,
      decoder: null,
    };
    record.closedPromise = new Promise((resolve) => {
      record.resolveClosed = resolve;
    });
    record.decoder = createJsonlDecoder({
      maxLineBytes: maxJsonlLineBytes,
      onMessage: (message) => dispatchMessage(message, record),
    });
    return record;
  };

  const finishRecord = (record, exitCode, signal, processError = null) => {
    if (record.finalized) return;
    record.finalized = true;
    record.exitCode = Number.isInteger(exitCode) ? exitCode : record.child.exitCode ?? null;
    record.signal = Object.prototype.toString.call(signal) === '[object String]'
      ? signal
      : record.child.signalCode ?? null;
    record.processError = processError;
    if (childRecord === record) childRecord = null;

    clearPendingServerRequests();
    const rejection = processError
      ? new CodexAppServerError('Codex app-server process reported an error', CODEX_ERROR_CODES.PROCESS_ERROR)
      : new CodexAppServerProcessExitError(record.exitCode, record.signal);
    rejectPendingRequests(rejection);
    record.resolveClosed();

    if (record.intentional || manualStopRequested || state === 'stopping') {
      if (state === 'stopping' || manualStopRequested) transition('stopped');
      return;
    }

    transition('restarting', rejection);
    scheduleRestart();
  };

  const attachChild = (record) => {
    const { child } = record;
    if (!child.stdout || !(child.stdout.on instanceof Function) || !child.stdin) {
      throw new CodexAppServerError('Codex app-server streams are unavailable', CODEX_ERROR_CODES.PROCESS_START_FAILED);
    }
    child.stdout.on('data', (chunk) => {
      if (record.finalized) return;
      try {
        record.decoder.push(chunk);
      } catch (error) {
        failTransport(record, error);
      }
    });
    if (child.stdout.on) {
      child.stdout.on('error', () => {
        failTransport(record, new CodexAppServerError(
          'Codex app-server output stream failed',
          CODEX_ERROR_CODES.PROCESS_ERROR,
        ));
      });
    }
    if (child.stderr && child.stderr.on instanceof Function) {
      // Drain stderr without retaining or logging its content.
      child.stderr.on('data', () => {});
      child.stderr.on('error', () => {});
    }
    if (child.stdin && child.stdin.on instanceof Function) {
      // Settle pending work if the input stream errors without the process
      // exiting; otherwise requests would hang forever.
      child.stdin.on('error', () => {
        failTransport(record, new CodexAppServerError(
          'Codex app-server input stream failed',
          CODEX_ERROR_CODES.PROCESS_ERROR,
        ));
      });
    }
    child.on('error', (error) => finishRecord(record, null, null, error));
    child.on('exit', (code, signal) => finishRecord(record, code, signal));
    child.on('close', (code, signal) => finishRecord(record, code, signal));
  };

  const waitForRecordClose = async (record, timeoutMs) => {
    let timer;
    await Promise.race([
      record.closedPromise,
      new Promise((resolve) => {
        timer = setTimeoutImpl(resolve, timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeoutImpl(timer);
  };

  async function terminateRecord(record, { intentional, signal }) {
    if (record.finalized) return;
    if (intentional) record.intentional = true;
    try {
      if (record.child.kill instanceof Function) record.child.kill(signal);
    } catch {
      // A later close/error event still settles the record; force timeout below is bounded.
    }
    await waitForRecordClose(record, lifecycleOptions.gracefulStopTimeoutMs);
    if (!record.finalized) {
      try {
        if (record.child.kill instanceof Function) record.child.kill('SIGKILL');
      } catch {
      }
      finishRecord(record, null, 'SIGKILL');
    }
  }

  const clearRestartTimer = () => {
    if (restartTimer === null) return;
    clearTimeoutImpl(restartTimer);
    restartTimer = null;
  };

  const scheduleRestart = () => {
    if (manualStopRequested || restartTimer !== null) return;
    if (restartAttempts >= lifecycleOptions.maxRestartAttempts) {
      manualStopRequested = true;
      transition('failed', new CodexAppServerError(
        'Codex app-server restart limit reached',
        CODEX_ERROR_CODES.RESTART_LIMIT,
      ));
      return;
    }

    restartAttempts += 1;
    totalRestartCount += 1;
    const delay = Math.min(
      lifecycleOptions.restartMaxDelayMs,
      lifecycleOptions.restartBaseDelayMs * (2 ** (restartAttempts - 1)),
    );
    transition('restarting');
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      if (manualStopRequested) return;
      automaticStartInProgress = true;
      start(launchOptions).catch(() => {
        if (!manualStopRequested) scheduleRestart();
      }).finally(() => {
        automaticStartInProgress = false;
      });
    }, delay);
  };

  const sendRequestInternal = (method, params) => new Promise((resolve, reject) => {
    const id = nextRequestId;
    nextRequestId += 1;
    pendingRequests.set(id, { resolve, reject, method });
    try {
      writeToChild(encodeJsonRpcRequest(id, method, params));
    } catch (error) {
      pendingRequests.delete(id);
      reject(error);
    }
  });

  const detectExecutableVersion = (effectiveLaunchOptions) => (
    detectExecutable instanceof Function
      ? detectExecutable({ executable, minimumVersion, ...effectiveLaunchOptions })
      : detectCodexExecutable({
        executable,
        execFile,
        minimumVersion,
        ...effectiveLaunchOptions,
      })
  );

  const checkAvailability = async () => {
    // A ready runtime already holds a known version; probing `codex --version`
    // again on every request races concurrent probes and a transient probe
    // failure must not flip a live runtime to unavailable.
    if (state === 'ready' && Object.prototype.toString.call(detectedVersion) === '[object String]') {
      return {
        supported: true,
        available: true,
        version: detectedVersion,
        minimumVersion,
        reason: null,
      };
    }
    try {
      const detected = await detectExecutableVersion({
        cwd: launchOptions.cwd,
        env: launchOptions.env,
      });
      const detectedVersionText = detected instanceof Object
        && Object.prototype.toString.call(detected.version) === '[object String]'
        ? detected.version
        : null;
      if (detectedVersionText === null) {
        throw new CodexAppServerError(
          'Codex executable version could not be detected',
          CODEX_ERROR_CODES.VERSION_UNAVAILABLE,
        );
      }
      detectedVersion = detectedVersionText;
      return {
        supported: true,
        available: true,
        version: detectedVersionText,
        minimumVersion,
        reason: null,
      };
    } catch (error) {
      const reason = statusErrorFor(error);
      return {
        supported: reason.code !== CODEX_ERROR_CODES.VERSION_UNSUPPORTED,
        available: false,
        version: null,
        minimumVersion,
        reason,
      };
    }
  };

  const startInternal = async (requestedLaunchOptions) => {
    transition('starting');
    const effectiveLaunchOptions = {
      cwd: requestedLaunchOptions.cwd,
      env: requestedLaunchOptions.env,
    };
    let detected;
    try {
      detected = await detectExecutableVersion(effectiveLaunchOptions);
    } catch (error) {
      transition('failed', error);
      throw error;
    }
    if (manualStopRequested) {
      throw new CodexAppServerError('Codex app-server is stopped', CODEX_ERROR_CODES.STOPPED);
    }
    detectedVersion = detected.version;

    let child;
    try {
      const spawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      };
      if (effectiveLaunchOptions.cwd) spawnOptions.cwd = effectiveLaunchOptions.cwd;
      if (effectiveLaunchOptions.env) spawnOptions.env = effectiveLaunchOptions.env;
      child = spawnProcess(executable, [...CODEX_APP_SERVER_COMMAND], spawnOptions);
    } catch {
      const error = new CodexAppServerError(
        'Codex app-server process could not be started',
        CODEX_ERROR_CODES.PROCESS_START_FAILED,
      );
      transition('failed', error);
      throw error;
    }

    if (!child || !(child.on instanceof Function)) {
      const error = new CodexAppServerError(
        'Codex app-server process could not be started',
        CODEX_ERROR_CODES.PROCESS_START_FAILED,
      );
      transition('failed', error);
      throw error;
    }

    const record = createRecord(child);
    childRecord = record;
    try {
      attachChild(record);
      const initializeResult = await sendRequestInternal('initialize', {
        clientInfo: { ...DEFAULT_CLIENT_INFO, ...clientInfo },
        capabilities: { experimentalApi: true },
      });
      if (record.finalized || childRecord !== record) {
        throw new CodexAppServerProcessExitError(record.exitCode, record.signal);
      }
      writeToChild(encodeJsonRpcNotification('initialized'));
      lastInitializeResult = initializeResult;
      lastError = null;
      transition('ready');
      return initializeResult;
    } catch (error) {
      if (!record.finalized) await terminateRecord(record, { intentional: true, signal: 'SIGTERM' });
      if (!(error instanceof CodexAppServerProcessExitError) && !manualStopRequested) {
        transition('failed', error);
      }
      throw error;
    }
  };

  const start = (startOptions = {}) => {
    if (!isObject(startOptions)) throw new TypeError('start options must be an object');
    manualStopRequested = false;
    clearRestartTimer();
    if (!automaticStartInProgress) restartAttempts = 0;
    launchOptions = {
      cwd: hasOwn(startOptions, 'cwd') ? startOptions.cwd : launchOptions.cwd,
      env: hasOwn(startOptions, 'env') ? startOptions.env : launchOptions.env,
    };
    if (state === 'ready') return Promise.resolve(lastInitializeResult);
    if (startPromise) return startPromise;
    startPromise = startInternal(launchOptions).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const request = async (method, params) => {
    if (Object.prototype.toString.call(method) !== '[object String]' || method.length === 0) {
      throw new TypeError('method must be a non-empty string');
    }
    await start();
    return sendRequestInternal(method, params);
  };

  const notify = async (method, params) => {
    if (Object.prototype.toString.call(method) !== '[object String]' || method.length === 0) {
      throw new TypeError('method must be a non-empty string');
    }
    await start();
    writeToChild(encodeJsonRpcNotification(method, params));
  };

  const stop = async () => {
    manualStopRequested = true;
    clearRestartTimer();
    transition('stopping');
    clearPendingServerRequests();
    rejectPendingRequests(new CodexAppServerError('Codex app-server is stopped', CODEX_ERROR_CODES.STOPPED));
    const record = childRecord;
    if (record) await terminateRecord(record, { intentional: true, signal: 'SIGTERM' });
    if (childRecord === null) transition('stopped');
  };

  const restart = async () => {
    manualStopRequested = true;
    clearRestartTimer();
    const record = childRecord;
    if (record) {
      clearPendingServerRequests();
      rejectPendingRequests(new CodexAppServerError('Codex app-server is stopped', CODEX_ERROR_CODES.STOPPED));
      await terminateRecord(record, { intentional: true, signal: 'SIGTERM' });
    }
    manualStopRequested = false;
    restartAttempts = 0;
    return start();
  };

  return {
    start,
    stop,
    restart,
    checkAvailability,
    request,
    notify,
    respond,
    subscribeNotifications,
    subscribe: subscribeNotifications,
    subscribeStatus,
    getStatus,
    setServerRequestHandler(handler) {
      if (handler !== null && !(handler instanceof Function)) {
        throw new TypeError('server request handler must be a function or null');
      }
      serverRequestHandler = handler;
    },
    dispose: stop,
    getPendingRequestCount: () => pendingRequests.size,
    getPendingServerRequestCount: () => pendingServerRequests.size,
  };
};
