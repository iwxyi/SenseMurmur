import type { Message } from '../types/message';

export function buildConversationTimeContext(messages: Message[], now = Date.now()) {
  const date = new Date(now);
  const local = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).format(date);
  const lastVisibleAt = messages.reduce<number | null>((latest, message) => {
    if (message.isDeleted || message.isStreaming || (message.type !== 'ai' && message.type !== 'user')
      || !Number.isFinite(message.timestamp) || message.timestamp > now) return latest;
    return Math.max(latest ?? message.timestamp, message.timestamp);
  }, null);
  const gap = lastVisibleAt == null ? ''
    : ` Last visible send was ${Math.floor((now - lastVisibleAt) / 1000)} seconds ago.`;
  return `## Time context\nCurrent device-local time: ${local}.${gap}\nTime is a light situational cue: let the character, current activity and exchange determine alertness, attention and willingness to talk. Late hours do not imply fatigue, and a daytime worker may be lively tonight. Do not invent work, sleep or read receipts, or mention the clock merely because it is supplied. Elapsed time is not evidence that anyone deliberately ignored someone. In a fictional scene, follow established scene time; this device clock is not the story clock.`;
}
