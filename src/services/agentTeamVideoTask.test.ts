import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamVideoAttachment, queueAgentTeamVideo } from './agentTeamVideoTask';
import { processRichMessageMedia, isLocalOnlyMediaMode } from './richMessageMedia';

vi.mock('./richMessageMedia', () => ({
  processRichMessageMedia: vi.fn(),
  isLocalOnlyMediaMode: vi.fn(() => true),
}));

const videoProfile = { id: 'video-test', name: '测试视频', type: 'video' as const, provider: 'official-ace',
  apiKey: '', baseUrl: '/api/ai', model: 'MiniMax-H3', isDefault: true };

beforeEach(() => {
  vi.mocked(processRichMessageMedia).mockReset();
  vi.mocked(isLocalOnlyMediaMode).mockReturnValue(true);
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  useSettingsStore.setState({ aiProfiles: [videoProfile] });
  useChatStore.setState({ chats: [{ id: 'team-video-chat', type: 'assistant', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
  useMessageStore.setState({ activeChatId: 'team-video-chat', messages: [], messageWindowsByChatId: {} });
});

describe('agent team video task', () => {
  it('submits one visible attachment and returns its persisted task ID', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'generating', mediaTaskId: 'task-one', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const params = { runId: 'run-one', taskId: 'shot', chatId: 'team-video-chat', prompt: '森林追逐', signal: new AbortController().signal };
    expect(await queueAgentTeamVideo(params)).toEqual({ externalTaskId: 'task-one' });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
    expect(inspectAgentTeamVideoAttachment('run-one', 'shot')).toEqual({ status: 'waiting_external', externalTaskId: 'task-one' });
    expect(await queueAgentTeamVideo(params)).toEqual({ externalTaskId: 'task-one' });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });

  it('passes the saved failure reason to the team run', () => {
    const message: Message = { id: 'video', chatId: 'team-video-chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '', emotion: 0,
      timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: 'failed-run', taskId: 'shot' }, attachments: [{
        id: 'attachment', kind: 'video', status: 'failed', altText: '视频', error: '上游额度不足', createdAt: 1, updatedAt: 2,
      }] } };
    useMessageStore.setState({ messages: [message] });
    expect(inspectAgentTeamVideoAttachment('failed-run', 'shot')).toEqual({ status: 'failed', error: '上游额度不足' });
  });

  it('describes a completed video to downstream tasks without exposing internal IDs', () => {
    const message: Message = { id: 'video-ready', chatId: 'team-video-chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '视频', emotion: 0,
      timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: 'ready-run', taskId: 'shot' }, attachments: [{
        id: 'attachment', kind: 'video', status: 'ready', altText: '团队生成视频', promptText: '森林追逐短片', mediaTaskId: 'private-task-id', url: '/private/video', createdAt: 1, updatedAt: 2,
      }] } };
    useMessageStore.setState({ messages: [message] });
    const result = inspectAgentTeamVideoAttachment('ready-run', 'shot');
    expect(result).toEqual({ status: 'completed', output: '视频已生成并保存在当前聊天附件。内容：森林追逐短片' });
    expect(JSON.stringify(result)).not.toContain('private-task-id');
  });

  it('reuses a queued message after interruption without creating another attachment', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'generating', mediaTaskId: 'recovered-task', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const params = { runId: 'interrupted-run', taskId: 'shot', chatId: 'team-video-chat', prompt: '森林追逐', signal: new AbortController().signal };
    const queued: Message = { id: 'team-video-interrupted-run-shot', chatId: params.chatId, type: 'ai', senderId: 'assistant', senderName: '助手', content: '视频生成中', emotion: 0,
      timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: params.runId, taskId: params.taskId }, attachments: [{
        id: 'team-video-shot', kind: 'video', status: 'queued', altText: '团队生成视频', promptText: params.prompt, createdAt: 1, updatedAt: 1,
      }] } };
    useMessageStore.setState({ messages: [queued] });
    expect(inspectAgentTeamVideoAttachment(params.runId, params.taskId)).toEqual({ status: 'queued' });
    expect(await queueAgentTeamVideo(params)).toEqual({ externalTaskId: 'recovered-task' });
    expect(useMessageStore.getState().messages.filter((message) => message.metadata?.agentTeamMedia?.runId === params.runId)).toHaveLength(1);
  });

  it('waits for cloud message confirmation before submitting the media task', async () => {
    vi.mocked(isLocalOnlyMediaMode).mockReturnValue(false);
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'generating', mediaTaskId: 'cloud-task', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const pending = queueAgentTeamVideo({ runId: 'cloud-run', taskId: 'shot', chatId: 'team-video-chat', prompt: '海边奔跑', signal: new AbortController().signal });
    await vi.waitFor(() => expect(useMessageStore.getState().messages.some((item) => item.metadata?.agentTeamMedia?.runId === 'cloud-run')).toBe(true));
    expect(processRichMessageMedia).not.toHaveBeenCalled();
    const message = useMessageStore.getState().messages.find((item) => item.metadata?.agentTeamMedia?.runId === 'cloud-run')!;
    useMessageStore.getState().upsertMessage({ ...message, serverId: 'server-video' });
    expect(await pending).toEqual({ externalTaskId: 'cloud-task' });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });
});
