import type { GroupChat } from '../types/chat';
import type { CharacterMindProjection } from './characterMindProjection';

export type CharacterMindPromptVisibility = 'public' | 'private';
export type VisibleMemoryRecallSetting = 'off' | 'implicit' | 'natural';

export interface CharacterMindPromptAdapterOptions {
  chatType: GroupChat['type'];
  visibility?: CharacterMindPromptVisibility;
  visibleMemoryRecall?: VisibleMemoryRecallSetting;
  visibleRecallCues?: string[];
  summarizeUserContinuity?: boolean;
  maxCoreLines?: number;
  maxRoomLines?: number;
  maxRecallCues?: number;
  includeActiveRoomLineSummaries?: boolean;
  includeRoomTopic?: boolean;
  includeExpressionGuidance?: boolean;
  renderVisibleRecallCues?: boolean;
}

export interface CharacterMindPromptAdapterOutput {
  promptBlock: string;
  coreContinuityBlock: string;
  renderedIdentityValues: string[];
  currentRoomBlock: string;
  visibleRecallInput: string[];
  trace: {
    visibility: CharacterMindPromptVisibility;
    visibleMemoryRecall: VisibleMemoryRecallSetting;
    omittedPrivateContinuity: boolean;
    omittedRawRoomLines: boolean;
    selectedSelfMemoryCount: number;
    renderedSelfMemoryCount: number;
    sourceIds: string[];
  };
}

const DEFAULT_CORE_LINES = 8;
const DEFAULT_ROOM_LINES = 6;
const DEFAULT_RECALL_CUES = 3;

function compactText(text: string | undefined | null, max = 180) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function stripInternalIds(text: string) {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '成员')
    .replace(/\b(local-character|draft|evt|msg|chat)-[A-Za-z0-9_-]{6,}\b/g, '成员')
    .replace(/\bstatus_shift\b/g, 'state shift')
    .replace(/\brelationship_delta\b/g, 'relationship change')
    .replace(/\bunknown_internal_source\b/g, 'memory source')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanValues(values: string[], _visibility: CharacterMindPromptVisibility, max: number) {
  return Array.from(new Set(values
    .map((value) => stripInternalIds(compactText(value)))
    .filter(Boolean)))
    .slice(0, max);
}

function bullet(label: string, values: string[]) {
  return values.length ? `- ${label}: ${values.join(' / ')}` : '';
}

function publicContinuityFallback(
  values: string[],
  fallback: string,
  visibility: CharacterMindPromptVisibility,
  rawValueCount = values.length,
) {
  if (visibility === 'private') return values;
  return rawValueCount > 0 ? [fallback] : [];
}

function buildCoreContinuityLines(
  projection: CharacterMindProjection,
  visibility: CharacterMindPromptVisibility,
  maxLines: number,
  summarizeUserContinuity = false,
) {
  const rawUserContinuity = projection.continuity.userProfile;
  const rawRelationshipContinuity = projection.continuity.relationshipMemories;
  const rawSharedHistory = projection.continuity.sharedHistory;
  const companionshipOwnsUserTargetDetails = summarizeUserContinuity && projection.relationship.targetId === 'user';
  const userContinuity = publicContinuityFallback(
    summarizeUserContinuity && rawUserContinuity.length
      ? ['User details are handled by the companionship context; let them affect care, restraint, familiarity, and omissions without repeating them here.']
      : cleanValues(rawUserContinuity, visibility, 3),
    'User continuity exists; let it affect care, restraint, familiarity, and omissions without revealing private facts.',
    visibility,
    rawUserContinuity.length,
  );
  const relationshipContinuity = publicContinuityFallback(
    companionshipOwnsUserTargetDetails && rawRelationshipContinuity.length
      ? ['User relationship details are handled by the companionship context; keep the stance active without repeating shared-anchor evidence here.']
      : cleanValues(rawRelationshipContinuity, visibility, 3),
    'Relationship continuity exists; let it bend stance and timing without reciting private evidence.',
    visibility,
    rawRelationshipContinuity.length,
  );
  const sharedHistory = publicContinuityFallback(
    companionshipOwnsUserTargetDetails && rawSharedHistory.length
      ? ['Shared user history is handled by the companionship context; use it as subtext without repeating the scene details here.']
      : cleanValues(rawSharedHistory, visibility, 2),
    'Shared history exists; use it as subtext unless the room has already made it public.',
    visibility,
    rawSharedHistory.length,
  );
  const rawSelfContinuity = projection.continuity.selfMemories;
  const selfContinuity = cleanValues(rawSelfContinuity, visibility, 4);
  const selfContinuityLine = bullet('Self continuity', selfContinuity);
  const rawTargetStance = projection.relationship.stance;
  const targetStance = cleanValues(rawTargetStance, visibility, 3);
  const identityEntries = [
    { label: 'Stable self', values: cleanValues(projection.identity.selfModel, visibility, 3) },
    { label: 'Voice and habits', values: cleanValues(projection.identity.stableVoice, visibility, 3) },
    { label: 'Desires', values: cleanValues(projection.identity.desires, visibility, 2) },
    { label: 'Fears and sensitivities', values: cleanValues(projection.identity.fears, visibility, 2) },
  ];
  const identityLines = identityEntries.slice(0, 2).map(({ label, values }) => bullet(label, values)).filter(Boolean);
  const targetRelationshipLine = projection.relationship.targetName
    ? bullet(`Stance toward ${stripInternalIds(projection.relationship.targetName)}`, [
      ...targetStance,
      ...relationshipContinuity.map((item) => `Relationship continuity: ${item}`),
      ...sharedHistory.map((item) => `Shared history: ${item}`),
    ].slice(0, 5))
    : '';
  const recordedStateLine = bullet('Recorded emotional state', cleanValues([
    ...projection.currentState.emotionalUndercurrent,
    ...projection.currentState.activeNeeds,
  ], visibility, 4));
  const priorityLines = [
    ...identityLines,
    targetRelationshipLine,
    recordedStateLine,
    selfContinuityLine,
  ].filter(Boolean);
  const continuityLines = [
    ...identityEntries.slice(2).map(({ label, values }) => bullet(label, values)),
    bullet('User continuity', userContinuity),
    !projection.relationship.targetName ? bullet('Relationship continuity', relationshipContinuity) : '',
    !projection.relationship.targetName ? bullet('Shared history', sharedHistory) : '',
    projection.currentState.selfAppraisal ? `- Self-appraisal: ${stripInternalIds(compactText(projection.currentState.selfAppraisal))}` : '',
  ].filter(Boolean);
  const lines = [...priorityLines, ...continuityLines]
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, maxLines);
  return {
    lines,
    selectedSelfMemoryCount: rawSelfContinuity.length,
    renderedSelfMemoryCount: selfContinuityLine && lines.includes(selfContinuityLine) ? selfContinuity.length : 0,
    renderedIdentityValues: identityEntries
      .filter(({ label, values }) => values.length && lines.includes(bullet(label, values)))
      .flatMap(({ values }) => values),
  };
}

function buildRoomLines(
  projection: CharacterMindProjection,
  visibility: CharacterMindPromptVisibility,
  maxLines: number,
  includeActiveRoomLineSummaries: boolean,
  includeRoomTopic: boolean,
  includeExpressionGuidance: boolean,
) {
  const activeRoomLines = includeActiveRoomLineSummaries
    ? cleanValues(projection.room.activeLines, visibility, 3)
    : [];
  const lines = [
    includeRoomTopic && projection.room.topic ? `- Current room topic: ${stripInternalIds(compactText(projection.room.topic))}` : '',
    bullet('Room pressure and constraints', cleanValues(projection.room.constraints, visibility, 4)),
    bullet('Active room lines', activeRoomLines),
    bullet('World, scenario, or growth context', cleanValues(projection.room.worldActivities, visibility, 4)),
    includeExpressionGuidance ? bullet('Expression guidance', cleanValues([
      projection.expression.socialMove,
      projection.expression.temperature,
      projection.expression.attention,
      projection.expression.length,
    ], visibility, 4)) : '',
    projection.expression.omissions.length ? `- Keep implicit or omit unless naturally triggered: ${projection.expression.omissions.join(' / ')}.` : '',
  ].filter(Boolean);
  return lines.slice(0, maxLines);
}

function selectRecallCues(
  projection: CharacterMindProjection,
  visibility: CharacterMindPromptVisibility,
  visibleMemoryRecall: VisibleMemoryRecallSetting,
  maxRecallCues: number,
  suppliedRecallCues?: string[],
  omitUserContinuity = false,
) {
  if (visibleMemoryRecall === 'off') return [];
  if (suppliedRecallCues !== undefined) {
    return Array.from(new Set(suppliedRecallCues.map((cue) => stripInternalIds(compactText(cue, 220))).filter(Boolean)))
      .slice(0, maxRecallCues);
  }
  const privateCueSources = [
    ...(omitUserContinuity ? [] : projection.continuity.userProfile),
    ...projection.continuity.relationshipMemories,
    ...projection.continuity.sharedHistory,
  ];
  const publicCueSources = [
    ...projection.continuity.relationshipMemories,
    ...projection.continuity.sharedHistory,
  ];
  const cues = cleanValues(visibility === 'private' ? privateCueSources : publicCueSources, visibility, maxRecallCues);
  if (visibleMemoryRecall === 'implicit') {
    return cues.map((cue) => `Use as subtext only: ${cue}`);
  }
  return cues.map((cue) => `May naturally reference if the current turn calls for it: ${cue}`);
}

export function adaptCharacterMindProjectionForPrompt(
  projection: CharacterMindProjection,
  options: CharacterMindPromptAdapterOptions,
): CharacterMindPromptAdapterOutput {
  const visibility = options.visibility
    || (options.chatType === 'direct' || options.chatType === 'ai_direct' ? 'private' : 'public');
  const visibleMemoryRecall = options.visibleMemoryRecall || 'implicit';
  const core = buildCoreContinuityLines(
    projection,
    visibility,
    options.maxCoreLines || DEFAULT_CORE_LINES,
    options.summarizeUserContinuity,
  );
  const roomLines = buildRoomLines(
    projection,
    visibility,
    options.maxRoomLines || DEFAULT_ROOM_LINES,
    options.includeActiveRoomLineSummaries ?? false,
    options.includeRoomTopic ?? true,
    options.includeExpressionGuidance ?? true,
  );
  const visibleRecallInput = selectRecallCues(
    projection,
    visibility,
    visibleMemoryRecall,
    options.maxRecallCues || DEFAULT_RECALL_CUES,
    options.visibleRecallCues,
    options.summarizeUserContinuity,
  );
  const recallLines = options.renderVisibleRecallCues !== false && visibleRecallInput.length
    ? ['## Visible Recall Cues', ...visibleRecallInput.map((cue) => `- ${cue}`)]
    : [];
  const coreContinuityBlock = core.lines.length ? `## Core Character Continuity\n${core.lines.join('\n')}` : '';
  const currentRoomBlock = roomLines.length ? `## Current Situation\n${roomLines.join('\n')}` : '';
  const promptParts = [
    coreContinuityBlock,
    currentRoomBlock,
    recallLines.join('\n'),
    'This projection is inner context, not a checklist. Let it change attention, wording, omissions, and timing without reciting it.',
  ].filter(Boolean);
  return {
    promptBlock: promptParts.length ? `\n## Character Mind Projection\n${promptParts.join('\n')}` : '',
    coreContinuityBlock,
    renderedIdentityValues: core.renderedIdentityValues,
    currentRoomBlock,
    visibleRecallInput,
    trace: {
      selectedSelfMemoryCount: core.selectedSelfMemoryCount,
      renderedSelfMemoryCount: core.renderedSelfMemoryCount,
      visibility,
      visibleMemoryRecall,
      omittedPrivateContinuity: visibility === 'public' && (
        projection.continuity.userProfile.length > 0
        || projection.continuity.relationshipMemories.length > 0
        || projection.continuity.sharedHistory.length > 0
      ),
      omittedRawRoomLines: !options.includeActiveRoomLineSummaries && projection.room.activeLines.length > 0,
      sourceIds: projection.hidden.sourceIds.slice(0, 12),
    },
  };
}
