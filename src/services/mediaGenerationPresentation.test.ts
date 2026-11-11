import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { projectMediaGenerationItems } from './mediaGenerationPresentation';

function buildMessage(patch: Partial<Message>): Message {
  return {
    id: patch.id || 'm1',
    chatId: 'chat-1',
    type: patch.type || 'ai',
    senderId: patch.senderId || 'mei',
    senderName: patch.senderName || '美羊羊',
    content: patch.content || '我把证件照发你看。',
    emotion: 0,
    timestamp: patch.timestamp || 1,
    isDeleted: false,
    metadata: patch.metadata,
  };
}

describe('mediaGenerationPresentation', () => {
  it('describes an accepted video check as result lookup', () => {
    const [item] = projectMediaGenerationItems([buildMessage({ metadata: { attachments: [{
      id: 'video', kind: 'video', status: 'queued', mediaTaskId: 'accepted-task', altText: '视频', createdAt: 1, updatedAt: 2,
    }] } })]);
    expect(item.detailText).toBe('视频任务已提交，正在检查生成结果。');
  });
  it('projects media attachment generation status with guidance and decision context', () => {
    const [item] = projectMediaGenerationItems([
      buildMessage({
        id: 'm-image',
        timestamp: 10,
        metadata: {
          generationDecision: {
            image: {
              shouldGenerate: true,
              reason: '用户要求发图',
              prompt: 'A certificate photo of Grey Wolf',
              altText: '灰太狼证件照',
            },
          },
          attachments: [{
            id: 'image-1',
            kind: 'image',
            status: 'generating',
            altText: '灰太狼证件照',
            promptText: 'A certificate photo of Grey Wolf',
            createdAt: 10,
            updatedAt: 12,
          }],
          runtimeDecision: {
            directorIntent: {
              source: 'user_message',
              beatType: 'answer',
              pressure: 0.98,
              reason: '用户指定角色发送或创作图片。',
              userGuidance: {
                kind: 'media_request',
                rawText: '美羊羊发个灰太狼证件照的图片',
                actorIds: ['mei'],
                mentionedActorIds: ['mei', 'hui'],
                focusText: '美羊羊发个灰太狼证件照的图片',
              },
            },
          },
        },
      }),
    ], [{ id: 'mei', name: '美羊羊' }, { id: 'hui', name: '灰太狼' }]);

    expect(item).toMatchObject({
      key: 'm-image:image-1',
      senderName: '美羊羊',
      status: 'generating',
      statusLabel: '生成中',
      title: '美羊羊 · 图片',
      summary: '灰太狼证件照',
      detailText: '正在生成图片，完成后会自动更新。',
      chips: expect.arrayContaining(['生成中', '图片', '来自显式发图请求', 'AI 决策：生成图片']),
    });
    expect(item.debugHint).toContain('提示词：A certificate photo of Grey Wolf');
  });

  it('surfaces failed media errors without requiring developer-only raw metadata', () => {
    const [item] = projectMediaGenerationItems([
      buildMessage({
        id: 'm-failed',
        metadata: {
          attachments: [{
            id: 'audio-1',
            kind: 'audio',
            status: 'failed',
            altText: '语音：晚安',
            promptText: '晚安',
            error: '语音模型未配置',
            createdAt: 10,
            updatedAt: 20,
          }],
        },
      }),
    ]);

    expect(item.statusLabel).toBe('生成失败');
    expect(item.detailText).toBe('失败原因：语音模型未配置');
    expect(item.chips).not.toEqual(expect.arrayContaining(['失败原因：语音模型未配置']));
    expect(item.tone).toBe('rgba(244, 67, 54, 0.08)');
  });

  it('uses short debug references instead of full internal attachment ids', () => {
    const longAttachmentId = 'image-2026-very-long-internal-attachment-id-abcdef123456';
    const longAssetId = 'asset-2026-very-long-internal-asset-id-xyz987654321';
    const [item] = projectMediaGenerationItems([
      buildMessage({
        id: 'm-debug',
        metadata: {
          attachments: [{
            id: longAttachmentId,
            kind: 'image',
            status: 'ready',
            assetId: longAssetId,
            altText: '示例图',
            promptText: 'portrait photo',
            createdAt: 10,
            updatedAt: 20,
            url: 'https://example.test/image.png',
          }],
        },
      }),
    ]);

    expect(item.debugHint).toContain('附件 …');
    expect(item.debugHint).toContain('资产 …');
    expect(item.debugHint).not.toContain(longAttachmentId);
    expect(item.debugHint).not.toContain(longAssetId);
  });
});
