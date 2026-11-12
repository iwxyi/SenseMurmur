import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamAudioAttachment, queueAgentTeamAudio } from './agentTeamAudioTask';
import { processRichMessageMedia, isLocalOnlyMediaMode } from './richMessageMedia';

vi.mock('./richMessageMedia', () => ({ processRichMessageMedia: vi.fn(), isLocalOnlyMediaMode: vi.fn(() => true) }));

beforeEach(() => {
  vi.mocked(processRichMessageMedia).mockReset();
  vi.mocked(isLocalOnlyMediaMode).mockReturnValue(true);
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  useSettingsStore.setState({ aiProfiles: [{ id: 'music', name: '音乐', type: 'audio', provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'music-model', isDefault: true }] });
  useChatStore.setState({ chats: [{ id: 'team-audio-chat', type: 'assistant', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
  useMessageStore.setState({ activeChatId: 'team-audio-chat', messages: [], messageWindowsByChatId: {} });
});

describe('agent team audio task', () => {
  it('queues narration with only the TTS profile and reuses the saved result', async () => {
    const tts = { id: 'tts', name: '旁白', type: 'tts' as const, provider: 'openai' as const, apiKey: 'test', baseUrl: 'https://example.test', model: 'tts-1', isDefault: true };
    useSettingsStore.setState((state) => ({ aiProfiles: [...state.aiProfiles, tts] }));
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, aiProfiles, upsertMessage }) => {
      expect(aiProfiles).toEqual([expect.objectContaining(tts)]);
      expect(message.metadata?.attachments?.[0]).toMatchObject({ audioPurpose: 'chat_voice', promptText: '欢迎来到森林。' });
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'ready', url: 'data:audio/mpeg;base64,AAAA', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const params = { runId: 'run-speech', taskId: 'narration', chatId: 'team-audio-chat', purpose: 'speech' as const, prompt: '欢迎来到森林。', signal: new AbortController().signal };
    expect(await queueAgentTeamAudio(params)).toEqual({ output: '旁白已生成并保存在当前聊天附件。正文：欢迎来到森林。' });
    expect(await queueAgentTeamAudio(params)).toEqual({ output: '旁白已生成并保存在当前聊天附件。正文：欢迎来到森林。' });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects an unusable TTS profile before creating an attachment', async () => {
    useSettingsStore.setState({ aiProfiles: [{ id: 'tts', name: '旁白', type: 'tts', provider: 'openai', apiKey: '', baseUrl: 'https://example.test', model: 'tts-1', isDefault: true }] });
    await expect(queueAgentTeamAudio({ runId: 'missing-tts', taskId: 'narration', chatId: 'team-audio-chat', purpose: 'speech', prompt: '你好', signal: new AbortController().signal })).rejects.toThrow('旁白模型未配置');
    expect(useMessageStore.getState().messages).toHaveLength(0);
    expect(processRichMessageMedia).not.toHaveBeenCalled();
  });

  it('creates a music attachment and returns its persisted external task ID', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      expect(message.metadata?.attachments?.[0]).toMatchObject({ kind: 'audio', audioPurpose: 'music_generation', promptText: '轻快的木琴配乐' });
      expect(['queued', 'generating']).toContain(message.metadata?.attachments?.[0]?.status);
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'generating', mediaTaskId: 'music-one', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const usageReference = { schemaVersion: 1 as const, runId: 'run-audio', taskId: 'theme', attempt: 1, kind: 'tool' as const };
    const params = { runId: 'run-audio', taskId: 'theme', chatId: 'team-audio-chat', prompt: '轻快的木琴配乐', usageReference, signal: new AbortController().signal };
    expect(await queueAgentTeamAudio(params)).toEqual({ externalTaskId: 'music-one' });
    expect(inspectAgentTeamAudioAttachment('run-audio', 'theme')).toEqual({ status: 'waiting_external', externalTaskId: 'music-one' });
    expect(useMessageStore.getState().messages[0].metadata?.workflowUsage).toEqual(usageReference);
    expect(await queueAgentTeamAudio(params)).toEqual({ externalTaskId: 'music-one' });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(2);
  });

  it('reports completion only when a playable attachment file is saved', () => {
    const message: Message = { id: 'audio-ready', chatId: 'team-audio-chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '音乐', emotion: 0,
      timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: 'ready-run', taskId: 'theme' }, attachments: [{
        id: 'attachment', kind: 'audio', audioPurpose: 'music_generation', status: 'ready', altText: '音乐', promptText: '木琴配乐',
        url: '/uploads/media/song.mp3', mimeType: 'audio/mpeg', createdAt: 1, updatedAt: 2,
      }] } };
    useMessageStore.setState({ messages: [message] });
    expect(inspectAgentTeamAudioAttachment('ready-run', 'theme')).toEqual({ status: 'completed', output: '音乐已生成并保存在当前聊天附件。主题：木琴配乐' });
    useMessageStore.setState({ messages: [{ ...message, metadata: { ...message.metadata, attachments: [{ ...message.metadata!.attachments![0], url: undefined }] } }] });
    expect(inspectAgentTeamAudioAttachment('ready-run', 'theme')).toMatchObject({ status: 'failed' });
  });
});
