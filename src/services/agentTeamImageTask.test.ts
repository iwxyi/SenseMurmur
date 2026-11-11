import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { useChatStore } from '../stores/useChatStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { inspectAgentTeamImageAttachment, queueAgentTeamImage, teamImageReference } from './agentTeamImageTask';
import { isLocalOnlyMediaMode, processRichMessageMedia } from './richMessageMedia';

vi.mock('./richMessageMedia', () => ({ processRichMessageMedia: vi.fn(), isLocalOnlyMediaMode: vi.fn(() => true) }));

const profile = { id: 'image-test', name: '测试图片', type: 'image' as const, provider: 'official-ace', apiKey: '', baseUrl: '/api/ai', model: 'nano-banana-2', isDefault: true };

function imageMessage(status: 'queued' | 'generating' | 'ready' | 'failed', url?: string): Message {
  return { id: 'team-image-run-shot', chatId: 'team-image-chat', type: 'ai', senderId: 'assistant', senderName: '助手', content: '图片', emotion: 0,
    timestamp: 1, isDeleted: false, metadata: { agentTeamMedia: { runId: 'run', taskId: 'shot' }, attachments: [{
      id: 'team-image-shot', kind: 'image', status, altText: '团队生成图片', promptText: '森林场景图', url, createdAt: 1, updatedAt: 2,
    }] } };
}

beforeEach(() => {
  vi.mocked(processRichMessageMedia).mockReset();
  vi.mocked(isLocalOnlyMediaMode).mockReturnValue(true);
  vi.spyOn(useChatStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useMessageStore.persist, 'hasHydrated').mockReturnValue(true);
  vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
  useChatStore.setState({ chats: [{ id: 'team-image-chat', type: 'assistant', deletedAt: null } as ReturnType<typeof useChatStore.getState>['chats'][number]] });
  useSettingsStore.setState({ aiProfiles: [profile] });
  useMessageStore.setState({ activeChatId: 'team-image-chat', messages: [], messageWindowsByChatId: {} });
});

describe('agent team image task', () => {
  it('uses one attachment and exposes the ready image as a video reference', async () => {
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({ ...item, status: 'ready', url: 'https://example.test/scene.png', updatedAt: Date.now() + 1 })) } });
    });
    const params = { runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', signal: new AbortController().signal };
    expect(await queueAgentTeamImage(params)).toEqual({ output: expect.stringContaining('森林场景图') });
    expect(teamImageReference('run', 'shot')).toMatchObject({ url: 'https://example.test/scene.png' });
    expect(await queueAgentTeamImage(params)).toEqual({ output: expect.stringContaining('森林场景图') });
    expect(processRichMessageMedia).toHaveBeenCalledTimes(1);
  });

  it('does not resubmit an image whose upstream request started before interruption', async () => {
    useMessageStore.setState({ messages: [imageMessage('generating')] });
    useSettingsStore.setState({ aiProfiles: [] });
    await expect(queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', signal: new AbortController().signal }))
      .rejects.toThrow('结果尚未确认');
    expect(processRichMessageMedia).not.toHaveBeenCalled();
  });

  it('reuses a queued attachment without creating another message', async () => {
    useMessageStore.setState({ messages: [imageMessage('queued')] });
    vi.mocked(processRichMessageMedia).mockImplementation(async ({ message, upsertMessage }) => {
      upsertMessage({ ...message, metadata: { ...message.metadata, attachments: message.metadata!.attachments!.map((item) => ({ ...item, status: 'ready', url: 'https://example.test/scene.png', updatedAt: 3 })) } });
    });
    await queueAgentTeamImage({ runId: 'run', taskId: 'shot', chatId: 'team-image-chat', prompt: '森林场景图', signal: new AbortController().signal });
    expect(useMessageStore.getState().messages.filter((message) => message.metadata?.agentTeamMedia?.runId === 'run')).toHaveLength(1);
  });

  it('blocks missing image files and carries the saved failure reason', () => {
    useMessageStore.setState({ messages: [imageMessage('ready')] });
    expect(inspectAgentTeamImageAttachment('run', 'shot')).toMatchObject({ status: 'failed' });
    useMessageStore.setState({ messages: [{ ...imageMessage('failed'), metadata: { ...imageMessage('failed').metadata,
      attachments: [{ ...imageMessage('failed').metadata!.attachments![0], error: '上游额度不足' }] } }] });
    expect(inspectAgentTeamImageAttachment('run', 'shot')).toEqual({ status: 'failed', error: '上游额度不足' });
  });

  it('preserves a saved backend path for server-side reference resolution', () => {
    useMessageStore.setState({ messages: [imageMessage('ready', '/uploads/media/scene.png')] });
    expect(teamImageReference('run', 'shot')?.url).toBe('/uploads/media/scene.png');
  });
});
