import { execFile as nodeExecFile } from 'node:child_process';
import { CODEX_ERROR_CODES, CodexAppServerVersionError } from './errors.js';

export const MIN_CODEX_APP_SERVER_VERSION = '0.148.0';

const VERSION_PATTERN = /(?:^|\s|[/@_-])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=$|\s|[^0-9A-Za-z.-])/g;

const isPrereleaseIdentifierNumeric = (value) => /^\d+$/.test(value);

const parsePrerelease = (value) => {
  if (!value) return [];
  return value.split('.').map((part) => (
    isPrereleaseIdentifierNumeric(part) ? Number.parseInt(part, 10) : part
  ));
};

export const parseCodexVersion = (value) => {
  const text = String(value ?? '').trim();
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: parsePrerelease(match[4]),
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`,
  };
};

export const extractCodexVersion = (output) => {
  const text = String(output ?? '');
  VERSION_PATTERN.lastIndex = 0;
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  return parseCodexVersion(`${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ''}`);
};

const coerceVersionInput = (value) => {
  // Accept either a parsed version object or a version string; strings are
  // decoded at this boundary so downstream comparison works on the domain
  // value only.
  if (Object.prototype.toString.call(value) === '[object String]') return parseCodexVersion(value);
  return value;
};

export const compareCodexVersions = (left, right) => {
  const leftVersion = coerceVersionInput(left);
  const rightVersion = coerceVersionInput(right);
  if (!leftVersion || !rightVersion) {
    throw new TypeError('Codex versions must be valid semantic versions');
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] > rightVersion[key] ? 1 : -1;
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
  if (leftVersion.prerelease.length === 0) return 1;
  if (rightVersion.prerelease.length === 0) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (Number.isInteger(leftPart) && Object.prototype.toString.call(rightPart) === '[object String]') return -1;
    if (Object.prototype.toString.call(leftPart) === '[object String]' && Number.isInteger(rightPart)) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

export const isSupportedCodexVersion = (version, minimum = MIN_CODEX_APP_SERVER_VERSION) => (
  compareCodexVersions(version, minimum) >= 0
);

const runVersionCommand = (execFile, executable, options) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, stdout, stderr) => {
    if (settled) return;
    settled = true;
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  };

  let child;
  try {
    child = execFile(executable, ['--version'], options, finish);
  } catch (error) {
    finish(error);
    return;
  }

  // A promise-returning runner is useful for deterministic dependency injection
  // in route/runtime tests while the default remains Node's callback API.
  if (child && child.then instanceof Function) {
    child.then((result) => finish(null, result?.stdout, result?.stderr), finish);
  } else if (
    child
    && (Object.prototype.toString.call(child.stdout) === '[object String]' || Buffer.isBuffer(child.stdout))
    && (
      Object.prototype.toString.call(child.stderr) === '[object String]'
      || Buffer.isBuffer(child.stderr)
      || child.stderr === undefined
    )
  ) {
    finish(null, child.stdout, child.stderr);
  }
});

export const detectCodexExecutable = async ({
  executable = 'codex',
  execFile = nodeExecFile,
  cwd,
  env,
  minimumVersion = MIN_CODEX_APP_SERVER_VERSION,
} = {}) => {
  const options = {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    windowsHide: true,
  };
  if (cwd) options.cwd = cwd;
  if (env) options.env = env;

  let result;
  try {
    result = await runVersionCommand(execFile, executable, options);
  } catch (error) {
    const code = error?.code === 'ENOENT'
      ? CODEX_ERROR_CODES.EXECUTABLE_NOT_FOUND
      : CODEX_ERROR_CODES.VERSION_UNAVAILABLE;
    throw new CodexAppServerVersionError(code, code === CODEX_ERROR_CODES.EXECUTABLE_NOT_FOUND
      ? 'Codex executable was not found'
      : 'Codex executable version could not be detected');
  }

  const version = extractCodexVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!version) {
    throw new CodexAppServerVersionError(
      CODEX_ERROR_CODES.VERSION_UNAVAILABLE,
      'Codex executable version could not be detected',
    );
  }
  if (!isSupportedCodexVersion(version, minimumVersion)) {
    throw new CodexAppServerVersionError(
      CODEX_ERROR_CODES.VERSION_UNSUPPORTED,
      'Codex executable is below the supported app-server version',
    );
  }

  return {
    executable,
    version: version.text,
    minimumVersion,
    supported: true,
  };
};
