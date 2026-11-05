import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { generateResponse } from './aiClient';
import { createAgentTeamWorkflow, recoverAgentTeamRuns } from './agentTeamWorkflow';
import { currentWorkflowScope, indexedDbWorkflowRepository } from './workflowRunRuntime';
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

  it('recovers a stopped run without resending an in-flight model request', async () => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = currentWorkflowScope();
    const now = Date.now();
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({
      snapshot: {
        run: { id: runId, chatId: 'chat', goal: '写报告', status: 'active', generation: 1, planVersion: 1, planOpen: true, updatedAt: now },
        tasks: [
          { id: 'plan', runId, kind: 'team_plan', input: '写报告', dependsOn: [], status: 'running', attempt: 1, updatedAt: now },
          { id: 'later', runId, kind: 'agent_text', input: {}, dependsOn: ['plan'], status: 'waiting_dependency', attempt: 0, updatedAt: now },
        ],
      }, value: undefined,
    }));
    expect(await recoverAgentTeamRuns()).toBe(true);
    const saved = await indexedDbWorkflowRepository.read(scope, runId);
    expect(saved?.run.status).toBe('paused');
    expect(saved?.tasks.map((task) => task.status)).toEqual(['result_unknown', 'waiting_dependency']);
    expect(generate).not.toHaveBeenCalled();
  });

  it('stores an instruction only for a paused unstarted child task and uses it on resume', async () => {
    const runId = `team-${crypto.randomUUID()}`;
    const plan = {
      summary: '写报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理材料', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }],
      finalAcceptance: '可阅读',
    };
    const now = Date.now();
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-instruction-test');
    await indexedDbWorkflowRepository.transact('team-instruction-test', runId, () => ({
      snapshot: {
        run: { id: runId, chatId: 'chat', goal: '写报告', status: 'paused', generation: 1, planVersion: 2, planOpen: true, updatedAt: now },
        tasks: [
          { id: 'plan', runId, kind: 'team_plan', input: '写报告', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
          { id: 'write', runId, kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '写报告' }, dependsOn: ['plan'], status: 'queued', attempt: 0, updatedAt: now },
        ],
      }, value: undefined,
    }));
    await expect(scoped.instructQueuedTask(runId, 'write', 1, '用简体中文')).rejects.toThrow('团队计划已更新');
    const updated = await scoped.instructQueuedTask(runId, 'write', 2, '用简体中文');
    expect(updated.run.planVersion).toBe(3);
    expect(updated.tasks[1].input).toMatchObject({ userInstruction: '用简体中文' });
    await indexedDbWorkflowRepository.transact('team-instruction-test', runId, (current) => {
      if (!current) throw new Error('测试任务不存在');
      return { snapshot: { ...current, run: { ...current.run, status: 'active' } }, value: undefined };
    });
    await expect(scoped.instructQueuedTask(runId, 'write', 3, '执行中修改')).rejects.toThrow('请先暂停整个团队任务');
    await indexedDbWorkflowRepository.transact('team-instruction-test', runId, (current) => {
      if (!current) throw new Error('测试任务不存在');
      return { snapshot: { ...current, run: { ...current.run, status: 'paused' } }, value: undefined };
    });
    generate.mockResolvedValueOnce('中文报告');
    const result = await scoped.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(generate.mock.calls[0][2][0].content).toContain('用户补充指示：用简体中文');
    await expect(scoped.instructQueuedTask(runId, 'write', 3, '再次修改')).rejects.toThrow('请先暂停整个团队任务');
  });
});
