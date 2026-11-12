import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { generateResponse, listAvailableModels } from './aiClient';
import { buildAgentTeamTaskRevisionRequest, createAgentTeamWorkflow, isRecoverableAgentTeamRun, recoverAgentTeamRuns } from './agentTeamWorkflow';
import { currentWorkflowScope, indexedDbWorkflowRepository, type WorkflowSnapshot } from './workflowRunRuntime';
import { workflowToolInvocationId, workflowToolOperationKey } from './workflowToolInvocation';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import { api as appApi } from './api';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamVideoAttachment, queueAgentTeamVideo } from './agentTeamVideoTask';
import { inspectAgentTeamImageAttachment, queueAgentTeamImage, teamImageReference } from './agentTeamImageTask';
import { inspectAgentTeamImages } from './agentTeamImageInspection';
import { inspectAgentTeamAudioAttachment, queueAgentTeamAudio } from './agentTeamAudioTask';
import { describeWorkflowToolRequest } from './workflowToolRequest';
import { conversationExecutionLockName } from './conversationExecutionLock';
import { composeAgentTeamMedia, inspectAgentTeamComposition, teamMediaAttachment } from './agentTeamMediaComposition';
import { inspectAgentTeamVideo } from './agentTeamVideoInspection';
import { defaultWorkflowGoalSpec } from './workflowGoalSpec';
import { countWorkflowModelCalls } from './workflowRunRuntime';
import { listTeamSavedMedia } from './agentTeamSavedMedia';
import { listTeamSavedText } from './agentTeamSavedText';
import * as persistence from '../stores/storePersistenceScope';
import { parseTeamReviewInput, teamReviewLeafSources, TEAM_REVIEW_EVIDENCE_LIMIT } from './agentTeamReviewEvidence';
import { workflowJsonDigest } from './workflowToolRequest';
import { validateAgentTeamPlan } from './agentTeamPlan';

vi.mock('./agentTeamMediaComposition', () => ({ canComposeTeamMedia: () => true, composeAgentTeamMedia: vi.fn(), inspectAgentTeamComposition: vi.fn(), teamMediaAttachment: vi.fn() }));
vi.mock('./agentTeamVideoInspection', () => ({ inspectAgentTeamVideo: vi.fn() }));

vi.mock('./agentTeamImageInspection', () => ({ inspectAgentTeamImages: vi.fn() }));
vi.mock('./agentTeamAudioTask', () => ({ inspectAgentTeamAudioAttachment: vi.fn(), queueAgentTeamAudio: vi.fn() }));

describe('agent team child collaboration', () => {
  it('selects only paused runs with work that can resume without guessing an unknown result', () => {
    const base: WorkflowSnapshot = {
      run: { id: 'run', chatId: 'chat', goal: 'goal', status: 'paused', generation: 1, planVersion: 1, planOpen: true, updatedAt: 1 },
      tasks: [{ id: 'task', runId: 'run', kind: 'agent_text', input: {}, dependsOn: [], status: 'queued', attempt: 0, updatedAt: 1 }],
    };
    expect(isRecoverableAgentTeamRun(base)).toBe(true);
    expect(isRecoverableAgentTeamRun({ ...base, run: { ...base.run, maxModelCalls: 1 }, tasks: [{ ...base.tasks[0], kind: 'agent_text', attempt: 1 }] })).toBe(false);
    expect(isRecoverableAgentTeamRun({ ...base, run: { ...base.run, maxModelCalls: 1 }, tasks: [
      { ...base.tasks[0], status: 'completed', attempt: 1 },
      { ...base.tasks[0], id: 'media', kind: 'agent_video', status: 'waiting_external', externalTaskId: 'submitted-video', attempt: 1 },
    ] })).toBe(true);
    expect(isRecoverableAgentTeamRun({ ...base, tasks: [{ ...base.tasks[0], status: 'result_unknown' }] })).toBe(false);
    expect(isRecoverableAgentTeamRun({ ...base, tasks: [{ ...base.tasks[0], status: 'waiting_user' }] })).toBe(false);
    expect(isRecoverableAgentTeamRun({ ...base, run: { ...base.run, status: 'completed' } })).toBe(false);
  });

  it('turns a completed child instruction into a role-scoped main-agent revision request', () => {
    const request = buildAgentTeamTaskRevisionRequest({
      id: 'research', runId: 'run', kind: 'agent_text',
      input: {
        task: { id: 'research', roleId: 'analyst', goal: '研究竞品', dependsOn: [], acceptance: '给出来源和结论' },
        role: { id: 'analyst', name: '市场分析师', responsibility: '分析市场', method: '比较公开资料', acceptance: '有证据' },
        goal: '研究产品机会',
      },
      output: '竞品多使用订阅制', dependsOn: [], status: 'completed', attempt: 1, updatedAt: 1,
    }, '补充日本市场，并给出数据年份');
    expect(request).toContain('市场分析师');
    expect(request).toContain('原任务：研究竞品');
    expect(request).toContain('原验收：给出来源和结论');
    expect(request).toContain('用户给该子 Agent 的新指示：补充日本市场，并给出数据年份');
  });

  it('rejects instructions for tasks without a confirmed completed delivery', () => {
    expect(() => buildAgentTeamTaskRevisionRequest({
      id: 'research', runId: 'run', kind: 'agent_text', input: {},
      dependsOn: [], status: 'result_unknown', attempt: 1, updatedAt: 1,
    }, '继续')).toThrow('只有已完成的子 Agent 任务');
  });
});

vi.mock('./agentTeamVideoTask', () => ({
  inspectAgentTeamVideoAttachment: vi.fn(),
  queueAgentTeamVideo: vi.fn(),
}));
vi.mock('./agentTeamImageTask', () => ({
  inspectAgentTeamImageAttachment: vi.fn(),
  queueAgentTeamImage: vi.fn(),
  teamImageReference: vi.fn(),
}));

vi.spyOn(appApi, 'searchWeb');
const search = vi.mocked(appApi.searchWeb);

vi.mock('./aiClient', () => ({ generateResponse: vi.fn(), listAvailableModels: vi.fn() }));
const generate = vi.mocked(generateResponse);

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback?: (lock: object) => Promise<unknown>) => (callback || _options as (lock: object) => Promise<unknown>)({}) } });
  useChatStore.setState((state) => ({ chats: [...state.chats.filter((chat) => chat.id !== 'chat'),
    { id: 'chat', type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
  generate.mockReset();
  vi.mocked(listAvailableModels).mockReset();
  vi.mocked(listAvailableModels).mockResolvedValue([{ id: 'MiniMax-H3', label: 'MiniMax H3', raw: { aceVideoOptions: { acceptsReferenceImages: true } } }]);
  search.mockReset();
  vi.mocked(inspectAgentTeamVideoAttachment).mockReset();
  vi.mocked(queueAgentTeamVideo).mockReset();
  vi.mocked(inspectAgentTeamImageAttachment).mockReset();
  vi.mocked(queueAgentTeamImage).mockReset();
  vi.mocked(teamImageReference).mockReset();
  vi.mocked(inspectAgentTeamImages).mockReset();
  vi.mocked(inspectAgentTeamAudioAttachment).mockReset();
  vi.mocked(queueAgentTeamAudio).mockReset();
  vi.mocked(composeAgentTeamMedia).mockReset();
  vi.mocked(inspectAgentTeamComposition).mockReset();
  vi.mocked(teamMediaAttachment).mockReset();
  vi.mocked(inspectAgentTeamVideo).mockReset();
});

describe('agent team workflow', () => {
  it.each([false, true])('gates actual image dispatch through persisted approval (model proposal: %s)', async (modelProposal) => {
    const runId = crypto.randomUUID();
    const scope = `approval-${runId}`;
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    useSettingsStore.setState({ aiProfiles: [{ id: 'image', name: '图片', type: 'image', provider: 'official-ace',
      apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true,
      imageCapabilities: { textToImage: true, referenceImage: true, multiReferenceImage: false, seed: false, negativePrompt: false } }] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '森林插画', roles: [{ id: 'artist', name: '画师',
      responsibility: '绘制', method: '生成', acceptance: '图片', allowedTools: ['image_generation'] }],
      tasks: [{ id: 'scene', roleId: 'artist', goal: '绘制森林', dependsOn: [], tool: 'image_generation', acceptance: '森林图',
        ...(modelProposal ? { approval: { summary: '确认森林画面', consequences: '生成会产生费用，价格以服务结算为准' } } : {}) }],
      finalAcceptance: '图片已保存' }));
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片已保存' });
    const goalSpec = { ...defaultWorkflowGoalSpec('绘制森林'), ...(!modelProposal ? { approvalTools: ['image_generation' as const] } : {}) };
    const initial = await createAgentTeamWorkflow(config, () => scope).start(runId, 'chat', '绘制森林', false, undefined, undefined, goalSpec);
    expect(initial.snapshot.tasks.find((task) => task.id === 'scene')).toMatchObject({ status: 'waiting_user', attempt: 0 });
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
    const restored = createAgentTeamWorkflow(config, () => scope);
    const waiting = await restored.resume(runId);
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
    await restored.decideApproval(runId, 'scene', waiting.snapshot.run.planVersion, 'approved');
    const approvedDigest = waiting.snapshot.tasks.find((task) => task.id === 'scene')?.approvals?.at(-1)?.executionSha256;
    useSettingsStore.setState((state) => ({ aiProfiles: state.aiProfiles.map((profile) => ({ ...profile, defaultImageSize: '2K' as const })) }));
    const changed = await restored.resume(runId);
    const changedTask = changed.snapshot.tasks.find((task) => task.id === 'scene');
    expect(changedTask?.status).toBe('waiting_user');
    expect(changedTask?.approvals).toHaveLength(2);
    expect(changedTask?.approvals?.at(-1)?.executionSha256).not.toBe(approvedDigest);
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
    await restored.decideApproval(runId, 'scene', changed.snapshot.run.planVersion, 'approved');
    const finished = await restored.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(queueAgentTeamImage).toHaveBeenCalledTimes(1);
    await restored.resume(runId);
    expect(queueAgentTeamImage).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('persists user questions across recovery and passes only real saved answers to downstream work', async () => {
    const runId = crypto.randomUUID();
    const scope = `user-response-${runId}`;
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const role = { id: 'analyst', name: '分析师', responsibility: '需求分析', method: '先确认关键事实',
      acceptance: '可执行建议', allowedTools: ['user_input', 'text_generation'] };
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '确认市场后研究', roles: [role], tasks: [
      { id: 'question', roleId: role.id, goal: '目标市场是哪里？', tool: 'user_input', dependsOn: [], acceptance: '用户明确市场' },
      { id: 'audience', roleId: role.id, goal: '目标用户是谁？', tool: 'user_input', dependsOn: [], acceptance: '用户明确受众' },
      { id: 'independent', roleId: role.id, goal: '列出分析框架', tool: 'text_generation', dependsOn: [], acceptance: '框架' },
      { id: 'report', roleId: role.id, goal: '研究市场', tool: 'text_generation', dependsOn: ['question', 'audience'], acceptance: '对应目标市场和受众' },
    ], finalAcceptance: '建议' })).mockResolvedValueOnce('分析框架');
    const started = await createAgentTeamWorkflow(config, () => scope).start(runId, 'chat', '研究产品', false);
    expect(started.snapshot.run.status).toBe('paused');
    expect(started.snapshot.tasks.find((task) => task.id === 'question')?.status).toBe('waiting_user');
    expect(started.snapshot.tasks.find((task) => task.id === 'independent')?.status).toBe('completed');
    expect(countWorkflowModelCalls(started.snapshot)).toBe(2);
    const restored = createAgentTeamWorkflow(config, () => scope);
    const waiting = await restored.resume(runId);
    expect(waiting.snapshot.run.status).toBe('paused');
    expect(generate).toHaveBeenCalledTimes(2);
    const version = waiting.snapshot.run.planVersion;
    for (const answer of ['', '  ', 'a'.repeat(4001)]) {
      await expect(restored.answerUserInput(runId, 'question', version, answer)).rejects.toThrow('1 到 4000');
    }
    await expect(restored.answerUserInput(runId, 'report', version, '无效')).rejects.toThrow('没有等待');
    const saved = await restored.answerUserInput(runId, 'question', version, '  日本市场  ');
    const question = saved.tasks.find((task) => task.id === 'question')!;
    expect(saved.run.planVersion).toBe(version + 1);
    expect(question.output).toBe('日本市场');
    expect(question.userResponse).toMatchObject({ schemaVersion: 1, runId, taskId: 'question', actor: 'local_user',
      planVersion: version, inputSha256: workflowJsonDigest(question.input), outputSha256: workflowJsonDigest('日本市场') });
    await expect(restored.answerUserInput(runId, 'audience', version, '开发者')).rejects.toThrow('计划已更新');
    await expect(restored.answerUserInput(runId, 'question', saved.run.planVersion, '替换')).rejects.toThrow('没有等待');
    await indexedDbWorkflowRepository.registerOutboxConsumer(scope, runId, 'test-reader');
    const before = await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'test-reader', 1000);
    await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => ({ snapshot: { ...current!,
      tasks: current!.tasks.map((task) => task.id === 'question' ? { ...task, userResponse: undefined } : task) }, value: undefined })))
      .rejects.toThrow('缺少版本依据');
    await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => ({ snapshot: { ...current!,
      tasks: current!.tasks.map((task) => task.id === 'question' ? { ...task, userResponse: { ...task.userResponse!, respondedAt: 0 } } : task) }, value: undefined })))
      .rejects.toThrow('已保存的用户答复不可修改');
    expect(await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'test-reader', 1000)).toEqual(before);
    const stillWaiting = await restored.resume(runId);
    expect(stillWaiting.snapshot.run.status).toBe('paused');
    expect(generate).toHaveBeenCalledTimes(2);
    await restored.answerUserInput(runId, 'audience', saved.run.planVersion, '开发者');
    generate.mockResolvedValueOnce('日本开发者市场报告');
    const finished = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(JSON.stringify(generate.mock.lastCall?.[2])).toContain('日本市场');
    expect(JSON.stringify(generate.mock.lastCall?.[2])).toContain('开发者');
    expect(countWorkflowModelCalls(finished.snapshot)).toBe(3);
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(3);
    const attempts = await indexedDbWorkflowRepository.listTaskAttempts(scope, runId, 'question');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('completed');
  });

  it('rejects questions when the saved goal contract does not authorize user_input', async () => {
    const spec = defaultWorkflowGoalSpec('独立研究');
    spec.allowedTools = spec.allowedTools.filter((tool) => tool !== 'user_input');
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '提问', roles: [{ id: 'lead', name: '研究员', responsibility: '研究',
      method: '核实', acceptance: '完整', allowedTools: ['user_input'] }], tasks: [
      { id: 'question', roleId: 'lead', goal: '哪个市场？', tool: 'user_input', dependsOn: [], acceptance: '明确' },
    ], finalAcceptance: '完成' }));
    const scope = crypto.randomUUID();
    const result = await createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope)
      .start(crypto.randomUUID(), 'chat', '独立研究', false, undefined, undefined, spec);
    expect(result.snapshot.run.status).toBe('failed');
    expect(result.snapshot.tasks).toHaveLength(1);
    expect(result.snapshot.tasks[0].error).toMatch(/授权|允许/);
  });

  it.each([false, true])('safely restores an interrupted local question (application recovery: %s)', async (applicationRecovery) => {
    const runId = crypto.randomUUID();
    const scope = applicationRecovery ? currentWorkflowScope() : crypto.randomUUID();
    const now = Date.now();
    const role = { id: 'lead', name: '研究员', responsibility: '研究', method: '询问', acceptance: '答复', allowedTools: ['user_input'] };
    const question = { id: 'question', roleId: 'lead', goal: '目标市场？', tool: 'user_input', dependsOn: [], acceptance: '明确' };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '研究', status: 'active', generation: 1, planVersion: 2, planOpen: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '研究', output: { summary: '提问', roles: [role], tasks: [question], finalAcceptance: '答复' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'question', runId, kind: 'agent_user_input', input: { task: question, role, goal: '研究' }, dependsOn: ['plan'], status: 'running', attempt: 1, updatedAt: now },
      ],
    }, value: undefined }));
    if (applicationRecovery) {
      expect(await recoverAgentTeamRuns()).toBe(true);
      expect((await indexedDbWorkflowRepository.read(scope, runId))?.tasks[1].status).toBe('queued');
    }
    const result = await createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope).resume(runId);
    expect(result.snapshot.run.status).toBe('paused');
    expect(result.snapshot.tasks[1].status).toBe('waiting_user');
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['budget', 'reject', 'retry', 'abandon'] as const)('persists bounded review layers across %s recovery', async (scenario) => {
    const runId = crypto.randomUUID();
    const scope = `batch-review-${runId}`;
    const now = Date.now();
    const role = { id: 'writer', name: '作者', responsibility: '研究', method: '核查', acceptance: '完整', allowedTools: ['text_generation'] };
    const taskSpecs = Array.from({ length: 40 }, (_, index) => ({ id: `note_${index}`, roleId: role.id,
      goal: '任务目标'.repeat(250), acceptance: '验收条件'.repeat(100), dependsOn: [], tool: 'text_generation' }));
    const spec = defaultWorkflowGoalSpec('完整报告');
    spec.execution.maxAutomaticReviewRounds = 1;
    const snapshot: WorkflowSnapshot = {
      run: { id: runId, chatId: 'chat', goal: '完整报告', goalSpec: spec, status: 'paused', generation: 1,
        planVersion: 2, planOpen: true, autoReview: true, ...(['budget', 'abandon'].includes(scenario) ? { maxModelCalls: 43 } : {}), updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '完整报告', output: { summary: '报告', roles: [role], tasks: taskSpecs, finalAcceptance: '全部完整' },
          dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        ...taskSpecs.map((task) => ({ id: task.id, runId, kind: 'agent_text', input: { task, role, goal: '完整报告' },
          output: `正文${task.id}`.repeat(500), dependsOn: ['plan'], status: 'completed' as const, attempt: 1, updatedAt: now })),
      ],
    };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    let requests = 0;
    const seenLeaves = new Set<string>();
    generate.mockImplementation(async (_config, _system, messages) => {
      const evidence = JSON.parse(messages[0].content.split('项已完成记录未列出）：')[1]);
      expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(TEAM_REVIEW_EVIDENCE_LIMIT);
      for (const entry of evidence) if (entry.kind === 'agent_text') seenLeaves.add(entry.task);
      const index = requests++;
      if (scenario === 'retry' && index === 0) return '{invalid';
      return JSON.stringify(scenario === 'reject' && index === 0
        ? { complete: false, reason: '第一批缺少来源', nextRequest: '核查第一批来源' }
        : { complete: true, reason: '本次审核通过' });
    });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    let result = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    const completedBefore = result.snapshot.tasks.filter((task) => task.kind === 'team_review' && task.status === 'completed');
    if (scenario === 'abandon') {
      expect(requests).toBe(2);
      const pending = result.snapshot.tasks.filter((task) => task.kind === 'team_review' && task.status !== 'completed').slice(0, 2);
      await indexedDbWorkflowRepository.transact(scope, runId, (current) => ({ snapshot: { ...current!,
        tasks: current!.tasks.map((task) => pending.some((item) => item.id === task.id) ? { ...task, status: 'result_unknown', attempt: 1 } : task) }, value: undefined }));
      const restarted = createAgentTeamWorkflow(config, () => scope);
      const abandoned = await restarted.abandonUnknownReview(runId, pending[0].id, result.snapshot.run.planVersion);
      expect(abandoned.tasks.filter((task) => task.kind === 'team_review' && task.status !== 'completed').every((task) => task.status === 'abandoned')).toBe(true);
      for (const task of completedBefore) expect(abandoned.tasks.find((item) => item.id === task.id)?.output).toEqual(task.output);
      const added = await restarted.addRevisionRequest(runId, abandoned.run.planVersion, '仅根据已有报告补充结论');
      await restarted.setModelCallLimit(runId, added.run.planVersion);
      generate.mockReset();
      generate.mockResolvedValueOnce(JSON.stringify({ summary: '补充', roles: [role], tasks: [{ ...taskSpecs[0], id: 'followup', goal: '补充结论' }], finalAcceptance: '完成' }))
        .mockResolvedValueOnce('补充结论');
      const finished = await restarted.resume(runId);
      expect(finished.snapshot.run.status, JSON.stringify(finished.snapshot.tasks.filter((task) => task.error).map((task) => ({ id: task.id, error: task.error })))).toBe('completed');
      expect(generate).toHaveBeenCalledTimes(2);
      return;
    }
    if (scenario === 'budget') {
      expect(requests).toBe(2);
      expect(result.snapshot.run.status).toBe('paused');
      const pending = result.snapshot.tasks.find((task) => task.kind === 'team_review' && task.status !== 'completed')!;
      await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => ({ snapshot: { ...current!,
        tasks: current!.tasks.map((task) => task.id === pending.id ? { ...task, input: { ...parseTeamReviewInput(task.input), sourceTaskIds: ['note_0'] } } : task) }, value: undefined })))
        .rejects.toThrow('分批审核范围不可修改');
      const restarted = createAgentTeamWorkflow(config, () => scope);
      await restarted.setModelCallLimit(runId, result.snapshot.run.planVersion);
      result = await restarted.resume(runId);
    } else if (scenario === 'retry') {
      const failed = result.snapshot.tasks.find((task) => task.kind === 'team_review' && task.status === 'failed')!;
      expect(failed.error).toContain('无效 JSON');
      const restarted = createAgentTeamWorkflow(config, () => scope);
      await restarted.retryFailedReview(runId, failed.id, result.snapshot.run.planVersion);
      result = await restarted.resume(runId);
      expect(result.snapshot.tasks.find((task) => task.id === failed.id)?.attempt).toBe(2);
    }
    const root = result.snapshot.tasks.find((task) => task.id === 'review_1')!;
    expect(root.status).toBe('completed');
    expect(root.output).toMatchObject({ complete: scenario !== 'reject' });
    expect(result.snapshot.run.status).toBe(scenario === 'reject' ? 'paused' : 'completed');
    expect(teamReviewLeafSources(result.snapshot, root)).toEqual(taskSpecs.map((task) => task.id));
    expect([...seenLeaves].sort()).toEqual(taskSpecs.map((task) => task.id).sort());
    for (const task of completedBefore) expect(result.snapshot.tasks.find((item) => item.id === task.id)?.output).toEqual(task.output);
    const rootRecord = root.output as { sources: Array<{ taskId: string; outputSha256: string }> };
    for (const source of rootRecord.sources) expect(source.outputSha256).toBe(workflowJsonDigest(result.snapshot.tasks.find((task) => task.id === source.taskId)!.output));
    const count = requests;
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(requests).toBe(count);
  });

  it.each((['text_generation', 'image_generation', 'video_generation', 'audio_generation', 'speech_generation', 'delegate_task'] as const)
    .flatMap((tool) => [{ artifactVersion: false, fileVersion: false }, { artifactVersion: true, fileVersion: false }, { artifactVersion: true, fileVersion: true }]
      .map((variant) => ({ tool, ...variant }))))('restores exact historical text for $tool (artifact version: $artifactVersion, project file: $fileVersion) without rewriting the source', async ({ tool, artifactVersion, fileVersion }) => {
    const runId = crypto.randomUUID();
    const scope = `saved-text-${runId}`;
    const chatId = `saved-text-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    const now = Date.now();
    const original = `逐字保留原稿：${'故事内容。'.repeat(tool === 'delegate_task' ? 200 : 400)}最后一句必须保留。`;
    const role = { id: 'writer', name: '作者', responsibility: '制作', method: '复用', acceptance: '准确', allowedTools: ['text_generation'] };
    const sourceTask = { id: 'source', roleId: role.id, goal: '写原稿', acceptance: '准确', dependsOn: [], tool: 'text_generation',
      ...(artifactVersion ? { deliverable: { kind: 'document', title: '原稿' } } : {}) };
    const snapshot: WorkflowSnapshot = { run: { id: runId, chatId, goal: '制作', status: 'completed', generation: 1, planVersion: 2, planOpen: false, updatedAt: now }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '制作', output: { summary: '制作', roles: [role], tasks: [sourceTask], finalAcceptance: '准确' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'source', runId, kind: 'agent_text', input: { task: sourceTask, role, goal: '制作' }, output: original, dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
    ] };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const expectedText = artifactVersion ? original.replace('逐字保留原稿：', '用户已经修改：') : original;
    if (artifactVersion) {
      const artifact = await createAgentTeamWorkflow(config, () => scope).publish(runId);
      const edited = useAssistantArtifactStore.getState().applyTextOperations({ chatId, operations: [{
        artifactId: artifact.id, baseVersionId: artifact.currentVersionId, search: original, replacement: expectedText,
      }] });
      expect(edited.results[0].error).toBeUndefined();
      if (fileVersion) useAssistantArtifactStore.setState((state) => ({ items: state.items.map((item) => item.id !== artifact.id ? item : {
        ...item, versions: item.versions.map((version) => version.id !== item.currentVersionId ? version : {
          ...version, content: '项目说明不应当作为所选文件正文', files: [{ id: 'script', path: 'scripts/story.txt', content: expectedText }],
        }),
      }) }));
    }
    const savedText = listTeamSavedText(snapshot, ['source'], useAssistantArtifactStore.getState().items)
      .filter((entry) => Boolean(entry.artifact) === artifactVersion).map((entry) => ({ ...entry, alias: 'original' }));
    expect(savedText).toHaveLength(1);
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '复用正文', finalAcceptance: '准确', roles: [{ ...role, allowedTools: tool === 'delegate_task' ? [tool, 'text_generation'] : [tool] }],
      tasks: [{ id: 'reuse', roleId: role.id, goal: '按原稿制作', tool, acceptance: '准确', dependsOn: [],
        savedText,
        ...(tool === 'speech_generation' ? { speech: { textTaskId: 'original' } } : {}) }] }));
    if (tool === 'delegate_task') generate.mockResolvedValueOnce(JSON.stringify({ summary: '下级复用', finalAcceptance: '准确', roles: [role],
      tasks: [{ id: 'child', roleId: role.id, tool: 'text_generation', goal: '按原稿制作', acceptance: '准确', dependsOn: [], savedText }] }));
    generate.mockResolvedValueOnce('已复用完整原稿');
    if (tool === 'delegate_task') generate.mockResolvedValueOnce('下级已完成');
    useSettingsStore.setState({ aiProfiles: [
      { id: 'audio', name: '音乐', type: 'audio', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'music-model', isDefault: true },
      { id: 'tts', name: '配音', type: 'tts', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'tts-1', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
    ] });
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片已保存' });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'submitted-video' });
    vi.mocked(queueAgentTeamAudio).mockResolvedValue({ output: '音频已保存' });
    await createAgentTeamWorkflow(config, () => scope).addRevisionRequest(runId, 2, '使用完整原稿继续制作');
    const result = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(result.snapshot.run.status, JSON.stringify(result.snapshot.tasks)).toBe(tool === 'video_generation' ? 'active' : 'completed');
    if (tool === 'text_generation') expect(JSON.stringify(generate.mock.calls[1][2])).toContain(expectedText);
    if (tool === 'delegate_task') {
      expect(JSON.stringify(generate.mock.calls[1])).toContain(expectedText);
      expect(JSON.stringify(generate.mock.calls[2][2])).toContain(expectedText);
      const delegationGoal = generate.mock.calls[1][2][0].content;
      const priorEvidence = JSON.parse(delegationGoal.split('已有交付：')[1].split('\n')[0]);
      expect(priorEvidence[0]).toMatchObject({ output: original.slice(0, 600), outputCharacters: original.length, truncated: true });
    }
    if (tool === 'image_generation') expect(queueAgentTeamImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(expectedText) }));
    if (tool === 'video_generation') expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(expectedText) }));
    if (tool === 'audio_generation') expect(queueAgentTeamAudio).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(expectedText) }));
    if (tool === 'speech_generation') expect(queueAgentTeamAudio).toHaveBeenCalledWith(expect.objectContaining({ prompt: expectedText, purpose: 'speech' }));
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect((await indexedDbWorkflowRepository.read(scope, runId))?.tasks.find((task) => task.id === 'source')).toMatchObject({ attempt: 1, output: original });
    expect(generate).toHaveBeenCalledTimes(tool === 'delegate_task' ? 4 : tool === 'text_generation' ? 2 : 1);
    expect(queueAgentTeamAudio).toHaveBeenCalledTimes(['audio_generation', 'speech_generation'].includes(tool) ? 1 : 0);
  });

  it.each(['image_generation', 'video_generation', 'image_inspection', 'video_inspection'] as const)('reuses historical media for %s after restoring the run', async (tool) => {
    if (tool === 'video_inspection') vi.stubGlobal('document', {});
    const runId = crypto.randomUUID();
    const scope = `saved-reference-${runId}`;
    const now = Date.now();
    useSettingsStore.setState({ aiProfiles: [
      { id: 'vision', name: '视觉', type: 'text', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true,
        imageCapabilities: { textToImage: true, referenceImage: true, multiReferenceImage: false, seed: false, negativePrompt: false } },
    ] });
    const video = tool === 'video_inspection';
    const sourceTool = video ? 'video_generation' : 'image_generation';
    const role = { id: 'editor', name: '编辑', responsibility: '修改', method: '复用', acceptance: '有效', allowedTools: [sourceTool] };
    const sourceTask = { id: 'source', roleId: role.id, goal: '素材', acceptance: '已保存', dependsOn: [], tool: sourceTool };
    const snapshot: WorkflowSnapshot = {
      run: { id: runId, chatId: 'chat', goal: '修改素材', status: 'completed', generation: 1, planVersion: 2, planOpen: false, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '素材', output: { roles: [role], tasks: [sourceTask], summary: '素材', finalAcceptance: '素材可用' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'source', runId, kind: video ? 'agent_video' : 'agent_image', input: { task: sourceTask, role, goal: '修改素材' }, output: '已保存', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
      ],
    };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '复用', finalAcceptance: '修改完成', roles: [{ ...role, allowedTools: [tool] }],
      tasks: [{ id: 'edit', roleId: role.id, goal: '编辑或检查已有素材', tool, acceptance: '完成', dependsOn: [],
        savedMedia: listTeamSavedMedia(snapshot, ['source']).map((media) => ({ ...media, alias: 'original' })) }] }));
    const reference = { url: 'data:image/png;base64,saved', mimeType: 'image/png' };
    vi.mocked(teamImageReference).mockReturnValue(reference);
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '新图片已保存' });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'new-video' });
    vi.mocked(inspectAgentTeamImages).mockImplementation(async (params) => { await params.beforeModelRequest?.(); return '图片符合'; });
    vi.mocked(teamMediaAttachment).mockReturnValue({ id: 'source', kind: 'video', status: 'ready', url: 'data:video/mp4;base64,saved', altText: '成片', createdAt: now, updatedAt: now });
    vi.mocked(inspectAgentTeamVideo).mockImplementation(async (params) => { await params.beforeModelRequest?.(); return '视频符合'; });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o' };
    await createAgentTeamWorkflow(config, () => scope).addRevisionRequest(runId, 2, '复用之前的素材');
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status, JSON.stringify(result.snapshot.tasks)).toBe(tool === 'video_generation' ? 'active' : 'completed');
    if (tool === 'image_generation') expect(queueAgentTeamImage).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [reference] }));
    if (tool === 'video_generation') expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [reference] }));
    if (tool === 'image_inspection') expect(inspectAgentTeamImages).toHaveBeenCalledWith(expect.objectContaining({ references: [reference] }));
    if (tool === 'video_inspection') expect(inspectAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ url: 'data:video/mp4;base64,saved' }));
    if (!video) expect(teamImageReference).toHaveBeenCalledWith(runId, 'source');
    if (tool !== 'image_generation') expect(queueAgentTeamImage).not.toHaveBeenCalled();
    if (tool !== 'video_generation') expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(queueAgentTeamImage).toHaveBeenCalledTimes(tool === 'image_generation' ? 1 : 0);
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(tool === 'video_generation' ? 1 : 0);
    expect(inspectAgentTeamImages).toHaveBeenCalledTimes(tool === 'image_inspection' ? 1 : 0);
    expect(inspectAgentTeamVideo).toHaveBeenCalledTimes(video ? 1 : 0);
  });

  it.each([false, true])('rejects an unavailable historical text version before paid generation (artifact: %s)', async (artifactVersion) => {
    const runId = crypto.randomUUID();
    const scope = `stale-text-${runId}`;
    const now = Date.now();
    const role = { id: 'writer', name: '作者', responsibility: '写作', method: '创作', acceptance: '正文可用', allowedTools: ['text_generation'] };
    const sourceTask = { id: 'source', roleId: role.id, tool: 'text_generation', goal: '原稿', acceptance: '准确', dependsOn: [] };
    const snapshot: WorkflowSnapshot = { run: { id: runId, chatId: 'chat', goal: '制作', status: 'completed', generation: 1, planVersion: 2, planOpen: false, updatedAt: now }, tasks: [
      { id: 'plan', runId, kind: 'team_plan', input: '制作', output: { summary: '制作', roles: [role], tasks: [sourceTask], finalAcceptance: '准确' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'source', runId, kind: 'agent_text', input: { task: sourceTask, role, goal: '制作' }, output: '原稿', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
    ] };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    const artifactId = `stale-artifact-${runId}`;
    if (artifactVersion) useAssistantArtifactStore.setState((state) => ({ items: [...state.items, {
      id: artifactId, chatId: 'chat', sourceMessageId: `team-delivery-${runId}:source`, kind: 'document', title: '用户稿件',
      currentVersionId: 'edited', createdAt: now, updatedAt: now,
      versions: [{ id: 'edited', artifactId, sourceMessageId: `team-delivery-${runId}:source`, content: '用户稿件', createdAt: now }],
    }] }));
    const savedText = listTeamSavedText(snapshot, ['source'], useAssistantArtifactStore.getState().items)
      .filter((entry) => Boolean(entry.artifact) === artifactVersion).map((entry) => ({ ...entry, alias: 'original' }));
    const originalRead = indexedDbWorkflowRepository.read.bind(indexedDbWorkflowRepository);
    const read = vi.spyOn(indexedDbWorkflowRepository, 'read');
    generate.mockImplementationOnce(async () => {
      if (artifactVersion) useAssistantArtifactStore.setState((state) => ({ items: state.items.filter((item) => item.id !== artifactId) }));
      // Simulate a source read corrupted outside the protected transaction boundary.
      else read.mockImplementation(async (storageScope, id) => {
        const current = await originalRead(storageScope, id);
        if (current && storageScope === scope && id === runId) current.tasks.find((task) => task.id === 'source')!.output = '已经变化的正文';
        return current;
      });
      return JSON.stringify({ summary: '原稿配音', finalAcceptance: '准确', roles: [{ ...role, allowedTools: ['speech_generation'] }],
        tasks: [{ id: 'voice', roleId: role.id, goal: '配音', tool: 'speech_generation', acceptance: '准确', dependsOn: [], savedText, speech: { textTaskId: 'original' } }] });
    });
    useSettingsStore.setState({ aiProfiles: [{ id: 'tts', name: '配音', type: 'tts', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'tts-1', isDefault: true }] });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    try {
      await workflow.addRevisionRequest(runId, 2, '用原稿配音');
      const result = await workflow.resume(runId);
      expect(result.snapshot.run.status).toBe('failed');
      expect(result.snapshot.tasks.find((task) => task.kind === 'agent_audio')).toMatchObject({ status: 'failed', error: expect.stringContaining(artifactVersion ? '指定版本不可用' : '版本已变化') });
      expect(queueAgentTeamAudio).not.toHaveBeenCalled();
      await createAgentTeamWorkflow(config, () => scope).resume(runId);
      expect(queueAgentTeamAudio).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });

  it('recomposes saved media in a later plan without submitting another paid media task', async () => {
    const runId = crypto.randomUUID();
    const scope = `saved-media-${runId}`;
    const now = Date.now();
    const role = { id: 'director', name: '导演', responsibility: '制作', method: '剪辑', acceptance: '成片', allowedTools: ['video_generation', 'audio_generation'] };
    const tasks = [
      { id: 'shot', roleId: role.id, goal: '拍摄', dependsOn: [], tool: 'video_generation', acceptance: '可播放' },
      { id: 'music', roleId: role.id, goal: '伴奏', dependsOn: [], tool: 'audio_generation', acceptance: '可播放' },
    ];
    const snapshot: WorkflowSnapshot = {
      run: { id: runId, chatId: 'chat', goal: '生成短片', status: 'completed', generation: 1, planVersion: 2, planOpen: false, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '生成短片', output: { roles: [role], tasks, summary: '素材', finalAcceptance: '素材可用' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        ...tasks.map((task) => ({ id: task.id, runId, kind: task.id === 'shot' ? 'agent_video' : 'agent_audio', input: { task, role, goal: '生成短片' },
          output: `${task.id} 已保存`, dependsOn: ['plan'], status: 'completed' as const, attempt: 1, updatedAt: now })),
      ],
    };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    const catalog = listTeamSavedMedia(snapshot, ['shot', 'music']);
    const extraPlan = { summary: '重新剪辑', finalAcceptance: '成片可用', roles: [{ ...role, allowedTools: ['media_composition'] }],
      tasks: [{ id: 'film', roleId: role.id, goal: '剪辑已保存镜头并叠加已有伴奏', tool: 'media_composition', acceptance: '可播放', dependsOn: [],
        savedMedia: catalog.map((source) => ({ ...source, alias: `old_${source.taskId}` })),
        composition: { clips: [{ taskId: 'old_shot' }], audioTracks: [{ taskId: 'old_music' }] } }] };
    generate.mockResolvedValueOnce(JSON.stringify(extraPlan));
    vi.mocked(composeAgentTeamMedia).mockResolvedValue({ output: '新成片已保存' });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    await workflow.addRevisionRequest(runId, 2, '只重新剪辑，不重新生成素材');
    const result = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(generate.mock.calls[0][1]).toContain('可复用历史素材目录');
    expect(generate.mock.calls[0][1]).toContain(catalog[0].outputSha256);
    const composition = vi.mocked(composeAgentTeamMedia).mock.calls[0][0];
    expect(composition.resolveTaskId?.('old_shot')).toBe('shot');
    expect(composition.resolveTaskId?.('old_music')).toBe('music');
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(composeAgentTeamMedia).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    expect(queueAgentTeamAudio).not.toHaveBeenCalled();
  });

  it('compiles a final-cut revision with original video and music aliases without paid resubmission', async () => {
    const runId = crypto.randomUUID();
    const scope = `patch-media-${runId}`;
    const now = Date.now();
    const plan = validateAgentTeamPlan({ summary: '短片', finalAcceptance: '可播放',
      roles: [{ id: 'maker', name: '制作', responsibility: '制作', method: '剪辑', acceptance: '可播放', allowedTools: ['video_generation', 'audio_generation', 'media_composition'] }],
      tasks: [
        { id: 'shot', roleId: 'maker', tool: 'video_generation', goal: '镜头', acceptance: '可播放', dependsOn: [] },
        { id: 'music', roleId: 'maker', tool: 'audio_generation', goal: '伴奏', acceptance: '可播放', dependsOn: [] },
        { id: 'film', roleId: 'maker', tool: 'media_composition', goal: '合成短片', acceptance: '可播放', dependsOn: ['shot', 'music'],
          composition: { clips: [{ taskId: 'shot' }], audioTracks: [{ taskId: 'music' }] } },
      ] });
    const kinds = ['agent_video', 'agent_audio', 'agent_media_composition'];
    const snapshot: WorkflowSnapshot = { run: { id: runId, chatId: 'chat', goal: '短片', status: 'completed', generation: 1, planVersion: 2, planOpen: false, updatedAt: now },
      tasks: [{ id: 'plan', runId, kind: 'team_plan', input: '短片', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        ...plan.tasks.map((task, index) => ({ id: task.id, runId, kind: kinds[index], input: { task, role: plan.roles[0], goal: '短片' },
          output: `${task.id}已保存`, dependsOn: ['plan', ...task.dependsOn], status: 'completed' as const, attempt: 1, updatedAt: now }))] };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot, value: undefined }));
    generate.mockResolvedValueOnce(JSON.stringify({ revisionPatch: { schemaVersion: 1, basePlanSha256: workflowJsonDigest(plan),
      updates: [{ taskId: 'film', goal: '再次输出短片供确认', acceptance: '可播放且保留已有配乐' }] } }));
    vi.mocked(composeAgentTeamMedia).mockResolvedValue({ output: '新成片已保存' });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    await workflow.addRevisionRequest(runId, 2, '再次输出成片，保持剪辑配置', 'film');
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'delegate')?.output).toMatchObject({
      revisionCompilation: { rerunTaskIds: ['film'], reusedTaskIds: ['shot', 'music'] },
    });
    const params = vi.mocked(composeAgentTeamMedia).mock.calls[0][0];
    expect(params.resolveTaskId?.('shot')).toBe('shot');
    expect(params.resolveTaskId?.('music')).toBe('music');
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(composeAgentTeamMedia).toHaveBeenCalledTimes(1);
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    expect(queueAgentTeamAudio).not.toHaveBeenCalled();
  });

  it('binds the starting branch, pauses after outstanding planning, and restores the whole run', async () => {
    const runId = crypto.randomUUID();
    const scope = `branch-${runId}`;
    const setBranch = (name: string) => useChatStore.setState((state) => ({ chats: state.chats.map((chat) => chat.id === 'chat'
      ? { ...chat, messageBranchState: { enabled: true, activeBranchName: name, refs: {
        main: { name: 'main', headNodeId: null, createdAt: 1, updatedAt: 1, version: 0 },
        alternate: { name: 'alternate', headNodeId: null, createdAt: 1, updatedAt: 1, version: 0 },
      } } } : chat) }));
    setBranch('main');
    let finishPlan!: (value: string) => void;
    generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishPlan = resolve; }));
    const api = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(api, () => scope);
    const pending = workflow.start(runId, 'chat', '撰写报告');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    setBranch('alternate');
    finishPlan(JSON.stringify({ summary: '报告', roles: [{ id: 'writer', name: '作者', responsibility: '撰写', method: '整理', acceptance: '可读', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal: '撰写报告', dependsOn: [], acceptance: '可读' }], finalAcceptance: '完整' }));
    const paused = await pending;
    expect(paused.snapshot.run).toMatchObject({ status: 'paused', pauseReason: expect.stringContaining('分支已切换') });
    expect(paused.snapshot.run.goalSpec?.sourceBranch?.name).toBe('main');
    expect(paused.snapshot.tasks.find((task) => task.id === 'report')?.attempt).toBe(0);
    await createAgentTeamWorkflow(api, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledOnce();
    setBranch('main');
    generate.mockResolvedValueOnce('报告正文');
    const restored = createAgentTeamWorkflow(api, () => scope);
    expect((await restored.resume(runId)).snapshot.run.status).toBe('completed');
    setBranch('alternate');
    await expect(restored.publish(runId)).rejects.toThrow('分支已切换');
    setBranch('main');
    await restored.publish(runId);
    const chat = useChatStore.getState().chats.find((item) => item.id === 'chat');
    expect(chat?.messageBranchState?.refs?.main.headNodeId).toBe(`team-delivery-${runId}`);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('passes a delegated image export to video generation after restoring its pending child', async () => {
    const runId = crypto.randomUUID();
    const scope = `export-${runId}`;
    const role = { id: 'artist', name: '创作者', responsibility: '制作', method: '先图后视频', acceptance: '可播放', allowedTools: ['delegate_task', 'image_generation', 'video_generation'] };
    const image = { id: 'art', roleId: role.id, goal: '制作角色素材', tool: 'delegate_task', mediaOutput: 'image', dependsOn: [], acceptance: '图片' };
    const shot = { id: 'shot', roleId: role.id, goal: '让角色奔跑', tool: 'video_generation', dependsOn: ['art'], acceptance: '视频' };
    const frame = { ...image, id: 'frame', tool: 'image_generation', mediaOutput: undefined };
    const makePlan = (tasks: unknown[], extra = {}) => JSON.stringify({ summary: '制作', roles: [role], tasks, finalAcceptance: '可播放', ...extra });
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(makePlan([image, shot]))
      .mockResolvedValueOnce(makePlan([frame], { resultTaskId: 'frame' }))
      .mockResolvedValueOnce('角色参考图已经完成');
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ externalTaskId: 'image-job' });
    vi.mocked(inspectAgentTeamImageAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'image-job' });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const pending = await createAgentTeamWorkflow(config, () => scope).start(runId, 'chat', '制作角色短片', false);
    expect(pending.snapshot.tasks.find((task) => task.id === 'art_frame')?.status).toBe('waiting_external');
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    vi.mocked(inspectAgentTeamImageAttachment).mockReturnValue({ status: 'completed', output: '角色图已保存' });
    const reference = { url: '/uploads/media/character.png', mimeType: 'image/png', label: '角色' };
    vi.mocked(teamImageReference).mockImplementation((_runId, taskId) => taskId === 'art_frame' ? reference : null);
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'video-job' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'video-job' });
    const resumed = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(resumed.snapshot.tasks.find((task) => task.id === 'art')?.status).toBe('completed');
    expect(resumed.snapshot.tasks.find((task) => task.id === 'shot')?.status).toBe('waiting_external');
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [reference], prompt: expect.stringContaining('角色参考图已经完成') }));
    expect(queueAgentTeamImage).toHaveBeenCalledTimes(1);
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('rejects a missing declared child media delivery before spawning paid work', async () => {
    const role = { id: 'artist', name: '创作者', responsibility: '制作', method: '先图后视频', acceptance: '图片', allowedTools: ['delegate_task', 'image_generation'] };
    const task = { id: 'art', roleId: role.id, goal: '素材', tool: 'delegate_task', mediaOutput: 'image', dependsOn: [], acceptance: '图片' };
    const plan = { summary: '制作', roles: [role], tasks: [task], finalAcceptance: '图片' };
    useSettingsStore.setState({ aiProfiles: [{ id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce(JSON.stringify({ ...plan, tasks: [{ ...task, id: 'frame', tool: 'image_generation', mediaOutput: undefined }] }));
    const runId = crypto.randomUUID();
    const result = await createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `missing-export-${runId}`).start(runId, 'chat', '制作素材', false);
    expect(result.snapshot.tasks.find((item) => item.id === 'art')?.error).toContain('符合父任务要求');
    expect(result.snapshot.tasks.some((item) => item.id === 'art_frame')).toBe(false);
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
  });

  it('recursively delegates, waits for children, aggregates and restores without duplicate calls', async () => {
    const runId = crypto.randomUUID();
    const scope = `recursive-${runId}`;
    const role = { id: 'lead', name: '负责人', responsibility: '交付研究', method: '按需拆分', acceptance: '有证据', allowedTools: ['text_generation', 'delegate_task'] };
    const makePlan = (id: string, goal: string, tool: string) => ({ summary: goal, roles: [role],
      tasks: [{ id, roleId: role.id, goal, tool, dependsOn: [], acceptance: '有证据' }], finalAcceptance: '报告可用',
      delegationChecks: [{ taskId: id, status: 'narrower', reason: '仅交付市场需求证据，不承担完整产品研究' }] });
    generate.mockResolvedValueOnce(JSON.stringify(makePlan('research', '研究产品机会', 'delegate_task')))
      .mockResolvedValueOnce(JSON.stringify(makePlan('market', '分析市场需求', 'delegate_task')))
      .mockResolvedValueOnce(JSON.stringify(makePlan('findings', '整理已提供的需求证据', 'text_generation')))
      .mockResolvedValueOnce('证据：用户需要离线运行')
      .mockResolvedValueOnce('市场结论：离线需求明确')
      .mockResolvedValueOnce('研究结论：优先离线交付');
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const result = await workflow.start(runId, 'chat', '研究产品机会', false);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'research')?.output).toContain('优先离线交付');
    expect(result.snapshot.tasks.find((task) => task.id === 'research_market')?.output).toContain('离线需求明确');
    expect(result.snapshot.tasks.find((task) => task.id === 'research_market_findings')?.output).toContain('离线运行');
    expect(generate.mock.calls[4][2][0].content).toContain('用户需要离线运行');
    expect(generate.mock.calls[5][2][0].content).toContain('离线需求明确');
    expect(countWorkflowModelCalls(result.snapshot)).toBe(6);
    const attempts = await indexedDbWorkflowRepository.listTaskAttempts(scope, runId, 'research');
    expect(attempts.map((attempt) => attempt.status)).toEqual(['completed', 'completed']);
    expect((await indexedDbWorkflowRepository.listPlanRevisions(scope, runId)).some((revision) => revision.addedTaskIds.includes('research_market_findings'))).toBe(true);
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it('rejects child plans that expand parent tool permissions', async () => {
    const runId = crypto.randomUUID();
    const scope = `recursive-denied-${runId}`;
    const role = { id: 'lead', name: '负责人', responsibility: '研究', method: '拆分', acceptance: '完整', allowedTools: ['delegate_task', 'text_generation'] };
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '研究', roles: [role], tasks: [{ id: 'research', roleId: role.id, goal: '研究', tool: 'delegate_task', dependsOn: [], acceptance: '完整' }], finalAcceptance: '完整' }))
      .mockResolvedValueOnce(JSON.stringify({ summary: '越权', roles: [{ ...role, allowedTools: ['text_generation', 'web_search'] }], tasks: [{ id: 'report', roleId: role.id, goal: '整理报告', tool: 'text_generation', dependsOn: [], acceptance: '报告' }], finalAcceptance: '报告' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.start(runId, 'chat', '研究', false);
    expect(result.snapshot.tasks.find((task) => task.id === 'research')?.status).toBe('failed');
    expect(result.snapshot.tasks).toHaveLength(2);
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
    expect(countWorkflowModelCalls(result.snapshot)).toBe(2);
  });

  it.each(['syntax', 'fields'])('blocks invalid JSON %s before downstream work and retries only the failed task after restore', async (mode) => {
    const runId = crypto.randomUUID();
    const scope = `output-contract-${runId}`;
    const role = { id: 'writer', name: '写作者', responsibility: '整理', method: '核对', acceptance: '准确', allowedTools: ['text_generation'] };
    const plan = { summary: '结构化交付', roles: [role], tasks: [
      { id: 'source', roleId: role.id, goal: '整理证据', dependsOn: [], acceptance: '准确' },
      { id: 'data', roleId: role.id, goal: '生成数据', dependsOn: ['source'], acceptance: '合法 JSON', deliverable: { kind: 'json', title: '数据',
        jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } } },
      { id: 'report', roleId: role.id, goal: '使用数据', dependsOn: ['data'], acceptance: '完整' },
    ], finalAcceptance: '准确' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('完整原始证据').mockResolvedValueOnce(mode === 'syntax' ? '这里是数据：{"value":1}' : '{"value":"1"}');
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const first = createAgentTeamWorkflow(config, () => scope);
    const failed = (await first.start(runId, 'chat', '生成数据报告')).snapshot;
    expect(failed.run.status).toBe('failed');
    expect(failed.tasks.find((task) => task.id === 'data')).toMatchObject({ status: 'failed', error: expect.stringContaining(mode === 'syntax' ? '要求合法 JSON' : 'JSON 不符合已声明的字段契约') });
    expect(failed.tasks.find((task) => task.id === 'report')?.attempt).toBe(0);
    expect(countWorkflowModelCalls(failed)).toBe(3);
    const restored = createAgentTeamWorkflow(config, () => scope);
    await restored.resume(runId);
    expect(generate).toHaveBeenCalledTimes(3);
    await expect(restored.retryFailedTask(runId, 'data', failed.run.planVersion - 1)).rejects.toThrow('计划已更新');
    await expect(restored.retryFailedTask(runId, 'source', failed.run.planVersion)).rejects.toThrow('不能重试');
    await restored.retryFailedTask(runId, 'data', failed.run.planVersion);
    generate.mockResolvedValueOnce('```json\n{"value":1}\n```').mockResolvedValueOnce('完成数据报告');
    const done = (await restored.resume(runId)).snapshot;
    expect(done.run.status).toBe('completed');
    expect(done.tasks.find((task) => task.id === 'source')).toEqual(failed.tasks.find((task) => task.id === 'source'));
    expect(done.tasks.find((task) => task.id === 'data')).toMatchObject({ attempt: 2, output: '{"value":1}' });
    expect(generate.mock.calls[3][1]).toContain('只返回一个合法 JSON');
    expect(generate.mock.calls[4][2][0].content).toContain('value');
    expect(countWorkflowModelCalls(done)).toBe(5);
    expect((await indexedDbWorkflowRepository.listTaskAttempts(scope, runId, 'data')).map((attempt) => attempt.status)).toEqual(['failed', 'completed']);
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(5);
  });

  it('retries a failed delegation synthesis without repeating completed child work', async () => {
    const runId = crypto.randomUUID();
    const scope = `synthesis-retry-${runId}`;
    const role = { id: 'lead', name: '负责人', responsibility: '研究', method: '拆分', acceptance: '完整', allowedTools: ['delegate_task', 'text_generation'] };
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '研究', roles: [role], tasks: [{ id: 'research', roleId: role.id, goal: '研究市场', tool: 'delegate_task', dependsOn: [], acceptance: '报告', deliverable: { kind: 'json', title: '结论' } }], finalAcceptance: '报告' }))
      .mockResolvedValueOnce(JSON.stringify({ summary: '证据', roles: [{ ...role, allowedTools: ['text_generation'] }], tasks: [{ id: 'evidence', roleId: role.id, goal: '整理证据', tool: 'text_generation', dependsOn: [], acceptance: '证据' }], finalAcceptance: '证据' }))
      .mockResolvedValueOnce('已完成的证据').mockResolvedValueOnce('无效 JSON 汇总').mockResolvedValueOnce('{"result":"汇总完成"}');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const failed = await workflow.start(runId, 'chat', '调研', false);
    expect(failed.snapshot.run.status).toBe('failed');
    expect(failed.snapshot.tasks.find((task) => task.id === 'research')?.error).toContain('要求合法 JSON');
    await workflow.retryFailedTask(runId, 'research', failed.snapshot.run.planVersion);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'research_evidence')?.attempt).toBe(1);
    expect(generate).toHaveBeenCalledTimes(5);
    expect(generate.mock.calls[4][2][0].content).toContain('已完成的证据');
  });

  it.each(['repeated', 'uncertain', 'missing'] as const)('blocks semantic delegation loops before child expansion and preserves failure on recovery: %s', async (status) => {
    const runId = crypto.randomUUID();
    const scope = `semantic-delegation-${runId}`;
    const role = { id: 'lead', name: '负责人', responsibility: '调研', method: '拆分', acceptance: '完整', allowedTools: ['delegate_task', 'text_generation'] };
    const makePlan = (id: string, goal: string) => ({ summary: goal, roles: [role],
      tasks: [{ id, goal, roleId: role.id, tool: 'delegate_task', dependsOn: [], acceptance: '完整报告' }], finalAcceptance: '完整' });
    generate.mockResolvedValueOnce(JSON.stringify(makePlan('research', '研究产品的市场机会')))
      .mockResolvedValueOnce(JSON.stringify({ ...makePlan('again', '全面分析该产品在市场上的发展潜力'),
        ...(status === 'missing' ? {} : { delegationChecks: [{ taskId: 'again', status, reason: '与父目标承担相同范围，只有措辞不同' }] }) }));
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const failed = (await workflow.start(runId, 'chat', '研究产品机会', false)).snapshot;
    expect(failed.run.status).toBe('failed');
    expect(failed.tasks).toHaveLength(2);
    expect(failed.tasks.find((task) => task.id === 'research')?.expansion).toBeUndefined();
    expect(failed.tasks.find((task) => task.id === 'research')).toMatchObject({ status: 'failed',
      error: expect.stringContaining(status === 'missing' ? '范围检查记录' : '范围无法确认') });
    expect(generate.mock.calls[1][1]).toContain('研究产品的市场机会');
    expect(generate.mock.calls[1][1]).toContain('换措辞');
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(countWorkflowModelCalls(failed)).toBe(2);
  });

  it.each(['complete', 'depth', 'repeat'] as const)('enforces recursive delegation boundaries: %s', async (mode) => {
    const runId = crypto.randomUUID();
    const role = { id: 'lead', name: '负责人', responsibility: '研究', method: '拆分', acceptance: '证据', allowedTools: ['delegate_task', 'text_generation'] };
    const plan = (id: string, goal: string, tool = 'delegate_task') => JSON.stringify({ summary: goal,
      roles: [{ ...role, allowedTools: tool === 'text_generation' ? ['text_generation'] : role.allowedTools }],
      tasks: [{ id, goal, roleId: role.id, tool, dependsOn: [], acceptance: '证据' }], finalAcceptance: '报告',
      delegationChecks: [{ taskId: id, status: 'narrower', reason: '仅负责当前局部证据，不承担完整祖先任务' }] });
    generate.mockResolvedValueOnce(plan('first', '研究机会'))
      .mockResolvedValueOnce(plan('second', mode === 'repeat' ? '研究机会' : '分析市场'))
      .mockResolvedValueOnce(plan('third', '分析客户'))
      .mockResolvedValueOnce(plan('leaf', '整理结论', mode === 'depth' ? 'delegate_task' : 'text_generation'))
      .mockResolvedValueOnce('真实证据').mockResolvedValueOnce('客户结论').mockResolvedValueOnce('市场结论').mockResolvedValueOnce('最终报告');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `boundary-${runId}`);
    const result = await workflow.start(runId, 'chat', '完成调研', false);
    if (mode === 'complete') {
      expect(result.snapshot.run.status).toBe('completed');
      expect(generate).toHaveBeenCalledTimes(8);
    } else {
      expect(result.snapshot.run.status).toBe('failed');
      expect(generate).toHaveBeenCalledTimes(mode === 'repeat' ? 2 : 4);
      expect(result.snapshot.tasks.some((task) => task.error?.includes(mode === 'repeat' ? '重复祖先目标' : '委派'))).toBe(true);
    }
  });

  it.each([0, 1])('persists goal constraints and enforces %s automatic review rounds after restart', async (rounds) => {
    const runId = crypto.randomUUID();
    const scope = `goal-contract-${runId}`;
    const goal = '写报告';
    const spec = defaultWorkflowGoalSpec(goal);
    spec.constraints = ['仅使用提供的资料'];
    spec.acceptance = ['列出未确定事项'];
    spec.allowedTools = ['text_generation'];
    spec.execution.maxAutomaticReviewRounds = rounds;
    const plan = { summary: '报告', roles: [{ id: 'writer', name: '作者', responsibility: '撰写', method: '整理', acceptance: '可读', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal, dependsOn: [], acceptance: '可读' }], finalAcceptance: '报告可读' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('报告正文');
    if (rounds) generate.mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '缺少不确定事项', nextRequest: '补充不确定事项' }));
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const result = await workflow.start(runId, 'chat', goal, true, undefined, undefined, spec);
    expect(result.snapshot.run.goalSpec).toEqual({ ...spec, sourceBranch: { enabled: false, name: 'main', headNodeId: null } });
    expect(generate.mock.calls[0][2][0].content).toContain('仅使用提供的资料');
    expect(generate.mock.calls[1][1]).toContain('列出未确定事项');
    expect(result.snapshot.tasks.filter((task) => task.kind === 'team_review')).toHaveLength(rounds);
    expect(result.snapshot.run.status).toBe(rounds ? 'paused' : 'completed');
    if (rounds) {
      expect(generate.mock.calls[2][2][0].content).toContain('列出未确定事项');
      expect(result.snapshot.tasks.find((task) => task.id === 'review_needs_user')?.status).toBe('waiting_user');
    }
    const calls = generate.mock.calls.length;
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(calls);
  });

  it('rejects unauthorized planned tools while retaining the consumed planning call', async () => {
    const runId = crypto.randomUUID();
    const spec = defaultWorkflowGoalSpec('写报告');
    spec.allowedTools = [];
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '报告',
      roles: [{ id: 'writer', name: '作者', responsibility: '撰写', method: '整理', acceptance: '可读', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '可读' }], finalAcceptance: '可读' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `goal-denied-${runId}`);
    const result = await workflow.start(runId, 'chat', '写报告', false, undefined, undefined, spec);
    expect(result.snapshot.tasks[0].error).toContain('未获得本次任务的目标授权');
    expect(countWorkflowModelCalls(result.snapshot)).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('blocks unauthorized tools in a saved plan before calling a model', async () => {
    const runId = crypto.randomUUID();
    const scope = `goal-saved-denied-${runId}`;
    const spec = defaultWorkflowGoalSpec('写报告');
    spec.allowedTools = [];
    const now = Date.now();
    const role = { id: 'writer', name: '作者', responsibility: '撰写', method: '整理', acceptance: '可读', allowedTools: ['text_generation'] };
    const task = { id: 'report', roleId: role.id, goal: '写报告', dependsOn: [], acceptance: '可读' };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '写报告', goalSpec: spec, status: 'paused', generation: 1, planVersion: 1, planOpen: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '写报告', output: { summary: '报告', roles: [role], tasks: [task], finalAcceptance: '可读' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: task.id, runId, kind: 'agent_text', input: { task, role, goal: '写报告' }, dependsOn: ['plan'], status: 'queued', attempt: 0, updatedAt: now },
      ],
    }, value: undefined }));
    const result = await createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope).resume(runId);
    expect(result.snapshot.tasks.find((item) => item.id === task.id)?.error).toContain('未获得本次任务的目标授权');
    expect(countWorkflowModelCalls(result.snapshot)).toBe(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([true, false])('inspects only saved video files (file available: %s) and never regenerates them', async (available) => {
    const runId = crypto.randomUUID();
    const scope = `video-inspection-${runId}`;
    const now = Date.now();
    useSettingsStore.setState({ aiProfiles: [{ id: 'vision', name: '视觉', type: 'text', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o', isDefault: true }] });
    const role = { id: 'reviewer', name: '检查员', responsibility: '检查视频', method: '抽帧', acceptance: '实际画面', allowedTools: ['video_generation', 'video_inspection'] };
    const tasks = [
      { id: 'shot', roleId: role.id, goal: '生成', acceptance: '视频可播放', dependsOn: [], tool: 'video_generation' },
      { id: 'inspect', roleId: role.id, goal: '检查', acceptance: '有角色', dependsOn: ['shot'], tool: 'video_inspection' },
    ];
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '检查短片', status: 'paused', generation: 1, planVersion: 1, planOpen: false, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '检查短片', output: { roles: [role], tasks, summary: '检查', finalAcceptance: '实际画面' }, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        ...tasks.map((task) => ({ id: task.id, runId, kind: task.id === 'shot' ? 'agent_video' : 'agent_video_inspection',
          input: { task, role, goal: '检查短片' }, output: task.id === 'shot' ? '视频已保存' : undefined,
          dependsOn: ['plan', ...task.dependsOn], status: task.id === 'shot' ? 'completed' as const : 'queued' as const, attempt: task.id === 'shot' ? 1 : 0, updatedAt: now })),
      ],
    }, value: undefined }));
    vi.mocked(teamMediaAttachment).mockReturnValue(available ? { id: 'video', kind: 'video', status: 'ready', url: 'data:video/mp4;base64,saved', altText: '成片', createdAt: now, updatedAt: now } : undefined);
    vi.mocked(inspectAgentTeamVideo).mockImplementation(async (params) => { await params.beforeModelRequest?.(); return '抽帧可见角色，未检查音轨'; });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o' }, () => scope);
    const result = await workflow.resume(runId);
    if (available) {
      expect(result.snapshot.run.status).toBe('completed');
      expect(inspectAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ url: 'data:video/mp4;base64,saved', maxFrames: 6 }));
      await workflow.resume(runId);
      expect(inspectAgentTeamVideo).toHaveBeenCalledTimes(1);
    } else {
      expect(result.snapshot.tasks.find((task) => task.id === 'inspect')).toMatchObject({ status: 'failed', error: expect.stringContaining('尚未保存') });
      expect(inspectAgentTeamVideo).not.toHaveBeenCalled();
    }
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
  });
  it.each(['running', 'failed', 'result_unknown'] as const)('resumes %s local composition without resubmitting completed media', async (status) => {
    const runId = crypto.randomUUID();
    const scope = `composition-${runId}`;
    const now = Date.now();
    const role = { id: 'director', name: '导演', responsibility: '制作', method: '剪辑', acceptance: '成片', allowedTools: ['video_generation', 'media_composition'] };
    const tasks = [
      { id: 'shot', roleId: role.id, goal: '拍摄', dependsOn: [], tool: 'video_generation', acceptance: '可播放' },
      { id: 'film', roleId: role.id, goal: '合成', dependsOn: ['shot'], tool: 'media_composition', acceptance: '可播放', composition: { clips: [{ taskId: 'shot' }] } },
    ];
    const plan = { roles: [role], tasks, summary: '短片', finalAcceptance: '成片' };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '生成短片', status: 'paused', generation: 1, planVersion: 1, planOpen: false, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '生成短片', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        ...tasks.map((task) => ({ id: task.id, runId, kind: task.id === 'shot' ? 'agent_video' : 'agent_media_composition',
          input: { task, role, goal: '生成短片' }, dependsOn: ['plan', ...task.dependsOn], status: task.id === 'shot' ? 'completed' as const : status, attempt: 1, updatedAt: now })),
      ],
    }, value: undefined }));
    vi.mocked(composeAgentTeamMedia).mockResolvedValue({ output: '成片已保存' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks[2]).toMatchObject({ status: 'completed', attempt: 2 });
    expect(composeAgentTeamMedia).toHaveBeenCalledTimes(1);
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    await workflow.resume(runId);
    expect(composeAgentTeamMedia).toHaveBeenCalledTimes(1);
  });

  it('executes and persists a forty-step dependent plan across the expanded capacity', async () => {
    const runId = crypto.randomUUID();
    const chatId = `forty-step-${runId}`;
    const scope = `forty-step-scope-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    const plan = {
      summary: '四十镜头脚本',
      roles: [{ id: 'writer', name: '编剧', responsibility: '编写镜头脚本', method: '逐镜头接续', acceptance: '镜头顺序完整', allowedTools: ['text_generation'] }],
      tasks: Array.from({ length: 40 }, (_, index) => ({
        id: `shot_${index + 1}`, roleId: 'writer', goal: `编写第 ${index + 1} 个镜头`,
        dependsOn: index === 0 ? [] : [`shot_${index}`], acceptance: '包含镜头内容',
      })),
      finalAcceptance: '四十个镜头均完成',
    };
    generate.mockResolvedValueOnce(JSON.stringify(plan));
    for (let index = 1; index <= 40; index += 1) generate.mockResolvedValueOnce(`镜头 ${index} 内容`);
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.start(runId, chatId, '生成四十镜头脚本');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks).toHaveLength(41);
    expect(result.snapshot.tasks.filter((task) => task.kind === 'agent_text' && task.status === 'completed')).toHaveLength(40);
    expect((await workflow.read(runId))?.tasks.find((task) => task.id === 'shot_40')?.output).toBe('镜头 40 内容');
    expect(generate).toHaveBeenCalledTimes(41);
    await workflow.addRevisionRequest(runId, result.snapshot.run.planVersion, '为四十个镜头补充运镜说明', 'shot_1');
    generate.mockResolvedValueOnce(JSON.stringify(plan));
    for (let index = 1; index <= 40; index += 1) generate.mockResolvedValueOnce(`补充镜头 ${index} 内容`);
    const extended = await workflow.resume(runId);
    expect(extended.snapshot.run.status).toBe('completed');
    expect(generate.mock.calls[41][2][0].content).toContain('镜头 1 内容');
    expect(generate.mock.calls[41][2][0].content).toContain('定向修订目标：shot_1');
    expect(extended.snapshot.tasks).toHaveLength(82);
    expect(extended.snapshot.tasks.find((task) => task.id === 'delegated_shot_40')?.output).toBe('补充镜头 40 内容');
    await workflow.resume(runId);
    expect(generate).toHaveBeenCalledTimes(82);
  }, 15_000);

  it('passes the completed image attachment to a dependent image task', async () => {
    const runId = crypto.randomUUID();
    const chatId = `image-chain-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true,
        imageCapabilities: { textToImage: true, referenceImage: true, multiReferenceImage: false, seed: false, negativePrompt: false } },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '连续画面', roles: [
      { id: 'artist', name: '画师', responsibility: '绘制场景', method: '先画场景再画角色', acceptance: '两张图', allowedTools: ['image_generation'] },
    ], tasks: [
      { id: 'scene', roleId: 'artist', goal: '画森林', dependsOn: [], tool: 'image_generation', acceptance: '森林图' },
      { id: 'character', roleId: 'artist', goal: '在森林中画角色', dependsOn: ['scene'], tool: 'image_generation', acceptance: '角色图' },
    ], finalAcceptance: '两张图已保存' }));
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片已保存' });
    vi.mocked(teamImageReference).mockReturnValue({ url: '/uploads/media/user/chat/scene.png', mimeType: 'image/png', label: '场景图' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'text-model' }, () => `image-chain-scope-${runId}`);
    const result = await workflow.start(runId, chatId, '画森林，然后在同一场景画角色');
    expect(result.snapshot.run.status).toBe('completed');
    expect(queueAgentTeamImage).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'character',
      referenceImages: [{ url: '/uploads/media/user/chat/scene.png', mimeType: 'image/png', label: '场景图' }] }));
  });

  it('rejects planning for a deleted assistant chat before calling the model', async () => {
    const runId = crypto.randomUUID();
    useChatStore.setState((state) => ({ chats: state.chats.map((chat) => chat.id === 'chat' ? { ...chat, deletedAt: Date.now() } : chat) }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `deleted-chat-${runId}`);
    await expect(workflow.start(runId, 'chat', '写一份报告')).rejects.toThrow('助手会话已删除或不可用');
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends a generated music attachment through a persisted asynchronous team task', async () => {
    const runId = crypto.randomUUID();
    const chatId = `music-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'audio', name: '音乐', type: 'audio', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'music-model', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '生成背景音乐', roles: [{ id: 'composer', name: '作曲', responsibility: '创作配乐', method: '生成音乐', acceptance: '音频可播放', allowedTools: ['audio_generation'] }],
      tasks: [{ id: 'theme', roleId: 'composer', goal: '创作轻快的森林追逐配乐，包含木琴和鼓点', dependsOn: [], tool: 'audio_generation', acceptance: '有完整音乐附件' }], finalAcceptance: '音乐附件可播放' }));
    vi.mocked(queueAgentTeamAudio).mockResolvedValue({ externalTaskId: 'music-task' });
    vi.mocked(inspectAgentTeamAudioAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'music-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'text-model' }, () => `music-scope-${runId}`);
    const result = await workflow.start(runId, chatId, '生成一段森林追逐背景音乐');
    expect(result.snapshot.tasks.find((task) => task.id === 'theme')).toMatchObject({ kind: 'agent_audio', status: 'waiting_external', externalTaskId: 'music-task' });
    expect(queueAgentTeamAudio).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('木琴和鼓点') }));
  });
  it.each([false, true])('reads only narration text with no production instructions (script dependency: %s)', async (dependency) => {
    const runId = crypto.randomUUID();
    const role = { id: 'narrator', name: '旁白制作', responsibility: '制作旁白', method: '先写正文再配音', acceptance: '可播放', allowedTools: ['text_generation', 'speech_generation'] };
    useSettingsStore.setState({ aiProfiles: [{ id: 'tts', name: '旁白', type: 'tts', provider: 'openai', apiKey: 'test', baseUrl: 'https://example.test', model: 'tts-1', isDefault: true }] });
    const text = '森林深处，一场追逐开始了。';
    const tasks = [
      ...(dependency ? [{ id: 'script', roleId: role.id, goal: '只写旁白正文', dependsOn: [], acceptance: '正文完整' }] : []),
      { id: 'narration', roleId: role.id, goal: '制作旁白，不应朗读这条指令', dependsOn: dependency ? ['script'] : [], tool: 'speech_generation', speech: dependency ? { textTaskId: 'script' } : { text }, acceptance: '附件可播放' },
    ];
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '配音', roles: [role], tasks, finalAcceptance: '旁白可播放' }));
    if (dependency) generate.mockResolvedValueOnce(text);
    vi.mocked(queueAgentTeamAudio).mockResolvedValue({ output: '旁白已保存' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'text-model' }, () => `speech-${runId}`);
    const result = await workflow.start(runId, 'chat', '制作森林短片旁白');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'narration')).toMatchObject({ kind: 'agent_audio', status: 'completed' });
    expect(queueAgentTeamAudio).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: text, purpose: 'speech' }));
  });

  it('passes completed lyrics into a dependent music generation task', async () => {
    const runId = crypto.randomUUID();
    const chatId = `lyrics-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'audio', name: '音乐', type: 'audio', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'music-model', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '写歌', roles: [{ id: 'writer', name: '词作者', responsibility: '写歌词', method: '创作', acceptance: '歌词完整', allowedTools: ['text_generation'] },
      { id: 'composer', name: '作曲', responsibility: '作曲', method: '生成音乐', acceptance: '音频可播放', allowedTools: ['audio_generation'] }],
    tasks: [{ id: 'lyrics', roleId: 'writer', goal: '写森林追逐主题歌词', dependsOn: [], tool: 'text_generation', acceptance: '有完整歌词' },
      { id: 'song', roleId: 'composer', goal: '用木琴与鼓点谱曲', dependsOn: ['lyrics'], tool: 'audio_generation', acceptance: '有完整音乐附件' }], finalAcceptance: '歌词和音乐均完成' }))
      .mockResolvedValueOnce('歌词：沿着森林小径，追逐夕阳的足迹。');
    vi.mocked(queueAgentTeamAudio).mockResolvedValue({ externalTaskId: 'lyrics-music-task' });
    vi.mocked(inspectAgentTeamAudioAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'lyrics-music-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'text-model' }, () => `lyrics-scope-${runId}`);
    const result = await workflow.start(runId, chatId, '先写歌词，再生成音乐');
    expect(result.snapshot.tasks.find((task) => task.id === 'song')?.status).toBe('waiting_external');
    expect(queueAgentTeamAudio).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('沿着森林小径，追逐夕阳的足迹') }));
  });
  it('inspects generated image bytes before passing observations downstream', async () => {
    const runId = crypto.randomUUID();
    const chatId = `inspection-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'vision', name: '视觉文字', type: 'text', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '检查场景', roles: [
      { id: 'artist', name: '画师', responsibility: '画场景', method: '生成图片', acceptance: '有图片', allowedTools: ['image_generation'] },
      { id: 'reviewer', name: '检查员', responsibility: '检查画面', method: '观察图片', acceptance: '有观察', allowedTools: ['image_inspection', 'text_generation'] },
    ], tasks: [
      { id: 'scene', roleId: 'artist', goal: '画森林', dependsOn: [], tool: 'image_generation', acceptance: '森林图' },
      { id: 'inspect', roleId: 'reviewer', goal: '检查森林', dependsOn: ['scene'], tool: 'image_inspection', acceptance: '有森林' },
      { id: 'report', roleId: 'reviewer', goal: '写检查报告', dependsOn: ['inspect'], tool: 'text_generation', acceptance: '报告可读' },
    ], finalAcceptance: '报告说明实际画面' })).mockResolvedValueOnce('根据检查观察撰写的报告');
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片附件已保存' });
    vi.mocked(teamImageReference).mockReturnValue({ url: '/uploads/media/forest.png', mimeType: 'image/png' });
    vi.mocked(inspectAgentTeamImages).mockImplementation(async (params) => { await params.beforeModelRequest?.(); return '实际画面有森林，无角色'; });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o' }, () => `inspection-scope-${runId}`);
    const result = await workflow.start(runId, chatId, '画森林并检查');
    expect(result.snapshot.run.status).toBe('completed');
    expect(inspectAgentTeamImages).toHaveBeenCalledWith(expect.objectContaining({ references: [{ url: '/uploads/media/forest.png', mimeType: 'image/png' }] }));
    expect(generate.mock.calls[1][2][0].content).toContain('实际画面有森林，无角色');
  });
  it('uses image inspection observations in a dependent video prompt', async () => {
    const runId = crypto.randomUUID();
    const chatId = `inspection-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'vision', name: '视觉文字', type: 'text', provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作短片', method: '先画后检查', acceptance: '可播放', allowedTools: ['image_generation', 'image_inspection', 'video_generation'] }],
      tasks: [
        { id: 'scene', roleId: 'director', goal: '画森林', dependsOn: [], tool: 'image_generation', acceptance: '森林图' },
        { id: 'inspect', roleId: 'director', goal: '检查场景', dependsOn: ['scene'], tool: 'image_inspection', acceptance: '有森林' },
        { id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: ['inspect'], tool: 'video_generation', acceptance: '可播放' },
      ], finalAcceptance: '短片可播放' }));
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片已保存' });
    vi.mocked(teamImageReference).mockReturnValue({ url: '/uploads/media/forest.png', mimeType: 'image/png' });
    vi.mocked(inspectAgentTeamImages).mockImplementation(async (params) => { await params.beforeModelRequest?.(); return '实际画面是森林，但光线偏暗'; });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'video-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'gpt-4o' }, () => `inspection-video-scope-${runId}`);
    const result = await workflow.start(runId, chatId, '画森林并生成短片');
    expect(result.snapshot.tasks.find((task) => task.id === 'shot')?.status).toBe('waiting_external');
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('实际画面是森林，但光线偏暗'),
      referenceImages: [{ url: '/uploads/media/forest.png', mimeType: 'image/png' }],
    }));
  });
  it('automatically reviews delivery, delegates one missing step, and does not repeat it on resume', async () => {
    const runId = crypto.randomUUID();
    const basePlan = { summary: '研究', roles: [{ id: 'writer', name: '写作者', responsibility: '研究', method: '整理', acceptance: '有结论', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'writer', goal: '研究问题', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '报告可读' };
    const followup = { ...basePlan, summary: '补写报告', tasks: [{ id: 'report', roleId: 'writer', goal: '根据研究写报告', dependsOn: [], acceptance: '报告可读' }] };
    const researchOutput = '研究结论'.repeat(600);
    generate.mockResolvedValueOnce(JSON.stringify(basePlan)).mockResolvedValueOnce(researchOutput)
      .mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '缺少报告', nextRequest: '根据研究结论写报告' }))
      .mockResolvedValueOnce(JSON.stringify(followup)).mockResolvedValueOnce('完整报告')
      .mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '报告已完成' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-auto-review-test');
    const finished = await workflow.start(runId, 'chat', '研究并写报告', true);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.find((task) => task.id === 'auto_delegate_1_report')?.output).toBe('完整报告');
    expect(finished.snapshot.tasks.filter((task) => task.kind === 'team_review')).toHaveLength(2);
    const reviews = finished.snapshot.tasks.filter((task) => task.kind === 'team_review');
    expect(reviews[0].output).toMatchObject({ schemaVersion: 1, runId, taskId: 'review_1', attempt: 1,
      sources: [{ taskId: 'research', kind: 'agent_text', attempt: 1 }] });
    expect(reviews[1].output).toMatchObject({ schemaVersion: 1, taskId: 'review_2', complete: true });
    const saved = JSON.stringify(reviews.map((task) => task.output));
    expect(generate.mock.calls[2][2][0].content).toContain('最终验收标准：报告可读');
    const firstEvidence = JSON.parse(generate.mock.calls[2][2][0].content.split('项已完成记录未列出）：')[1]);
    expect(firstEvidence).toEqual([{ task: 'research', kind: 'agent_text', goal: '研究问题', acceptance: '有结论',
      output: researchOutput.slice(0, 1800), outputCharacters: researchOutput.length, truncated: true }]);
    expect(generate.mock.calls[2][1]).toContain('未展示的部分不能当作已读取');
    const secondEvidence = JSON.parse(generate.mock.calls[5][2][0].content.split('项已完成记录未列出）：')[1]);
    expect(secondEvidence.find((item: { task: string }) => item.task === 'auto_delegate_1_report')).toMatchObject({
      goal: '根据研究写报告', acceptance: '报告可读', output: '完整报告', outputCharacters: 4, truncated: false,
    });
    const resumed = await workflow.resume(runId);
    expect(JSON.stringify(resumed.snapshot.tasks.filter((task) => task.kind === 'team_review').map((task) => task.output))).toBe(saved);
    await expect(indexedDbWorkflowRepository.transact('team-auto-review-test', runId, (current) => {
      if (!current) throw new Error('Missing run');
      return { snapshot: { ...current, tasks: current.tasks.map((task) => task.id === 'review_1' ? { ...task, output: { complete: true, reason: '篡改结论' } } : task) }, value: undefined };
    })).rejects.toThrow('验收记录不可修改');
    expect(generate).toHaveBeenCalledTimes(6);
  });
  it.each([false, true])('pauses stalled revisions and remains blocked after restart (paraphrased: %s)', async (paraphrased) => {
    const runId = crypto.randomUUID();
    const plan = { summary: '研究', roles: [{ id: 'writer', name: '研究员', responsibility: '研究', method: '核对来源', acceptance: '有来源', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'writer', goal: '研究问题', dependsOn: [], acceptance: '有来源' }], finalAcceptance: '结论有来源' };
    const verdict = JSON.stringify({ complete: false, reason: '缺少来源', nextRequest: '补充来源' });
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('目前缺少来源')
      .mockResolvedValueOnce(verdict).mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce(paraphrased ? '暂时尚无资料，稍后继续查询' : '目前缺少来源')
      .mockResolvedValueOnce(paraphrased ? JSON.stringify({ complete: false, reason: '没有新增资料', nextRequest: '查找可核验公开资料', progress: { status: 'stalled', reason: '只有改写和承诺，没有新增来源' } }) : verdict);
    const scope = `team-stalled-${runId}`;
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const result = await workflow.start(runId, 'chat', '研究问题', true);
    expect(result.snapshot.run.status).toBe('paused');
    expect(result.snapshot.tasks.find((task) => task.id === 'review_needs_user')?.error).toContain('没有产生新的文本交付');
    expect(result.snapshot.tasks.some((task) => task.id === 'auto_delegate_2')).toBe(false);
    if (paraphrased) {
      expect(result.snapshot.tasks.find((task) => task.id === 'review_2')?.output).toMatchObject({ progress: { status: 'stalled', previousReviewTaskId: 'review_1' } });
      expect(generate.mock.calls[5][1]).toContain('完整文字证据');
      expect(generate.mock.calls[5][1]).toContain('暂时尚无资料，稍后继续查询');
    }
    const restarted = createAgentTeamWorkflow(config, () => scope);
    await restarted.resume(runId);
    expect(generate).toHaveBeenCalledTimes(6);
    const updated = await restarted.addRevisionRequest(runId, result.snapshot.run.planVersion, '明确只使用已提供资料');
    expect(updated.tasks.some((task) => task.id === 'review_needs_user')).toBe(false);
  });
  it.each(['advanced', 'uncertain'])('continues automatic revision when progress is %s', async (status) => {
    const runId = crypto.randomUUID();
    const plan = { summary: '研究', roles: [{ id: 'writer', name: '研究员', responsibility: '研究', method: '核对', acceptance: '有来源', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'writer', goal: '研究问题', dependsOn: [], acceptance: '有来源' }], finalAcceptance: '结论有来源' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('尚无资料')
      .mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '缺少来源', nextRequest: '补充来源' }))
      .mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('找到资料线索，尚需核对')
      .mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '尚需核对', nextRequest: '核对资料线索', progress: { status, reason: '新增了可核对线索' } }))
      .mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('已核对资料，结论完整')
      .mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '已完成' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `progress-${runId}`);
    const result = await workflow.start(runId, 'chat', '研究问题', true);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.some((task) => task.id === 'review_needs_user')).toBe(false);
    expect(generate).toHaveBeenCalledTimes(9);
  });

  it('retains early media evidence when a long run has later text results', async () => {
    const runId = crypto.randomUUID();
    const now = Date.now();
    const plan = { summary: '短片说明', roles: [{ id: 'writer', name: '写作者', responsibility: '整理', method: '撰写', acceptance: '有内容', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'note_0', roleId: 'writer', goal: '写说明', dependsOn: [], acceptance: '可读' }], finalAcceptance: '视频与说明齐全' };
    const scope = 'team-review-media-evidence-test';
    const sourceTaskIds = ['shot', ...Array.from({ length: 13 }, (_, index) => `note_${index}`)];
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '生成视频并附说明', status: 'active', generation: 1, planVersion: 2, planOpen: true, autoReview: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '生成视频并附说明', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'shot', runId, kind: 'agent_video', input: {}, output: '视频附件已保存', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
        ...sourceTaskIds.slice(1).map((id) => ({ id, runId, kind: 'agent_text', input: {}, output: '说明已写', dependsOn: ['plan'], status: 'completed' as const, attempt: 1, updatedAt: now })),
        { id: 'review_1', runId, kind: 'team_review', input: { sourceTaskIds }, dependsOn: sourceTaskIds, status: 'queued', attempt: 0, updatedAt: now },
      ],
    }, value: undefined }));
    generate.mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '已交付' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    const evidence = generate.mock.calls[0][2][0].content;
    expect(evidence).toContain('视频附件已保存');
    expect(evidence).toContain('另有 0 项已完成记录未列出');
    expect(evidence).toContain('note_12');
  });
  it('resumes an already expanded automatic plan near the task limit without blocking it again', async () => {
    const runId = crypto.randomUUID();
    const chatId = `auto-limit-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    const basePlan = { summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '生成视频', method: '生成', acceptance: '成片', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成短片', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '可播放' };
    const extraPlan = { summary: '补充', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'note', roleId: 'writer', goal: '补充说明', dependsOn: [], acceptance: '有说明' }], finalAcceptance: '完整' };
    const now = Date.now();
    const tasks: WorkflowSnapshot['tasks'] = [
      { id: 'plan', runId, kind: 'team_plan', input: '短片', output: basePlan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'shot', runId, kind: 'agent_video', input: { task: basePlan.tasks[0], role: basePlan.roles[0], goal: '短片' }, output: '视频已生成', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'review_1', runId, kind: 'team_review', input: { sourceTaskIds: ['shot'] }, output: { complete: false, reason: '缺少说明', nextRequest: '补充说明' }, dependsOn: ['shot'], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'auto_delegate_1', runId, kind: 'team_plan_revision', input: { request: '补充说明', sourceTaskIds: ['shot'] }, output: extraPlan, dependsOn: ['review_1', 'shot'], status: 'completed', attempt: 1, updatedAt: now },
      { id: 'auto_delegate_1_note', runId, kind: 'agent_text', input: { task: extraPlan.tasks[0], role: extraPlan.roles[0], goal: '短片', sourcePlanTaskId: 'auto_delegate_1', contextTaskIds: ['shot'] }, dependsOn: ['auto_delegate_1', 'shot'], status: 'completed', output: '说明完成', attempt: 1, updatedAt: now },
      ...Array.from({ length: 18 }, (_, index): WorkflowSnapshot['tasks'][number] => ({ id: `history_${index}`, runId, kind: 'agent_text', input: {}, dependsOn: [], status: 'completed', output: '历史记录', attempt: 1, updatedAt: now })),
    ];
    const scope = 'team-auto-limit-resume-test';
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: { run: { id: runId, chatId, goal: '短片', status: 'paused', generation: 1, planVersion: 6, planOpen: true, autoReview: true, updatedAt: now }, tasks }, value: undefined }));
    generate.mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '已完成' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.some((task) => task.id === 'review_needs_user')).toBe(false);
    expect(result.snapshot.tasks.find((task) => task.id === 'review_2')?.status).toBe('completed');
  });
  it('reports malformed completed review output as a definite failure', async () => {
    const runId = crypto.randomUUID();
    const plan = { summary: '报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '成稿' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('报告正文').mockResolvedValueOnce('{bad json');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-invalid-review-test');
    const result = await workflow.start(runId, 'chat', '写报告', true);
    expect(result.snapshot.tasks.find((task) => task.id === 'review_1')?.status).toBe('failed');
    expect(result.snapshot.tasks.find((task) => task.id === 'review_1')?.error).toContain('无效 JSON');
    const retry = await workflow.retryFailedReview(runId, 'review_1', result.snapshot.run.planVersion);
    expect(retry.tasks.find((task) => task.id === 'review_1')?.status).toBe('queued');
    expect(retry.run.status).toBe('paused');
    generate.mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '报告完整' }));
    const finished = await workflow.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.find((task) => task.id === 'write')?.attempt).toBe(1);
    expect(finished.snapshot.tasks.find((task) => task.id === 'review_1')?.attempt).toBe(2);
  });
  it('reports an empty completed child response as a definite failure', async () => {
    const runId = crypto.randomUUID();
    const plan = { summary: '报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '成稿' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('   ');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-empty-child-test');
    const result = await workflow.start(runId, 'chat', '写报告');
    expect(result.snapshot.tasks.find((task) => task.id === 'write')?.status).toBe('failed');
    expect(result.snapshot.tasks.find((task) => task.id === 'write')?.error).toContain('未提交内容');
  });
  it('reviews an asynchronously generated video after its saved attachment completes', async () => {
    const runId = crypto.randomUUID();
    const chatId = `review-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作视频', method: '生成', acceptance: '可播放', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成短片', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '短片可播放' }));
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'saved-video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'saved-video-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-review-video-test');
    const waiting = await workflow.start(runId, chatId, '生成一段短片', true);
    expect(waiting.snapshot.run.status).toBe('active');
    expect(waiting.snapshot.tasks.some((task) => task.kind === 'team_review')).toBe(false);
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'completed', output: '视频已生成' });
    generate.mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '视频已交付' }));
    const finished = await workflow.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.find((task) => task.id === 'review_1')?.status).toBe('completed');
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
    await workflow.resume(runId);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('recovers a saved automatic review after a new workflow instance is created', async () => {
    const runId = crypto.randomUUID();
    const scope = 'team-review-restart-test';
    const plan = { summary: '报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '撰写报告', dependsOn: [], acceptance: '报告完整' }], finalAcceptance: '报告完整' };
    let finishReview!: (value: string) => void;
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('报告正文')
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishReview = resolve; }));
    const first = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const pending = first.start(runId, 'chat', '写报告', true);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    await first.requestPauseAfterCurrentBatch(runId);
    finishReview(JSON.stringify({ complete: true, reason: '报告完整' }));
    const paused = await pending;
    expect(paused.snapshot.run.status).toBe('paused');
    const recovered = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const finished = await recovered.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.filter((task) => task.kind === 'team_review')).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it('runs a text team when the configured video model directory is unavailable', async () => {
    const runId = crypto.randomUUID();
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'missing-video', isDefault: true }] });
    vi.mocked(listAvailableModels).mockRejectedValueOnce(new Error('模型目录请求失败'));
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '写摘要', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '有摘要', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写摘要', dependsOn: [], acceptance: '有摘要' }], finalAcceptance: '摘要完整' })).mockResolvedValueOnce('摘要内容');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-text-video-unavailable-test');
    const result = await workflow.start(runId, 'chat', '写一份摘要');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'write')?.output).toBe('摘要内容');
    expect(generate.mock.calls[0][1]).toContain('视频模型目录暂不可用');
  });
  it('rejects a video plan when the selected model is missing from the live directory', async () => {
    const runId = crypto.randomUUID();
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'removed-video', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '生成视频', method: '生成', acceptance: '成片', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '可播放' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-removed-video-test');
    const result = await workflow.start(runId, 'chat', '生成短片');
    expect(result.snapshot.tasks[0].status).toBe('failed');
    expect(result.snapshot.tasks[0].error).toContain('未在可用模型列表中');
    expect(result.snapshot.tasks[0].capabilityIssue).toMatchObject({ schemaVersion: 1, tool: 'video_generation', code: 'service_unavailable', attempt: 1 });
    const recovered = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-removed-video-test');
    expect((await recovered.read(runId))?.tasks[0].capabilityIssue).toEqual(result.snapshot.tasks[0].capabilityIssue);
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    const retry = await workflow.retryFailedTask(runId, 'plan', result.snapshot.run.planVersion);
    expect(retry.run.status).toBe('paused');
    expect(retry.tasks[0].capabilityIssue).toBeUndefined();
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '生成视频', method: '生成', acceptance: '成片', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '可播放' }));
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'restored-video' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'restored-video' });
    const resumed = await workflow.resume(runId);
    expect(resumed.snapshot.tasks[0].status).toBe('completed');
    expect(resumed.snapshot.tasks[0].attempt).toBe(2);
    expect(resumed.snapshot.tasks.find((task) => task.id === 'shot')?.status).toBe('waiting_external');
  });
  it('does not reuse the automatic acceptance verdict after an explicit new task', async () => {
    const runId = crypto.randomUUID();
    const plan = { summary: '研究', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'writer', goal: '研究', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '有结论' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('研究结论')
      .mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '研究已完成' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-explicit-after-review-test');
    const first = await workflow.start(runId, 'chat', '研究问题', true);
    expect(first.snapshot.run.status).toBe('completed');
    const reopened = await workflow.addRevisionRequest(runId, first.snapshot.run.planVersion, '再写一份报告');
    expect(reopened.run.autoReview).toBe(false);
    generate.mockResolvedValueOnce(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: 'report', goal: '写报告' }] })).mockResolvedValueOnce('报告正文');
    const finished = await workflow.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.find((task) => task.id === 'delegated_report')?.output).toBe('报告正文');
    expect(finished.snapshot.tasks.filter((task) => task.kind === 'team_review')).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(5);
  });
  it('keeps unmet acceptance blocked and lets the user replace the block with an explicit task', async () => {
    const runId = crypto.randomUUID();
    const plan = { summary: '研究', roles: [{ id: 'writer', name: '写作者', responsibility: '研究', method: '整理', acceptance: '有结论', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'writer', goal: '研究问题', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '完整交付' };
    generate.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce('阶段结论');
    for (let round = 0; round < 3; round += 1) {
      generate.mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '仍不完整', nextRequest: `补做步骤 ${round + 1}` }));
      if (round < 2) generate.mockResolvedValueOnce(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: `extra_${round + 1}` }] })).mockResolvedValueOnce(`补做结果 ${round + 1}`);
    }
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-auto-block-test');
    const blocked = await workflow.start(runId, 'chat', '完成复杂目标', true);
    expect(blocked.snapshot.run.status).toBe('paused');
    expect(blocked.snapshot.tasks.find((task) => task.id === 'review_needs_user')?.status).toBe('waiting_user');
    const calls = generate.mock.calls.length;
    await workflow.resume(runId);
    expect(generate).toHaveBeenCalledTimes(calls);
    const updated = await workflow.addRevisionRequest(runId, blocked.snapshot.run.planVersion, '按我的新要求补做');
    expect(updated.tasks.some((task) => task.id === 'review_needs_user')).toBe(false);
    expect(updated.run.autoReview).toBe(false);
  });
  it('passes a completed image attachment to the dependent video task', async () => {
    const runId = crypto.randomUUID();
    const chatId = `image-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'test-image', name: '测试图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '制作短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '先画后拍', acceptance: '成片', allowedTools: ['image_generation', 'video_generation'] }],
      tasks: [
        { id: 'scene', roleId: 'director', goal: '黄昏森林场景图', dependsOn: [], tool: 'image_generation', acceptance: '有图片' },
        { id: 'shot', roleId: 'director', goal: '森林追逐视频', dependsOn: ['scene'], tool: 'video_generation', acceptance: '可播放' },
      ], finalAcceptance: '成片可播放' }));
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '图片已生成并保存在当前聊天附件' });
    vi.mocked(teamImageReference).mockReturnValue({ url: 'https://example.test/scene.png', mimeType: 'image/png', label: '场景图' });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'video-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-image-video-test');
    const result = await workflow.start(runId, chatId, '先画场景再生成视频');
    expect(result.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'waiting_external']);
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [{ url: 'https://example.test/scene.png', mimeType: 'image/png', label: '场景图' }] }));
  });
  it('passes an image reference through an intermediate script dependency', async () => {
    const runId = crypto.randomUUID();
    const chatId = `indirect-image-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '先画后拍', acceptance: '成片', allowedTools: ['image_generation', 'text_generation', 'video_generation'] }],
      tasks: [
        { id: 'scene', roleId: 'director', goal: '场景图', dependsOn: [], tool: 'image_generation', acceptance: '有图片' },
        { id: 'script', roleId: 'director', goal: '写镜头脚本', dependsOn: ['scene'], tool: 'text_generation', acceptance: '有脚本' },
        { id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: ['script'], tool: 'video_generation', acceptance: '可播放' },
      ], finalAcceptance: '视频可播放' })).mockResolvedValueOnce('镜头脚本');
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '场景图已保存' });
    vi.mocked(teamImageReference).mockReturnValue({ url: '/uploads/media/scene.png', mimeType: 'image/png', label: '场景图' });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'video-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-indirect-image-test');
    const result = await workflow.start(runId, chatId, '先画场景再生成视频');
    expect(result.snapshot.tasks.find((task) => task.id === 'shot')?.status).toBe('waiting_external');
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: [{ url: '/uploads/media/scene.png', mimeType: 'image/png', label: '场景图' }] }));
  });
  it('passes an upstream script through an image dependency to the video prompt', async () => {
    const runId = crypto.randomUUID();
    const chatId = `script-image-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true },
    ] });
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '按脚本制作', acceptance: '成片', allowedTools: ['text_generation', 'image_generation', 'video_generation'] }],
      tasks: [
        { id: 'script', roleId: 'director', goal: '写镜头脚本', dependsOn: [], tool: 'text_generation', acceptance: '有脚本' },
        { id: 'scene', roleId: 'director', goal: '画关键帧', dependsOn: ['script'], tool: 'image_generation', acceptance: '有图片' },
        { id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: ['scene'], tool: 'video_generation', acceptance: '可播放' },
      ], finalAcceptance: '视频可播放' })).mockResolvedValueOnce('黄昏森林中恐龙追逐机器猫，镜头向右跟拍');
    vi.mocked(queueAgentTeamImage).mockResolvedValue({ output: '关键帧已保存' });
    vi.mocked(teamImageReference).mockReturnValue({ url: '/uploads/media/frame.png', mimeType: 'image/png', label: '关键帧' });
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'video-task' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-script-image-video-test');
    const result = await workflow.start(runId, chatId, '先写脚本再画图并生成视频');
    expect(result.snapshot.tasks.find((task) => task.id === 'shot')?.status).toBe('waiting_external');
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('黄昏森林中恐龙追逐机器猫，镜头向右跟拍'),
      referenceImages: [{ url: '/uploads/media/frame.png', mimeType: 'image/png', label: '关键帧' }],
    }));
  });
  it('rejects a two-image video plan when the selected model permits one reference', async () => {
    const runId = crypto.randomUUID();
    const chatId = `one-reference-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [
      { id: 'image', name: '图片', type: 'image', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true },
      { id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'one-image-model', isDefault: true },
    ] });
    vi.mocked(listAvailableModels).mockResolvedValueOnce([{ id: 'one-image-model', label: '单图视频', raw: { aceVideoOptions: { acceptsReferenceImages: true, maxReferenceImages: 1 } } }]);
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '先画后拍', acceptance: '成片', allowedTools: ['image_generation', 'video_generation'] }],
      tasks: [
        { id: 'scene_a', roleId: 'director', goal: '场景图', dependsOn: [], tool: 'image_generation', acceptance: '有图片' },
        { id: 'scene_b', roleId: 'director', goal: '角色图', dependsOn: [], tool: 'image_generation', acceptance: '有图片' },
        { id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: ['scene_a', 'scene_b'], tool: 'video_generation', acceptance: '可播放' },
      ], finalAcceptance: '可播放' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-single-reference-test');
    const result = await workflow.start(runId, chatId, '用两张图生成视频');
    expect(result.snapshot.tasks[0].status).toBe('failed');
    expect(result.snapshot.tasks[0].error).toContain('最多支持 1 张参考图片');
    expect(queueAgentTeamImage).not.toHaveBeenCalled();
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
  });
  it('rejects a text-only video plan when the selected model requires a reference image', async () => {
    const runId = crypto.randomUUID();
    const chatId = `image-required-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'video', name: '视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'minimax-i2v', isDefault: true }] });
    vi.mocked(listAvailableModels).mockResolvedValueOnce([{ id: 'minimax-i2v', label: '图生视频', raw: { aceVideoOptions: { acceptsReferenceImages: true, requiresReferenceImage: true, maxReferenceImages: 1 } } }]);
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '生成', acceptance: '成片', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '可播放' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-image-required-test');
    const result = await workflow.start(runId, chatId, '生成视频');
    expect(result.snapshot.tasks[0].status).toBe('failed');
    expect(result.snapshot.tasks[0].error).toContain('必须提供参考图片');
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
  });
  it('waits for a submitted video and runs dependent writing only after the attachment is ready', async () => {
    const runId = crypto.randomUUID();
    const chatId = `video-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '制作短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '按脚本拍摄', acceptance: '可播放', allowedTools: ['video_generation', 'text_generation'] }],
      tasks: [
        { id: 'shot', roleId: 'director', goal: '森林里的追逐镜头', dependsOn: [], tool: 'video_generation', acceptance: '视频可播放' },
        { id: 'summary', roleId: 'director', goal: '总结成片', dependsOn: ['shot'], tool: 'text_generation', acceptance: '简短总结' },
      ], finalAcceptance: '成片和摘要',
    })).mockResolvedValueOnce('视频制作完成');
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'task-1' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'task-1' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-video-test');
    const pending = await workflow.start(runId, chatId, '制作短片');
    expect(pending.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'waiting_external', 'waiting_dependency']);
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'completed', output: '视频已生成' });
    const completed = await workflow.resume(runId);
    expect(completed.snapshot.run.status).toBe('completed');
    expect(completed.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[1][2][0].content).toContain('视频已生成');
  });

  it('restores delegated external media without re-planning or resubmitting it', async () => {
    const runId = crypto.randomUUID();
    const scope = `delegated-video-${runId}`;
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    const role = { id: 'director', name: '导演', responsibility: '拍摄', method: '拆分', acceptance: '成片', allowedTools: ['delegate_task', 'video_generation', 'text_generation'] };
    generate.mockResolvedValueOnce(JSON.stringify({ summary: '短片', roles: [role], tasks: [{ id: 'film', roleId: role.id, goal: '制作短片', tool: 'delegate_task', dependsOn: [], acceptance: '成片' }], finalAcceptance: '可播放' }))
      .mockResolvedValueOnce(JSON.stringify({ summary: '镜头', roles: [{ ...role, allowedTools: ['video_generation'] }], tasks: [{ id: 'shot', roleId: role.id, goal: '森林追逐', tool: 'video_generation', dependsOn: [], acceptance: '视频' }], finalAcceptance: '视频' }))
      .mockResolvedValueOnce('下级已交付视频');
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'delegated-video-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'delegated-video-task' });
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const pending = await createAgentTeamWorkflow(config, () => scope).start(runId, 'chat', '制作森林短片', false);
    expect(pending.snapshot.tasks.find((task) => task.id === 'film')?.status).toBe('waiting_dependency');
    expect(pending.snapshot.tasks.find((task) => task.id === 'film_shot')?.externalTaskId).toBe('delegated-video-task');
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'completed', output: '视频已生成并保存' });
    const completed = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(completed.snapshot.run.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2][2][0].content).toContain('视频已生成并保存');
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
  });

  it('passes a completed script into the video prompt', async () => {
    const runId = crypto.randomUUID();
    const chatId = `script-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '制作短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '按脚本拍摄', acceptance: '可播放', allowedTools: ['text_generation', 'video_generation'] }],
      tasks: [
        { id: 'script', roleId: 'director', goal: '写追逐脚本', dependsOn: [], tool: 'text_generation', acceptance: '脚本完成' },
        { id: 'shot', roleId: 'director', goal: '生成追逐视频', dependsOn: ['script'], tool: 'video_generation', acceptance: '视频可播放' },
      ], finalAcceptance: '成片',
    })).mockResolvedValueOnce('恐龙从树林冲出，猫骑着飞行器逃离');
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'task-script' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'waiting_external', externalTaskId: 'task-script' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-script-video-test');
    const pending = await workflow.start(runId, chatId, '制作追逐短片');
    expect(pending.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'waiting_external']);
    expect(queueAgentTeamVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('恐龙从树林冲出，猫骑着飞行器逃离') }));
  });

  it('continues a failed run after its video attachment was retried successfully', async () => {
    const runId = crypto.randomUUID();
    const chatId = `retried-video-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '制作短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '拍摄', acceptance: '成片', allowedTools: ['video_generation', 'text_generation'] }],
      tasks: [
        { id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: [], tool: 'video_generation', acceptance: '可播放' },
        { id: 'summary', roleId: 'director', goal: '总结视频', dependsOn: ['shot'], tool: 'text_generation', acceptance: '有总结' },
      ], finalAcceptance: '可播放',
    })).mockResolvedValueOnce('视频已交付');
    vi.mocked(queueAgentTeamVideo).mockResolvedValue({ externalTaskId: 'retried-task' });
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'failed', error: '上游暂时失败' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-retried-video-test');
    expect((await workflow.start(runId, chatId, '制作短片')).snapshot.run.status).toBe('failed');
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'completed', output: '视频已生成并保存在当前聊天附件' });
    const completed = await workflow.resume(runId);
    expect(completed.snapshot.run.status).toBe('completed');
    expect(completed.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(queueAgentTeamVideo).toHaveBeenCalledTimes(1);
  });

  it('reconciles an unknown video result from its saved attachment before continuing', async () => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = 'team-unknown-video-test';
    const now = Date.now();
    const plan = { summary: '短片', roles: [{ id: 'director', name: '导演', responsibility: '制作', method: '拍摄', acceptance: '成片', allowedTools: ['video_generation'] }],
      tasks: [{ id: 'shot', roleId: 'director', goal: '生成视频', dependsOn: [], tool: 'video_generation', acceptance: '可播放' }], finalAcceptance: '成片' };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '生成短片', status: 'paused', generation: 1, planVersion: 1, planOpen: false, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '生成短片', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'shot', runId, kind: 'agent_video', input: { task: plan.tasks[0], role: plan.roles[0], goal: '生成短片' }, dependsOn: ['plan'], status: 'result_unknown', attempt: 1, updatedAt: now },
      ],
    }, value: undefined }));
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue({ status: 'completed', output: '视频已生成' });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const result = await workflow.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks[1].status).toBe('completed');
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
  });
  it('does not start child tasks when pause was requested during planning', async () => {
    const runId = crypto.randomUUID();
    let finishPlan!: (value: string) => void;
    generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishPlan = resolve; }));
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-pause-planning-test');
    const pending = scoped.start(runId, 'chat', '写报告');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await scoped.requestPauseAfterCurrentBatch(runId);
    finishPlan(JSON.stringify({
      summary: '写报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }],
      finalAcceptance: '报告可读',
    }));
    const paused = await pending;
    expect(paused.snapshot.run.status).toBe('paused');
    expect(paused.snapshot.tasks.map((task) => task.status)).toEqual(['completed', 'queued']);
    expect(generate).toHaveBeenCalledTimes(1);
    generate.mockResolvedValueOnce('已完成的报告');
    const resumed = await scoped.resume(runId);
    expect(resumed.snapshot.run.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(2);
  });

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

  it('uses real search results as evidence for a dependent text task', async () => {
    const runId = crypto.randomUUID();
    const chatId = `search-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, {
      id: chatId, type: 'assistant', deletedAt: null, modeState: { agentCapabilities: { enabled: true, webSearch: true } },
    } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '搜索后写摘要',
      roles: [{ id: 'researcher', name: '研究员', responsibility: '查证', method: '检索并核对', acceptance: '提供来源', allowedTools: ['web_search', 'text_generation'] }],
      tasks: [
        { id: 'lookup', roleId: 'researcher', goal: 'MirageTea 最新资料', dependsOn: [], tool: 'web_search', acceptance: '给出来源' },
        { id: 'report', roleId: 'researcher', goal: '写摘要', dependsOn: ['lookup'], tool: 'text_generation', acceptance: '引用来源' },
      ], finalAcceptance: '摘要可核对',
    })).mockResolvedValueOnce('已核对摘要');
    search.mockResolvedValueOnce({ query: 'MirageTea 最新资料', providerCode: 'test', pointCost: 0, results: [{ title: '资料', url: 'https://example.test/source', snippet: '可信线索' }] });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-search-test');
    const result = await workflow.start(runId, chatId, '调研并写摘要');
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.map((task) => task.kind)).toEqual(['team_plan', 'agent_web_search', 'agent_text']);
    expect(search).toHaveBeenCalledWith('MirageTea 最新资料', expect.objectContaining({ source: 'assistant_agent', resourceId: chatId }));
    expect(generate.mock.calls[1][2][0].content).toContain('https://example.test/source');
    expect(result.snapshot.tasks[1].toolInvocation).toMatchObject({ kind: 'agent_web_search', state: 'succeeded',
      request: describeWorkflowToolRequest('web_search', { query: 'MirageTea 最新资料', count: 8 }) });
    expect((await indexedDbWorkflowRepository.listTaskAttempts('team-search-test', runId, 'lookup'))[0].toolInvocation).toEqual(result.snapshot.tasks[1].toolInvocation);
  });

  it('refuses a planned search when the chat search capability was revoked', async () => {
    const runId = crypto.randomUUID();
    const chatId = `search-revoked-${runId}`;
    const chat = { id: chatId, type: 'assistant', deletedAt: null, modeState: { agentCapabilities: { enabled: true, webSearch: true } } } as (ReturnType<typeof useChatStore.getState>['chats'])[number];
    useChatStore.setState((state) => ({ chats: [...state.chats, chat] }));
    let finishPlan!: (value: string) => void;
    generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishPlan = resolve; }));
    const planned = JSON.stringify({
      summary: '搜索资料',
      roles: [{ id: 'researcher', name: '研究员', responsibility: '查证', method: '检索', acceptance: '提供来源', allowedTools: ['web_search'] }],
      tasks: [{ id: 'lookup', roleId: 'researcher', goal: '资料', dependsOn: [], tool: 'web_search', acceptance: '给出来源' }],
      finalAcceptance: '资料可核对',
    });
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-search-revoked-test');
    const pending = workflow.start(runId, chatId, '搜集资料');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await workflow.requestPauseAfterCurrentBatch(runId);
    finishPlan(planned);
    const paused = await pending;
    expect(paused.snapshot.tasks[1].status).toBe('queued');
    useChatStore.setState((state) => ({ chats: state.chats.map((item) => item.id === chatId
      ? { ...item, modeState: { ...item.modeState, agentCapabilities: { ...item.modeState.agentCapabilities, webSearch: false } } }
      : item) }));
    const resumed = await workflow.resume(runId);
    expect(resumed.snapshot.tasks[1].status).toBe('failed');
    expect(search).not.toHaveBeenCalled();
  });

  it('publishes one visible message and one document across repeated deliveries', async () => {
    const runId = crypto.randomUUID();
    const chatId = `team-chat-${runId}`;
    const chat = { id: chatId, type: 'assistant', name: '团队交付', memberIds: [], deletedAt: null, messageBranchState: { enabled: false } };
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

  it('does not publish recovered delivery when the conversation execution lock is unavailable', async () => {
    const runId = crypto.randomUUID();
    const chatId = `locked-delivery-${runId}`;
    const scope = `locked-delivery-scope-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '锁定交付', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理材料', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '报告可读',
    })).mockResolvedValueOnce('报告正文');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    await workflow.start(runId, chatId, '写报告');
    const request = vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) =>
      callback(name === conversationExecutionLockName(scope, chatId) ? null : {}));
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(workflow.publish(runId)).rejects.toThrow('另一个标签页');
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)).toHaveLength(0);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.some((item) => item.id === `team-delivery-${runId}`)).not.toBe(true);
    expect((await indexedDbWorkflowRepository.read(scope, runId))?.run.deliveryStatus).toBeUndefined();
    expect(request.mock.calls.map(([name]) => name)).toEqual([conversationExecutionLockName(scope, chatId)]);
  });

  it('publishes typed task deliverables as separate artifacts attached to one idempotent message', async () => {
    const runId = crypto.randomUUID();
    const chatId = `typed-delivery-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '多产物交付', memberIds: [], deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '调研与数据交付',
      roles: [{ id: 'analyst', name: '分析师', responsibility: '调研并整理数据', method: '提取结论和数据', acceptance: '交付可复用', allowedTools: ['text_generation'] }],
      tasks: [
        { id: 'findings', roleId: 'analyst', goal: '撰写调研结论', dependsOn: [], acceptance: '报告完整', deliverable: { kind: 'document', title: '调研报告' } },
        { id: 'comparison', roleId: 'analyst', goal: '整理比较表', dependsOn: ['findings'], acceptance: '表格完整', deliverable: { kind: 'table', title: '比較表', language: 'markdown' } },
      ], finalAcceptance: '报告和表格均可复用',
    })).mockResolvedValueOnce('调研结论文本').mockResolvedValueOnce(' | 项目 | 值 |\n | --- | --- |\n | A | 1 |');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'typed-delivery-test');
    await workflow.start(runId, chatId, '完成调研并交付报告和表格');
    const first = await workflow.publish(runId);
    const second = await workflow.publish(runId);
    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId).filter((item) => item.sourceMessageId.startsWith(`team-delivery-${runId}:`));
    expect(artifacts.map((item) => [item.kind, item.title]).sort((left, right) => left[0].localeCompare(right[0]))).toEqual([['document', '调研报告'], ['table', '比較表']]);
    expect(artifacts).toHaveLength(2);
    expect(first.id).toBe(second.id);
    const delivered = useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.find((message) => message.id === `team-delivery-${runId}`);
    expect(delivered?.metadata?.assistant?.artifacts).toHaveLength(2);
    expect(delivered?.metadata?.assistant?.artifacts?.map((item) => item.id).sort()).toEqual(artifacts.map((item) => item.id).sort());
  });

  it('runs independent report and table tasks concurrently and publishes both artifacts', async () => {
    const runId = crypto.randomUUID();
    const chatId = `parallel-delivery-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '市场研究交付',
      roles: [{ id: 'analyst', name: '研究员', responsibility: '研究并整理', method: '并行完成报告和数据表', acceptance: '两份交付均完整', allowedTools: ['text_generation'] }],
      tasks: [
        { id: 'report', roleId: 'analyst', goal: '撰写市场研究报告', dependsOn: [], acceptance: '报告完整', deliverable: { kind: 'document', title: '市场报告' } },
        { id: 'table', roleId: 'analyst', goal: '整理市场数据表', dependsOn: [], acceptance: '表格完整', deliverable: { kind: 'table', title: '市场数据' } },
      ],
      finalAcceptance: '报告与数据表均可复用',
    })).mockResolvedValueOnce('报告正文').mockResolvedValueOnce('| 类别 | 数量 |\n| --- | --- |\n| A | 3 |');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => `parallel-delivery-scope-${runId}`);
    const finished = await workflow.start(runId, chatId, '完成市场研究报告与数据表');
    expect(finished.snapshot.run.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(finished.snapshot.tasks.filter((task) => task.id === 'report' || task.id === 'table').map((task) => task.status)).toEqual(['completed', 'completed']);

    await workflow.publish(runId);
    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId);
    expect(artifacts.map((item) => [item.kind, item.title]).sort()).toEqual([['document', '市场报告'], ['table', '市场数据']]);
    const delivery = useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.find((message) => message.id === `team-delivery-${runId}`);
    expect(delivery?.metadata?.assistant?.artifacts).toHaveLength(2);
  });

  it('does not publish a completed run after the workspace changes during store hydration', async () => {
    const runId = crypto.randomUUID();
    const chatId = `team-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '团队交付', memberIds: [], deletedAt: null } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '交付报告', roles: [{ id: 'writer', name: '写作者', responsibility: '写报告', method: '整理材料', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '报告可读',
    })).mockResolvedValueOnce('完成的报告');
    let activeScope = 'team-publish-scope-a';
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => activeScope);
    await workflow.start(runId, chatId, '交付报告');
    const hydrated = vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(false);
    const rehydrate = vi.spyOn(useChatStore.persist, 'rehydrate').mockImplementation(async () => {
      activeScope = 'team-publish-scope-b';
      return undefined;
    });
    try {
      await expect(workflow.publish(runId)).rejects.toThrow('账号已切换');
      expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)).toHaveLength(0);
      expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.some((item) => item.id === `team-delivery-${runId}`)).not.toBe(true);
    } finally {
      hydrated.mockRestore();
      rehydrate.mockRestore();
    }
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

  it.each(['reserved', 'started', 'accepted'] as const)('recovers the %s tool journal at application startup', async (state) => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = currentWorkflowScope();
    const now = Date.now();
    vi.mocked(inspectAgentTeamVideoAttachment).mockReturnValue(state === 'accepted'
      ? { status: 'waiting_external', externalTaskId: 'accepted-job' } : null);
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '制作视频', status: 'active', generation: 1, planVersion: 1, planOpen: true, updatedAt: now },
      tasks: [{ id: 'plan', runId, kind: 'team_plan', input: '制作视频', dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'video', runId, kind: 'agent_video', input: {}, dependsOn: ['plan'], status: 'running', attempt: 1, updatedAt: now,
        toolInvocation: { schemaVersion: 1, id: workflowToolInvocationId(runId, 'video', 1), operationKey: workflowToolOperationKey(runId, 'video'),
          runId, taskId: 'video', kind: 'agent_video', attempt: 1, planVersion: 1, state: state === 'reserved' ? 'reserved' : 'started', reservedAt: now,
          ...(state === 'reserved' ? {} : { startedAt: now }) } }],
    }, value: undefined }));
    expect(await recoverAgentTeamRuns()).toBe(true);
    const saved = await indexedDbWorkflowRepository.read(scope, runId);
    expect(saved?.tasks[1]).toMatchObject({
      status: state === 'reserved' ? 'queued' : state === 'accepted' ? 'waiting_external' : 'result_unknown',
      toolInvocation: { state: state === 'reserved' ? 'not_started' : state === 'accepted' ? 'waiting_external' : 'result_unknown' },
    });
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
  });

  it('publishes a completed run after restart when the client stopped before delivery', async () => {
    const runId = `team-${crypto.randomUUID()}`;
    const chatId = `recovered-delivery-${runId}`;
    const scope = currentWorkflowScope();
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '恢复交付报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写报告', method: '整理资料', acceptance: '报告可读', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '报告可读', deliverable: { kind: 'document', title: '恢复报告' } }],
      finalAcceptance: '报告已完成',
    })).mockResolvedValueOnce('恢复后的报告内容');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const finished = await workflow.start(runId, chatId, '写报告');
    expect(finished.snapshot.run.status).toBe('completed');
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)).toHaveLength(0);

    expect(await recoverAgentTeamRuns()).toBe(true);
    expect(await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery')).toHaveLength(0);
    expect(await recoverAgentTeamRuns()).toBe(false);
    const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].versions.find((version) => version.id === artifacts[0].currentVersionId)?.content).toBe('恢复后的报告内容');
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.filter((message) => message.id === `team-delivery-${runId}`)).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await indexedDbWorkflowRepository.read(scope, runId))?.run.deliveryStatus).toBe('published');
    expect(await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery')).toHaveLength(0);
  });

  it.each(['artifact', 'message', 'transaction', 'edited-artifact', 'edited-message', 'later-message'])('recovers or blocks the immutable delivery after a %s failure', async (failure) => {
    const runId = `team-${crypto.randomUUID()}`;
    const chatId = `partial-delivery-${runId}`;
    const scope = currentWorkflowScope();
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    generate.mockResolvedValueOnce(JSON.stringify({
      summary: '中断恢复报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写报告', method: '整理资料', acceptance: '报告可读', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '报告可读', deliverable: { kind: 'document', title: '中断恢复报告' } }],
      finalAcceptance: '报告已完成',
    })).mockResolvedValueOnce('已保存的报告内容');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    await workflow.start(runId, chatId, '写报告');
    const messageStore = useMessageStore.getState();
    const interrupted = failure === 'artifact'
      ? vi.spyOn(useAssistantArtifactStore.getState(), 'applyWorkflowDelivery').mockImplementationOnce(() => { throw new Error('模拟交付写入失败'); })
      : failure === 'message' || failure === 'edited-artifact'
      ? vi.spyOn(messageStore, 'upsertMessage').mockImplementationOnce(() => { throw new Error('模拟交付写入失败'); })
      : vi.spyOn(persistence, 'commitBufferedPersistenceWrites').mockRejectedValueOnce(new Error('模拟交付写入失败'));
    await expect(workflow.publish(runId)).rejects.toThrow('模拟交付写入失败');
    interrupted.mockRestore();
    const prepared = await indexedDbWorkflowRepository.read(scope, runId);
    expect(prepared?.run.deliveryStatus).toBe('pending');
    expect(prepared?.run.deliveryIssue).toBe('save_failed');
    if (failure === 'artifact') await expect(workflow.publish(runId, prepared!.run.planVersion)).rejects.toThrow('没有待处理的内容冲突');
    await indexedDbWorkflowRepository.registerOutboxConsumer(scope, runId, 'team-delivery');
    expect((await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery')).length).toBeGreaterThan(0);
    expect(prepared?.run.delivery?.message.id).toBe(`team-delivery-${runId}`);
    await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => {
      if (!current?.run.delivery) throw new Error('缺少交付清单');
      current.run.delivery.message.content = '篡改交付清单';
      return { snapshot: current, value: undefined };
    })).rejects.toThrow('交付清单不可修改');
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)).toHaveLength(failure === 'artifact' ? 0 : 1);
    const versionId = prepared!.run.delivery!.artifacts[0].after.currentVersionId;
    if (failure === 'later-message') {
      const newerMessage = { ...prepared!.run.delivery!.message, id: `newer-${runId}`, clientKey: `newer-${runId}`,
        content: '之后的新消息', timestamp: prepared!.run.delivery!.message.timestamp + 1000 };
      useMessageStore.getState().upsertMessage(newerMessage);
      await useChatStore.getState().updateChat(chatId, { latestMessage: newerMessage, lastMessageAt: newerMessage.timestamp });
    }
    if (failure === 'edited-artifact') {
      useAssistantArtifactStore.setState((state) => ({ items: state.items.map((item) => item.chatId !== chatId ? item : {
        ...item, versions: item.versions.map((version) => ({ ...version, content: '用户亲自修改的内容' })),
      }) }));
      await expect(workflow.publish(runId)).rejects.toThrow('产物已被修改');
      expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)[0].versions[0].content).toBe('用户亲自修改的内容');
      expect((await workflow.read(runId))?.run.deliveryStatus).toBe('pending');
      expect((await workflow.read(runId))?.run.deliveryIssue).toBe('artifact_conflict');
      expect(generate).toHaveBeenCalledTimes(2);
    }
    if (failure === 'edited-message') {
      const message = useMessageStore.getState().messageWindowsByChatId[chatId]!.messages.find((item) => item.id === `team-delivery-${runId}`)!;
      useMessageStore.getState().upsertMessage({ ...message, content: '用户修改了交付消息' });
      await expect(workflow.publish(runId)).rejects.toThrow('交付消息已被修改');
      expect((await workflow.read(runId))?.run.deliveryStatus).toBe('pending');
      expect((await workflow.read(runId))?.run.deliveryIssue).toBe('message_conflict');
      expect(generate).toHaveBeenCalledTimes(2);
    }
    if (failure === 'edited-artifact' || failure === 'edited-message') {
      await expect(workflow.publish(runId, prepared!.run.planVersion + 1)).rejects.toThrow('交付版本冲突');
      const copyInterrupted = vi.spyOn(useAssistantArtifactStore.getState(), 'applyWorkflowDelivery').mockImplementationOnce(() => { throw new Error('模拟副本保存中断'); });
      await expect(workflow.publish(runId, prepared!.run.planVersion)).rejects.toThrow('模拟副本保存中断');
      copyInterrupted.mockRestore();
      const copyIntent = (await workflow.read(runId))!.run.deliveryCopy!;
      const decisions = (await workflow.read(runId))!.run.decisions!;
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ planVersion: prepared!.run.planVersion, action: 'preserve_and_copy_delivery',
        scope: { conflict: failure === 'edited-artifact' ? 'artifact_conflict' : 'message_conflict' } });
      await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => {
        current!.run.decisions = [];
        return { snapshot: current!, value: undefined };
      })).rejects.toThrow('决策不可删除');
      const beforeRejectedDecision = await workflow.read(runId);
      const outboxBeforeRejectedDecision = await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery');
      await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => {
        current!.run.decisions![0].scope.candidateSha256 = '0'.repeat(64);
        return { snapshot: current!, value: undefined };
      })).rejects.toThrow('决策与交付范围不一致');
      expect(await workflow.read(runId)).toEqual(beforeRejectedDecision);
      expect(await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery')).toEqual(outboxBeforeRejectedDecision);
      expect(copyIntent.copyOfPlanVersion).toBe(prepared!.run.planVersion);
      expect((await workflow.read(runId))!.run.delivery).toEqual(prepared!.run.delivery);
      await expect(indexedDbWorkflowRepository.transact(scope, runId, (current) => {
        current!.run.deliveryCopy!.message.content = '篡改副本';
        return { snapshot: current!, value: undefined };
      })).rejects.toThrow(/另存清单不可修改|决策另存结果与候选不一致/);
      const restored = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
      await restored.publish(runId);
      await restored.publish(runId, prepared!.run.planVersion);
      const final = (await restored.read(runId))!;
      expect(final.run.deliveryStatus).toBe('published');
      expect(final.run.deliveryCopy).toEqual(copyIntent);
      expect(final.run.decisions).toEqual(decisions);
      const artifacts = useAssistantArtifactStore.getState().getArtifactsForChat(chatId);
      expect(artifacts).toHaveLength(2);
      expect(artifacts.find((item) => item.id === copyIntent.artifacts[0].after.id)?.versions[0].content).toBe('已保存的报告内容');
      if (failure === 'edited-artifact') expect(artifacts.find((item) => item.id === prepared!.run.delivery!.artifacts[0].after.id)?.versions[0].content).toBe('用户亲自修改的内容');
      const savedMessages = useMessageStore.getState().messageWindowsByChatId[chatId]!.messages;
      expect(savedMessages.filter((item) => item.id === copyIntent.message.id)).toHaveLength(1);
      if (failure === 'edited-message') expect(savedMessages.find((item) => item.id === `team-delivery-${runId}`)?.content).toBe('用户修改了交付消息');
      expect(generate).toHaveBeenCalledTimes(2);
      return;
    }

    expect(await recoverAgentTeamRuns()).toBe(true);
    expect((await indexedDbWorkflowRepository.read(scope, runId))?.run.deliveryStatus).toBe('published');
    expect((await workflow.read(runId))?.run.deliveryIssue).toBeUndefined();
    expect(await indexedDbWorkflowRepository.listOutboxEvents(scope, runId, 'team-delivery')).toHaveLength(0);
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)).toHaveLength(1);
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)[0].currentVersionId).toBe(versionId);
    expect(useAssistantArtifactStore.getState().getArtifactsForChat(chatId)[0].versions).toHaveLength(1);
    expect(useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.filter((message) => message.id === `team-delivery-${runId}`)).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
    if (failure === 'later-message') {
      expect(useChatStore.getState().chats.find((chat) => chat.id === chatId)?.latestMessage?.id).toBe(`newer-${runId}`);
    }
  });

  it('preserves an interrupted review as unknown instead of evaluating or publishing it again', async () => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = currentWorkflowScope();
    const now = Date.now();
    const plan = { summary: '报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '可阅读' };
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '写报告', status: 'active', generation: 1, planVersion: 3, planOpen: true, autoReview: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '写报告', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'write', runId, kind: 'agent_text', input: { task: plan.tasks[0], role: plan.roles[0], goal: '写报告' }, output: '报告正文', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'review_1', runId, kind: 'team_review', input: { sourceTaskIds: ['write'] }, dependsOn: ['write'], status: 'running', attempt: 1, updatedAt: now },
      ],
    }, value: undefined }));
    expect(await recoverAgentTeamRuns()).toBe(true);
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    const resumed = await workflow.resume(runId);
    expect(resumed.snapshot.run.status).toBe('active');
    expect(resumed.snapshot.tasks.find((task) => task.id === 'review_1')?.status).toBe('result_unknown');
    expect(resumed.summary.blocked.some((item) => item.taskId === 'review_1')).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    await recoverAgentTeamRuns();
    const paused = await workflow.read(runId);
    const handled = await workflow.abandonUnknownReview(runId, 'review_1', paused!.run.planVersion);
    expect(handled.tasks.find((task) => task.id === 'review_1')?.status).toBe('abandoned');
    expect(handled.tasks.find((task) => task.id === 'review_needs_user')?.status).toBe('waiting_user');
    expect(handled.run.autoReview).toBe(false);
    await expect(workflow.abandonUnknownReview(runId, 'review_1', paused!.run.planVersion)).rejects.toThrow('计划已更新');
    const continued = await workflow.addRevisionRequest(runId, handled.run.planVersion, '按新要求完成报告');
    expect(continued.tasks.some((task) => task.id === 'review_needs_user')).toBe(false);
    await expect(workflow.addRevisionRequest(runId, continued.run.planVersion, '重复追加')).rejects.toThrow('请先完成已追加');
    generate.mockResolvedValueOnce(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], id: 'followup', goal: '按新要求完成报告' }] })).mockResolvedValueOnce('新报告正文');
    const delivered = await workflow.resume(runId);
    expect(delivered.snapshot.run.status).toBe('completed');
    expect(delivered.snapshot.tasks.find((task) => task.id === 'delegated_followup')?.output).toBe('新报告正文');
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

  it.each([undefined, true])('rejects a queued task with weakened JSON schema %s before calling the model', async (jsonSchema) => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = 'team-json-schema-consistency-test';
    const plan = {
      summary: '生成数据',
      roles: [{ id: 'writer', name: '写作者', responsibility: '生成数据', method: '整理材料', acceptance: '字段正确', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '生成数据', dependsOn: [], acceptance: '字段正确', deliverable: {
        kind: 'json', title: '数据', jsonSchema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
      } }],
      finalAcceptance: '字段正确',
    };
    const now = Date.now();
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '生成数据', status: 'paused', generation: 1, planVersion: 2, planOpen: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '生成数据', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'write', runId, kind: 'agent_text', input: {
          task: { ...plan.tasks[0], deliverable: { kind: 'json', title: '数据', jsonSchema } },
          role: plan.roles[0], goal: '生成数据',
        }, dependsOn: ['plan'], status: 'queued', attempt: 0, updatedAt: now },
      ],
    }, value: undefined }));

    const resumed = await scoped.resume(runId);
    expect(resumed.snapshot.tasks.find((task) => task.id === 'write')).toMatchObject({
      status: 'failed', error: '团队任务与已保存计划不一致', modelInvocation: { state: 'not_started' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'task-version', 'role-version'] as const)('validates saved task and role contract versions before requests: %s', async (variant) => {
    const runId = `team-${crypto.randomUUID()}`;
    const scope = 'team-legacy-role-version-test';
    const plan = {
      summary: '写报告',
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理材料', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'write', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }],
      finalAcceptance: '可阅读',
    };
    const now = Date.now();
    const taskInput = { task: { acceptance: '成稿', dependsOn: [], goal: '写报告', roleId: 'writer', id: 'write' },
      role: { ...plan.roles[0] }, goal: '写报告' };
    if (variant !== 'legacy') Object.assign(variant === 'task-version' ? taskInput.task : taskInput.role, { schemaVersion: 2 });
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => scope);
    await indexedDbWorkflowRepository.transact(scope, runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '写报告', status: 'paused', generation: 1, planVersion: 2, planOpen: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '写报告', output: plan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'write', runId, kind: 'agent_text', input: taskInput, dependsOn: ['plan'], status: 'queued', attempt: 0, updatedAt: now },
      ],
    }, value: undefined }));

    if (variant === 'legacy') generate.mockResolvedValueOnce('已完成的报告');
    const resumed = await scoped.resume(runId);
    if (variant !== 'legacy') {
      expect(resumed.snapshot.tasks.find((task) => task.id === 'write')).toMatchObject({
        status: 'failed', modelInvocation: { state: 'not_started' },
      });
      expect(generate).not.toHaveBeenCalled();
      return;
    }
    expect(resumed.snapshot.run.status).toBe('completed');
    expect(resumed.snapshot.tasks.find((task) => task.id === 'write')?.output).toBe('已完成的报告');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('persists a delegated plan, resumes its child task, and includes its result in delivery', async () => {
    const runId = crypto.randomUUID();
    const chatId = `delegate-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    const basePlan = {
      summary: '先调研', roles: [{ id: 'researcher', name: '研究员', responsibility: '调研', method: '整理', acceptance: '有结论', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'researcher', goal: '调研问题', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '完成研究',
    };
    const delegatedPlan = {
      summary: '追加总结', roles: [{ id: 'writer', name: '写作者', responsibility: '总结', method: '整理研究', acceptance: '有报告', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal: '撰写报告', dependsOn: [], acceptance: '报告完整' }], finalAcceptance: '报告可读',
    };
    let finishPlan!: (value: string) => void;
    generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishPlan = resolve; }));
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-delegation-test');
    const initial = scoped.start(runId, chatId, '研究问题');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await scoped.requestPauseAfterCurrentBatch(runId);
    finishPlan(JSON.stringify(basePlan));
    expect((await initial).snapshot.run.status).toBe('paused');
    const paused = await scoped.read(runId);
    expect(paused?.run.status).toBe('paused');
    await scoped.addRevisionRequest(runId, paused!.run.planVersion, '根据研究结论写报告');
    generate.mockResolvedValueOnce('研究结论').mockResolvedValueOnce(JSON.stringify(delegatedPlan)).mockResolvedValueOnce('完整报告');
    const result = await scoped.resume(runId);
    expect(result.snapshot.run.status).toBe('completed');
    expect(result.snapshot.tasks.find((task) => task.id === 'delegated_report')?.output).toBe('完整报告');
    expect(generate.mock.calls[3][2][0].content).toContain('研究结论');
    const artifact = await scoped.publish(runId);
    const content = artifact.versions.find((version) => version.id === artifact.currentVersionId)?.content;
    expect(content).toContain('完整报告');
    await scoped.resume(runId);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it('compiles a targeted revision, reuses pinned branches and resumes only unfinished downstream work', async () => {
    const runId = crypto.randomUUID();
    const chatId = `patch-chat-${runId}`;
    const scope = `patch-scope-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '局部重做', memberIds: [], deletedAt: null } as (typeof state.chats)[number]] }));
    const basePlan = { summary: '双分支报告', finalAcceptance: '完整报告',
      roles: [{ id: 'writer', name: '写作', responsibility: '写作', method: '按证据撰写', acceptance: '完整', allowedTools: ['text_generation'] }],
      tasks: [
        { id: 'source', roleId: 'writer', goal: '准备资料', acceptance: '完整', dependsOn: [] },
        { id: 'draft', roleId: 'writer', goal: '撰写草稿', acceptance: '完整', dependsOn: ['source'] },
        { id: 'other', roleId: 'writer', goal: '独立数据', acceptance: '完整', dependsOn: [] },
        { id: 'final', roleId: 'writer', goal: '最终汇总', acceptance: '完整', dependsOn: ['draft', 'other'] },
      ] };
    generate.mockResolvedValueOnce(JSON.stringify(basePlan)).mockResolvedValue('原始交付正文');
    const config = { provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' };
    const workflow = createAgentTeamWorkflow(config, () => scope);
    const first = await workflow.start(runId, chatId, '写报告', false, undefined, 7);
    expect(first.snapshot.run.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(5);
    const originals = first.snapshot.tasks.filter((task) => task.id !== 'plan');
    const rootPlan = first.snapshot.tasks.find((task) => task.id === 'plan')!.output;
    await workflow.addRevisionRequest(runId, first.snapshot.run.planVersion, '草稿改为通俗解释', 'draft');
    generate.mockResolvedValueOnce(JSON.stringify({ revisionPatch: { schemaVersion: 1, basePlanSha256: workflowJsonDigest(rootPlan),
      updates: [{ taskId: 'draft', goal: '通俗解释资料', acceptance: '易于理解' }] } })).mockResolvedValueOnce('修改后的草稿');
    const paused = await workflow.resume(runId);
    expect(paused.snapshot.run.status).toBe('paused');
    expect(generate).toHaveBeenCalledTimes(7);
    expect(paused.snapshot.tasks.find((task) => task.id === 'delegate')?.output).toMatchObject({
      revisionCompilation: { changedTaskIds: ['draft'], rerunTaskIds: ['draft', 'final'], reusedTaskIds: ['source', 'other'] },
    });
    expect(paused.snapshot.tasks.filter((task) => task.id.startsWith('delegated_')).map((task) => task.id)).toEqual(['delegated_draft', 'delegated_final']);
    for (const original of originals) expect(paused.snapshot.tasks.find((task) => task.id === original.id)).toEqual(original);
    const restored = createAgentTeamWorkflow(config, () => scope);
    await restored.setModelCallLimit(runId, paused.snapshot.run.planVersion, 8);
    generate.mockResolvedValueOnce('修改后的汇总');
    const completed = await restored.resume(runId);
    expect(completed.snapshot.run.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(8);
    expect(generate.mock.calls[7][2][0].content).toContain('修改后的草稿');
    expect(generate.mock.calls[7][2][0].content).toContain('原始交付正文');
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(8);
    const next = createAgentTeamWorkflow(config, () => scope);
    const beforeSecond = (await next.read(runId))!;
    const previousPlan = beforeSecond.tasks.find((task) => task.id === 'delegate')!.output;
    const secondRequest = await next.addRevisionRequest(runId, beforeSecond.run.planVersion, '只修改最新汇总的语气', 'delegated_final');
    await next.setModelCallLimit(runId, secondRequest.run.planVersion, 10);
    generate.mockResolvedValueOnce(JSON.stringify({ revisionPatch: { schemaVersion: 1, basePlanSha256: workflowJsonDigest(previousPlan),
      updates: [{ taskId: 'final', goal: '用简洁语气汇总', acceptance: '简洁完整' }] } })).mockResolvedValueOnce('第二轮汇总');
    const second = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(second.snapshot.run.status).toBe('completed');
    expect(second.snapshot.tasks.find((task) => task.id === 'delegate_2')?.output).toMatchObject({
      revisionCompilation: { changedTaskIds: ['final'], rerunTaskIds: ['final'], reusedTaskIds: ['draft'] },
      tasks: [{ savedText: [expect.objectContaining({ alias: 'other', taskId: 'other' }), expect.objectContaining({ alias: 'draft', taskId: 'delegated_draft' })] }],
    });
    expect(generate.mock.calls[9][2][0].content).toContain('修改后的草稿');
    for (const original of completed.snapshot.tasks) expect(second.snapshot.tasks.find((task) => task.id === original.id)).toEqual(original);
    await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(generate).toHaveBeenCalledTimes(10);
    const latest = (await next.read(runId))!;
    const oldRequest = await next.addRevisionRequest(runId, latest.run.planVersion, '改动旧资料', 'source');
    await next.setModelCallLimit(runId, oldRequest.run.planVersion, 11);
    generate.mockResolvedValueOnce(JSON.stringify({ revisionPatch: { schemaVersion: 1, basePlanSha256: workflowJsonDigest(rootPlan),
      updates: [{ taskId: 'source', goal: '改动旧资料', acceptance: '更新资料' }] } }));
    const stale = await createAgentTeamWorkflow(config, () => scope).resume(runId);
    expect(stale.snapshot.run.status).toBe('failed');
    expect(stale.snapshot.tasks.find((task) => task.id === 'delegate_3')?.error).toContain('不允许局部修订');
    expect(generate).toHaveBeenCalledTimes(11);
  });

  it('reopens a completed run for delegation and updates its existing delivery version', async () => {
    const runId = crypto.randomUUID();
    const chatId = `reopen-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    const basePlan = {
      summary: '基础研究', roles: [{ id: 'researcher', name: '研究员', responsibility: '研究', method: '整理', acceptance: '有结论', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'researcher', goal: '研究问题', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '研究完成',
    };
    const extraPlan = {
      summary: '扩展报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理研究', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '报告完成',
    };
    generate.mockResolvedValueOnce(JSON.stringify(basePlan)).mockResolvedValueOnce('第一阶段结论');
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-reopen-test');
    const completed = await scoped.start(runId, chatId, '研究问题');
    expect(completed.snapshot.run.status).toBe('completed');
    const first = await scoped.publish(runId);
    const firstVersionId = first.currentVersionId;
    await expect(scoped.addRevisionRequest(runId, completed.snapshot.run.planVersion, '补一份报告', 'missing')).rejects.toThrow('已完成的子任务');
    expect((await scoped.read(runId))?.run.planVersion).toBe(completed.snapshot.run.planVersion);
    const reopened = await scoped.addRevisionRequest(runId, completed.snapshot.run.planVersion, '补一份报告', 'research');
    expect(reopened.run.status).toBe('paused');
    expect(reopened.run.planOpen).toBe(true);
    const revisionInput = { request: '补一份报告', sourceTaskIds: ['research'], impact: {
      schemaVersion: 1, basePlanVersion: completed.snapshot.run.planVersion, targetTaskId: 'research',
      affectedTaskIds: ['research'], generatedMediaTaskIds: [],
    } };
    expect(reopened.tasks.find((task) => task.id === 'delegate')?.input).toEqual(revisionInput);
    const restored = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-reopen-test');
    expect((await restored.read(runId))?.tasks.find((task) => task.id === 'delegate')?.input).toEqual(revisionInput);
    await expect(scoped.addRevisionRequest(runId, completed.snapshot.run.planVersion, '重复追加')).rejects.toThrow('计划已更新');
    generate.mockResolvedValueOnce(JSON.stringify(extraPlan)).mockResolvedValueOnce('第二阶段报告');
    const finished = await restored.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(generate.mock.calls[2][2][0].content).toContain('定向修订目标：research');
    expect(generate.mock.calls[2][2][0].content).toContain('第一阶段结论');
    const second = await scoped.publish(runId);
    expect(second.id).toBe(first.id);
    expect(second.currentVersionId).not.toBe(firstVersionId);
    expect(second.versions.find((version) => version.id === second.currentVersionId)?.content).toContain('第二阶段报告');
    const delivered = useMessageStore.getState().messageWindowsByChatId[chatId]?.messages.find((message) => message.id === `team-delivery-${runId}`);
    expect(delivered?.metadata?.assistant?.artifacts?.[0]?.versionId).toBe(second.currentVersionId);
    const repeated = await scoped.publish(runId);
    expect(repeated.currentVersionId).toBe(second.currentVersionId);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it('accepts a second revision and publishes all rounds in one artifact', async () => {
    const runId = crypto.randomUUID();
    const chatId = `multiple-revisions-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null, messageBranchState: { enabled: false } } as (typeof state.chats)[number]] }));
    const plan = (id: string, goal: string) => ({ summary: goal,
      roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '有交付', allowedTools: ['text_generation'] }],
      tasks: [{ id, roleId: 'writer', goal, dependsOn: [], acceptance: '有内容' }], finalAcceptance: '内容完整' });
    generate.mockResolvedValueOnce(JSON.stringify(plan('research', '研究'))).mockResolvedValueOnce('研究结论');
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-multiple-revisions-test');
    const first = await workflow.start(runId, chatId, '研究并形成报告');
    await workflow.addRevisionRequest(runId, first.snapshot.run.planVersion, '补充报告');
    generate.mockResolvedValueOnce(JSON.stringify(plan('report', '报告'))).mockResolvedValueOnce('报告内容');
    const second = await workflow.resume(runId);
    expect(second.snapshot.tasks.find((task) => task.id === 'delegated_report')?.output).toBe('报告内容');
    await workflow.addRevisionRequest(runId, second.snapshot.run.planVersion, '补充摘要');
    generate.mockResolvedValueOnce(JSON.stringify(plan('summary', '摘要'))).mockResolvedValueOnce('摘要内容');
    const third = await workflow.resume(runId);
    expect(third.snapshot.tasks.find((task) => task.id === 'delegate_2_summary')?.output).toBe('摘要内容');
    const artifact = await workflow.publish(runId);
    const content = artifact.versions.find((version) => version.id === artifact.currentVersionId)?.content;
    expect(content).toContain('研究结论');
    expect(content).toContain('报告内容');
    expect(content).toContain('摘要内容');
  });

  it('keeps delegated children queued when paused during delegated planning', async () => {
    const runId = crypto.randomUUID();
    const now = Date.now();
    const basePlan = {
      summary: '调研', roles: [{ id: 'researcher', name: '研究员', responsibility: '调研', method: '整理', acceptance: '有结论', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'research', roleId: 'researcher', goal: '调研', dependsOn: [], acceptance: '有结论' }], finalAcceptance: '完成',
    };
    const revisionPlan = {
      summary: '补充报告', roles: [{ id: 'writer', name: '写作者', responsibility: '撰写', method: '整理', acceptance: '成稿', allowedTools: ['text_generation'] }],
      tasks: [{ id: 'report', roleId: 'writer', goal: '写报告', dependsOn: [], acceptance: '成稿' }], finalAcceptance: '可读',
    };
    const scoped = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-delegation-pause-test');
    await indexedDbWorkflowRepository.transact('team-delegation-pause-test', runId, () => ({ snapshot: {
      run: { id: runId, chatId: 'chat', goal: '调研并写报告', status: 'paused', generation: 1, planVersion: 2, planOpen: true, updatedAt: now },
      tasks: [
        { id: 'plan', runId, kind: 'team_plan', input: '调研并写报告', output: basePlan, dependsOn: [], status: 'completed', attempt: 1, updatedAt: now },
        { id: 'research', runId, kind: 'agent_text', input: { task: basePlan.tasks[0], role: basePlan.roles[0], goal: '调研并写报告' }, output: '研究结论', dependsOn: ['plan'], status: 'completed', attempt: 1, updatedAt: now },
      ],
    }, value: undefined }));
    await scoped.addRevisionRequest(runId, 2, '写报告');
    let finishRevision!: (value: string) => void;
    generate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRevision = resolve; }));
    const pending = scoped.resume(runId);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await scoped.requestPauseAfterCurrentBatch(runId);
    finishRevision(JSON.stringify(revisionPlan));
    const paused = await pending;
    expect(paused.snapshot.run.status).toBe('paused');
    expect(paused.snapshot.tasks.find((task) => task.id === 'delegated_report')?.status).toBe('waiting_dependency');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
