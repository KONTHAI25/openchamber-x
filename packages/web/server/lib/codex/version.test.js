import { describe, expect, it, mock } from 'bun:test';
import {
  compareCodexVersions,
  detectCodexExecutable,
  extractCodexVersion,
  isSupportedCodexVersion,
} from './version.js';

describe('Codex executable version detection', () => {
  it('extracts CLI versions without retaining command output', () => {
    expect(extractCodexVersion('codex-cli 0.148.0\n')).toMatchObject({ text: '0.148.0' });
    expect(isSupportedCodexVersion('0.148.0')).toBe(true);
    expect(isSupportedCodexVersion('0.147.9')).toBe(false);
    expect(compareCodexVersions('0.148.0-beta.1', '0.148.0')).toBe(-1);
  });

  it('checks the executable with injected process execution', async () => {
    const execFile = mock((_file, _args, _options, callback) => {
      callback(null, 'codex-cli 0.149.1\n', '');
      return undefined;
    });
    await expect(detectCodexExecutable({ executable: 'codex', execFile })).resolves.toMatchObject({
      version: '0.149.1',
      supported: true,
    });
    expect(execFile).toHaveBeenCalledWith('codex', ['--version'], expect.objectContaining({
      encoding: 'utf8',
    }), expect.any(Function));
  });

  it('reports unsupported versions as a typed, non-content error', async () => {
    const execFile = (_file, _args, _options, callback) => {
      const error = new Error('private output should not escape');
      error.code = 'ENOENT';
      callback(error);
    };
    await expect(detectCodexExecutable({ execFile })).rejects.toMatchObject({
      code: 'CODEX_EXECUTABLE_NOT_FOUND',
      message: 'Codex executable was not found',
    });
  });
});
