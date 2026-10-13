import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';

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
