export const CODEX_ERROR_CODES = Object.freeze({
  EXECUTABLE_NOT_FOUND: 'CODEX_EXECUTABLE_NOT_FOUND',
  VERSION_UNAVAILABLE: 'CODEX_VERSION_UNAVAILABLE',
  VERSION_UNSUPPORTED: 'CODEX_VERSION_UNSUPPORTED',
  PROCESS_START_FAILED: 'CODEX_PROCESS_START_FAILED',
  PROCESS_EXITED: 'CODEX_PROCESS_EXITED',
  PROCESS_ERROR: 'CODEX_PROCESS_ERROR',
  PROTOCOL_ERROR: 'CODEX_PROTOCOL_ERROR',
  RPC_ERROR: 'CODEX_RPC_ERROR',
  REQUEST_FAILED: 'CODEX_REQUEST_FAILED',
  STOPPED: 'CODEX_APP_SERVER_STOPPED',
  RESTART_LIMIT: 'CODEX_RESTART_LIMIT',
});

export class CodexAppServerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

export class CodexAppServerRpcError extends CodexAppServerError {
  constructor(rpcCode, rpcMessage) {
    super('Codex app-server RPC request failed', CODEX_ERROR_CODES.RPC_ERROR);
    this.name = 'CodexAppServerRpcError';
    this.rpcCode = rpcCode;
    this.rpcMessage = rpcMessage;
  }
}

const normalizeSignal = (signal) => {
  // `signal` arrives from Node's exit/close events (string) or from callers
  // that only tracked a numeric exit code. Anything else is not a signal name.
  if (signal === undefined || signal === null) return null;
  return Object.prototype.toString.call(signal) === '[object String]' ? signal : null;
};

export class CodexAppServerProcessExitError extends CodexAppServerError {
  constructor(exitCode, signal) {
    super('Codex app-server process exited', CODEX_ERROR_CODES.PROCESS_EXITED);
    this.name = 'CodexAppServerProcessExitError';
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    this.signal = normalizeSignal(signal);
  }
}

export class CodexAppServerVersionError extends CodexAppServerError {
  constructor(code, message) {
    super(message, code);
    this.name = 'CodexAppServerVersionError';
  }
}

export const createProtocolError = (message = 'Invalid Codex app-server protocol message') => (
  new CodexAppServerError(message, CODEX_ERROR_CODES.PROTOCOL_ERROR)
);

