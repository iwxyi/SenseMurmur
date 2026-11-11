type AttachmentDisplayLike = {
  kind?: 'image' | 'audio' | 'video' | 'sticker' | string;
  audioPurpose?: 'chat_voice' | 'listening_exercise' | 'music_generation';
  status?: 'placeholder' | 'queued' | 'generating' | 'ready' | 'failed' | 'deleted' | string;
  url?: string;
  error?: string;
};

function formatKind(attachment: AttachmentDisplayLike) {
  if (attachment.kind === 'audio') return attachment.audioPurpose === 'music_generation' ? '音乐' : '语音';
  const kind = attachment.kind;
  if (kind === 'video') return '视频';
  if (kind === 'sticker') return '表情';
  return '图片';
}

function actorAction(attachment: AttachmentDisplayLike) {
  if (attachment.kind === 'audio') return attachment.audioPurpose === 'music_generation' ? '对方正在生成音乐' : '对方正在讲话';
  const kind = attachment.kind;
  if (kind === 'video') return '对方正在生成视频';
  if (kind === 'sticker') return '对方正在发送表情';
  return '对方正在发送图片';
}

export function getAttachmentErrorText(attachment: { error?: string }) {
  const text = attachment.error?.trim();
  return text || '生成任务失败，请检查模型配置或稍后重试。';
}

export function getAttachmentStatusLabel(attachment: AttachmentDisplayLike) {
  const kind = formatKind(attachment);
  if (attachment.status === 'placeholder' || attachment.status === 'queued') return `${actorAction(attachment)}…`;
  if (attachment.status === 'generating') return `${actorAction(attachment)}…`;
  if (attachment.status === 'ready') return `${kind}已生成`;
  if (attachment.status === 'failed') return `${kind}生成失败`;
  if (attachment.status === 'deleted') return `${kind}已删除`;
  return `${kind}处理中`;
}

export function getAttachmentStatusDetail(attachment: AttachmentDisplayLike) {
  const kind = formatKind(attachment);
  if (attachment.status === 'failed') return getAttachmentErrorText(attachment);
  if (attachment.status === 'placeholder' || attachment.status === 'queued') return `${actorAction(attachment)}，稍等一下。`;
  if (attachment.status === 'generating') return `${actorAction(attachment)}，很快就好。`;
  if (attachment.status === 'ready') return attachment.url ? `${kind}已生成。` : `${kind}已生成，但资源地址暂不可用。`;
  if (attachment.status === 'deleted') return `${kind}已删除。`;
  return `${kind}正在处理。`;
}
