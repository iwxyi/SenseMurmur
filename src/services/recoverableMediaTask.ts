import type { MessageAttachment } from '../types/message';

export function isRecoverableMediaAttachment(attachment: MessageAttachment) {
  const supported = attachment.kind === 'video'
    || (attachment.kind === 'audio' && attachment.audioPurpose === 'music_generation')
    || (attachment.kind === 'image' && Boolean(attachment.executionQuoteId || attachment.mediaTaskId));
  return supported && Boolean(attachment.mediaTaskId || attachment.generationJobId)
    && (attachment.status === 'generating' || (attachment.status === 'queued' && Boolean(attachment.mediaTaskId)));
}
