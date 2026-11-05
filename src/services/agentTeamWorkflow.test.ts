import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { generateResponse } from './aiClient';
import { createAgentTeamWorkflow } from './agentTeamWorkflow';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';

vi.mock('./aiClient', () => ({ generateResponse: vi.fn() }));
const generate = vi.mocked(generateResponse);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback?: (lock: object) => Promise<unknown>) => (callback || _options as (lock: object) => Promise<unknown>)({}) } });
  generate.mockReset();
});

describe('agent team workflow', () => {
  it('persists a plan, executes dependent roles with upstream output, then closes the run', async () => {
    const plan = {
      summary: '调研后写摘要',
      roles: [{ id: 'analyst', name: '分析员', responsibility: '研究问题', method: '逐项分析', acceptance: '列出结论', allowedTools: ['text_generation'] }],
      tasks: [
        { id: 'research', roleId: 'analyst', goal: '分析需求', dependsOn: [], acceptance: '有结论' },
        { id: 'report', roleId: 'analyst', goal: '写报告', dependsOn: ['research'], acceptance: '覆盖结论' },
      ],
      finalAcceptance: '报告完成',
    };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('需求结论').mockResolvedValueOnce('最终报告');
    const runId = crypto.randomUUID();
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-test');
    const result = await scoped.start(runId, 'chat', '做一份报告');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2][2][0].content).toContain('需求结论');
    await scoped.resume(runId);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('publishes one visible message and one document across repeated deliveries', async () => {
    const runId = crypto.randomUUID();
    const chatId = `team-chat-${runId}`;
    const chat = { id: chatId, type: 'assistant', name: '团队交付', memberIds: [], deletedAt: null };
    useChatStore.setState((state) => ({ chats: [...state.chats, chat as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '交付报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '写报告', method: '整理材料', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }],
      finalAcceptance: '报告可读',
    })).mockResolvedValueOnce('完成的报告');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-publish-test');
    await workflow.start(runId, chatId, '交付报告');
    const first = await workflow.publish(runId);
    const second = await workflow.publish(runId);
    expect(first.id).toBe(second.id);
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId).filter((item) => item.sourceMessageId === `team-delivery-${runId}`)).toHaveLength(1);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.filter((item) => item.id === `team-delivery-${runId}`)).toHaveLength(1);
  });
});
