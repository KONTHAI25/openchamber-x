import { StringDecoder } from 'node:string_decoder';
import { createProtocolError } from './errors.js';

export const DEFAULT_MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

// Validation helpers below decode untrusted values (parsed JSON and stream
// chunks) into narrow domain shapes instead of narrowing with `typeof`.
// Each returns a plain result object with an explicit `ok` field so callers
// branch on the domain value, never on a raw representation.
const isPlainObject = (value) => (
  value !== null
  && Object.prototype.toString.call(value) === '[object Object]'
  && !Array.isArray(value)
);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRpcId = (value) => value === null || Object.prototype.toString.call(value) === '[object String]' || (
  Object.prototype.toString.call(value) === '[object Number]' && Number.isFinite(value)
);

const readMethod = (value) => {
  const method = value.method;
  if (Object.prototype.toString.call(method) !== '[object String]' || method.length === 0) return { ok: false };
  return { ok: true, method };
};

const readErrorField = (value) => {
  const error = value.error;
  if (
    !isPlainObject(error)
    || Object.prototype.toString.call(error.code) !== '[object Number]'
    || !Number.isFinite(error.code)
    || Object.prototype.toString.call(error.message) !== '[object String]'
  ) {
    return { ok: false };
  }
  return { ok: true, error };
};

const parseChunk = (chunk) => {
  // Accept either a Buffer/Uint8Array (from child stdout) or a string; any
  // other shape is rejected here so the decoder never narrows at use sites.
  if (Object.prototype.toString.call(chunk) === '[object String]') return { ok: true, buffer: Buffer.from(chunk) };
  if (Buffer.isBuffer(chunk)) return { ok: true, buffer: chunk };
  return { ok: false };
};

const serialize = (message) => {
  try {
    return `${JSON.stringify(message)}\n`;
  } catch {
    throw createProtocolError('Codex app-server message could not be serialized');
  }
};

export const encodeJsonRpcRequest = (id, method, params) => {
  const message = { id, method };
  if (params !== undefined) message.params = params;
  return serialize(message);
};

export const encodeJsonRpcNotification = (method, params) => {
  const message = { method };
  if (params !== undefined) message.params = params;
  return serialize(message);
};

export const encodeJsonRpcResult = (id, result) => serialize({
  id,
  result: result === undefined ? null : result,
});

export const encodeJsonRpcError = (id, code, message) => serialize({
  id,
  error: { code, message },
});

export const parseJsonRpcMessage = (value) => {
  // Codex app-server uses JSON-RPC semantics over JSONL but intentionally
  // omits the `jsonrpc` member. Accept it on input for forwards compatibility,
  // but never emit it because current CLIs close stdio on that wire shape.
  if (!isPlainObject(value) || (hasOwn(value, 'jsonrpc') && value.jsonrpc !== '2.0')) {
    throw createProtocolError();
  }

  const hasId = hasOwn(value, 'id');
  const hasMethod = hasOwn(value, 'method');
  if (hasMethod) {
    const methodResult = readMethod(value);
    if (!methodResult.ok || (hasId && !isRpcId(value.id))) {
      throw createProtocolError();
    }
    return hasId
      ? { kind: 'request', id: value.id, method: methodResult.method, params: value.params }
      : { kind: 'notification', method: methodResult.method, params: value.params };
  }

  if (!hasId || !isRpcId(value.id)) {
    throw createProtocolError();
  }
  if (hasOwn(value, 'error')) {
    const errorResult = readErrorField(value);
    if (!errorResult.ok) {
      throw createProtocolError();
    }
    return { kind: 'response', id: value.id, error: errorResult.error };
  }
  if (!hasOwn(value, 'result')) {
    throw createProtocolError();
  }
  return { kind: 'response', id: value.id, result: value.result };
};

export const parseJsonRpcLine = (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw createProtocolError('Codex app-server emitted invalid JSON');
  }
  return parseJsonRpcMessage(value);
};

export const createJsonlDecoder = ({
  onMessage,
  maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES,
} = {}) => {
  if (!(onMessage instanceof Function)) throw new TypeError('onMessage must be a function');
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new TypeError('maxLineBytes must be a positive integer');
  }

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let ended = false;

  const consumeLine = (line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.trim().length === 0) return;
    if (Buffer.byteLength(normalized, 'utf8') > maxLineBytes) {
      throw createProtocolError('Codex app-server JSONL frame exceeded its size limit');
    }
    onMessage(parseJsonRpcLine(normalized));
  };

  const consumeText = (text) => {
    buffer += text;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      throw createProtocolError('Codex app-server JSONL frame exceeded its size limit');
    }
  };

  return {
    push(chunk) {
      if (ended) throw createProtocolError('Codex app-server JSONL decoder is closed');
      const parsedChunk = parseChunk(chunk);
      if (!parsedChunk.ok) {
        throw createProtocolError('Codex app-server emitted an invalid stream chunk');
      }
      consumeText(decoder.write(parsedChunk.buffer));
    },
    end() {
      if (ended) return;
      ended = true;
      consumeText(decoder.end());
      if (buffer.length > 0) {
        consumeLine(buffer);
        buffer = '';
      }
    },
  };
};
