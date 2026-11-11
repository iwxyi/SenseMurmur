import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { generateResponse, listAvailableModels } from './aiClient';
import { buildAgentTeamTaskRevisionRequest, createAgentTeamWorkflow, recoverAgentTeamRuns } from './agentTeamWorkflow';
import { currentWorkflowScope, indexedDbWorkflowRepository, type WorkflowSnapshot } from './workflowRunRuntime';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import { api as appApi } from './api';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamVideoAttachment, queueAgentTeamVideo } from './agentTeamVideoTask';
import { inspectAgentTeamImageAttachment, queueAgentTeamImage, teamImageReference } from './agentTeamImageTask';
import { inspectAgentTeamImages } from './agentTeamImageInspection';
import { inspectAgentTeamAudioAttachment, queueAgentTeamAudio } from './agentTeamAudioTask';

vi.mock('./agentTeamImageInspection', () => ({ inspectAgentTeamImages: vi.fn() }));
vi.mock('./agentTeamAudioTask', () => ({ inspectAgentTeamAudioAttachment: vi.fn(), queueAgentTeamAudio: vi.fn() }));

describe('agent team child collaboration', () => {
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

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback?: (lock: object) => Promise<unknown>) => (callback || _options as (lock: object) => Promise<unknown>)({}) } });
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
});

describe('agent team workflow', () => {
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
    vi.mocked(inspectAgentTeamImages).mockResolvedValue('实际画面有森林，无角色');
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
    vi.mocked(inspectAgentTeamImages).mockResolvedValue('实际画面是森林，但光线偏暗');
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
    generate.mockResolvedValueOnce(JSON.stringify(basePlan)).mockResolvedValueOnce('研究结论')
      .mockResolvedValueOnce(JSON.stringify({ complete: false, reason: '缺少报告', nextRequest: '根据研究结论写报告' }))
      .mockResolvedValueOnce(JSON.stringify(followup)).mockResolvedValueOnce('完整报告')
      .mockResolvedValueOnce(JSON.stringify({ complete: true, reason: '报告已完成' }));
    const workflow = createAgentTeamWorkflow({ provider: 'openai', apiKey: 'test', baseUrl: '', model: 'test' }, () => 'team-auto-review-test');
    const finished = await workflow.start(runId, 'chat', '研究并写报告', true);
    expect(finished.snapshot.run.status).toBe('completed');
    expect(finished.snapshot.tasks.find((task) => task.id === 'auto_delegate_1_report')?.output).toBe('完整报告');
    expect(finished.snapshot.tasks.filter((task) => task.kind === 'team_review')).toHaveLength(2);
    expect(generate.mock.calls[2][2][0].content).toContain('最终验收标准：报告可读');
    await workflow.resume(runId);
    expect(generate).toHaveBeenCalledTimes(6);
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
    expect(evidence).toContain('另有 2 项已完成记录未列出');
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
    expect(queueAgentTeamVideo).not.toHaveBeenCalled();
    useSettingsStore.setState({ aiProfiles: [{ id: 'test-video', name: '测试视频', type: 'video', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true }] });
    const retry = await workflow.retryFailedPlan(runId, 'plan', result.snapshot.run.planVersion);
    expect(retry.run.status).toBe('paused');
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

  it('persists a delegated plan, resumes its child task, and includes its result in delivery', async () => {
    const runId = crypto.randomUUID();
    const chatId = `delegate-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null } as (typeof state.chats)[number]] }));
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

  it('reopens a completed run for delegation and updates its existing delivery version', async () => {
    const runId = crypto.randomUUID();
    const chatId = `reopen-chat-${runId}`;
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null } as (typeof state.chats)[number]] }));
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
    const reopened = await scoped.addRevisionRequest(runId, completed.snapshot.run.planVersion, '补一份报告');
    expect(reopened.run.status).toBe('paused');
    expect(reopened.run.planOpen).toBe(true);
    await expect(scoped.addRevisionRequest(runId, completed.snapshot.run.planVersion, '重复追加')).rejects.toThrow('计划已更新');
    generate.mockResolvedValueOnce(JSON.stringify(extraPlan)).mockResolvedValueOnce('第二阶段报告');
    const finished = await scoped.resume(runId);
    expect(finished.snapshot.run.status).toBe('completed');
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
    useChatStore.setState((state) => ({ chats: [...state.chats, { id: chatId, type: 'assistant', name: '交付', memberIds: [], deletedAt: null } as (typeof state.chats)[number]] }));
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
