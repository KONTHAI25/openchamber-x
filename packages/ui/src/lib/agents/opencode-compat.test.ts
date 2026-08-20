import { describe, expect, test } from 'bun:test';
import type { JsonValue } from './contracts';
import {
  encodeCodexSessionId,
  isCodexSessionId,
  mapCodexNotification,
  mapCodexThreadRead,
  parseCodexThread,
  parseCodexThreadList,
  type CodexThreadRecord,
} from './opencode-compat';

const thread: CodexThreadRecord = {
  id: 'thread/one',
  cwd: '/work/project',
  name: 'Compatibility thread',
  modelProvider: 'openai',
  model: 'gpt-5.6-luna',
  createdAt: 20,
  updatedAt: 30,
  turns: [
    {
      id: 'turn-2',
      startedAt: 20,
      completedAt: 22,
      status: 'completed',
      items: [
        { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'second' }] },
        { id: 'agent-2', type: 'agentMessage', text: 'later' },
      ],
    },
    {
      id: 'turn-1',
      startedAt: 10,
      completedAt: 12,
      status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
        { id: 'agent-1', type: 'agentMessage', text: 'earlier' },
      ],
    },
  ],
};

describe('Codex OpenCode compatibility', () => {
  test('maps thread reads to synthetic sessions and chronological message records', () => {
    const result = mapCodexThreadRead({ thread });

    expect(result.session.id).toBe('codex:thread/one');
    expect(result.session.metadata?.openchamberBackend).toBe('codex');
    expect(result.messages.map((message) => message.info.id)).toEqual([
      'codex:user-1',
      'codex:agent-1',
      'codex:user-2',
      'codex:agent-2',
    ]);
    expect(result.messages[0]?.parts[0]?.type).toBe('text');
    if (result.messages[0]?.parts[0]?.type === 'text') expect(result.messages[0].parts[0].text).toBe('first');
    expect(result.messages[1]?.parts[0]?.type).toBe('text');
    if (result.messages[1]?.parts[0]?.type === 'text') expect(result.messages[1].parts[0].text).toBe('earlier');
  });

  test('parses list and read result envelopes strictly', () => {
    const listFixture: JsonValue = JSON.parse(JSON.stringify({ threads: [thread] }));
    const list = parseCodexThreadList(listFixture);
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data[0]?.id).toBe(thread.id);

    const readFixture: JsonValue = JSON.parse('{"id":"missing-cwd"}');
    const read = parseCodexThread(readFixture);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('malformed');
  });

  test('preserves stable synthetic session references', () => {
    const encoded = encodeCodexSessionId('thread/one');
    expect(encoded).toBe('codex:thread/one');
    expect(isCodexSessionId(encoded)).toBe(true);
    expect(isCodexSessionId('session_1')).toBe(false);
  });

  test('maps lifecycle, streaming, approval, and user-input notifications', () => {
    const started = mapCodexNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(started?.type).toBe('session.status');
    if (started?.type === 'session.status') expect(started.properties.sessionID).toBe('codex:thread-1');

    const delta = mapCodexNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'item-1', delta: 'hello' },
    });
    expect(delta?.type).toBe('message.part.delta');
    if (delta?.type === 'message.part.delta') {
      expect(delta.properties.sessionID).toBe('codex:thread-1');
      expect(delta.properties.partID).toBe('codex:item-1');
      expect(delta.properties.field).toBe('text');
      expect(delta.properties.delta).toBe('hello');
    }

    const approval = mapCodexNotification({
      method: 'item/commandExecution/requestApproval',
      id: 7,
      params: { threadId: 'thread-1', itemId: 'item-1', command: 'git status' },
    });
    expect(approval?.type).toBe('permission.asked');
    if (approval?.type === 'permission.asked') {
      expect(approval.properties.permission).toBe('command');
      expect(approval.properties.patterns).toEqual(['git status']);
    }

    const question = mapCodexNotification({
      method: 'item/tool/requestUserInput',
      id: 'request-1',
      params: {
        threadId: 'thread-1',
        itemId: 'item-1',
        questions: [{ header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'First' }] }],
      },
    });
    expect(question?.type).toBe('question.asked');
    if (question?.type === 'question.asked') expect(question.properties.id).toBe('codex:request-1');

    expect(mapCodexNotification({ method: 'future/event', params: {} })).toBeNull();
  });
});
