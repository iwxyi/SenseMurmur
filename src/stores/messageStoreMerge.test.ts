import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { MAX_CACHED_MESSAGES_PER_CHAT, mergeMessages, trimMessagesWithBranchContext } from './messageStoreMerge';

function buildMessage(patch: Partial<Message> = {}): Message {
  return {
    id: 'local-message-1',
    clientKey: 'local-message-1',
    serverId: 'server-message-1',
    chatId: 'chat-1',
    type: 'ai',
    senderId: 'assistant',
    senderName: '助手',
    content: '图片已生成',
    emotion: 0,
    timestamp: 123,
    isDeleted: false,
    ...patch,
  };
}

describe('mergeMessages rich media metadata', () => {
  it('keeps a newer local video poll result over an older cloud placeholder', () => {
    const local = buildMessage({ metadata: {
      generation: { status: 'failed', updatedAt: 300 },
      attachments: [{ id: 'video', kind: 'video', status: 'failed', mediaTaskId: 'task-1', error: '上游生成失败', altText: '视频', createdAt: 100, updatedAt: 300 }],
    } });
    const remote = buildMessage({ metadata: {
      generation: { status: 'generating', updatedAt: 200 },
      attachments: [{ id: 'video', kind: 'video', status: 'generating', mediaTaskId: 'task-1', altText: '视频', createdAt: 100, updatedAt: 200 }],
    } });

    expect(mergeMessages([local], [remote])[0].metadata).toMatchObject({
      generation: { status: 'failed', updatedAt: 300 },
      attachments: [{ status: 'failed', mediaTaskId: 'task-1', error: '上游生成失败' }],
    });
  });

  it('keeps the latest accepted task when a stale cloud copy arrives after retry', () => {
    const local = buildMessage({ metadata: { attachments: [
      { id: 'video', kind: 'video', status: 'generating', mediaTaskId: 'new-task', altText: '视频', createdAt: 100, updatedAt: 300 },
    ] } });
    const remote = buildMessage({ metadata: { attachments: [
      { id: 'video', kind: 'video', status: 'failed', mediaTaskId: 'old-task', error: '旧任务失败', altText: '视频', createdAt: 100, updatedAt: 200 },
    ] } });

    expect(mergeMessages([local], [remote])[0].metadata?.attachments?.[0]).toMatchObject({
      status: 'generating', mediaTaskId: 'new-task', updatedAt: 300,
    });
  });

  it('accepts a newer explicit retry instead of restoring the previous ready file', () => {
    const local = buildMessage({ metadata: { attachments: [
      { id: 'video', kind: 'video', status: 'ready', generationJobId: 'old-job', url: '/video-old.mp4', altText: '视频', createdAt: 100, updatedAt: 200 },
    ] } });
    const remote = buildMessage({ metadata: { attachments: [
      { id: 'video', kind: 'video', status: 'queued', generationJobId: 'new-job', altText: '视频', createdAt: 100, updatedAt: 300 },
    ] } });

    expect(mergeMessages([local], [remote])[0].metadata?.attachments?.[0]).toMatchObject({
      status: 'queued', generationJobId: 'new-job', updatedAt: 300,
    });
  });

  it('retains an older unfinished video task beyond the ordinary message window', () => {
    const pending = buildMessage({ id: 'pending-video', timestamp: 1, metadata: { attachments: [{ id: 'video', kind: 'video', status: 'generating', mediaTaskId: 'task-1', altText: '视频', createdAt: 1, updatedAt: 1 }] } });
    const messages = [pending, ...Array.from({ length: MAX_CACHED_MESSAGES_PER_CHAT }, (_, index) => buildMessage({ id: `later-${index}`, timestamp: index + 2 }))];
    expect(trimMessagesWithBranchContext(messages).some((item) => item.id === pending.id)).toBe(true);
  });
  it('retains an older accepted music task beyond the ordinary message window', () => {
    const pending = buildMessage({ id: 'pending-music', timestamp: 1, metadata: { attachments: [{ id: 'music', kind: 'audio', audioPurpose: 'music_generation', status: 'generating', mediaTaskId: 'task-1', altText: '音乐', createdAt: 1, updatedAt: 1 }] } });
    const messages = [pending, ...Array.from({ length: MAX_CACHED_MESSAGES_PER_CHAT }, (_, index) => buildMessage({ id: `later-${index}`, timestamp: index + 2 }))];
    expect(trimMessagesWithBranchContext(messages).some((item) => item.id === pending.id)).toBe(true);
  });
  it('retains branch edges when cloud metadata only updates media generation', () => {
    const branching = { nodeId: 'node-1', parentNodeId: 'older-parent', rootNodeId: 'root', sequence: 5 };
    const local = buildMessage({ metadata: { branching } });
    const remote = buildMessage({ metadata: { generation: { status: 'ready', updatedAt: 200 } } });
    expect(mergeMessages([local], [remote])[0].metadata?.branching).toEqual(branching);
  });
  it('keeps a local ready data-url image when the cloud copy only has an unresolved placeholder', () => {
    const local = buildMessage({
      metadata: {
        generation: { status: 'ready', updatedAt: 200 },
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'ready',
          url: 'data:image/png;base64,correct',
          mimeType: 'image/png',
          altText: '正确的参考图结果',
          promptText: '按参考图修改标题',
          targetImageIds: ['previous-message:image-source'],
          referenceImages: [{ url: 'data:image/png;base64,source', mimeType: 'image/png', label: '待修改图片' }],
          createdAt: 100,
          updatedAt: 200,
        }],
      },
    });
    const remotePlaceholder = buildMessage({
      id: 'server-message-1',
      clientKey: 'local-message-1',
      serverId: 'server-message-1',
      metadata: {
        generation: { status: 'generating', updatedAt: 220 },
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'queued',
          altText: '正确的参考图结果',
          promptText: '按参考图修改标题',
          targetImageIds: ['previous-message:image-source'],
          createdAt: 100,
          updatedAt: 220,
        }],
      },
    });

    const merged = mergeMessages([local], [remotePlaceholder]);
    const attachment = merged[0]?.metadata?.attachments?.[0];

    expect(attachment).toMatchObject({
      id: 'image-1',
      status: 'ready',
      url: 'data:image/png;base64,correct',
    });
    expect(attachment?.referenceImages?.[0]?.url).toBe('data:image/png;base64,source');
    expect(merged[0]?.metadata?.generation?.status).toBe('ready');
  });

  it('accepts the cloud asset when the remote ready image has a usable url', () => {
    const local = buildMessage({
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'ready',
          url: 'data:image/png;base64,local',
          altText: '本地图',
          createdAt: 100,
          updatedAt: 200,
        }],
      },
    });
    const remoteReady = buildMessage({
      id: 'server-message-1',
      clientKey: 'local-message-1',
      serverId: 'server-message-1',
      metadata: {
        attachments: [{
          id: 'image-1',
          kind: 'image',
          status: 'ready',
          assetId: 'asset-1',
          url: '/api/media/assets/asset-1',
          altText: '云端图',
          createdAt: 100,
          updatedAt: 240,
        }],
      },
    });

    const merged = mergeMessages([local], [remoteReady]);

    expect(merged[0]?.metadata?.attachments?.[0]).toMatchObject({
      status: 'ready',
      assetId: 'asset-1',
      url: '/api/media/assets/asset-1',
    });
  });
});
