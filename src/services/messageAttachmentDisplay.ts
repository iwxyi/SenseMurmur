type AttachmentDisplayLike = {
  kind?: 'image' | 'audio' | 'video' | 'sticker' | string;
  status?: 'placeholder' | 'queued' | 'generating' | 'ready' | 'failed' | 'deleted' | string;
  url?: string;
  error?: string;
};

function formatKind(kind: AttachmentDisplayLike['kind']) {
  if (kind === 'audio') return '语音';
  if (kind === 'video') return '视频';
  if (kind === 'sticker') return '表情';
  return '图片';
}

function actorAction(kind: AttachmentDisplayLike['kind']) {
  if (kind === 'audio') return '对方正在讲话';
  if (kind === 'video') return '对方正在生成视频';
  if (kind === 'sticker') return '对方正在发送表情';
  return '对方正在发送图片';
}

export function getAttachmentErrorText(attachment: { error?: string }) {
  const text = attachment.error?.trim();
  return text || '生成任务失败，请检查模型配置或稍后重试。';
}

export function getAttachmentStatusLabel(attachment: AttachmentDisplayLike) {
  const kind = formatKind(attachment.kind);
  if (attachment.status === 'placeholder' || attachment.status === 'queued') return `${actorAction(attachment.kind)}…`;
  if (attachment.status === 'generating') return `${actorAction(attachment.kind)}…`;
  if (attachment.status === 'ready') return `${kind}已生成`;
  if (attachment.status === 'failed') return `${kind}生成失败`;
  if (attachment.status === 'deleted') return `${kind}已删除`;
  return `${kind}处理中`;
}

export function getAttachmentStatusDetail(attachment: AttachmentDisplayLike) {
  const kind = formatKind(attachment.kind);
  if (attachment.status === 'failed') return getAttachmentErrorText(attachment);
  if (attachment.status === 'placeholder' || attachment.status === 'queued') return `${actorAction(attachment.kind)}，稍等一下。`;
  if (attachment.status === 'generating') return `${actorAction(attachment.kind)}，很快就好。`;
  if (attachment.status === 'ready') return attachment.url ? `${kind}已生成。` : `${kind}已生成，但资源地址暂不可用。`;
  if (attachment.status === 'deleted') return `${kind}已删除。`;
  return `${kind}正在处理。`;
}
