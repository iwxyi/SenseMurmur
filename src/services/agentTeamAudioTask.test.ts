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
  it('creates a music attachment and returns its persisted external task ID', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      expect(message.metadata?.attachments?.[0]).toMatchObject({ kind: 'audio', audioPurpose: 'music_generation', promptText: '轻快的木琴配乐' });
      expect(['queued', 'generating']).toContain(message.metadata?.attachments?.[0]?.status);
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({
        ...item, status: 'generating', mediaTaskId: 'music-one', updatedAt: item.updatedAt + 1,
      })) } });
    });
    const params = { runId: 'run-audio', taskId: 'theme', chatId: 'team-audio-chat', prompt: '轻快的木琴配乐', signal: new AbortController().signal };
    expect(await queueAgentTeamAudio(params)).toEqual({ externalTaskId: 'music-one' });
    expect(inspectAgentTeamAudioAttachment('run-audio', 'theme')).toEqual({ status: 'waiting_external', externalTaskId: 'music-one' });
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
