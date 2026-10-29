import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';

export type ChannelSemanticKey = GroupChat['type'];

export interface ChannelSemanticDefinition {
  key: ChannelSemanticKey;
  label: string;
  promptPrefix: string;
  transcriptInstruction: string;
  targetPriority: 'latest_human' | 'counterpart' | 'room_thread';
  memoryMode: 'user_private' | 'pair_private' | 'public_room';
  duplicateTolerance: 'relaxed' | 'balanced' | 'strict';
  summariseRecentContext: (messages: Message[]) => string[];
}

function recentVisible(messages: Message[]) {
  return messages.filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event').slice(-8);
}

function buildSharedRecentSummary(messages: Message[]) {
  const recent = recentVisible(messages);
  if (!recent.length) return ['- No visible recent turns yet.'];
  const latest = recent.at(-1);
  const humanCount = recent.filter((message) => message.type === 'user' || message.type === 'god').length;
  const aiCount = recent.filter((message) => message.type === 'ai').length;
  const speakers = Array.from(new Set(recent.map((message) => message.senderName || message.senderId))).slice(-6);
  return [
    `- Recent window: ${recent.length} turns (${humanCount} human / ${aiCount} AI).`,
    `- Latest turn: ${latest ? `${latest.type === 'ai' ? 'AI' : 'human'} from ${latest.senderName || latest.senderId}` : 'none'}.`,
    `- Active speakers: ${speakers.join(', ') || 'none'}.`,
  ];
}

const registry = new Map<ChannelSemanticKey, ChannelSemanticDefinition>([
  ['assistant', {
    key: 'assistant',
    label: 'General assistant channel',
    promptPrefix: 'This is a neutral assistant channel. Answer the user directly and objectively; do not roleplay or simulate a character.',
    transcriptInstruction: 'Recent transcript is task context for a general assistant, not a character dialogue sample.',
    targetPriority: 'latest_human',
    memoryMode: 'user_private',
    duplicateTolerance: 'relaxed',
    summariseRecentContext: buildSharedRecentSummary,
  }],
  ['direct', {
    key: 'direct',
    label: 'User-private channel',
    promptPrefix: 'This is a private conversation between this person and the user. Interpret the user\'s words within their relationship and the ongoing exchange; an explicit request for help or a deliverable remains a request, not every remark is a task.',
    transcriptInstruction: 'Recent transcript is private context and direct input, not a public-room writing sample.',
    targetPriority: 'latest_human',
    memoryMode: 'user_private',
    duplicateTolerance: 'relaxed',
    summariseRecentContext: buildSharedRecentSummary,
  }],
  ['ai_direct', {
    key: 'ai_direct',
    label: 'Character private chat',
    promptPrefix: 'This is a private AI side-thread. Treat it as a two-party channel with reciprocal carry-over, not as a public room.',
    transcriptInstruction: 'Recent transcript is pair-private relationship context, not a generic room script.',
    targetPriority: 'counterpart',
    memoryMode: 'pair_private',
    duplicateTolerance: 'balanced',
    summariseRecentContext: buildSharedRecentSummary,
  }],
  ['group', {
    key: 'group',
    label: 'Public room',
    promptPrefix: 'This is a public multi-party room. Public timing, local room pressure, and visible social momentum matter.',
    transcriptInstruction: 'Recent transcript is room state and thread evidence, not a style sample to imitate.',
    targetPriority: 'room_thread',
    memoryMode: 'public_room',
    duplicateTolerance: 'strict',
    summariseRecentContext: buildSharedRecentSummary,
  }],
]);

export function getChannelSemantics(chat: Pick<GroupChat, 'type'>) {
  return registry.get(chat.type) || registry.get('group')!;
}
