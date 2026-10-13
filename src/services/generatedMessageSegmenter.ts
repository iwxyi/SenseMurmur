import type { GeneratedRoundMessage } from './chatEngine';
import type { ConversationUpdate } from '../types/conversationContinuity';

function stateUpdateForSegment<T extends { evidenceText?: string }>(update: T | undefined, parts: string[], index: number) {
  if (!update) return undefined;
  const owner = update.evidenceText ? parts.findIndex((part) => part.includes(update.evidenceText!)) : 0;
  return owner === index ? update : undefined;
}

function continuityForSegment(update: ConversationUpdate | undefined, parts: string[], index: number) {
  if (!update) return undefined;
  const owns = (evidence: string) => parts[index].includes(evidence) && !parts.slice(0, index).some((part) => part.includes(evidence));
  const items = update.items.filter((item) => owns(item.evidenceText));
  const room = update.room && owns(update.room.evidenceText) ? update.room : undefined;
  const settled = update.settled && owns(update.settled.evidenceText) ? update.settled : undefined;
  return items.length || room || settled ? { items, ...(room ? { room } : {}), ...(settled ? { settled } : {}) } : undefined;
}

// Compatibility-only protection for legacy extraMessages. The model-facing
// room limit is deliberately softer and may be exceeded when meaning requires it.
const MAX_EXTRA_MESSAGES = 7;

function normalizeModelExtraMessages(extraMessages: unknown) {
  if (!Array.isArray(extraMessages)) return [];
  const cleaned = extraMessages
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (cleaned.length <= MAX_EXTRA_MESSAGES) return cleaned;
  return [
    ...cleaned.slice(0, MAX_EXTRA_MESSAGES - 1),
    cleaned.slice(MAX_EXTRA_MESSAGES - 1).join('\n'),
  ];
}

function withoutTransientExtras(message: GeneratedRoundMessage): GeneratedRoundMessage {
  if (message.extraMessages == null && message.messageParts == null) return message;
  const rest = { ...message };
  delete rest.extraMessages;
  delete rest.messageParts;
  return rest;
}

function getVisibleTurnParts(message: GeneratedRoundMessage) {
  if (Array.isArray(message.messageParts) && message.messageParts.length) {
    return message.messageParts.map((part) => part.content).filter(Boolean);
  }
  return [message.content, ...normalizeModelExtraMessages(message.extraMessages)].filter(Boolean);
}

export function buildGeneratedTurnContent(message: GeneratedRoundMessage) {
  return getVisibleTurnParts(message).join('\n');
}

export function splitGeneratedMessageText(content: string, requestedCount = 1) {
  void requestedCount;
  return content ? [content] : [];
}

export function splitGeneratedRoundMessage(message: GeneratedRoundMessage) {
  if (Array.isArray(message.messageParts) && message.messageParts.length) {
    const baseMessage = withoutTransientExtras(message);
    const parts = message.messageParts.filter((part) => Boolean(part.content?.trim()));
    return parts.map((part, index) => ({
      ...baseMessage,
      content: part.content,
      metadata: {
        ...(part.metadata || {}),
        presenceUpdate: stateUpdateForSegment(message.metadata?.presenceUpdate, parts.map((item) => item.content), index),
        activityUpdate: stateUpdateForSegment(message.metadata?.activityUpdate, parts.map((item) => item.content), index),
        conversationUpdate: continuityForSegment(message.metadata?.conversationUpdate, parts.map((item) => item.content), index),
        turnSegment: {
          index,
          count: parts.length,
        },
      },
      interactionHint: index === 0 ? message.interactionHint : null,
      interactionHints: index === 0 ? message.interactionHints : null,
      incomingInteractionHint: index === 0 ? message.incomingInteractionHint : null,
      addressedTargetIds: index === 0 ? message.addressedTargetIds : null,
      primaryAddressedTargetId: index === 0 ? message.primaryAddressedTargetId : null,
      socialEventHints: index === 0 ? message.socialEventHints : null,
      conflictFocus: stateUpdateForSegment(message.conflictFocus || undefined, parts.map((item) => item.content), index) || null,
    }));
  }
  const parts = getVisibleTurnParts(message);
  const baseMessage = withoutTransientExtras(message);
  if (parts.length <= 1) return [baseMessage];

  if (
    message.metadata?.withdrawal?.withdrawn
  ) {
    return [baseMessage];
  }

  if (
    message.metadata?.generationDecision?.image?.shouldGenerate
    || message.metadata?.generationDecision?.audio?.shouldGenerate
    || message.metadata?.format === 'markdown'
  ) {
    return [{
      ...baseMessage,
      content: parts.join('\n'),
    }];
  }

  return parts.map((content, index) => ({
    ...baseMessage,
    content,
    metadata: {
      ...(index === 0 ? baseMessage.metadata : {
        format: baseMessage.metadata?.format,
        manualSpeaker: baseMessage.metadata?.manualSpeaker,
        turnParameters: baseMessage.metadata?.turnParameters,
      }),
      conversationUpdate: continuityForSegment(message.metadata?.conversationUpdate, parts, index),
      presenceUpdate: stateUpdateForSegment(message.metadata?.presenceUpdate, parts, index),
      activityUpdate: stateUpdateForSegment(message.metadata?.activityUpdate, parts, index),
      turnSegment: {
        index,
        count: parts.length,
      },
    },
    interactionHint: index === 0 ? message.interactionHint : null,
    interactionHints: index === 0 ? message.interactionHints : null,
    incomingInteractionHint: index === 0 ? message.incomingInteractionHint : null,
    addressedTargetIds: index === 0 ? message.addressedTargetIds : null,
    primaryAddressedTargetId: index === 0 ? message.primaryAddressedTargetId : null,
    socialEventHints: index === 0 ? message.socialEventHints : null,
    conflictFocus: stateUpdateForSegment(message.conflictFocus || undefined, parts, index) || null,
  }));
}
