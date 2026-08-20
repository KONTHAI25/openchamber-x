import express from 'express';

const AGENTS_PATH = '/api/agents';
const CODEX_PATH = `${AGENTS_PATH}/codex`;
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_KEYS = 10_000;
const INVALID_JSON = Symbol('invalid-json');
const RESULT_TYPES = new Set(['ok', 'unsupported', 'unavailable', 'error']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value) => {
  if (
    value === null
    || Object.prototype.toString.call(value) !== '[object Object]'
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const defineSafeProperty = (target, key, value) => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const cloneJsonValue = (value, depth = 0, state = { keys: 0 }) => {
  if (depth > MAX_JSON_DEPTH) {
    return INVALID_JSON;
  }

  const tag = Object.prototype.toString.call(value);
  if (value === null || tag === '[object String]' || tag === '[object Boolean]') {
    return value;
  }

  if (tag === '[object Number]') {
    return Number.isFinite(value) ? value : INVALID_JSON;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_KEYS) {
      return INVALID_JSON;
    }
    const result = [];
    for (const item of value) {
      const clonedItem = cloneJsonValue(item, depth + 1, state);
      if (clonedItem === INVALID_JSON) {
        return INVALID_JSON;
      }
      result.push(clonedItem);
    }
    return result;
  }

  if (!isPlainObject(value)) {
    return INVALID_JSON;
  }

  const keys = Object.keys(value);
  state.keys += keys.length;
  if (state.keys > MAX_JSON_KEYS) {
    return INVALID_JSON;
  }

  const result = {};
  for (const key of keys) {
    const clonedValue = cloneJsonValue(value[key], depth + 1, state);
    if (clonedValue === INVALID_JSON) {
      return INVALID_JSON;
    }
    defineSafeProperty(result, key, clonedValue);
  }
  return result;
};

const cloneObject = (value, fallback = null) => {
  const cloned = cloneJsonValue(value);
  return isPlainObject(cloned) ? cloned : fallback;
};

const isIdentifier = (value) => (
  Object.prototype.toString.call(value) === '[object String]'
  && value.length > 0
  && value.length <= 256
  && /^[A-Za-z0-9._:-]+$/.test(value)
);

const isRequestId = (value) => (
  (Object.prototype.toString.call(value) === '[object String]' && isIdentifier(value))
  || (Object.prototype.toString.call(value) === '[object Number]' && Number.isSafeInteger(value))
);

const isNonEmptyString = (value, maxLength = 4096) => (
  Object.prototype.toString.call(value) === '[object String]'
  && value.length > 0
  && value.length <= maxLength
  && !/[\u0000-\u001f\u007f]/.test(value)
);

const makeInvalidParams = (message) => ({
  result: 'error',
  error: {
    code: 'invalid_params',
    message,
  },
});

const makeOk = (data) => ({
  result: 'ok',
  data: data === undefined ? null : data,
});

const makeUnsupported = (message = 'Codex does not support this operation') => ({
  result: 'unsupported',
  error: {
    code: 'unsupported',
    message,
  },
});

const makeUnavailable = (message = 'Codex is unavailable') => ({
  result: 'unavailable',
  error: {
    code: 'unavailable',
    message,
  },
});

const makeError = (message = 'Codex request failed', code = 'backend_error') => ({
  result: 'error',
  error: {
    code,
    message,
  },
});

const outcomeStatusCode = (outcome) => {
  if (outcome.error?.code === 'invalid_params') return 400;
  if (outcome.result === 'unsupported') return 501;
  if (outcome.result === 'unavailable') return 503;
  if (outcome.result === 'error') return 500;
  return 200;
};

const sendOutcome = (res, outcome) => {
  const safeOutcome = RESULT_TYPES.has(outcome?.result) ? outcome : makeError();
  return res.status(outcomeStatusCode(safeOutcome)).json(safeOutcome);
};

const outcomeForError = (error) => {
  const code = error instanceof Error && Object.prototype.toString.call(error.code) === '[object String]'
    ? error.code.toLowerCase()
    : '';
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 0;
  if (code === 'unsupported' || code === 'not_supported' || statusCode === 501) {
    return makeUnsupported();
  }
  if (code === 'unavailable' || code === 'not_ready' || statusCode === 503) {
    return makeUnavailable();
  }
  return makeError();
};

const readJsonPayload = (value, label) => {
  const cloned = cloneJsonValue(value === undefined ? null : value);
  if (cloned === INVALID_JSON) {
    throw new Error(`${label} was not valid JSON`);
  }
  return cloned;
};

const readBodyParams = (req) => {
  const body = req.body === undefined ? {} : req.body;
  const params = cloneObject(body);
  return params;
};

const readQueryParams = (req) => {
  const query = req.query === undefined ? {} : req.query;
  const params = cloneObject(query);
  return params ? { params } : { error: 'Query parameters must be JSON-compatible values' };
};

const validateKnownIdentifiers = (params, fields) => {
  for (const field of fields) {
    if (hasOwn(params, field) && !isIdentifier(params[field])) {
      return `${field} must be a non-empty identifier`;
    }
  }
  return null;
};

const readActionParams = (req, requiredIdentifiers = []) => {
  const params = readBodyParams(req);
  if (!params) {
    return { error: 'Request body must be a JSON object' };
  }

  const identifierError = validateKnownIdentifiers(params, [
    'threadId',
    'turnId',
    'requestId',
    'approvalId',
    ...requiredIdentifiers,
  ]);
  if (identifierError) {
    return { error: identifierError };
  }

  for (const field of requiredIdentifiers) {
    if (!isIdentifier(params[field])) {
      return { error: `${field} is required` };
    }
  }

  return { params };
};

const addPathIdentifier = (params, field, value) => {
  if (!isIdentifier(value)) {
    return { error: `${field} must be a non-empty identifier` };
  }
  if (hasOwn(params, field) && params[field] !== value) {
    return { error: `${field} does not match the path` };
  }
  defineSafeProperty(params, field, value);
  return { params };
};

const readThreadActionParams = (req, requiredIdentifiers = []) => {
  const parsed = readActionParams(req, requiredIdentifiers);
  if (parsed.error) return parsed;
  return addPathIdentifier(parsed.params, 'threadId', req.params?.threadId);
};

const readThreadListParams = (req) => {
  const parsed = readQueryParams(req);
  if (parsed.error) {
    return parsed;
  }
  const query = parsed.params;

  const forwarded = {};
  if (hasOwn(query, 'cursor')) {
    if (!isNonEmptyString(query.cursor, 1024)) {
      return { error: 'cursor must be a non-empty string' };
    }
    defineSafeProperty(forwarded, 'cursor', query.cursor);
  }
  if (hasOwn(query, 'directory')) {
    if (!isNonEmptyString(query.directory)) {
      return { error: 'directory must be a non-empty string' };
    }
    if (!hasOwn(forwarded, 'cwd')) {
      defineSafeProperty(forwarded, 'cwd', query.directory);
    }
  }
  if (hasOwn(query, 'cwd')) {
    if (!isNonEmptyString(query.cwd)) {
      return { error: 'cwd must be a non-empty string' };
    }
    defineSafeProperty(forwarded, 'cwd', query.cwd);
  }
  if (hasOwn(query, 'limit')) {
    const limit = Object.prototype.toString.call(query.limit) === '[object String]'
      ? Number(query.limit)
      : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return { error: 'limit must be an integer between 1 and 1000' };
    }
    defineSafeProperty(forwarded, 'limit', limit);
  }
  if (hasOwn(query, 'archived')) {
    if (query.archived === 'true') {
      defineSafeProperty(forwarded, 'archived', true);
    } else if (query.archived === 'false') {
      defineSafeProperty(forwarded, 'archived', false);
    } else if (Object.prototype.toString.call(query.archived) !== '[object Boolean]') {
      return { error: 'archived must be a boolean' };
    } else {
      defineSafeProperty(forwarded, 'archived', query.archived);
    }
  }

  for (const key of Object.keys(query)) {
    if (key !== 'cursor' && key !== 'cwd' && key !== 'directory' && key !== 'limit' && key !== 'archived') {
      return { error: `${key} is not a supported query parameter` };
    }
  }

  return { params: forwarded };
};

const readThreadNameParams = (req) => {
  const parsed = readActionParams(req, ['threadId']);
  if (parsed.error) return parsed;
  if (!isNonEmptyString(parsed.params.name, 512)) {
    return { error: 'name must be a non-empty string' };
  }
  return parsed;
};

const readResponseParams = (req) => {
  const body = readBodyParams(req);
  if (!body) {
    return { error: 'Request body must be a JSON object' };
  }

  const routeId = req.params?.requestId || req.params?.approvalId || req.params?.id;
  const id = routeId ?? body.requestId ?? body.approvalId ?? body.id;
  if (!isRequestId(id)) {
    return { error: 'A valid response id is required' };
  }

  const hasResult = hasOwn(body, 'result') || hasOwn(body, 'response');
  if (!hasResult) {
    return { error: 'result is required' };
  }
  const rawResult = hasOwn(body, 'result') ? body.result : body.response;
  const result = cloneJsonValue(rawResult);
  if (!isPlainObject(result)) {
    return { error: 'result must be a JSON object' };
  }

  return { id, result };
};

const defaultWriteSseEvent = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const eventType = (notification) => {
  if (Object.prototype.toString.call(notification.type) === '[object String]') return notification.type;
  if (Object.prototype.toString.call(notification.method) === '[object String]') return notification.method;
  if (Object.prototype.toString.call(notification.event) === '[object String]') return notification.event;
  return null;
};

const normalizeNotification = (notification, sequence) => {
  if (!isPlainObject(notification)) {
    return null;
  }
  const type = eventType(notification);
  if (!type || type.length > 240) {
    return null;
  }
  const rawPayload = hasOwn(notification, 'payload')
    ? notification.payload
    : notification.params;
  const payload = cloneJsonValue(rawPayload === undefined ? {} : rawPayload);
  if (!isPlainObject(payload)) {
    return null;
  }
  return {
    backend: 'codex',
    sequence,
    type,
    payload,
  };
};

const isUnavailable = (availability) => (
  availability === false
  || (isPlainObject(availability) && availability.available === false)
  || (isPlainObject(availability) && availability.status === 'unavailable')
  || (isPlainObject(availability) && availability.result === 'unavailable')
);

const isUnsupported = (availability) => (
  isPlainObject(availability)
  && (
    availability.supported === false
    || availability.status === 'unsupported'
    || availability.result === 'unsupported'
  )
);

const registerGet = (app, paths, handler) => {
  for (const path of paths) {
    app.get(path, handler);
  }
};

const registerPost = (app, paths, handler) => {
  for (const path of paths) {
    app.post(path, handler);
  }
};

const registerDelete = (app, paths, handler) => {
  for (const path of paths) {
    app.delete(path, handler);
  }
};

export const registerAgentBackendRoutes = (app, { codexRuntime, writeSseEvent } = {}) => {
  if (!codexRuntime || Object.prototype.toString.call(codexRuntime) !== '[object Object]') {
    throw new TypeError('codexRuntime is required');
  }
  for (const method of ['start', 'request', 'respond', 'subscribe', 'getStatus', 'checkAvailability']) {
    if (!(codexRuntime[method] instanceof Function)) {
      throw new TypeError(`codexRuntime.${method} is required`);
    }
  }

  const clients = new Set();
  let sequence = 0;
  let startPromise = null;
  let unsubscribe = null;
  let statusUnsubscribe = null;

  const ensureStarted = () => {
    if (!startPromise) {
      startPromise = Promise.resolve().then(() => codexRuntime.start());
    }
    return startPromise;
  };

  const getAvailability = async () => {
    // Once the runtime is ready with a known version, re-probing `codex --version`
    // on every request races concurrent probes and can flip a live runtime to
    // unavailable on a transient probe failure. Only probe when not ready.
    const status = await codexRuntime.getStatus();
    if (
      status
      && isPlainObject(status)
      && status.state === 'ready'
      && Object.prototype.toString.call(status.version) === '[object String]'
    ) {
      return null;
    }
    const availability = await codexRuntime.checkAvailability();
    if (isUnsupported(availability)) return makeUnsupported();
    if (isUnavailable(availability)) return makeUnavailable();
    return null;
  };

  const executeRequest = async (method, params, res) => {
    try {
      const availabilityOutcome = await getAvailability();
      if (availabilityOutcome) {
        return sendOutcome(res, availabilityOutcome);
      }
      await ensureStarted();
      const response = readJsonPayload(await codexRuntime.request(method, params), 'Codex response');
      return sendOutcome(res, makeOk(response));
    } catch (error) {
      return sendOutcome(res, outcomeForError(error));
    }
  };

  const executeResponse = async (id, result, res) => {
    try {
      const availabilityOutcome = await getAvailability();
      if (availabilityOutcome) {
        return sendOutcome(res, availabilityOutcome);
      }
      await ensureStarted();
      const response = readJsonPayload(await codexRuntime.respond(id, result), 'Codex response');
      if (response && isPlainObject(response) && response.responded === false) {
        return sendOutcome(res, makeError('Codex response was not delivered', 'codex_response_not_delivered'));
      }
      return sendOutcome(res, makeOk(response));
    } catch (error) {
      return sendOutcome(res, outcomeForError(error));
    }
  };

  const handleStatus = async (_req, res) => {
    try {
      const availability = await codexRuntime.checkAvailability();
      const status = await codexRuntime.getStatus();
      const safeStatus = readJsonPayload(status, 'Codex status');
      const safeAvailability = readJsonPayload(availability, 'Codex availability');
      const state = isPlainObject(safeStatus) ? safeStatus.state : null;
      if (
        (state === 'failed' || state === 'stopped')
        && isUnavailable(safeAvailability)
      ) {
        return sendOutcome(res, {
          result: 'unavailable',
          error: {
            code: 'unavailable',
            message: 'Codex is unavailable',
            backend: 'codex',
            status: safeStatus,
            availability: safeAvailability,
          },
        });
      }
      return sendOutcome(res, makeOk({
        backend: 'codex',
        status: safeStatus,
        availability: safeAvailability,
      }));
    } catch (error) {
      return sendOutcome(res, outcomeForError(error));
    }
  };

  const makeRequestHandler = (method, parser = readActionParams) => async (req, res) => {
    const parsed = parser(req);
    if (parsed.error) {
      return sendOutcome(res, makeInvalidParams(parsed.error));
    }
    return executeRequest(method, parsed.params, res);
  };

  const makePathRequestHandler = (method, requiredIdentifiers = []) => (
    makeRequestHandler(method, (req) => readThreadActionParams(req, requiredIdentifiers))
  );

  const handleResponse = async (req, res) => {
    const parsed = readResponseParams(req);
    if (parsed.error) {
      return sendOutcome(res, makeInvalidParams(parsed.error));
    }
    return executeResponse(parsed.id, parsed.result, res);
  };

  const publishNotification = (notification) => {
    const envelope = normalizeNotification(notification, sequence + 1);
    if (!envelope) {
      return;
    }
    sequence += 1;

    for (const client of Array.from(clients)) {
      if (client.closed || client.res.writableEnded || client.res.destroyed) {
        client.cleanup();
        continue;
      }
      try {
        client.write(envelope);
      } catch {
        client.cleanup();
      }
    }
  };

  const publishBackendStatus = (status) => {
    if (!isPlainObject(status)) return;
    const state = status.state;
    if (state !== 'failed' && state !== 'stopped') return;
    sequence += 1;
    const envelope = {
      backend: 'codex',
      sequence,
      type: 'backend_status',
      payload: { state },
    };
    for (const client of Array.from(clients)) {
      if (client.closed || client.res.writableEnded || client.res.destroyed) {
        client.cleanup();
        continue;
      }
      try {
        client.write(envelope);
      } catch {
        // Fall through to cleanup: the stream is no longer usable.
      }
      client.cleanup();
    }
  };

  const subscription = codexRuntime.subscribe(publishNotification);
  if (subscription instanceof Function) {
    unsubscribe = subscription;
  } else if (subscription && subscription.unsubscribe instanceof Function) {
    unsubscribe = () => subscription.unsubscribe();
  }

  if (codexRuntime.subscribeStatus instanceof Function) {
    const statusSubscription = codexRuntime.subscribeStatus(publishBackendStatus);
    if (statusSubscription instanceof Function) {
      statusUnsubscribe = statusSubscription;
    } else if (statusSubscription && statusSubscription.unsubscribe instanceof Function) {
      statusUnsubscribe = () => statusSubscription.unsubscribe();
    }
  }

  const handleEvents = async (req, res) => {
    try {
      const availabilityOutcome = await getAvailability();
      if (availabilityOutcome) {
        return sendOutcome(res, availabilityOutcome);
      }
      await ensureStarted();
    } catch (error) {
      return sendOutcome(res, outcomeForError(error));
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client = {
      closed: false,
      cleanup: null,
      heartbeatTimer: null,
      res,
      write: (payload) => {
        const writer = writeSseEvent instanceof Function ? writeSseEvent : defaultWriteSseEvent;
        writer(res, payload);
        res.flush?.();
      },
    };

    client.cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      if (client.heartbeatTimer) {
        clearInterval(client.heartbeatTimer);
        client.heartbeatTimer = null;
      }
      clients.delete(client);
    };

    clients.add(client);

    const cleanup = client.cleanup;
    req.on?.('aborted', cleanup);
    req.on?.('close', cleanup);
    res.on?.('close', cleanup);
    res.on?.('error', cleanup);

    client.heartbeatTimer = setInterval(() => {
      if (client.closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try {
        res.write(':heartbeat\n\n');
        res.flush?.();
      } catch {
        cleanup();
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    client.heartbeatTimer.unref?.();

    return undefined;
  };

  // The existing server installs authentication at /api before feature route
  // registration. This module deliberately does not create a second auth
  // policy; it only parses and validates the request once it reaches here.
  if (app.use instanceof Function) {
    app.use(AGENTS_PATH, express.json({ limit: '1mb' }));
    app.use(AGENTS_PATH, (error, _req, res, next) => {
      if (error?.type === 'entity.parse.failed') {
        return sendOutcome(res, makeInvalidParams('Request body must be valid JSON'));
      }
      if (error?.type === 'entity.too.large') {
        return sendOutcome(res, makeInvalidParams('Request body exceeds the 1mb limit'));
      }
      return next(error);
    });
  }

  registerGet(app, [`${AGENTS_PATH}/status`, `${AGENTS_PATH}/backend`, `${AGENTS_PATH}/backend/status`], handleStatus);

  registerGet(app, [`${CODEX_PATH}/account`, `${CODEX_PATH}/account/read`], makeRequestHandler('account/read'));
  registerPost(app, [`${CODEX_PATH}/account/login/start`], makeRequestHandler('account/login/start'));
  registerPost(app, [`${CODEX_PATH}/account/login/cancel`], makeRequestHandler('account/login/cancel'));
  registerPost(app, [`${CODEX_PATH}/account/logout`], makeRequestHandler('account/logout'));

  registerGet(app, [`${CODEX_PATH}/models`, `${CODEX_PATH}/models/list`], makeRequestHandler('model/list', readQueryParams));

  registerGet(app, [`${CODEX_PATH}/threads`, `${CODEX_PATH}/threads/list`], makeRequestHandler('thread/list', readThreadListParams));
  registerPost(app, [`${CODEX_PATH}/threads/start`], makeRequestHandler('thread/start'));
  registerPost(app, [`${CODEX_PATH}/threads/read`], makeRequestHandler('thread/read', (req) => readActionParams(req, ['threadId'])));
  registerGet(app, [`${CODEX_PATH}/threads/:threadId`], makePathRequestHandler('thread/read'));
  registerPost(app, [`${CODEX_PATH}/threads/resume`], makeRequestHandler('thread/resume', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/threads/fork`], makeRequestHandler('thread/fork', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/threads/archive`], makeRequestHandler('thread/archive', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/threads/unarchive`], makeRequestHandler('thread/unarchive', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/threads/delete`], makeRequestHandler('thread/delete', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/threads/name`], makeRequestHandler('thread/name/set', readThreadNameParams));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/resume`], makePathRequestHandler('thread/resume'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/fork`], makePathRequestHandler('thread/fork'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/archive`], makePathRequestHandler('thread/archive'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/unarchive`], makePathRequestHandler('thread/unarchive'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/delete`], makePathRequestHandler('thread/delete'));
  registerDelete(app, [`${CODEX_PATH}/threads/:threadId`], makePathRequestHandler('thread/delete'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/turns/start`], makePathRequestHandler('turn/start'));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/turns/steer`], makePathRequestHandler('turn/steer', ['turnId']));
  registerPost(app, [`${CODEX_PATH}/threads/:threadId/turns/interrupt`], makePathRequestHandler('turn/interrupt', ['turnId']));
  registerPost(app, [`${CODEX_PATH}/turns/start`], makeRequestHandler('turn/start', (req) => readActionParams(req, ['threadId'])));
  registerPost(app, [`${CODEX_PATH}/turns/steer`], makeRequestHandler('turn/steer', (req) => readActionParams(req, ['threadId', 'turnId'])));
  registerPost(app, [`${CODEX_PATH}/turns/interrupt`], makeRequestHandler('turn/interrupt', (req) => readActionParams(req, ['threadId', 'turnId'])));

  registerPost(app, [`${CODEX_PATH}/approval/respond`, `${CODEX_PATH}/approvals/respond`], handleResponse);
  registerPost(app, [`${CODEX_PATH}/approval/:approvalId/respond`, `${CODEX_PATH}/approvals/:approvalId/respond`], handleResponse);
  registerPost(app, [`${CODEX_PATH}/user-input/respond`, `${CODEX_PATH}/userInput/respond`], handleResponse);
  registerPost(app, [`${CODEX_PATH}/user-input/:requestId/respond`, `${CODEX_PATH}/userInput/:requestId/respond`], handleResponse);
  registerGet(app, [`${AGENTS_PATH}/events`], handleEvents);

  return {
    close() {
      for (const client of Array.from(clients)) {
        client.cleanup();
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (statusUnsubscribe) {
        statusUnsubscribe();
        statusUnsubscribe = null;
      }
    },
    getConnectedClientCount() {
      return clients.size;
    },
  };
};
