import type { RuntimeEventV2, SocialEventCandidatePayload, SocialEventHintEnvelope } from '../types/runtimeEvent';
import type { GroupChat } from '../types/chat';

export function isCompletedSocialArtifact(event: RuntimeEventV2) {
  if (event.kind !== 'artifact') return false;
  const payload = event.payload as { status?: string };
  // Legacy artifacts had no lifecycle status; preserve their existing interpretation.
  return payload.status == null || payload.status === 'completed';
}

const ARTIFACT_TYPES = {
  status_update: 'status_note',
  check_in: 'check_in_note',
  react_to_moment: 'moment_reaction_note',
  gift_exchange: 'gift_note',
  conflict_expression: 'conflict_note',
} as const;

interface SocialIntentPayload {
  status?: string;
  intentId?: string;
  eventKind?: SocialEventCandidatePayload['eventKind'];
  seedIntent?: string;
  initiatorId?: string;
  candidateId?: string;
}

export function getUnsettledSocialIntents(chat: GroupChat) {
  const events = chat.runtimeEventsV2 || [];
  const settled = new Set(events.filter((event) => event.kind === 'artifact')
    .map((event) => event.payload as SocialIntentPayload)
    .filter((payload) => payload.status === 'completed' || payload.status === 'cancelled')
    .map((payload) => payload.intentId).filter(Boolean));
  return events.filter((event) => {
    const payload = event.payload as SocialIntentPayload;
    return event.kind === 'artifact' && payload.status === 'tentative'
      && payload.eventKind != null && payload.eventKind in ARTIFACT_TYPES
      && payload.initiatorId != null && event.actorIds?.[0] === payload.initiatorId
      && !settled.has(event.id);
  });
}

export function getSocialIntentStateEventIds(events: RuntimeEventV2[], retainedIds: Set<string>) {
  const stateIds = new Set<string>();
  const outcomes = events.filter((event) => event.kind === 'artifact'
    && ['completed', 'cancelled'].includes((event.payload as SocialIntentPayload).status || ''));
  const settledIds = new Set(outcomes.map((event) => (event.payload as SocialIntentPayload).intentId));
  for (const event of events) {
    const payload = event.payload as SocialIntentPayload;
    if (event.kind !== 'artifact' || payload.status !== 'tentative'
      || !payload.initiatorId || !payload.eventKind || !(payload.eventKind in ARTIFACT_TYPES)) continue;
    if (!settledIds.has(event.id) || retainedIds.has(event.id)) {
      stateIds.add(event.id);
      if (payload.candidateId) {
        stateIds.add(payload.candidateId);
        events.filter((item) => item.summary === `handled_social_event:${payload.candidateId}`)
          .forEach((item) => stateIds.add(item.id));
      }
    }
  }
  for (const event of outcomes) {
    if (stateIds.has((event.payload as SocialIntentPayload).intentId || '')) stateIds.add(event.id);
  }
  for (const event of events) {
    const payload = event.payload as { artifactType?: string; intentId?: string };
    if (event.kind === 'artifact' && payload.artifactType === 'social_intent_handoff'
      && stateIds.has(payload.intentId || '')) stateIds.add(event.id);
  }
  return stateIds;
}

export function getPendingSocialIntents(chat: GroupChat, actorId: string) {
  return getUnsettledSocialIntents(chat).filter((event) => {
    const payload = event.payload as SocialIntentPayload;
    return event.kind === 'artifact' && payload.status === 'tentative'
      && payload.eventKind != null && payload.eventKind in ARTIFACT_TYPES
      && payload.initiatorId === actorId && event.actorIds?.[0] === actorId
      && !event.visibleToRoles?.length
      && (!event.visibleToIds?.length || chat.memberIds.every((id) => event.visibleToIds?.includes(id)))
      && (event.visibility === 'derived_public' || event.visibility === 'public'
        || (event.visibility === 'pair_private' && (chat.type === 'direct' || chat.type === 'ai_direct')
          && chat.memberIds.every((id) => id === actorId || event.targetIds?.includes(id))));
  });
}

export function buildPendingSocialIntentContext(chat: GroupChat, actorId: string) {
  return getPendingSocialIntents(chat, actorId).slice(-5).map((event) => {
    const payload = event.payload as SocialIntentPayload;
    return JSON.stringify({ intentId: event.id, eventKind: payload.eventKind, intent: payload.seedIntent });
  }).join('\n');
}

export function buildSocialIntentOutcomes(chat: GroupChat, message: {
  id?: string;
  senderId: string;
  content: string;
  socialEventHints?: SocialEventHintEnvelope[] | null;
}) {
  if (!message.id) return [];
  const messageId = message.id;
  const pending = getPendingSocialIntents(chat, message.senderId);
  const consumed = new Set<string>();
  return (message.socialEventHints || []).flatMap((hint) => {
    if (!hint.intentId || !hint.outcome || !hint.evidenceText
      || !message.content.includes(hint.evidenceText) || consumed.has(hint.intentId)) return [];
    const intent = pending.find((event) => event.id === hint.intentId
      && (event.payload as SocialIntentPayload).eventKind === hint.eventKind);
    if (!intent) return [];
    consumed.add(intent.id);
    return [{
      ...intent,
      id: `${intent.id}:outcome:${messageId}`,
      createdAt: Date.now(),
      evidenceMessageIds: [messageId],
      summary: intent.visibility === 'pair_private' ? '私域表达的结果已记录' : hint.evidenceText,
      payload: {
        ...intent.payload,
        status: hint.outcome,
        intentId: intent.id,
        messageId,
        text: hint.evidenceText,
        evidenceText: hint.evidenceText,
      },
    } satisfies RuntimeEventV2];
  });
}

export function buildSocialIntentArtifact(payload: SocialEventCandidatePayload, actorName: string, candidateId?: string) {
  if (!(payload.eventKind in ARTIFACT_TYPES)) return null;
  const artifactType = ARTIFACT_TYPES[payload.eventKind as keyof typeof ARTIFACT_TYPES];
  const text = `${actorName} 的待定意图：${payload.seedIntent}`;
  return {
    summary: text,
    visibility: payload.visibilityPlan === 'public' ? 'derived_public' as const : 'pair_private' as const,
    payload: {
      artifactType,
      eventKind: payload.eventKind,
      status: 'tentative',
      text,
      seedIntent: payload.seedIntent,
      sourceText: payload.sourceText,
      openingMessage: payload.openingMessage,
      candidateId,
      initiatorId: payload.initiatorId,
      participantIds: payload.participantIds,
      targetIds: payload.targetIds,
      title: payload.title,
      activityType: payload.activityType,
      reasonType: payload.reasonType,
      timeHint: payload.timeHint,
      locationHint: payload.locationHint,
      expectedArtifacts: payload.expectedArtifacts || [],
      dedupeKey: payload.dedupeKey,
    },
  };
}
