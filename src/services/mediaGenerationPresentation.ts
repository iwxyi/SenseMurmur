import type { Message, MessageAttachment, MessageAttachmentStatus } from '../types/message';
import { getAttachmentErrorText } from './messageAttachmentDisplay';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';

export interface ProjectedMediaGenerationItem {
  key: string;
  messageId: string;
  senderName: string;
  kindLabel: string;
  status: MessageAttachmentStatus;
  statusLabel: string;
  title: string;
  summary: string;
  detailText: string;
  chips: string[];
  debugHint: string;
  tone: string;
  updatedAt: number;
}

function clean(text: string | undefined | null, members: DisplayTextMember[] = []) {
  return sanitizeUserFacingText(text || '', members).replace(/\s+/g, ' ').trim();
}

function clip(text: string, max = 96) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toSafeRef(value: string | undefined | null) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 12) return text;
  return `…${text.slice(-8)}`;
}

function formatKind(kind: MessageAttachment['kind']) {
  const labels: Record<MessageAttachment['kind'], string> = {
    image: '图片',
    audio: '语音',
    video: '视频',
    sticker: '表情',
    file: '文件',
  };
  return labels[kind] || kind;
}

function formatStatus(status: MessageAttachmentStatus) {
  const labels: Record<MessageAttachmentStatus, string> = {
    placeholder: '等待生成',
    queued: '排队中',
    generating: '生成中',
    ready: '已生成',
    failed: '生成失败',
    deleted: '已删除',
  };
  return labels[status] || status;
}

function statusTone(status: MessageAttachmentStatus) {
  if (status === 'ready') return 'rgba(46, 125, 50, 0.08)';
  if (status === 'failed') return 'rgba(244, 67, 54, 0.08)';
  if (status === 'generating' || status === 'queued' || status === 'placeholder') return 'rgba(25, 118, 210, 0.08)';
  return 'action.hover';
}

function buildDecisionChip(message: Message, attachment: MessageAttachment) {
  const decision = message.metadata?.generationDecision;
  if (attachment.kind === 'image' && decision?.image?.shouldGenerate) return 'AI 决策：生成图片';
  if (attachment.kind === 'audio' && decision?.audio?.shouldGenerate) return 'AI 决策：生成语音';
  return '';
}

function buildGuidanceChip(message: Message) {
  const guidance = message.metadata?.runtimeDecision?.directorIntent?.userGuidance;
  if (!guidance) return '';
  if (guidance.kind === 'media_request') return '来自显式发图请求';
  if (guidance.kind === 'direct_reply') return '来自点名回应';
  return '来自话题引导';
}

function buildStatusDetail(attachment: MessageAttachment, kindLabel: string) {
  if (attachment.status === 'failed') return `失败原因：${getAttachmentErrorText(attachment)}`;
  if (attachment.status === 'queued' && attachment.mediaTaskId) return `${kindLabel}任务已提交，正在检查生成结果。`;
  if (attachment.status === 'placeholder' || attachment.status === 'queued') return `${kindLabel}已加入生成队列，等待开始。`;
  if (attachment.status === 'generating') return `正在生成${kindLabel}，完成后会自动更新。`;
  if (attachment.status === 'ready') return attachment.url ? `${kindLabel}已生成。` : `${kindLabel}已生成，但资源地址暂不可用。`;
  if (attachment.status === 'deleted') return `${kindLabel}已删除。`;
  return `${kindLabel}正在处理。`;
}

function buildQueueProgress(message: Message, attachment: MessageAttachment) {
  const attachments = (message.metadata?.attachments || []).filter((item) => item.kind === attachment.kind && item.status !== 'deleted');
  const index = attachments.findIndex((item) => item.id === attachment.id);
  if (index < 0) return '';
  const total = attachments.length;
  const position = index + 1;
  const frontCount = attachments.slice(0, index).filter((item) => item.status === 'queued' || item.status === 'generating').length;
  if (attachment.status === 'queued') return `队列 ${position}/${total}，前面还有 ${frontCount} 个`;
  if (attachment.status === 'generating') return `队列 ${position}/${total}`;
  return '';
}

function buildAttachmentItem(message: Message, attachment: MessageAttachment, members: DisplayTextMember[]): ProjectedMediaGenerationItem {
  const kindLabel = formatKind(attachment.kind);
  const statusLabel = formatStatus(attachment.status);
  const altText = clean(attachment.altText, members);
  const content = clean(message.content, members);
  const summary = clip(altText || content || `${kindLabel}附件`);
  const decisionChip = buildDecisionChip(message, attachment);
  const guidanceChip = buildGuidanceChip(message);
  const queueChip = buildQueueProgress(message, attachment);
  const detailText = clean(buildStatusDetail(attachment, kindLabel), members);
  const size = typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > 0 ? `${Math.round(attachment.sizeBytes / 1024)}KB` : '';
  const chips = [
    statusLabel,
    kindLabel,
    queueChip,
    guidanceChip,
    decisionChip,
    size,
  ].filter(Boolean);
  const prompt = clean(attachment.promptText, members);
  return {
    key: `${message.id}:${attachment.id}`,
    messageId: message.id,
    senderName: clean(message.senderName, members) || '成员',
    kindLabel,
    status: attachment.status,
    statusLabel,
    title: `${clean(message.senderName, members) || '成员'} · ${kindLabel}`,
    summary,
    detailText,
    chips,
    debugHint: [
      prompt ? `提示词：${prompt}` : '',
      attachment.status === 'failed' ? detailText : '',
      `附件 ${toSafeRef(attachment.id)}`,
      attachment.assetId ? `资产 ${toSafeRef(attachment.assetId)}` : '',
      attachment.url ? '已有资源地址' : '',
    ].filter(Boolean).join('\n'),
    tone: statusTone(attachment.status),
    updatedAt: attachment.updatedAt || message.timestamp,
  };
}

export function projectMediaGenerationItems(messages: Message[], members: DisplayTextMember[] = [], limit = 6): ProjectedMediaGenerationItem[] {
  return messages
    .filter((message) => !message.isDeleted && Boolean(message.metadata?.attachments?.length))
    .flatMap((message) => (message.metadata?.attachments || []).map((attachment) => buildAttachmentItem(message, attachment, members)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
