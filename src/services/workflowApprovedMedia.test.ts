import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Message, MessageAttachment } from '../types/message';
import { api } from './api';
import { prepareAiMediaTask } from './aiClient';
import { readApprovedWorkflowMedia } from './workflowApprovedMedia';
import { createWorkflowRunRuntime, indexedDbWorkflowRepository, type WorkflowSnapshot } from './workflowRunRuntime';

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
});
afterEach(() => vi.restoreAllMocks());

describe('approved workflow media at queue submission', () => {
  it('leaves ordinary unsigned messages on their existing path', async () => {
    expect(await readApprovedWorkflowMedia({} as Message, {} as MessageAttachment)).toBeUndefined();
  });

  it.each(['valid', 'wrong-chat', 'wrong-attempt', 'wrong-key', 'wrong-quote', 'missing-usage', 'paused'] as const)(
    'checks persisted approval and invocation before submission: %s', async (variation) => {
      const runId = crypto.randomUUID();
      const usage = { schemaVersion: 1 as const, runId, taskId: 'music', attempt: 1, kind: 'tool' as const };
      const now = Date.now();
      vi.spyOn(api, 'quoteAiMedia').mockResolvedValue({ schemaVersion: 1, id: 'a'.repeat(64), model: 'fixture-music', modality: 'audio',
        requestSha256: 'b'.repeat(64), costQuoteId: 'c'.repeat(64), amount: '1.000000', unit: 'point', kind: 'request_tariff',
        capturedAt: now, expiresAt: now + 300000, token: 'd'.repeat(64) });
      const initial: WorkflowSnapshot = { run: { id: runId, chatId: 'chat', goal: '制作音乐', status: 'active', planVersion: 1, generation: 0, updatedAt: now },
        tasks: [{ id: 'music', runId, kind: 'agent_audio', input: '音乐', dependsOn: [], status: 'queued', attempt: 0, updatedAt: now }] };
      const check = vi.fn(async (message: Message, attachment: MessageAttachment) => readApprovedWorkflowMedia(message, attachment));
      const runtime = createWorkflowRunRuntime(indexedDbWorkflowRepository, {
        tracksToolInvocations: true,
        approvalRequirement: (task) => ({ summary: '生成音乐', consequences: '产生费用', mediaExecution: task.approvals?.at(-1)?.mediaExecution }),
        prepareApprovalRequirement: async (_task, _snapshot, requirement, signal) => requirement.mediaExecution ? requirement : {
          ...requirement, mediaExecution: await prepareAiMediaTask({ profile: { provider: 'official-ace', model: 'fixture-music' },
            prompt: '森林配乐', clientRequestKey: runId, aiUsage: { type: 'audio_generation', resourceId: 'chat', workflow: usage }, signal }),
        },
        execute: async (task, _signal, context) => {
          await context.beginToolInvocation();
          const attachment: MessageAttachment = { id: 'audio', kind: 'audio', status: 'queued', altText: '音乐', createdAt: now, updatedAt: now,
            executionQuoteId: task.approvals!.at(-1)!.mediaExecution!.quote.id, generationJobId: runId };
          const message: Message = { id: 'message', chatId: 'chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '音乐',
            emotion: 0, timestamp: now, isDeleted: false, metadata: { workflowUsage: usage, attachments: [attachment] } };
          if (variation === 'wrong-chat') message.chatId = 'other';
          if (variation === 'wrong-attempt') message.metadata!.workflowUsage = { ...usage, attempt: 2 };
          if (variation === 'wrong-key') attachment.generationJobId = 'other';
          if (variation === 'wrong-quote') attachment.executionQuoteId = 'other';
          if (variation === 'missing-usage') message.metadata!.workflowUsage = undefined;
          if (variation === 'paused') await runtime.pause(runId);
          if (variation === 'valid') expect(await check(message, attachment)).toEqual(task.approvals!.at(-1)!.mediaExecution);
          else await expect(check(message, attachment)).rejects.toThrow();
          return { output: 'checked' };
        },
      });
      await runtime.create(initial);
      await runtime.resume(runId);
      await runtime.decideApproval(runId, 'music', 1, 'approved');
      await runtime.resume(runId);
      expect(check).toHaveBeenCalledOnce();
    },
  );
});
