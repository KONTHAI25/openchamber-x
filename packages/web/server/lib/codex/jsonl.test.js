import { describe, expect, it } from 'bun:test';
import {
  createJsonlDecoder,
  encodeJsonRpcRequest,
  parseJsonRpcLine,
} from './jsonl.js';

describe('Codex app-server JSONL protocol', () => {
  it('decodes split UTF-8 JSONL frames and ignores blank lines', () => {
    const messages = [];
    const decoder = createJsonlDecoder({ onMessage: (message) => messages.push(message) });
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { delta: '✓' },
    });
    const encoded = Buffer.from(`${frame}\r\n\n`);
    decoder.push(encoded.subarray(0, encoded.length - 2));
    decoder.push(encoded.subarray(encoded.length - 2));

    expect(messages).toEqual([{
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: { delta: '✓' },
    }]);
  });

  it('parses responses and rejects malformed JSON-RPC messages', () => {
    expect(parseJsonRpcLine('{"id":4,"result":{"ok":true}}')).toEqual({
      kind: 'response',
      id: 4,
      result: { ok: true },
    });
    expect(() => parseJsonRpcLine('{"jsonrpc":"2.0","id":4}')).toThrow(/protocol/i);
    expect(() => parseJsonRpcLine('{not-json}')).toThrow(/JSON/i);
  });

  it('keeps request framing line-delimited and omits undefined params', () => {
    expect(encodeJsonRpcRequest(9, 'initialize')).toBe(
      '{"id":9,"method":"initialize"}\n',
    );
  });
});
