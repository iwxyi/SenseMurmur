import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { SessionLoopContinuation } from './sessionRunner';
import { readSessionLoopContinuation, writeSessionLoopContinuation } from './sessionLoopContinuationStore';

function continuation(context: string): SessionLoopContinuation {
  return {
    noSendContextKey: context,
    externalInputAnchor: null,
    anchorBranchName: undefined,
    consumedSpeakerIds: ['role-a'],
    consumedReplyDebtSpeakerIds: [],
    presenceByMemberId: [['role-a', 'online']],
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('session loop continuation store', () => {
  it('restores the completed turn snapshot in the same account and chat', async () => {
    await writeSessionLoopContinuation('chat-a', continuation('first'), 'account-a');
    expect(await readSessionLoopContinuation('chat-a', 'account-a')).toEqual(continuation('first'));
    await writeSessionLoopContinuation('chat-a', continuation('second'), 'account-a');
    expect(await readSessionLoopContinuation('chat-a', 'account-a')).toEqual(continuation('second'));
  });

  it('isolates account and conversation snapshots', async () => {
    await writeSessionLoopContinuation('chat-a', continuation('private'), 'account-a');
    expect(await readSessionLoopContinuation('chat-a', 'account-b')).toBeNull();
    expect(await readSessionLoopContinuation('chat-b', 'account-a')).toBeNull();
  });
});
