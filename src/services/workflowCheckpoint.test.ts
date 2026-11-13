import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { api, ApiError } from './api';
import { setChatExecutionFence, clearChatExecutionFence } from './chatExecutionFence';
import { indexedDbWorkflowRepository } from './workflowRunRuntime';
import { assertWorkflowCheckpointCurrent, pullNewWorkflowCheckpoint, pushWorkflowCheckpoint, validateWorkflowCheckpoint } from './workflowCheckpoint';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const checkpoint = { schemaVersion: 1, data: { snapshot: { schemaVersion: 1,
  run: { schemaVersion: 1, id: 'run', chatId: 'chat', goal: 'test', status: 'paused', generation: 0, planVersion: 1, updatedAt: 1 },
  tasks: [{ schemaVersion: 1, id: 'task', runId: 'run', kind: 'agent_text', input: 'private',
    dependsOn: [], status: 'completed', output: 'result', attempt: 1, updatedAt: 1 }] }, outbox: [], attempts: [], revisions: [], consumers: [] } };

describe('workflow cloud checkpoint', () => {
  it('accepts only a versioned checkpoint for the requested run and chat', () => {
    expect(validateWorkflowCheckpoint(checkpoint, 'run', 'chat')).toEqual(checkpoint);
    expect(() => validateWorkflowCheckpoint(checkpoint, 'other', 'chat')).toThrow('归属');
    expect(() => validateWorkflowCheckpoint(checkpoint, 'run', 'other')).toThrow('归属');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, schemaVersion: 2 }, 'run', 'chat')).toThrow('版本');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, data: { ...checkpoint.data, snapshot: { ...checkpoint.data.snapshot,
      tasks: [{ ...checkpoint.data.snapshot.tasks[0], schemaVersion: 2 }] } } }, 'run', 'chat')).toThrow('版本');
    expect(() => validateWorkflowCheckpoint({ ...checkpoint, data: { ...checkpoint.data, snapshot: { ...checkpoint.data.snapshot,
      tasks: [{ ...checkpoint.data.snapshot.tasks[0], status: 'forged' }] } } }, 'run', 'chat')).toThrow('状态');
  });

  it('moves a run between isolated local scopes and blocks an old device before execution', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const runId = `run-${crypto.randomUUID()}`;
    const chatId = `chat-${crypto.randomUUID()}`;
    const source = `device-a-${runId}`;
    const target = `device-b-${runId}`;
    const snapshot = { ...checkpoint.data.snapshot, run: { ...checkpoint.data.snapshot.run, id: runId, chatId },
      tasks: checkpoint.data.snapshot.tasks.map((task) => ({ ...task, runId })) };
    await indexedDbWorkflowRepository.transact(source, runId, () => ({ snapshot, value: undefined }));
    let remote: { revision: number; sha256: string; chatId: string; payload: unknown } | null = null;
    const get = vi.spyOn(api, 'getWorkflowCheckpoint').mockImplementation(async () => {
      if (!remote) throw new ApiError('missing', { status: 404, code: 'NOT_FOUND' });
      return { ...remote, runId, updatedAt: Date.now(), payload: remote.payload as typeof checkpoint };
    });
    const put = vi.spyOn(api, 'putWorkflowCheckpoint').mockImplementation(async (_id, input) => {
      if (input.expectedRevision !== (remote?.revision ?? 0)) throw new Error('revision conflict');
      const sha256Value = bytesToHex(sha256(utf8ToBytes(JSON.stringify(input.payload))));
      remote = { revision: input.expectedRevision + 1, sha256: sha256Value, chatId, payload: input.payload };
      return { runId, chatId, revision: remote.revision, sha256: remote.sha256 };
    });
    const fence = { ownerId: crypto.randomUUID(), generation: 1 };
    setChatExecutionFence(chatId, fence);
    try {
      const first = await pushWorkflowCheckpoint(source, runId);
      expect(first.revision).toBe(1);
      const imported = await pullNewWorkflowCheckpoint(target, runId, chatId);
      expect(imported).toEqual(snapshot);
      await assertWorkflowCheckpointCurrent(target, runId, chatId);
      await indexedDbWorkflowRepository.transact(target, runId, (current) => ({ snapshot: {
        ...current!, run: { ...current!.run, status: 'paused' as const, updatedAt: Date.now() },
      }, value: undefined }));
      expect((await pushWorkflowCheckpoint(target, runId)).revision).toBe(2);
      await expect(assertWorkflowCheckpointCurrent(source, runId, chatId)).rejects.toThrow('不同进度');
      await expect(pushWorkflowCheckpoint(source, runId)).rejects.toThrow('不同进度');
      expect(put).toHaveBeenCalledTimes(2);
    } finally {
      clearChatExecutionFence(chatId, fence);
      get.mockRestore(); put.mockRestore(); vi.unstubAllGlobals();
    }
  });
});
