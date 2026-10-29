import { useMemo, useState } from 'react';
import { DetailedFactsPanel } from './DetailedFactsPanel';
import { useDetailedFacts } from '../../hooks/useDetailedFacts';
import { Box, Button, Chip, LinearProgress, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { AICharacter } from '../../types/character';
import type { GroupChat } from '../../types/chat';
import type { MemoryItem } from '../../services/memoryTypes';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useChatStore } from '../../stores/useChatStore';
import { useMessageStore } from '../../stores/useMessageStore';
import SimpleBarChart from '../common/SimpleBarChart';
import SurfaceCard from '../common/SurfaceCard';
import SectionHeader from '../common/SectionHeader';
import PageSection from '../common/PageSection';
import StatChipRow from '../common/StatChipRow';
import DebugChip from '../common/DebugChip';
import { formatRelationshipNumber } from '../../services/relationshipLedger';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { applyDriftToBehavior, formatLocalizedDriftSummary, getDominantEmotionLabel, getAffectSummaryLines, formatEmotionStateLabel } from '../../services/personalityDrift';
import LayeredMemoryPanel from '../memory/LayeredMemoryPanel';
import { getPreferredAIProfile, isAIProfileUsable } from '../../types/settings';
import {
  buildCharacterExperienceArtifactContext,
  buildCharacterFinalLetterContext,
  buildLocalCharacterExperienceArtifact,
  generateCharacterExperienceArtifact,
  type CharacterExperienceArtifactKind,
} from '../../services/characterExperienceArtifacts';
import { summarizeExpressionFeedbackInfluence } from '../../services/expressionFeedbackInfluence';
import { buildMemberInnerLifeChips } from '../../services/memberInnerLifePresentation';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import { safeRuntimePrivateText } from '../../services/runtimePrivateTextPrivacy';
import { formatInnerImpulseLabel } from '../../services/runtimeDecisionLabels';
import { buildCharacterCompanionshipStates, buildCompanionshipRuntimeTrace, buildCompanionshipStatusSignature, buildRitualRegistry, buildSharedMemoryAnchors, buildSharedPhrases, buildSharedSecrets, buildUserCompanionshipProjection } from '../../services/companionshipProjection';
import { buildCompanionshipPrivateThreadScheduleDiagnostics } from '../../services/companionshipPrivateThreadSchedule';
import { applyCompanionshipLedgerBackflow } from '../../services/companionshipLedgerBackflow';
import { buildSharedPhraseEventsFromCompanionshipEvent } from '../../services/companionshipSharedPhraseBackflow';
import type { Message } from '../../types/message';
import type { AttachmentProfileHistoryEntry, CareTopicHistoryEntry, CharacterCompanionshipState, CompanionshipPhase, CompanionshipRuntimeTrace, CompanionshipStyle, IntimateConflictHistoryEntry, PendingCareTopic, PendingPromise, PhaseHistoryEntry, PrivateThreadScheduleDiagnostic, PromiseHistoryEntry, RitualHistoryEntry, RitualRegistryEntry, SharedAnchorHistoryEntry, SharedMemoryAnchor, SharedPhrase, SharedPhraseHistoryEntry, SharedSecret, SharedSecretHistoryEntry, UserAttachmentProfile, UserProfileMemoryEventItem, UserProfileMemoryHistoryEntry, UserProfileMemoryKind } from '../../types/companionship';
import type { RuntimeEventV2 } from '../../types/runtimeEvent';
import {
  type ManualAddressingSetAction,
  type ManualPromiseLifecycleAction,
  type PromiseMergeTarget,
  buildManualAddressingEvent,
  buildManualAddressingSetEvent,
  buildManualAttachmentProfileEvent,
  buildManualCareTopicBlockedEvent,
  buildManualCareTopicRestoreEvent,
  buildManualIntimateConflictDismissedEvent,
  buildManualIntimateConflictResolvedEvent,
  buildManualIntimateConflictRestoreEvent,
  buildManualPhaseCorrectionEvent,
  buildManualPhaseRestoreFromHistoryEvent,
  buildManualPhaseRevokeEvent,
  buildManualPromiseLifecycleEvent,
  buildManualPromiseMergeEvents,
  buildManualPromiseRestoreEvent,
  buildManualPromiseUpsertEvent,
  buildManualRitualActionEvent,
  buildManualRitualRestoreFromHistoryEvent,
  buildManualRitualUpdateEvent,
  buildManualSharedAnchorArchiveEvent,
  buildManualSharedAnchorPairPrivateEvent,
  buildManualSharedAnchorParticipantsEvent,
  buildManualSharedAnchorRestoreEvent,
  buildManualSharedAnchorUpsertEvent,
  buildManualSharedPhrasePairPrivateEvent,
  buildManualSharedPhraseParticipantsEvent,
  buildManualSharedPhraseRestoreEvent,
  buildManualSharedPhraseSuppressedEvent,
  buildManualSharedPhraseUpsertEvent,
  buildManualSharedSecretConsequenceEvent,
  buildManualSharedSecretMaskEvent,
  buildManualSharedSecretPairPrivateEvent,
  buildManualSharedSecretParticipantsEvent,
  buildManualSharedSecretRestorePublicEvent,
  buildManualSharedSecretRevokedEvent,
  buildManualUserProfileMemoryRestoreEvent,
  buildManualUserProfileMemoryRevokeEvent,
  buildManualUserProfileMemoryUpsertEvent,
  clipRuntimeText,
  INTERACTION_PACE_OPTIONS,
  formatAddressingActionLabel,
  formatAttachmentActionLabel,
  formatAttachmentStyleLabel,
  formatCareTopicActionLabel,
  formatInteractionPacePreferenceLabel,
  formatIntimateConflictActionLabel,
  formatPromiseActionLabel,
  formatRitualActionLabel,
  formatRuntimeEvidence,
  formatUserProfileMemoryActionLabel,
  formatUserProfileMemoryKindLabel,
} from '../../services/companionshipManualEvents';

type ParticipantOption = { id: string; name: string };

function buildCharacterLayeredMemories(character: Partial<AICharacter>): MemoryItem[] {
  if (character.layeredMemories?.length) return character.layeredMemories;
  const now = Date.now();
  const items: MemoryItem[] = [];

  for (const item of character.memory?.longTerm || []) {
    items.push({ id: `lt-${item}`, scope: 'character_self', layer: 'long_term', kind: 'trait_evidence', ownerId: character.id || 'character', text: item, salience: 0.8, confidence: 0.75, recency: 0.7, reinforcementCount: 1, sourceEventIds: [], createdAt: now, updatedAt: now });
  }
  for (const item of character.memory?.obsessions || []) {
    items.push({ id: `obs-${item}`, scope: 'character_self', layer: 'long_term', kind: 'obsession', ownerId: character.id || 'character', text: item, salience: 0.85, confidence: 0.8, recency: 0.75, reinforcementCount: 1, sourceEventIds: [], createdAt: now, updatedAt: now });
  }
  for (const item of character.memory?.tabooTopics || []) {
    items.push({ id: `taboo-${item}`, scope: 'character_self', layer: 'long_term', kind: 'taboo', ownerId: character.id || 'character', text: item, salience: 0.8, confidence: 0.78, recency: 0.7, reinforcementCount: 1, sourceEventIds: [], createdAt: now, updatedAt: now });
  }
  for (const item of character.memory?.userMemories || []) {
    items.push({ id: `user-${item}`, scope: 'character_self', layer: 'episodic', kind: 'trait_evidence', ownerId: character.id || 'character', text: item, salience: 0.65, confidence: 0.7, recency: 0.8, reinforcementCount: 1, sourceEventIds: [], createdAt: now, updatedAt: now });
  }

  return items;
}

function buildRelationshipMemoryItems(character: Partial<AICharacter>): MemoryItem[] {
  const now = Date.now();
  return (character.relationships || []).slice(0, 8).map((relation, index) => ({
    id: `rel-${relation.characterId}-${index}`,
    scope: 'relationship',
    layer: 'episodic',
    kind: relation.warmth + relation.competence + relation.trust >= relation.threat + 12 ? 'bond' : 'resentment',
    ownerId: character.id || 'character',
    subjectIds: [character.id || 'character', relation.characterId],
    text: relation.note || relation.characterId,
    salience: 0.7,
    confidence: 0.72,
    recency: 0.75,
    reinforcementCount: 1,
    sourceEventIds: [],
    createdAt: relation.updatedAt || now,
    updatedAt: relation.updatedAt || now,
  }));
}

function recentByTime<T extends { lastMessageAt?: number; updatedAt?: number; createdAt?: number }>(items: T[], limit: number) {
  return items.slice().sort((a, b) => (b.lastMessageAt || b.updatedAt || b.createdAt || 0) - (a.lastMessageAt || a.updatedAt || a.createdAt || 0)).slice(0, limit);
}

function getTraitLabel(key: string, language: string) {
  const isZh = language.startsWith('zh');
  const labels: Record<string, string> = {
    openness: isZh ? '开放性' : 'Openness',
    extroversion: isZh ? '外向性' : 'Extroversion',
    agreeableness: isZh ? '宜人性' : 'Agreeableness',
    neuroticism: isZh ? '神经质' : 'Neuroticism',
    humor: isZh ? '幽默感' : 'Humor',
    creativity: isZh ? '创造力' : 'Creativity',
    assertiveness: isZh ? '果断度' : 'Assertiveness',
    empathy: isZh ? '共情力' : 'Empathy',
    irritation: isZh ? '烦躁' : 'Irritation',
    affection: isZh ? '好感' : 'Affection',
    insecurity: isZh ? '不安' : 'Insecurity',
    excitement: isZh ? '兴奋' : 'Excitement',
    embarrassment: isZh ? '尴尬' : 'Embarrassment',
    proactivity: isZh ? '主动性' : 'Proactivity',
    aggressiveness: isZh ? '攻击性' : 'Aggressiveness',
    humorIntensity: isZh ? '幽默感' : 'Humor intensity',
    empathyLevel: isZh ? '共情度' : 'Empathy level',
    summarizing: isZh ? '总结倾向' : 'Summarizing',
    offTopic: isZh ? '跑题倾向' : 'Off-topic',
  };
  return labels[key] || key;
}

function describeDriftValue(key: string, value: number, language: string) {
  const isZh = language.startsWith('zh');
  const abs = Math.abs(value);
  if (abs < 2) return '';
  const intensity = abs >= 10 ? 'strong' : abs >= 5 ? 'mid' : 'low';
  const zhLabels: Record<string, { up: string; down: string }> = {
    openness: { up: intensity === 'strong' ? '明显更开放' : '更开放', down: intensity === 'strong' ? '明显更保守' : '更保守' },
    extroversion: { up: intensity === 'strong' ? '明显更外放' : '更外放', down: intensity === 'strong' ? '明显更收敛' : '更收敛' },
    agreeableness: { up: intensity === 'strong' ? '明显更好说话' : '更好说话', down: intensity === 'strong' ? '明显更不让步' : '更不让步' },
    neuroticism: { up: intensity === 'strong' ? '明显更敏感' : '更敏感', down: intensity === 'strong' ? '明显更稳定' : '更稳定' },
    humor: { up: intensity === 'strong' ? '明显更爱开玩笑' : '更爱开玩笑', down: intensity === 'strong' ? '明显更少玩笑' : '更少玩笑' },
    creativity: { up: intensity === 'strong' ? '明显更发散' : '更发散', down: intensity === 'strong' ? '明显更按部就班' : '更按部就班' },
    assertiveness: { up: intensity === 'strong' ? '明显更强势' : '更主动出击', down: intensity === 'strong' ? '明显更退让' : '更退让' },
    empathy: { up: intensity === 'strong' ? '明显更会接住别人' : '更会接住别人', down: intensity === 'strong' ? '明显更少共情' : '更少共情' },
  };
  const enLabels: Record<string, { up: string; down: string }> = {
    openness: { up: 'More open', down: 'More guarded' },
    extroversion: { up: 'More outgoing', down: 'More reserved' },
    agreeableness: { up: 'More agreeable', down: 'Less yielding' },
    neuroticism: { up: 'More sensitive', down: 'More steady' },
    humor: { up: 'More playful', down: 'Less playful' },
    creativity: { up: 'More divergent', down: 'More conventional' },
    assertiveness: { up: 'More assertive', down: 'More yielding' },
    empathy: { up: 'More empathetic', down: 'Less empathetic' },
  };
  const labels = isZh ? zhLabels : enLabels;
  const label = labels[key]?.[value > 0 ? 'up' : 'down'];
  return label || `${getTraitLabel(key, language)}${value > 0 ? '+' : ''}${value}`;
}

function buildDriftChips(drift: Partial<AICharacter['personality']>, language: string, developerMode: boolean) {
  return Object.entries(drift)
    .filter(([, value]) => typeof value === 'number' && Math.abs(value) >= 2)
    .sort((a, b) => Math.abs(Number(b[1] || 0)) - Math.abs(Number(a[1] || 0)))
    .slice(0, developerMode ? 6 : 3)
    .map(([key, value]) => developerMode
      ? `${getTraitLabel(key, language)} ${Number(value) > 0 ? '+' : ''}${value}`
      : describeDriftValue(key, Number(value), language))
    .filter(Boolean);
}

function buildEmotionChips(character: Partial<AICharacter>, language: string) {
  const emotional = character.emotionalState;
  if (!emotional) return [];
  return [
    ['irritation', emotional.irritation],
    ['affection', emotional.affection],
    ['insecurity', emotional.insecurity],
    ['excitement', emotional.excitement],
    ['embarrassment', emotional.embarrassment],
  ]
    .map(([key, value]) => ({ key: String(key), value: Number(value) }))
    .filter((item) => item.value >= 12)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => ({
      label: formatEmotionStateLabel(item.key, item.value, language),
      hint: `${getTraitLabel(item.key, language)} ${item.value}`,
    }));
}

function EmotionPanel({ character, developerMode, emotionChips }: { character: Partial<AICharacter>; developerMode: boolean; emotionChips: Array<{ label: string; hint: string }> }) {
  const { i18n } = useTranslation();
  const emotional = character.emotionalState;
  if (!emotional) return <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '暂无情绪轨迹' : 'No emotion trace yet'}</Typography>;
  if (!developerMode) {
    return emotionChips.length ? (
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }} useFlexGap>
        {emotionChips.map((item) => (
          <Tooltip key={item.label} title={item.hint} arrow>
            <Chip size="small" label={item.label} variant="outlined" />
          </Tooltip>
        ))}
      </Stack>
    ) : null;
  }
  return (
    <Stack spacing={1}>
      {[
        ['irritation', emotional.irritation],
        ['affection', emotional.affection],
        ['insecurity', emotional.insecurity],
        ['excitement', emotional.excitement],
        ['embarrassment', emotional.embarrassment],
      ].map(([key, value]) => (
        <Box key={String(key)}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">{getTraitLabel(String(key), i18n.language)}</Typography>
            <Typography variant="caption" color="text.secondary">{value}</Typography>
          </Box>
          <LinearProgress variant="determinate" value={Number(value)} sx={{ height: 5, borderRadius: 999 }} />
        </Box>
      ))}
    </Stack>
  );
}

function getInnerImpulseLabel(impulse: NonNullable<AICharacter['soulState']>['lastImpulse'] | undefined, language: string) {
  if (!impulse) return language.startsWith('zh') ? '尚未形成明显冲动' : 'No clear impulse yet';
  return formatInnerImpulseLabel(impulse, language, 'insight');
}

function buildSoulSummary(character: Partial<AICharacter>, language: string) {
  const soul = character.soulState;
  const isZh = language.startsWith('zh');
  if (!soul) {
    return isZh
      ? '这个角色还没有留下足够的运行痕迹。等它经历几轮被回应、被忽视、靠近或退让后，内心残响会开始浮现。'
      : 'This character has not left enough runtime traces yet.';
  }
  if (soul.lastImpulse === 'repair') return isZh ? '刚才的话留下了一点余波，它有想靠近、找补，又不愿说得太软的冲动。' : 'A recent edge left residue; it wants to repair without sounding too soft.';
  if (soul.lastImpulse === 'seek_attention') return isZh ? '它有点想被看见，但更可能绕着说，用玩笑或半句话试探有没有人接住。' : 'It wants to be noticed, likely through a joke or sideways remark.';
  if (soul.lastImpulse === 'defend_face') return isZh ? '面子风险正在上升，它可能先嘴硬、岔开，或把真正想说的话压回去。' : 'Face pressure is rising; it may dodge, harden, or swallow words.';
  if (soul.lastImpulse === 'comfort') return isZh ? '它对房间仍有安全感，倾向笨拙但认真地接住别人。' : 'It still trusts the room enough to offer clumsy care.';
  if (soul.lastImpulse === 'mock') return isZh ? '关系里有一点刺感，它可能用调侃和反驳保持距离。' : 'There is a relational edge, so teasing may become distance.';
  if (soul.lastImpulse === 'avoid') return isZh ? '此刻能量或安全感偏低，它更可能短句、旁观，或者先退一步。' : 'Low energy or safety makes it more likely to step back.';
  if (soul.trustInRoom >= 58 && soul.loneliness < 45) return isZh ? '它暂时还相信这个房间，表达会更松一点，也更容易留下温和的余地。' : 'It still trusts the room and can speak with more ease.';
  return isZh ? '它还没有强烈冲动，更多是在观察房间里的关系和话题如何继续。' : 'No strong impulse; it is watching how the room continues.';
}

function soulMetricValue(value: number, canBeNegative = false) {
  if (!canBeNegative) return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return Math.max(0, Math.min(100, ((Number.isFinite(value) ? value : 0) + 100) / 2));
}

function SoulMetricRow({ label, value, hint, canBeNegative = false }: { label: string; value: number; hint: string; canBeNegative?: boolean }) {
  return (
    <Tooltip title={hint} arrow placement="top">
      <Box sx={{ cursor: 'help', '&:hover .soul-metric-label': { textDecoration: 'underline' } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
          <Typography className="soul-metric-label" variant="caption" color="text.secondary">{label}</Typography>
          <Typography variant="caption" color="text.secondary">{Math.round(value)}</Typography>
        </Box>
        <LinearProgress variant="determinate" value={soulMetricValue(value, canBeNegative)} sx={{ height: 5, borderRadius: 999 }} />
      </Box>
    </Tooltip>
  );
}

function SoulStatePanel({ character, developerMode }: { character: Partial<AICharacter>; developerMode: boolean }) {
  const { i18n } = useTranslation();
  const soul = character.soulState;
  const isZh = i18n.language.startsWith('zh');
  const summary = buildSoulSummary(character, i18n.language);
  const chips = soul ? [
    getInnerImpulseLabel(soul.lastImpulse, i18n.language),
    soul.ignoredStreak >= 2 ? (isZh ? '有未被接住的余波' : 'Unanswered residue') : '',
    soul.repression >= 56 ? (isZh ? '话被压住' : 'Suppressed words') : '',
    soul.trustInRoom >= 58 ? (isZh ? '仍有安全感' : 'Room feels safe') : '',
  ].filter(Boolean) : [isZh ? '等待经历' : 'Waiting for traces'];
  return (
    <SurfaceCard>
      <SectionHeader title={isZh ? '内心残响' : 'Inner Residue'} dense action={developerMode ? <DebugChip /> : undefined} />
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">{summary}</Typography>
        <StatChipRow items={chips} />
        {soul?.lastImpulseReason ? (
          <Tooltip title={isZh ? `最近依据：${soul.lastImpulseReason}` : `Reason: ${soul.lastImpulseReason}`} arrow placement="top">
            <Typography variant="caption" color="text.secondary" sx={{ width: 'fit-content', cursor: 'help', '&:hover': { textDecoration: 'underline' } }}>
              {isZh ? '查看形成原因' : 'View reason'}
            </Typography>
          </Tooltip>
        ) : null}
        {developerMode && soul ? (
          <Stack spacing={0.8} sx={{ pt: 0.5 }}>
            <SoulMetricRow label={isZh ? '心境' : 'Mood'} value={soul.mood?.pleasure || 0} canBeNegative hint={isZh ? '心境来自情绪、关系安全感和近期回应，不代表固定性格。' : 'Mood is projected from emotion, safety, and recent response.'} />
            <SoulMetricRow label={isZh ? '能量' : 'Energy'} value={soul.energy} hint={isZh ? '决定它更愿意主动发言，还是短句、旁观、停顿。' : 'Whether it tends to speak up or stay brief.'} />
            <SoulMetricRow label={isZh ? '孤独感' : 'Loneliness'} value={soul.loneliness} hint={isZh ? '来自最近发言是否被接住，用来模拟想被看见的冲动。' : 'Derived from whether recent speech was answered.'} />
            <SoulMetricRow label={isZh ? '压抑感' : 'Repression'} value={soul.repression} hint={isZh ? '表示有些话被压住，可能转化为迟疑、刺感或找补。' : 'Suppressed words may leak as hesitation, edge, or repair.'} />
            <SoulMetricRow label={isZh ? '房间安全感' : 'Room safety'} value={soul.trustInRoom} hint={isZh ? '角色对当前群聊氛围的安全判断，会影响是否露出柔软面。' : 'How safe the room feels for this character.'} />
          </Stack>
        ) : null}
      </Stack>
    </SurfaceCard>
  );
}

function relationshipLevel(value: number) {
  const abs = Math.abs(value);
  if (abs >= 60) return value < 0 ? '很低' : '很强';
  if (abs >= 32) return value < 0 ? '偏低' : '偏高';
  if (abs >= 8) return value < 0 ? '略低' : '略高';
  return '';
}

function buildRelationshipReadableChips(relation: NonNullable<AICharacter['relationships']>[number]) {
  const dimensions = [
    { label: '亲和', value: Number.isFinite(relation.warmth) ? relation.warmth : 0, threshold: 8 },
    { label: '能力判断', value: Number.isFinite(relation.competence) ? relation.competence : 0, threshold: 8 },
    { label: '信任', value: Number.isFinite(relation.trust) ? relation.trust : 0, threshold: 8 },
    { label: '威胁感', value: Number.isFinite(relation.threat) ? relation.threat : 0, threshold: 12 },
  ];
  const visible = dimensions
    .filter((item) => Math.abs(item.value) >= item.threshold)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((item) => `${item.label}${relationshipLevel(item.value)}`);
  return visible;
}

function buildRelationshipDebugChips(relation: NonNullable<AICharacter['relationships']>[number]) {
  return [
    `亲和 ${formatRelationshipNumber(Number.isFinite(relation.warmth) ? relation.warmth : 0)}`,
    `能力 ${formatRelationshipNumber(Number.isFinite(relation.competence) ? relation.competence : 0)}`,
    `信任 ${formatRelationshipNumber(Number.isFinite(relation.trust) ? relation.trust : 0)}`,
    `威胁 ${formatRelationshipNumber(Number.isFinite(relation.threat) ? relation.threat : 0)}`,
  ];
}

function buildRelationshipDebugHint(relation: NonNullable<AICharacter['relationships']>[number]) {
  return buildRelationshipDebugChips(relation).join(' / ');
}

function buildRelationshipUserHint(relation: NonNullable<AICharacter['relationships']>[number], members: Array<{ id: string; name?: string }>) {
  const readable = buildRelationshipReadableChips(relation).join(' / ');
  const note = relation.note && relation.note !== relation.characterId ? sanitizeUserFacingText(relation.note, members) : '';
  return [readable ? `当前倾向：${readable}` : '', note ? `最近证据：${note}` : ''].filter(Boolean).join('\n') || '这段关系来自角色资料和最近互动的累计印象。';
}

function formatCharacterCompanionshipStyle(style: CharacterCompanionshipState['style']) {
  const labels: Record<CharacterCompanionshipState['style'], string> = {
    close_friend: '亲近朋友',
    sibling_like: '像家人',
    romantic_tension: '暧昧张力',
    mentor_protege: '照看/学习',
    partner: '可靠搭档',
    rival_with_care: '带刺关心',
  };
  return labels[style];
}

function formatSharedMemoryAnchorKind(kind: SharedMemoryAnchor['kind']) {
  const labels: Record<SharedMemoryAnchor['kind'], string> = {
    first_time: '第一次',
    confession: '心意确认',
    conflict: '旧冲突',
    repair: '修复',
    inside_joke: '共同梗',
    shared_secret: '小秘密',
    promise: '约定',
    milestone: '里程碑',
  };
  return labels[kind];
}

function formatPendingPromiseKind(kind: PendingPromise['kind']) {
  const labels: Record<PendingPromise['kind'], string> = {
    shared_activity: '一起做的事',
    user_followup: '等用户回来说',
    emotional_commitment: '情感承诺',
    boundary_agreement: '关系边界',
    repair_agreement: '修复约定',
    ritual: '关系仪式',
    other: '普通约定',
  };
  return labels[kind];
}

function normalizeParticipantSelection(ids: string[], requiredIds: string[]) {
  const required = requiredIds.filter(Boolean);
  return Array.from(new Set([...required, ...ids.filter(Boolean)])).slice(0, 6);
}

function ParticipantEditor({
  selectedIds,
  options,
  resolveCharacterName,
  requiredIds,
  onSave,
}: {
  selectedIds: string[];
  options: ParticipantOption[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  requiredIds: string[];
  onSave: (participantIds: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const normalizedCurrent = normalizeParticipantSelection(selectedIds, requiredIds);
  const normalizedDraft = normalizeParticipantSelection(draftIds, requiredIds);
  const selectableOptions = options.filter((option) => !requiredIds.includes(option.id));
  const changed = normalizedCurrent.slice().sort().join(',') !== normalizedDraft.slice().sort().join(',');
  if (!editing) {
    return (
      <Button
        size="small"
        variant="text"
        onClick={() => {
          setDraftIds(normalizedCurrent);
          setEditing(true);
        }}
        sx={{ minWidth: 0 }}
      >
        编辑参与者
      </Button>
    );
  }
  return (
    <Box sx={{ width: '100%', p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        参与者
      </Typography>
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {requiredIds.filter(Boolean).map((id) => (
          <Chip key={id} size="small" label={`${resolveCharacterName(id)} · 必选`} variant="outlined" sx={{ height: 24, borderRadius: 999 }} />
        ))}
        {selectableOptions.map((option) => {
          const selected = normalizedDraft.includes(option.id);
          return (
            <Chip
              key={option.id}
              size="small"
              label={option.name}
              color={selected ? 'primary' : 'default'}
              variant={selected ? 'filled' : 'outlined'}
              onClick={() => {
                setDraftIds((prev) => {
                  const next = selected ? prev.filter((id) => id !== option.id) : [...prev, option.id];
                  return normalizeParticipantSelection(next, requiredIds);
                });
              }}
              sx={{ height: 24, borderRadius: 999 }}
            />
          );
        })}
      </Stack>
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.75 }}>
        <Button
          size="small"
          variant="text"
          disabled={!changed || normalizedDraft.length < 2}
          onClick={() => {
            onSave(normalizedDraft);
            setEditing(false);
          }}
          sx={{ minWidth: 0 }}
        >
          保存
        </Button>
        <Button
          size="small"
          variant="text"
          onClick={() => {
            setDraftIds(normalizedCurrent);
            setEditing(false);
          }}
          sx={{ minWidth: 0 }}
        >
          取消
        </Button>
      </Box>
    </Box>
  );
}

function SharedMemoryAnchorPanel({
  characterId,
  anchors,
  participantOptions,
  resolveCharacterName,
  developerMode,
  allowNonUserAnchors = false,
  onArchiveAnchor,
  onUpdateAnchor,
  onKeepPairPrivate,
  onKeepCharacterPair,
  onUpdateParticipants,
}: {
  characterId: string;
  anchors: SharedMemoryAnchor[];
  participantOptions: ParticipantOption[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
  allowNonUserAnchors?: boolean;
  onArchiveAnchor?: (anchor: SharedMemoryAnchor) => void;
  onUpdateAnchor?: (anchor: SharedMemoryAnchor, patch: { kind: SharedMemoryAnchor['kind']; title: string; text: string }) => void;
  onKeepPairPrivate?: (anchor: SharedMemoryAnchor) => void;
  onKeepCharacterPair?: (anchor: SharedMemoryAnchor, targetId: string) => void;
  onUpdateParticipants?: (anchor: SharedMemoryAnchor, participantIds: string[]) => void;
}) {
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  const [editingAnchorKind, setEditingAnchorKind] = useState<SharedMemoryAnchor['kind']>('milestone');
  const [editingAnchorTitle, setEditingAnchorTitle] = useState('');
  const [editingAnchorText, setEditingAnchorText] = useState('');
  return anchors.length ? (
    <Stack spacing={1}>
      {anchors.slice(0, developerMode ? 8 : 4).map((anchor) => {
        const participantNames = anchor.participantIds.map((id) => resolveCharacterName(id)).join(' × ');
        const archiveAnchor = onArchiveAnchor;
        const updateAnchor = onUpdateAnchor;
        const keepPairPrivate = onKeepPairPrivate;
        const keepCharacterPair = onKeepCharacterPair;
        const isEditing = editingAnchorId === anchor.id;
        const isUserAnchor = anchor.participantIds.includes('user');
        const canArchive = Boolean(archiveAnchor) && (isUserAnchor || allowNonUserAnchors);
        const canEdit = Boolean(updateAnchor) && (isUserAnchor || allowNonUserAnchors);
        const canEditParticipants = Boolean(onUpdateParticipants) && (isUserAnchor || allowNonUserAnchors);
        const canNarrowParticipants = Boolean(keepPairPrivate) && anchor.participantIds.includes('user') && anchor.participantIds.some((id) => id !== 'user' && id !== characterId);
        const rolePairTargets = !isUserAnchor && keepCharacterPair && anchor.participantIds.length > 2
          ? anchor.participantIds.filter((id) => id !== characterId)
          : [];
        const chips = developerMode
          ? [
              formatSharedMemoryAnchorKind(anchor.kind),
              `显著 ${anchor.salience}`,
              `置信 ${anchor.confidence}`,
              anchor.source === 'layered_memory' ? '分层记忆' : '关系备注',
            ]
          : [formatSharedMemoryAnchorKind(anchor.kind), participantNames].filter(Boolean);
        return (
          <Box key={anchor.id} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Stack spacing={0.65}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{anchor.title}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">{participantNames}</Typography>
                  {canEdit && updateAnchor ? (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => {
                        setEditingAnchorId(anchor.id);
                        setEditingAnchorKind(anchor.kind);
                        setEditingAnchorTitle(anchor.title);
                        setEditingAnchorText(anchor.text);
                      }}
                      sx={{ p: 0, minWidth: 0 }}
                    >
                      修改
                    </Button>
                  ) : null}
                  {canArchive && archiveAnchor ? (
                    <Button size="small" variant="text" onClick={() => archiveAnchor(anchor)} sx={{ p: 0, minWidth: 0 }}>
                      归档
                    </Button>
                  ) : null}
                  {canNarrowParticipants && keepPairPrivate ? (
                    <Button size="small" variant="text" onClick={() => keepPairPrivate(anchor)} sx={{ p: 0, minWidth: 0 }}>
                      只保留我和角色
                    </Button>
                  ) : null}
                  {rolePairTargets.map((targetId) => (
                    <Button key={targetId} size="small" variant="text" onClick={() => keepCharacterPair?.(anchor, targetId)} sx={{ p: 0, minWidth: 0 }}>
                      只保留{resolveCharacterName(targetId)}
                    </Button>
                  ))}
                </Box>
              </Box>
              {canEditParticipants && onUpdateParticipants ? (
                <ParticipantEditor
                  selectedIds={anchor.participantIds}
                  options={participantOptions}
                  resolveCharacterName={resolveCharacterName}
                  requiredIds={isUserAnchor ? [characterId, 'user'] : [characterId]}
                  onSave={(participantIds) => onUpdateParticipants(anchor, participantIds)}
                />
              ) : null}
              {isEditing ? (
                <Stack spacing={0.75}>
                  <TextField
                    select
                    size="small"
                    label="类型"
                    value={editingAnchorKind}
                    onChange={(event) => setEditingAnchorKind(event.target.value as SharedMemoryAnchor['kind'])}
                    slotProps={{ select: { native: true } }}
                  >
                    {(['first_time', 'confession', 'conflict', 'repair', 'inside_joke', 'shared_secret', 'promise', 'milestone'] as SharedMemoryAnchor['kind'][]).map((kind) => (
                      <option key={kind} value={kind}>{formatSharedMemoryAnchorKind(kind)}</option>
                    ))}
                  </TextField>
                  <TextField
                    size="small"
                    label="标题"
                    value={editingAnchorTitle}
                    onChange={(event) => setEditingAnchorTitle(event.target.value)}
                    fullWidth
                  />
                  <TextField
                    size="small"
                    label="内容"
                    value={editingAnchorText}
                    onChange={(event) => setEditingAnchorText(event.target.value)}
                    fullWidth
                    multiline
                    minRows={2}
                    maxRows={4}
                  />
                  <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                    <Button
                      size="small"
                      variant="text"
                      disabled={!editingAnchorTitle.trim() || !editingAnchorText.trim()}
                      onClick={() => {
                        if (!editingAnchorTitle.trim() || !editingAnchorText.trim() || !updateAnchor) return;
                        updateAnchor(anchor, {
                          kind: editingAnchorKind,
                          title: editingAnchorTitle.trim(),
                          text: editingAnchorText.trim(),
                        });
                        setEditingAnchorId(null);
                        setEditingAnchorTitle('');
                        setEditingAnchorText('');
                      }}
                      sx={{ minWidth: 0 }}
                    >
                      保存
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => {
                        setEditingAnchorId(null);
                        setEditingAnchorTitle('');
                        setEditingAnchorText('');
                      }}
                      sx={{ minWidth: 0 }}
                    >
                      取消
                    </Button>
                  </Box>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                  {anchor.text}
                </Typography>
              )}
              {chips.length ? <StatChipRow items={chips} /> : null}
              {developerMode && anchor.evidence ? (
                <Typography variant="caption" color="text.secondary">
                  证据：{anchor.evidence}
                </Typography>
              ) : null}
              {developerMode && anchor.sourceMessageIds?.length ? (
                <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                  来源消息：{anchor.sourceMessageIds.join(' / ')}
                </Typography>
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  ) : null;
}

function CharacterCompanionshipPanel({
  states,
  resolveCharacterName,
  developerMode,
}: {
  states: CharacterCompanionshipState[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
}) {
  return states.length ? (
    <Stack spacing={1}>
      {states.slice(0, developerMode ? 8 : 4).map((state) => {
        const chips = developerMode
          ? [
              `亲近 ${state.closeness}`,
              `护短 ${state.protectiveness}`,
              `依赖 ${state.reliance}`,
            ]
          : [
              state.closeness >= 58 ? '很熟' : state.closeness >= 36 ? '熟悉' : '',
              state.protectiveness >= 58 ? '护短明显' : state.protectiveness >= 36 ? '会在意' : '',
              state.reliance >= 58 ? '很信赖' : state.reliance >= 36 ? '可依赖' : '',
            ].filter(Boolean);
        const textureLines = [
          state.sharedSecrets.length ? `秘密：${state.sharedSecrets.join('、')}` : '',
          state.sharedRituals.length ? `仪式/共同梗：${state.sharedRituals.join('、')}` : '',
          state.sharedPromises.length ? `未完成约定：${state.sharedPromises.join('、')}` : '',
          state.unresolvedCareTopics.length ? `未完成关心：${state.unresolvedCareTopics.join('、')}` : '',
        ].filter(Boolean);
        return (
          <Box key={`${state.actorId}-${state.targetId}`} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Stack spacing={0.65}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>{resolveCharacterName(state.targetId)}</Typography>
                <Chip size="small" label={formatCharacterCompanionshipStyle(state.style)} variant="outlined" />
              </Box>
              {chips.length ? <StatChipRow items={chips} /> : null}
              {textureLines.length ? (
                <Typography variant="caption" color="text.secondary">
                  {textureLines.join('；')}
                </Typography>
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  ) : <Typography variant="caption" color="text.secondary">暂无可投影的角色陪伴关系。关系积累到一定强度后，这里会显示护短、默契、搭档感或带刺关心。</Typography>;
}

function formatPrivateThreadScheduleAction(action: PrivateThreadScheduleDiagnostic['action']) {
  const labels: Record<PrivateThreadScheduleDiagnostic['action'], string> = {
    candidate_created: '候选已记录',
    opened: '已打开私聊',
    suppressed: '被设置抑制',
    skipped: '冷却跳过',
  };
  return labels[action];
}

function formatPrivateThreadReasonType(reasonType?: string) {
  const labels: Record<string, string> = {
    companionship_promise_followup: '约定承接',
    companionship_shared_secret: '小秘密承接',
    companionship_shared_ritual: '共同仪式余波',
    companionship_care_followup: '关心事项',
    companionship_group_mediation: '公开缓和后的私下承接',
  };
  return reasonType ? labels[reasonType] || reasonType : '未标注原因';
}

function PrivateThreadScheduleDiagnosticsPanel({
  items,
  currentCharacterId,
  resolveCharacterName,
}: {
  items: Array<{ chatName: string; diagnostic: PrivateThreadScheduleDiagnostic }>;
  currentCharacterId: string;
  resolveCharacterName: (id: string, fallback?: string) => string;
}) {
  if (!items.length) return null;
  return (
    <Stack spacing={0.75} sx={{ mt: 1.1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
        角色私聊调度诊断
      </Typography>
      {items.slice(0, 8).map(({ chatName, diagnostic }) => {
        const partnerId = diagnostic.participantIds.find((id) => id !== currentCharacterId) || diagnostic.targetId || diagnostic.actorId;
        const chips = [
          formatPrivateThreadScheduleAction(diagnostic.action),
          diagnostic.isCoolingDown ? '冷却中' : '',
          diagnostic.decisionSource ? `来源 ${diagnostic.decisionSource}` : '',
          typeof diagnostic.confidence === 'number' ? `置信 ${Math.round(diagnostic.confidence * 100)}%` : '',
        ].filter(Boolean);
        const lines = [
          diagnostic.triggerReason ? `触发：${diagnostic.triggerReason}` : '',
          diagnostic.openingMessage ? `第一句：${diagnostic.openingMessage}` : '',
          diagnostic.reason ? `状态原因：${diagnostic.reason}` : '',
          diagnostic.nextAvailableAt ? `下次可用：${new Date(diagnostic.nextAvailableAt).toLocaleString()}` : '',
          diagnostic.candidateId ? `候选：${diagnostic.candidateId}` : '',
          diagnostic.privateChatId ? `私聊：${diagnostic.privateChatId}` : '',
        ].filter(Boolean);
        return (
          <Box key={diagnostic.id} sx={{ p: 1, borderRadius: 2, bgcolor: 'background.paper', border: '1px dashed', borderColor: 'divider' }}>
            <Stack spacing={0.55}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {resolveCharacterName(diagnostic.actorId)} → {resolveCharacterName(partnerId)}
                </Typography>
                <Chip size="small" label={formatPrivateThreadReasonType(diagnostic.reasonType)} variant="outlined" />
              </Box>
              <Typography variant="caption" color="text.secondary">
                {chatName} · {new Date(diagnostic.occurredAt).toLocaleString()}
              </Typography>
              <StatChipRow items={chips} />
              {lines.length ? (
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {lines.join('\n')}
                </Typography>
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

function RoleSharedPhrasePanel({
  items,
  characterId,
  participantOptions,
  resolveCharacterName,
  developerMode,
  onUpdateSharedPhrase,
  onSuppressSharedPhrase,
  onKeepCharacterPair,
  onUpdateParticipants,
}: {
  items: Array<{ chat: GroupChat; chatName: string; phrase: SharedPhrase }>;
  characterId: string;
  participantOptions: ParticipantOption[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
  onUpdateSharedPhrase: (chat: GroupChat, phrase: SharedPhrase, patch: { text: string; kind: SharedPhrase['kind']; visibility: SharedPhrase['visibility'] }) => void;
  onSuppressSharedPhrase: (chat: GroupChat, phrase: SharedPhrase) => void;
  onKeepCharacterPair?: (chat: GroupChat, phrase: SharedPhrase, targetId: string) => void;
  onUpdateParticipants?: (chat: GroupChat, phrase: SharedPhrase, participantIds: string[]) => void;
}) {
  const [editingPhraseId, setEditingPhraseId] = useState<string | null>(null);
  const [editingPhraseText, setEditingPhraseText] = useState('');
  const [editingPhraseKind, setEditingPhraseKind] = useState<SharedPhrase['kind']>('other');
  const [editingPhraseVisibility, setEditingPhraseVisibility] = useState<SharedPhrase['visibility']>('between_actors');
  if (!items.length) {
    return null;
  }
  return (
    <Stack spacing={0.85}>
      {items.slice(0, developerMode ? 10 : 6).map(({ chat, chatName, phrase }) => {
        const phraseKey = `${chat.id}-${phrase.id}`;
        const participantNames = phrase.participantIds
          .filter((id) => id !== characterId)
          .map((id) => resolveCharacterName(id))
          .join(' × ');
        const isEditing = editingPhraseId === phraseKey;
        const rolePairTargets = !phrase.participantIds.includes('user') && phrase.participantIds.length > 2
          ? phrase.participantIds.filter((id) => id !== characterId)
          : [];
        return (
          <Box key={phraseKey} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.35 }}>
                  <Chip size="small" label={formatSharedPhraseKindLabel(phrase.kind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                  {participantNames ? <Typography variant="caption" color="text.secondary">{participantNames}</Typography> : null}
                  {developerMode ? (
                    <>
                      <Typography variant="caption" color="text.secondary">{chatName}</Typography>
                      <Typography variant="caption" color="text.secondary">{formatSharedPhraseVisibilityLabel(phrase.visibility)}</Typography>
                      {phrase.reuseCount > 1 ? <Typography variant="caption" color="text.secondary">复用 {phrase.reuseCount}</Typography> : null}
                    </>
                  ) : null}
                </Stack>
                {isEditing ? (
                  <Stack spacing={0.75}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
                      <TextField
                        select
                        size="small"
                        label="类型"
                        value={editingPhraseKind}
                        onChange={(event) => setEditingPhraseKind(event.target.value as SharedPhrase['kind'])}
                        slotProps={{ select: { native: true } }}
                        sx={{ minWidth: { sm: 116 } }}
                      >
                        {(['pet_name', 'inside_joke', 'promise_line', 'comfort_line', 'confession_line', 'secret_code', 'other'] as SharedPhrase['kind'][]).map((kind) => (
                          <option key={kind} value={kind}>{formatSharedPhraseKindLabel(kind)}</option>
                        ))}
                      </TextField>
                      <TextField
                        select
                        size="small"
                        label="可见性"
                        value={editingPhraseVisibility}
                        onChange={(event) => setEditingPhraseVisibility(event.target.value as SharedPhrase['visibility'])}
                        slotProps={{ select: { native: true } }}
                        sx={{ minWidth: { sm: 124 } }}
                      >
                        {(['private', 'between_actors', 'public_hint'] as SharedPhrase['visibility'][]).map((visibility) => (
                          <option key={visibility} value={visibility}>{formatSharedPhraseVisibilityLabel(visibility)}</option>
                        ))}
                      </TextField>
                    </Stack>
                    <TextField
                      size="small"
                      value={editingPhraseText}
                      onChange={(event) => setEditingPhraseText(event.target.value)}
                      fullWidth
                      multiline
                      minRows={1}
                      maxRows={3}
                      autoFocus
                      placeholder="改成更合适的话"
                    />
                  </Stack>
                ) : (
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>「{phrase.text}」</Typography>
                )}
                {developerMode && phrase.evidence ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word', mt: 0.25 }}>
                    证据：{clipRuntimeText(phrase.evidence, 96)}
                  </Typography>
                ) : null}
                {developerMode && phrase.sourceMessageIds?.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all', mt: 0.15 }}>
                    来源消息：{phrase.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
              </Box>
              {isEditing ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingPhraseText.trim() || (editingPhraseText.trim() === phrase.text && editingPhraseKind === phrase.kind && editingPhraseVisibility === phrase.visibility)}
                    onClick={() => {
                      const nextText = editingPhraseText.trim();
                      if (!nextText) return;
                      onUpdateSharedPhrase(chat, phrase, { text: nextText, kind: editingPhraseKind, visibility: editingPhraseVisibility });
                      setEditingPhraseId(null);
                      setEditingPhraseText('');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingPhraseId(null);
                      setEditingPhraseText('');
                      setEditingPhraseKind('other');
                      setEditingPhraseVisibility('between_actors');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    取消
                  </Button>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingPhraseId(phraseKey);
                      setEditingPhraseText(phrase.text);
                      setEditingPhraseKind(phrase.kind);
                      setEditingPhraseVisibility(phrase.visibility);
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    修改
                  </Button>
                  <Button size="small" variant="text" onClick={() => onSuppressSharedPhrase(chat, phrase)} sx={{ minWidth: 0 }}>
                    不再使用
                  </Button>
                  {rolePairTargets.map((targetId) => (
                    <Button key={targetId} size="small" variant="text" onClick={() => onKeepCharacterPair?.(chat, phrase, targetId)} sx={{ minWidth: 0 }}>
                      只保留{resolveCharacterName(targetId)}
                    </Button>
                  ))}
                </Box>
              )}
            </Box>
            {onUpdateParticipants ? (
              <Box sx={{ mt: 0.75 }}>
                <ParticipantEditor
                  selectedIds={phrase.participantIds}
                  options={participantOptions}
                  resolveCharacterName={resolveCharacterName}
                  requiredIds={[characterId]}
                  onSave={(participantIds) => onUpdateParticipants(chat, phrase, participantIds)}
                />
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}

function RoleSharedSecretPanel({
  items,
  characterId,
  participantOptions,
  resolveCharacterName,
  developerMode,
  onUpdateSharedSecretMask,
  onRevokeSharedSecret,
  onKeepCharacterPair,
  onUpdateParticipants,
}: {
  items: Array<{ chat: GroupChat; chatName: string; secret: SharedSecret }>;
  characterId: string;
  participantOptions: ParticipantOption[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
  onUpdateSharedSecretMask: (chat: GroupChat, secret: SharedSecret, publicMask: string) => void;
  onRevokeSharedSecret: (chat: GroupChat, secret: SharedSecret) => void;
  onKeepCharacterPair?: (chat: GroupChat, secret: SharedSecret, targetId: string) => void;
  onUpdateParticipants?: (chat: GroupChat, secret: SharedSecret, participantIds: string[]) => void;
}) {
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [editingSecretMask, setEditingSecretMask] = useState('');
  if (!items.length) {
    return null;
  }
  return (
    <Stack spacing={0.85}>
      {items.slice(0, developerMode ? 10 : 6).map(({ chat, chatName, secret }) => {
        const secretKey = `${chat.id}-${secret.id}`;
        const participantNames = secret.participantIds
          .filter((id) => id !== characterId)
          .map((id) => resolveCharacterName(id))
          .join(' × ');
        const isEditing = editingSecretId === secretKey;
        const rolePairTargets = !secret.participantIds.includes('user') && secret.participantIds.length > 2
          ? secret.participantIds.filter((id) => id !== characterId)
          : [];
        return (
          <Box key={secretKey} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.35 }}>
                  <Chip size="small" label={secret.leakState === 'sealed' ? '保密中' : secret.leakState === 'hinted_publicly' ? '已暗示' : secret.leakState === 'confessed' ? '已坦白' : '已泄露'} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                  {secret.consequenceKind && secret.consequenceKind !== 'none' ? <Chip size="small" label={formatSharedSecretConsequenceLabel(secret.consequenceKind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} /> : null}
                  {participantNames ? <Typography variant="caption" color="text.secondary">{participantNames}</Typography> : null}
                  {developerMode ? (
                    <>
                      <Typography variant="caption" color="text.secondary">{chatName}</Typography>
                      <Typography variant="caption" color="text.secondary">权重 {secret.emotionalWeight}</Typography>
                    </>
                  ) : null}
                </Stack>
                {isEditing ? (
                  <TextField
                    size="small"
                    value={editingSecretMask}
                    onChange={(event) => setEditingSecretMask(event.target.value)}
                    fullWidth
                    multiline
                    minRows={1}
                    maxRows={3}
                    autoFocus
                    placeholder="公开场合能看到的模糊说法"
                  />
                ) : (
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{secret.publicMask}</Typography>
                )}
                {developerMode ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    参与者：{secret.participantIds.map((id) => resolveCharacterName(id)).join(' × ')}
                  </Typography>
                ) : null}
                {developerMode && secret.sourceMessageIds?.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all', mt: 0.15 }}>
                    来源消息：{secret.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
              </Box>
              {isEditing ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingSecretMask.trim() || editingSecretMask.trim() === secret.publicMask}
                    onClick={() => {
                      const nextMask = editingSecretMask.trim();
                      if (!nextMask || nextMask === secret.publicMask) return;
                      onUpdateSharedSecretMask(chat, secret, nextMask);
                      setEditingSecretId(null);
                      setEditingSecretMask('');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingSecretId(null);
                      setEditingSecretMask('');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    取消
                  </Button>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingSecretId(secretKey);
                      setEditingSecretMask(secret.publicMask);
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    修改描述
                  </Button>
                  <Button size="small" variant="text" onClick={() => onRevokeSharedSecret(chat, secret)} sx={{ minWidth: 0 }}>
                    撤回
                  </Button>
                  {rolePairTargets.map((targetId) => (
                    <Button key={targetId} size="small" variant="text" onClick={() => onKeepCharacterPair?.(chat, secret, targetId)} sx={{ minWidth: 0 }}>
                      只保留{resolveCharacterName(targetId)}
                    </Button>
                  ))}
                </Box>
              )}
            </Box>
            {onUpdateParticipants ? (
              <Box sx={{ mt: 0.75 }}>
                <ParticipantEditor
                  selectedIds={secret.participantIds}
                  options={participantOptions}
                  resolveCharacterName={resolveCharacterName}
                  requiredIds={[characterId]}
                  onSave={(participantIds) => onUpdateParticipants(chat, secret, participantIds)}
                />
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}

function RoleRitualPanel({
  items,
  characterId,
  resolveCharacterName,
  developerMode,
  onUpdateRitual,
  onSuppressRitual,
  onRestoreRitual,
}: {
  items: Array<{ chat: GroupChat; chatName: string; ritual: RitualRegistryEntry }>;
  characterId: string;
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
  onUpdateRitual: (chat: GroupChat, ritual: RitualRegistryEntry, content: string) => void;
  onSuppressRitual: (chat: GroupChat, ritual: RitualRegistryEntry) => void;
  onRestoreRitual: (chat: GroupChat, ritual: RitualRegistryEntry) => void;
}) {
  const [editingRitualId, setEditingRitualId] = useState<string | null>(null);
  const [editingRitualContent, setEditingRitualContent] = useState('');
  if (!items.length) {
    return null;
  }
  return (
    <Stack spacing={0.85}>
      {items.slice(0, developerMode ? 10 : 6).map(({ chat, chatName, ritual }) => {
        const ritualKey = `${chat.id}-${ritual.id}`;
        const participantNames = ritual.participantIds
          .filter((id) => id !== characterId)
          .map((id) => resolveCharacterName(id))
          .join(' × ');
        const isEditing = editingRitualId === ritualKey;
        return (
          <Box key={ritualKey} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.35 }}>
                  <Chip size="small" label={formatRitualKindLabel(ritual.kind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                  <Typography variant="caption" color={ritual.executionState === 'suppressed' ? 'warning.main' : 'text.secondary'}>
                    {formatRitualExecutionLabel(ritual.executionState)}
                  </Typography>
                  {participantNames ? <Typography variant="caption" color="text.secondary">{participantNames}</Typography> : null}
                  {developerMode ? (
                    <>
                      <Typography variant="caption" color="text.secondary">{chatName}</Typography>
                      {ritual.nextAvailableAt ? <Typography variant="caption" color="text.secondary">下次 {new Date(ritual.nextAvailableAt).toLocaleString()}</Typography> : null}
                    </>
                  ) : null}
                </Stack>
                {isEditing ? (
                  <TextField
                    size="small"
                    value={editingRitualContent}
                    onChange={(event) => setEditingRitualContent(event.target.value)}
                    fullWidth
                    multiline
                    minRows={1}
                    maxRows={3}
                    autoFocus
                    placeholder="改成更合适的仪式内容"
                  />
                ) : (
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{ritual.content}</Typography>
                )}
                {developerMode && ritual.boundaryReasons.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word', mt: 0.25 }}>
                    边界：{ritual.boundaryReasons.slice(0, 2).join(' / ')}
                  </Typography>
                ) : null}
                {developerMode && ritual.sourceMessageIds?.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all', mt: 0.15 }}>
                    来源消息：{ritual.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
              </Box>
              {isEditing ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingRitualContent.trim() || editingRitualContent.trim() === ritual.content}
                    onClick={() => {
                      const nextContent = editingRitualContent.trim();
                      if (!nextContent || nextContent === ritual.content) return;
                      onUpdateRitual(chat, ritual, nextContent);
                      setEditingRitualId(null);
                      setEditingRitualContent('');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingRitualId(null);
                      setEditingRitualContent('');
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    取消
                  </Button>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => {
                      setEditingRitualId(ritualKey);
                      setEditingRitualContent(ritual.content);
                    }}
                    sx={{ minWidth: 0 }}
                  >
                    修改
                  </Button>
                  {ritual.executionState === 'suppressed' ? (
                    <Button size="small" variant="text" onClick={() => onRestoreRitual(chat, ritual)} sx={{ minWidth: 0 }}>
                      恢复
                    </Button>
                  ) : (
                    <Button size="small" variant="text" onClick={() => onSuppressRitual(chat, ritual)} sx={{ minWidth: 0 }}>
                      不再使用
                    </Button>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
}

function CompanionshipDeveloperTracePanel({
  trace,
  onDisableAttachment,
  onEnableAttachment,
  onCorrectAttachment,
  onRestoreAttachment,
  onRestoreAddress,
  onRestoreConflict,
  onRestorePhase,
  onRestoreUserProfile,
  onRestoreCareTopic,
  onRestorePromise,
  onRestoreSharedAnchor,
  onRestoreSharedSecretPublic,
  onRestoreSharedPhrase,
  onRestoreRitualFromHistory,
}: {
  trace: CompanionshipRuntimeTrace | null | undefined;
  onDisableAttachment?: () => void;
  onEnableAttachment?: () => void;
  onCorrectAttachment?: (style: UserAttachmentProfile['inferredStyle']) => void;
  onRestoreAttachment?: (item: AttachmentProfileHistoryEntry) => void;
  onRestoreAddress?: (action: ManualAddressingSetAction, address: string) => void;
  onRestoreConflict?: (item: IntimateConflictHistoryEntry) => void;
  onRestorePhase?: (item: PhaseHistoryEntry) => void;
  onRestoreUserProfile?: (item: UserProfileMemoryHistoryEntry) => void;
  onRestoreCareTopic?: (item: CareTopicHistoryEntry) => void;
  onRestorePromise?: (item: PromiseHistoryEntry) => void;
  onRestoreSharedAnchor?: (item: SharedAnchorHistoryEntry) => void;
  onRestoreSharedSecretPublic?: (item: SharedSecretHistoryEntry) => void;
  onRestoreSharedPhrase?: (item: SharedPhraseHistoryEntry) => void;
  onRestoreRitualFromHistory?: (item: RitualHistoryEntry) => void;
}) {
  if (!trace) return null;
  const intimacyItems = [
    ['吸引', trace.intimacy.attraction],
    ['亲密', trace.intimacy.intimacy],
    ['依恋', trace.intimacy.attachment],
    ['想念', trace.intimacy.longing],
    ['安全', trace.intimacy.security],
  ] as const;
  const policyItems = [
    `主动预算 ${trace.carePolicy.dailyInitiationBudget}/天`,
    `触发敏感 ${trace.carePolicy.triggerSensitivity}`,
    `沉默阈值 ${trace.carePolicy.silenceAnxietyThresholdHours}h`,
    `表达强度 ${trace.carePolicy.expressionIntensity}`,
    trace.carePolicy.allowMissYou ? '允许想念表达' : '禁用想念表达',
  ];
  const phaseHistory = trace.phaseHistory.slice(0, 6);
  const userProfileHistory = trace.userProfileHistory.slice(0, 6);
  const addressingHistory = trace.addressingHistory.slice(0, 6);
  const careTopicHistory = trace.careTopicHistory.slice(0, 6);
  const promiseHistory = trace.promiseHistory.slice(0, 6);
  const sharedAnchorHistory = trace.sharedAnchorHistory.slice(0, 6);
  const sharedSecretHistory = trace.sharedSecretHistory.slice(0, 6);
  const sharedPhraseHistory = trace.sharedPhraseHistory.slice(0, 6);
  const ritualHistory = trace.ritualHistory.slice(0, 6);
  const conflictHistory = trace.conflictHistory.slice(0, 6);
  const attachmentHistory = trace.attachmentHistory.slice(0, 6);
  return (
    <Stack spacing={1}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 0.75 }}>
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>阶段/风格</Typography>
          <Typography variant="body2">{trace.phase} · {trace.style}</Typography>
        </Box>
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>画像置信</Typography>
          <Typography variant="body2">{trace.userProfileConfidence}%</Typography>
        </Box>
      </Box>
      {phaseHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>阶段历史</Typography>
          <Stack spacing={0.5}>
            {phaseHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatPhaseHistoryActionLabel(item.action)} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.phase ? `${formatCompanionshipPhaseLabel(item.phase)} · ${item.style ? formatCompanionshipStyleLabel(item.style) : '自动风格'}` : '自动判断'}
                  </Typography>
                </Box>
                {item.reason ? <Typography variant="body2" sx={{ mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {typeof item.confidence === 'number' || item.decisionSource ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                ) : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestorePhase && item.phase ? (
                  <Button size="small" variant="text" onClick={() => onRestorePhase(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复此阶段
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {userProfileHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>画像历史</Typography>
          <Stack spacing={0.5}>
            {userProfileHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatUserProfileMemoryActionLabel(item.action)} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                {item.reason ? <Typography variant="body2" sx={{ mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.45 }}>
                  {item.items.map((profileItem, index) => (
                    <Chip
                      key={`${profileItem.kind}-${profileItem.text}-${index}`}
                      size="small"
                      variant="outlined"
                      label={`${formatUserProfileMemoryKindLabel(profileItem.kind)}：${profileItem.text}${profileItem.sensitive ? ' · 敏感' : ''}`}
                      sx={{ maxWidth: '100%', height: 22, borderRadius: 999, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                    />
                  ))}
                </Stack>
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreUserProfile && item.items.length ? (
                  <Button size="small" variant="text" onClick={() => onRestoreUserProfile(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复这些线索
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {addressingHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>称呼历史</Typography>
          <Stack spacing={0.5}>
            {addressingHistory.map((item) => {
              const labels = [
                item.currentAddress ? `当前：${item.currentAddress}` : '',
                item.privateAddress ? `私下：${item.privateAddress}` : '',
                item.publicAddress ? `公开：${item.publicAddress}` : '',
                item.forbiddenAddresses.length ? `禁用：${item.forbiddenAddresses.join('、')}` : '',
              ].filter(Boolean);
              return (
                <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary">
                      {formatAddressingActionLabel(item.action)} · {new Date(item.occurredAt).toLocaleString()}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {[item.initiatedBy ? `发起 ${item.initiatedBy}` : '', item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : ''].filter(Boolean).join(' · ')}
                    </Typography>
                  </Box>
                  {labels.length ? (
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.45 }}>
                      {labels.map((label) => (
                        <Chip key={label} size="small" variant="outlined" label={label} sx={{ height: 22, borderRadius: 999 }} />
                      ))}
                    </Stack>
                  ) : null}
                  {onRestoreAddress && (item.currentAddress || item.privateAddress || item.publicAddress) ? (
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.55 }}>
                      {item.currentAddress ? (
                        <Button size="small" variant="text" onClick={() => onRestoreAddress('set_current', item.currentAddress || '')} sx={{ minWidth: 0, p: 0 }}>
                          恢复当前
                        </Button>
                      ) : null}
                      {item.privateAddress ? (
                        <Button size="small" variant="text" onClick={() => onRestoreAddress('set_private', item.privateAddress || '')} sx={{ minWidth: 0, p: 0 }}>
                          恢复私下
                        </Button>
                      ) : null}
                      {item.publicAddress ? (
                        <Button size="small" variant="text" onClick={() => onRestoreAddress('set_public', item.publicAddress || '')} sx={{ minWidth: 0, p: 0 }}>
                          恢复公开
                        </Button>
                      ) : null}
                    </Stack>
                  ) : null}
                  {item.reason ? <Typography variant="body2" sx={{ mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                  {item.evidence.length ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                      证据：{formatRuntimeEvidence(item.evidence)}
                    </Typography>
                  ) : null}
                  {item.sourceMessageIds?.length ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15, wordBreak: 'break-all' }}>
                      来源消息：{item.sourceMessageIds.join(' / ')}
                    </Typography>
                  ) : null}
                </Box>
              );
            })}
          </Stack>
        </Box>
      ) : null}
      <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>亲密投影</Typography>
        <Stack spacing={0.65}>
          {intimacyItems.map(([label, value]) => (
            <Box key={label} sx={{ display: 'grid', gridTemplateColumns: '44px 1fr 36px', alignItems: 'center', gap: 0.75 }}>
              <Typography variant="caption" color="text.secondary">{label}</Typography>
              <LinearProgress variant="determinate" value={value} sx={{ height: 6, borderRadius: 999 }} />
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>{value}</Typography>
            </Box>
          ))}
        </Stack>
      </Box>
      <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>主动策略</Typography>
        <StatChipRow items={policyItems} />
        {trace.boundaryReasons.length ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.65 }}>
            克制：{formatRuntimeEvidence(trace.boundaryReasons, '有一条私域克制原因已隐藏原文')}
          </Typography>
        ) : null}
      </Box>
      {trace.pendingCareTopics.length || trace.pendingPromises.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>未完成事项</Typography>
          {trace.pendingCareTopics.length ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              关心事项：{formatRuntimeEvidence(trace.pendingCareTopics, '有一条私域关心事项已隐藏原文')}
            </Typography>
          ) : null}
          {trace.pendingPromises.length ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              约定：{formatRuntimeEvidence(trace.pendingPromises, '有一条私域约定已隐藏原文')}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {careTopicHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>关心历史</Typography>
          <Stack spacing={0.5}>
            {careTopicHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatCareTopicActionLabel(item.action)} · {item.urgency} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : '', item.dueAt ? `到期 ${new Date(item.dueAt).toLocaleString()}` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.topicText, '有一条私域关心事项已隐藏原文')}</Typography>
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreCareTopic && item.action !== 'opened' ? (
                  <Button size="small" variant="text" onClick={() => onRestoreCareTopic(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复追踪
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {promiseHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>约定历史</Typography>
          <Stack spacing={0.5}>
            {promiseHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatPromiseActionLabel(item.action)} · {item.promiseKind ? formatPendingPromiseKind(item.promiseKind) : '约定'} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : '', item.dueAt ? `到期 ${new Date(item.dueAt).toLocaleString()}` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.promiseText, '有一条私域约定已隐藏原文')}</Typography>
                {item.supersedesText ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    替换旧约定：{safeRuntimePrivateText(item.supersedesText, '有一条私域旧约定已隐藏原文')}
                  </Typography>
                ) : null}
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestorePromise && item.action !== 'opened' ? (
                  <Button size="small" variant="text" onClick={() => onRestorePromise(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复为未完成约定
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {sharedAnchorHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>共同锚点历史</Typography>
          <Stack spacing={0.5}>
            {sharedAnchorHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatSharedAnchorActionLabel(item.action)} · {item.kind ? formatSharedMemoryAnchorKind(item.kind) : '共同锚点'} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : '', typeof item.salience === 'number' ? `显著 ${Math.round(item.salience)}` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                {item.title ? <Typography variant="body2" sx={{ mt: 0.25, fontWeight: 700, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.title, '有一条私域共同锚点标题已隐藏原文')}</Typography> : null}
                <Typography variant="body2" sx={{ mt: item.title ? 0 : 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.text, '有一条私域共同锚点已隐藏原文')}</Typography>
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.mergedAnchorIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    合并/压制：{item.mergedAnchorIds.join(' / ')}
                  </Typography>
                ) : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreSharedAnchor && (item.action === 'archive' || item.action === 'revoke') ? (
                  <Button size="small" variant="text" onClick={() => onRestoreSharedAnchor(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复此锚点
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {sharedSecretHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>小秘密历史</Typography>
          <Stack spacing={0.5}>
            {sharedSecretHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatSharedSecretActionLabel(item.action)} · {item.leakState === 'sealed' ? '保密中' : item.leakState === 'hinted_publicly' ? '已暗示' : item.leakState === 'confessed' ? '已坦白' : '已泄露'} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.consequenceKind ? formatSharedSecretConsequenceLabel(item.consequenceKind) : '', item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : '', typeof item.emotionalWeight === 'number' ? `权重 ${Math.round(item.emotionalWeight)}` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.publicMask, '有一条小秘密公开遮罩已隐藏原文')}</Typography>
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreSharedSecretPublic && item.action === 'revoked' ? (
                  <Button size="small" variant="text" onClick={() => onRestoreSharedSecretPublic(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复公开边界
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {ritualHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>仪式历史</Typography>
          <Stack spacing={0.5}>
            {ritualHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatRitualActionLabel(item.action)} · {formatRitualKindLabel(item.kind)} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : '', item.nextAvailableAt ? `下次 ${new Date(item.nextAvailableAt).toLocaleString()}` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                {item.content ? <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.content, '有一条私域仪式内容已隐藏原文')}</Typography> : null}
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.evolution.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    演化：{formatRuntimeEvidence(item.evolution, '有一条私域仪式演化已隐藏原文')}
                  </Typography>
                ) : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreRitualFromHistory && item.content && item.action !== 'suppressed' ? (
                  <Button size="small" variant="text" onClick={() => onRestoreRitualFromHistory(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复此内容
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {sharedPhraseHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>共同话语历史</Typography>
          <Stack spacing={0.5}>
            {sharedPhraseHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatSharedPhraseActionLabel(item.action)} · {item.kind ? formatSharedPhraseKindLabel(item.kind) : '共同话语'} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {[item.visibility ? formatSharedPhraseVisibilityLabel(item.visibility) : '', item.decisionSource ? `来源 ${item.decisionSource}` : '', typeof item.confidence === 'number' ? `置信 ${Math.round(item.confidence <= 1 ? item.confidence * 100 : item.confidence)}%` : ''].filter(Boolean).join(' · ')}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.text, '有一句私域共同话语已隐藏原文')}</Typography>
                {item.reason ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreSharedPhrase && item.action !== 'revoked' ? (
                  <Button size="small" variant="text" onClick={() => onRestoreSharedPhrase(item)} sx={{ mt: 0.4, p: 0, minWidth: 0 }}>
                    恢复此话语
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {trace.attachmentProfile ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 0.65 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>依恋适配</Typography>
            {trace.attachmentProfile.confidence <= 0 ? (
              <Button size="small" variant="text" onClick={onEnableAttachment} sx={{ p: 0, minWidth: 0 }}>
                恢复适配
              </Button>
            ) : (
              <Button size="small" variant="text" onClick={onDisableAttachment} sx={{ p: 0, minWidth: 0 }}>
                关闭适配
              </Button>
            )}
          </Box>
          <StatChipRow items={[formatAttachmentStyleLabel(trace.attachmentProfile.inferredStyle), `置信 ${trace.attachmentProfile.confidence}%`, ...trace.attachmentProfile.adaptations]} />
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.65 }}>
            {(['secure', 'anxious', 'avoidant', 'disorganized'] as UserAttachmentProfile['inferredStyle'][]).map((style) => (
              <Button
                key={style}
                size="small"
                variant={trace.attachmentProfile?.inferredStyle === style && (trace.attachmentProfile?.confidence || 0) >= 100 ? 'contained' : 'outlined'}
                onClick={() => onCorrectAttachment?.(style)}
                sx={{ minHeight: 24, px: 1, py: 0.1, borderRadius: 999, fontSize: 12 }}
              >
                {formatAttachmentStyleLabel(style)}
              </Button>
            ))}
          </Stack>
          {trace.attachmentProfile.evidence.length ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.65 }}>
              证据：{formatRuntimeEvidence(trace.attachmentProfile.evidence)}
            </Typography>
          ) : null}
        </Box>
      ) : null}
      {trace.intimateConflict ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'warning.main', color: 'warning.contrastText' }}>
          <Typography variant="caption" sx={{ display: 'block', opacity: 0.78 }}>亲密冲突/修复</Typography>
          <Typography variant="body2">{safeRuntimePrivateText(trace.intimateConflict.summary, '有一条私域冲突摘要已隐藏原文')}</Typography>
          <Typography variant="caption" sx={{ display: 'block', opacity: 0.78 }}>
            {trace.intimateConflict.kind} · 强度 {trace.intimateConflict.severity} · 修复成熟度 {trace.intimateConflict.repairReadiness}
          </Typography>
        </Box>
      ) : null}
      {conflictHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>冲突历史</Typography>
          <Stack spacing={0.5}>
            {conflictHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatIntimateConflictActionLabel(item.action)} · {item.kind} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.severity}/{item.repairReadiness}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ mt: 0.25 }}>{safeRuntimePrivateText(item.summary, '有一条私域冲突摘要已隐藏原文')}</Typography>
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
                {onRestoreConflict && item.action !== 'dismissed' ? (
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => onRestoreConflict(item)}
                    sx={{ mt: 0.4, p: 0, minWidth: 0 }}
                  >
                    恢复为当前状态
                  </Button>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {attachmentHistory.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>互动节奏历史</Typography>
          <Stack spacing={0.5}>
            {attachmentHistory.map((item) => (
              <Box key={item.id} sx={{ p: 0.75, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formatAttachmentActionLabel(item.action)} · {new Date(item.occurredAt).toLocaleString()}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {item.inferredStyle ? formatAttachmentStyleLabel(item.inferredStyle) : '无类型'}
                  </Typography>
                </Box>
                {item.reason ? <Typography variant="body2" sx={{ mt: 0.25 }}>{safeRuntimePrivateText(item.reason)}</Typography> : null}
                {onRestoreAttachment && item.inferredStyle ? (
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => onRestoreAttachment(item)}
                    sx={{ minWidth: 0, p: 0, mt: 0.35 }}
                  >
                    恢复此节奏
                  </Button>
                ) : null}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  置信 {item.confidence}%
                </Typography>
                {item.evidence.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    证据：{formatRuntimeEvidence(item.evidence)}
                  </Typography>
                ) : null}
                {item.sourceMessageIds?.length ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.15, wordBreak: 'break-all' }}>
                    来源消息：{item.sourceMessageIds.join(' / ')}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Stack>
        </Box>
      ) : null}
      {trace.diagnostics.length ? (
        <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'error.main', color: 'error.contrastText' }}>
          <Typography variant="caption" sx={{ display: 'block', opacity: 0.78 }}>运行诊断</Typography>
          {trace.diagnostics.map((item) => (
            <Typography key={item} variant="caption" sx={{ display: 'block', fontFamily: 'monospace', wordBreak: 'break-word' }}>
              {item}
            </Typography>
          ))}
        </Box>
      ) : null}
    </Stack>
  );
}

function formatCompanionshipPhaseLabel(phase: CompanionshipRuntimeTrace['phase']) {
  const labels: Record<CompanionshipRuntimeTrace['phase'], string> = {
    stranger: '陌生',
    curious: '好奇',
    fond: '好感',
    ambiguous: '暧昧',
    confessing: '确认前',
    confirmed: '已确认',
    passionate: '热恋',
    deep: '深层陪伴',
    cooling: '降温',
    crisis: '危机',
    reconciling: '修复中',
  };
  return labels[phase] || phase;
}

function formatCompanionshipStyleLabel(style: CompanionshipRuntimeTrace['style']) {
  const labels: Record<CompanionshipRuntimeTrace['style'], string> = {
    friend: '朋友',
    family: '家人式',
    mentor: '照看/引导',
    ambiguous: '暧昧',
    romantic: '亲密',
    custom: '自定义',
  };
  return labels[style] || style;
}

function formatPhaseHistoryActionLabel(action: PhaseHistoryEntry['action']) {
  if (action === 'revoked') return '恢复自动判断';
  if (action === 'inferred') return '自动推断';
  return '阶段修正';
}

function formatSharedPhraseKindLabel(kind: SharedPhrase['kind']) {
  const labels: Record<SharedPhrase['kind'], string> = {
    pet_name: '专属称呼',
    inside_joke: '共同话',
    promise_line: '约定话语',
    comfort_line: '安慰话语',
    confession_line: '心意话语',
    secret_code: '秘密暗号',
    other: '共同话语',
  };
  return labels[kind] || kind;
}

function formatSharedPhraseVisibilityLabel(visibility: SharedPhrase['visibility']) {
  const labels: Record<SharedPhrase['visibility'], string> = {
    private: '私密',
    between_actors: '两人可用',
    public_hint: '公开可暗示',
  };
  return labels[visibility] || visibility;
}

function formatSharedPhraseActionLabel(action: SharedPhraseHistoryEntry['action']) {
  const labels: Record<SharedPhraseHistoryEntry['action'], string> = {
    upsert: '写入/修正',
    reused: '复用强化',
    suppressed: '停用',
    revoked: '撤回',
  };
  return labels[action] || action;
}

function formatSharedAnchorActionLabel(action: CompanionshipRuntimeTrace['sharedAnchorHistory'][number]['action']) {
  const labels: Record<CompanionshipRuntimeTrace['sharedAnchorHistory'][number]['action'], string> = {
    upsert: '写入/修正',
    merge: '合并',
    archive: '归档',
    revoke: '撤回',
  };
  return labels[action] || action;
}

function formatSharedSecretActionLabel(action: CompanionshipRuntimeTrace['sharedSecretHistory'][number]['action']) {
  const labels: Record<CompanionshipRuntimeTrace['sharedSecretHistory'][number]['action'], string> = {
    recorded: '记录',
    hinted_publicly: '公开暗示',
    leaked: '泄露',
    confessed: '坦白',
    revoked: '撤回',
  };
  return labels[action] || action;
}

const PHASE_CORRECTION_OPTIONS: Array<{ label: string; phase: CompanionshipPhase; style: CompanionshipStyle }> = [
  { label: '朋友', phase: 'fond', style: 'friend' },
  { label: '暧昧', phase: 'ambiguous', style: 'ambiguous' },
  { label: '已确认', phase: 'confirmed', style: 'romantic' },
  { label: '降温', phase: 'cooling', style: 'friend' },
  { label: '修复中', phase: 'reconciling', style: 'friend' },
  { label: '危机', phase: 'crisis', style: 'friend' },
];

function isSameCompanionshipPhaseCorrection(trace: CompanionshipRuntimeTrace | null, option: { phase: CompanionshipPhase; style: CompanionshipStyle }) {
  return Boolean(trace && trace.phase === option.phase && trace.style === option.style);
}

function formatSharedSecretConsequenceLabel(kind: SharedSecret['consequenceKind']) {
  const labels: Record<NonNullable<SharedSecret['consequenceKind']>, string> = {
    none: '未细分',
    misunderstanding: '误会',
    accidental_leak: '无意说漏',
    intentional_breach: '主动越界',
    protective_confession: '保护性坦白',
    voluntary_confession: '主动坦白',
  };
  return labels[kind || 'none'];
}

function sharedSecretConsequenceOptions(secret: SharedSecret): NonNullable<SharedSecret['consequenceKind']>[] {
  if (secret.leakState === 'leaked') return ['misunderstanding', 'accidental_leak', 'intentional_breach'];
  if (secret.leakState === 'confessed') return ['protective_confession', 'voluntary_confession'];
  return ['none'];
}

function formatRitualKindLabel(kind: RitualRegistryEntry['kind']) {
  const labels: Record<RitualRegistryEntry['kind'], string> = {
    daily_greeting: '日常问候',
    anniversary: '纪念日',
    inside_joke: '共同梗',
    pet_name: '专属称呼',
    reconciliation: '和好仪式',
    milestone: '关系里程碑',
  };
  return labels[kind];
}

function formatRitualExecutionLabel(state: RitualRegistryEntry['executionState'] | undefined) {
  if (state === 'cooldown') return '冷却中';
  if (state === 'suppressed') return '已抑制';
  return '可用';
}

function UserCompanionshipCard({
  characterId,
  chatName,
  signature,
  trace,
  participantOptions,
  resolveCharacterName,
  pendingCareTopics,
  pendingPromises,
  sharedPhrases,
  sharedSecrets,
  rituals,
  onBlockCareTopic,
  onUpdatePromiseLifecycle,
  onUpdatePromise,
  onMergePromise,
  onSetAddress,
  onForbidAddress,
  onUnforbidAddress,
  onResolveConflict,
  onDismissConflict,
  onDisableAttachment,
  onEnableAttachment,
  onCorrectAttachment,
  onRestoreAttachment,
  onRestoreConflict,
  onRestorePhase,
  onRestoreUserProfile,
  onRestoreCareTopic,
  onRestorePromise,
  onRestoreSharedAnchor,
  onRestoreSharedSecretPublic,
  onRestoreSharedPhrase,
  onRestoreRitualFromHistory,
  onUpdateProfileCue,
  onRevokeProfileCue,
  onRevokeSharedSecret,
  onUpdateSharedSecretMask,
  onCorrectSharedSecretConsequence,
  onKeepSharedSecretPairPrivate,
  onUpdateSharedSecretParticipants,
  onUpdateSharedPhrase,
  onSuppressSharedPhrase,
  onKeepSharedPhrasePairPrivate,
  onUpdateSharedPhraseParticipants,
  onUpdateRitual,
  onSuppressRitual,
  onRestoreRitual,
  onCorrectPhase,
  onRevokePhase,
  developerMode,
}: {
  characterId: string;
  chatName: string;
  signature: NonNullable<ReturnType<typeof buildCompanionshipStatusSignature>>;
  trace: CompanionshipRuntimeTrace | null;
  participantOptions: ParticipantOption[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  pendingCareTopics: PendingCareTopic[];
  pendingPromises: PendingPromise[];
  sharedPhrases: SharedPhrase[];
  sharedSecrets: SharedSecret[];
  rituals: RitualRegistryEntry[];
  onBlockCareTopic: (topic: PendingCareTopic) => void;
  onUpdatePromiseLifecycle: (promise: PendingPromise, action: ManualPromiseLifecycleAction) => void;
  onUpdatePromise: (promise: PendingPromise, patch: { text: string; kind: PendingPromise['kind'] }) => void;
  onMergePromise: (promise: PendingPromise, target: PromiseMergeTarget) => void;
  onSetAddress: (action: ManualAddressingSetAction, address: string) => void;
  onForbidAddress: (address: string) => void;
  onUnforbidAddress: (address: string) => void;
  onResolveConflict: (conflict: NonNullable<CompanionshipRuntimeTrace['intimateConflict']>) => void;
  onDismissConflict: (conflict: NonNullable<CompanionshipRuntimeTrace['intimateConflict']>) => void;
  onDisableAttachment: () => void;
  onEnableAttachment: () => void;
  onCorrectAttachment: (style: UserAttachmentProfile['inferredStyle']) => void;
  onRestoreAttachment: (item: AttachmentProfileHistoryEntry) => void;
  onRestoreConflict: (item: IntimateConflictHistoryEntry) => void;
  onRestorePhase: (item: PhaseHistoryEntry) => void;
  onRestoreUserProfile: (item: UserProfileMemoryHistoryEntry) => void;
  onRestoreCareTopic: (item: CareTopicHistoryEntry) => void;
  onRestorePromise: (item: PromiseHistoryEntry) => void;
  onRestoreSharedAnchor: (item: SharedAnchorHistoryEntry) => void;
  onRestoreSharedSecretPublic: (item: SharedSecretHistoryEntry) => void;
  onRestoreSharedPhrase: (item: SharedPhraseHistoryEntry) => void;
  onRestoreRitualFromHistory: (item: RitualHistoryEntry) => void;
  onUpdateProfileCue: (item: UserProfileMemoryEventItem) => void;
  onRevokeProfileCue: (item: UserProfileMemoryEventItem) => void;
  onRevokeSharedSecret: (secret: SharedSecret) => void;
  onUpdateSharedSecretMask: (secret: SharedSecret, publicMask: string) => void;
  onCorrectSharedSecretConsequence: (secret: SharedSecret, consequenceKind: NonNullable<SharedSecret['consequenceKind']>) => void;
  onKeepSharedSecretPairPrivate: (secret: SharedSecret) => void;
  onUpdateSharedSecretParticipants: (secret: SharedSecret, participantIds: string[]) => void;
  onUpdateSharedPhrase: (phrase: SharedPhrase, patch: { text: string; kind: SharedPhrase['kind']; visibility: SharedPhrase['visibility'] }) => void;
  onSuppressSharedPhrase: (phrase: SharedPhrase) => void;
  onKeepSharedPhrasePairPrivate: (phrase: SharedPhrase) => void;
  onUpdateSharedPhraseParticipants: (phrase: SharedPhrase, participantIds: string[]) => void;
  onUpdateRitual: (ritual: RitualRegistryEntry, content: string) => void;
  onSuppressRitual: (ritual: RitualRegistryEntry) => void;
  onRestoreRitual: (ritual: RitualRegistryEntry) => void;
  onCorrectPhase: (phase: CompanionshipPhase, style: CompanionshipStyle) => void;
  onRevokePhase: () => void;
  developerMode: boolean;
}) {
  const [editingPhraseId, setEditingPhraseId] = useState<string | null>(null);
  const [editingPhraseText, setEditingPhraseText] = useState('');
  const [editingPhraseKind, setEditingPhraseKind] = useState<SharedPhrase['kind']>('other');
  const [editingPhraseVisibility, setEditingPhraseVisibility] = useState<SharedPhrase['visibility']>('between_actors');
  const [editingAddressAction, setEditingAddressAction] = useState<ManualAddressingSetAction | null>(null);
  const [editingAddressText, setEditingAddressText] = useState('');
  const [editingProfileCueKey, setEditingProfileCueKey] = useState<string | null>(null);
  const [editingProfileCueKind, setEditingProfileCueKind] = useState<UserProfileMemoryKind>('preference');
  const [editingProfileCueText, setEditingProfileCueText] = useState('');
  const [editingProfileCueSensitive, setEditingProfileCueSensitive] = useState(false);
  const [editingPromiseId, setEditingPromiseId] = useState<string | null>(null);
  const [editingPromiseText, setEditingPromiseText] = useState('');
  const [editingPromiseKind, setEditingPromiseKind] = useState<PendingPromise['kind']>('other');
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [editingSecretMask, setEditingSecretMask] = useState('');
  const [editingRitualId, setEditingRitualId] = useState<string | null>(null);
  const [editingRitualContent, setEditingRitualContent] = useState('');
  const headlineChips = [
    trace ? formatCompanionshipPhaseLabel(trace.phase) : '',
    trace ? formatCompanionshipStyleLabel(trace.style) : '',
    signature.addressing?.currentAddress ? `称呼 ${signature.addressing.currentAddress}` : '',
    trace?.pendingCareTopics.length ? `关心 ${trace.pendingCareTopics.length}` : '',
    trace?.pendingPromises.length ? `约定 ${trace.pendingPromises.length}` : '',
    trace?.boundaries.length || trace?.boundaryReasons.length ? '有边界' : '',
  ].filter(Boolean);
  const visibleLines = [
    trace?.sharedAnchors.length ? `共同锚点：${trace.sharedAnchors.slice(0, 2).join(' / ')}` : '',
    trace?.sharedPhrases.length ? `共同话语：${trace.sharedPhrases.slice(0, 2).join(' / ')}` : '',
    trace?.sharedSecrets.length ? `小秘密：${trace.sharedSecrets.slice(0, 2).join(' / ')}` : '',
    trace?.rituals.length ? `仪式：${trace.rituals.slice(0, 2).join(' / ')}` : '',
    trace?.boundaries.length ? `用户边界：${trace.boundaries.slice(0, 2).join(' / ')}` : '',
  ].filter(Boolean);
  return (
    <Box sx={{ p: { xs: 1.15, sm: 1.35 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.16)' }}>
      <Stack spacing={1}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>{chatName}</Typography>
            <Typography variant="caption" color="text.secondary">
              {trace ? `${formatCompanionshipPhaseLabel(trace.phase)} · ${formatCompanionshipStyleLabel(trace.style)} · 画像置信 ${trace.userProfileConfidence}%` : '最近单聊投影'}
            </Typography>
          </Box>
          {developerMode ? <DebugChip /> : null}
        </Box>
        <Typography variant="body2" color="text.primary">
          {signature.text}
        </Typography>
        {headlineChips.length ? <StatChipRow items={headlineChips} /> : null}
        {signature.addressing ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 0.75 }}>
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'background.paper' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>当前称呼</Typography>
              {editingAddressAction === 'set_current' ? (
                <TextField
                  size="small"
                  value={editingAddressText}
                  onChange={(event) => setEditingAddressText(event.target.value)}
                  fullWidth
                  autoFocus
                  slotProps={{ htmlInput: { maxLength: 16 } }}
                />
              ) : (
                <Typography variant="body2" noWrap>{signature.addressing.currentAddress}</Typography>
              )}
              {editingAddressAction === 'set_current' ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.35 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingAddressText.trim() || editingAddressText.replace(/\s+/g, '').trim() === signature.addressing.currentAddress}
                    onClick={() => {
                      const nextAddress = editingAddressText.replace(/\s+/g, '').trim();
                      if (!nextAddress || nextAddress === signature.addressing?.currentAddress) return;
                      onSetAddress('set_current', nextAddress);
                      setEditingAddressAction(null);
                      setEditingAddressText('');
                    }}
                    sx={{ p: 0, minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button size="small" variant="text" onClick={() => { setEditingAddressAction(null); setEditingAddressText(''); }} sx={{ p: 0, minWidth: 0 }}>
                    取消
                  </Button>
                </Box>
              ) : (
                <Button size="small" variant="text" onClick={() => { setEditingAddressAction('set_current'); setEditingAddressText(signature.addressing?.currentAddress || ''); }} sx={{ mt: 0.35, p: 0, minWidth: 0 }}>
                  修改
                </Button>
              )}
              {signature.addressing.currentAddress && signature.addressing.currentAddress !== '你' && !signature.addressing.forbiddenAddresses.includes(signature.addressing.currentAddress) ? (
                <Button size="small" variant="text" onClick={() => onForbidAddress(signature.addressing?.currentAddress || '')} sx={{ mt: 0.35, p: 0, minWidth: 0 }}>
                  禁用
                </Button>
              ) : null}
            </Box>
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'background.paper' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>私下称呼</Typography>
              {editingAddressAction === 'set_private' ? (
                <TextField
                  size="small"
                  value={editingAddressText}
                  onChange={(event) => setEditingAddressText(event.target.value)}
                  fullWidth
                  autoFocus
                  slotProps={{ htmlInput: { maxLength: 16 } }}
                />
              ) : (
                <Typography variant="body2" noWrap>{signature.addressing.privateAddress || signature.addressing.currentAddress}</Typography>
              )}
              {editingAddressAction === 'set_private' ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.35 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingAddressText.trim() || editingAddressText.replace(/\s+/g, '').trim() === (signature.addressing.privateAddress || '')}
                    onClick={() => {
                      const nextAddress = editingAddressText.replace(/\s+/g, '').trim();
                      if (!nextAddress || nextAddress === signature.addressing?.privateAddress) return;
                      onSetAddress('set_private', nextAddress);
                      setEditingAddressAction(null);
                      setEditingAddressText('');
                    }}
                    sx={{ p: 0, minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button size="small" variant="text" onClick={() => { setEditingAddressAction(null); setEditingAddressText(''); }} sx={{ p: 0, minWidth: 0 }}>
                    取消
                  </Button>
                </Box>
              ) : (
                <Button size="small" variant="text" onClick={() => { setEditingAddressAction('set_private'); setEditingAddressText(signature.addressing?.privateAddress || signature.addressing?.currentAddress || ''); }} sx={{ mt: 0.35, p: 0, minWidth: 0 }}>
                  修改
                </Button>
              )}
              {signature.addressing.privateAddress && signature.addressing.privateAddress !== signature.addressing.currentAddress && !signature.addressing.forbiddenAddresses.includes(signature.addressing.privateAddress) ? (
                <Button size="small" variant="text" onClick={() => onForbidAddress(signature.addressing?.privateAddress || '')} sx={{ mt: 0.35, p: 0, minWidth: 0 }}>
                  禁用
                </Button>
              ) : null}
            </Box>
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'background.paper' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>公开称呼</Typography>
              {editingAddressAction === 'set_public' ? (
                <TextField
                  size="small"
                  value={editingAddressText}
                  onChange={(event) => setEditingAddressText(event.target.value)}
                  fullWidth
                  autoFocus
                  slotProps={{ htmlInput: { maxLength: 16 } }}
                />
              ) : (
                <Typography variant="body2" noWrap>{signature.addressing.publicAddress || '用户'}</Typography>
              )}
              {editingAddressAction === 'set_public' ? (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.35 }}>
                  <Button
                    size="small"
                    variant="text"
                    disabled={!editingAddressText.trim() || editingAddressText.replace(/\s+/g, '').trim() === (signature.addressing.publicAddress || '用户')}
                    onClick={() => {
                      const nextAddress = editingAddressText.replace(/\s+/g, '').trim();
                      if (!nextAddress || nextAddress === (signature.addressing?.publicAddress || '用户')) return;
                      onSetAddress('set_public', nextAddress);
                      setEditingAddressAction(null);
                      setEditingAddressText('');
                    }}
                    sx={{ p: 0, minWidth: 0 }}
                  >
                    保存
                  </Button>
                  <Button size="small" variant="text" onClick={() => { setEditingAddressAction(null); setEditingAddressText(''); }} sx={{ p: 0, minWidth: 0 }}>
                    取消
                  </Button>
                </Box>
              ) : (
                <Button size="small" variant="text" onClick={() => { setEditingAddressAction('set_public'); setEditingAddressText(signature.addressing?.publicAddress || '用户'); }} sx={{ mt: 0.35, p: 0, minWidth: 0 }}>
                  修改
                </Button>
              )}
            </Box>
          </Box>
        ) : null}
        {trace ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
              关系状态
            </Typography>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Button
                size="small"
                variant="outlined"
                onClick={onRevokePhase}
                sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
              >
                自动判断
              </Button>
              {PHASE_CORRECTION_OPTIONS.map((option) => {
                const selected = isSameCompanionshipPhaseCorrection(trace, option);
                return (
                  <Button
                    key={`public-${option.phase}-${option.style}`}
                    size="small"
                    variant={selected ? 'contained' : 'outlined'}
                    disabled={selected}
                    onClick={() => onCorrectPhase(option.phase, option.style)}
                    sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </Stack>
          </Box>
        ) : null}
        {signature.unsentDraft || signature.offlineTrace || signature.onlineReturn ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.35 }}>
              {signature.unsentDraft ? '未发送的话' : signature.onlineReturn ? '上线回归' : '离线痕迹'}
            </Typography>
            <Typography variant="body2">
              {safeRuntimePrivateText(signature.unsentDraft || signature.onlineReturn || signature.offlineTrace, '有一条私域状态痕迹已隐藏原文')}
            </Typography>
          </Box>
        ) : null}
        {trace?.intimateConflict ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'warning.main', color: 'warning.contrastText' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="caption" sx={{ display: 'block', opacity: 0.82 }}>亲密冲突/修复</Typography>
                <Typography variant="body2">{safeRuntimePrivateText(trace.intimateConflict.summary, '有一条私域冲突摘要已隐藏原文')}</Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                <Button size="small" variant="outlined" onClick={() => trace.intimateConflict && onResolveConflict(trace.intimateConflict)} sx={{ color: 'inherit', borderColor: 'currentColor' }}>
                  已修复
                </Button>
                <Button size="small" variant="outlined" onClick={() => trace.intimateConflict && onDismissConflict(trace.intimateConflict)} sx={{ color: 'inherit', borderColor: 'currentColor' }}>
                  不是冲突
                </Button>
              </Box>
            </Box>
          </Box>
        ) : null}
        {pendingCareTopics.length || pendingPromises.length ? (
          <Stack spacing={0.75}>
            {pendingCareTopics.slice(0, 3).map((topic) => (
              <Box key={topic.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>待关心</Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{topic.text}</Typography>
                </Box>
                <Button size="small" variant="text" onClick={() => onBlockCareTopic(topic)} sx={{ flexShrink: 0 }}>
                  关闭
                </Button>
              </Box>
            ))}
            {pendingPromises.slice(0, 5).map((promise, index, visiblePromises) => (
              <Box key={promise.id} sx={{ display: 'flex', alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 1, p: 1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', flexDirection: { xs: 'column', sm: 'row' } }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    未完成约定 · {formatPendingPromiseKind(promise.kind)} · {promise.reminderPolicy.shouldRemind ? '可轻提醒' : '不主动提醒'}
                  </Typography>
                  {editingPromiseId === promise.id ? (
                    <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                      <TextField
                        select
                        size="small"
                        label="类型"
                        value={editingPromiseKind}
                        onChange={(event) => setEditingPromiseKind(event.target.value as PendingPromise['kind'])}
                        slotProps={{ select: { native: true } }}
                      >
                        {(['shared_activity', 'user_followup', 'emotional_commitment', 'boundary_agreement', 'repair_agreement', 'ritual', 'other'] as PendingPromise['kind'][]).map((kind) => (
                          <option key={kind} value={kind}>{formatPendingPromiseKind(kind)}</option>
                        ))}
                      </TextField>
                      <TextField
                        size="small"
                        label="内容"
                        value={editingPromiseText}
                        onChange={(event) => setEditingPromiseText(event.target.value)}
                        fullWidth
                        multiline
                        minRows={1}
                        maxRows={3}
                      />
                    </Stack>
                  ) : (
                    <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{promise.text}</Typography>
                  )}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: { xs: 'flex-start', sm: 'flex-end' }, gap: 0.5, flexWrap: 'wrap', flexShrink: 0 }}>
                  {editingPromiseId === promise.id ? (
                    <>
                      <Button
                        size="small"
                        variant="text"
                        disabled={!editingPromiseText.trim() || (editingPromiseText.trim() === promise.text && editingPromiseKind === promise.kind)}
                        onClick={() => {
                          const text = editingPromiseText.trim();
                          if (!text) return;
                          onUpdatePromise(promise, { text, kind: editingPromiseKind });
                          setEditingPromiseId(null);
                          setEditingPromiseText('');
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        保存
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingPromiseId(null);
                          setEditingPromiseText('');
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingPromiseId(promise.id);
                          setEditingPromiseText(promise.text);
                          setEditingPromiseKind(promise.kind);
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        修改
                      </Button>
                      {index > 0 ? (
                        <Button size="small" variant="text" onClick={() => onMergePromise(promise, 'previous')} sx={{ minWidth: 0 }}>
                          合并到上一条
                        </Button>
                      ) : null}
                      {index < visiblePromises.length - 1 ? (
                        <Button size="small" variant="text" onClick={() => onMergePromise(promise, 'next')} sx={{ minWidth: 0 }}>
                          合并到下一条
                        </Button>
                      ) : null}
                      <Button size="small" variant="text" onClick={() => onUpdatePromiseLifecycle(promise, 'fulfilled')} sx={{ minWidth: 0 }}>
                        完成
                      </Button>
                      <Button size="small" variant="text" onClick={() => onUpdatePromiseLifecycle(promise, 'stale')} sx={{ minWidth: 0 }}>
                        落空
                      </Button>
                      {promise.reminderPolicy.shouldRemind ? (
                        <Button size="small" variant="text" onClick={() => onUpdatePromiseLifecycle(promise, 'blocked')} sx={{ minWidth: 0 }}>
                          不再提醒
                        </Button>
                      ) : null}
                      <Button size="small" variant="text" onClick={() => onUpdatePromiseLifecycle(promise, 'revoked')} sx={{ minWidth: 0 }}>
                        关闭追踪
                      </Button>
                    </>
                  )}
                </Box>
              </Box>
            ))}
          </Stack>
        ) : null}
        {visibleLines.length ? (
          <Stack spacing={0.45}>
            {visibleLines.map((line) => (
              <Typography key={line} variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                {line}
              </Typography>
            ))}
          </Stack>
        ) : null}
        {sharedPhrases.length ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
              我们之间的话
            </Typography>
            <Stack spacing={0.75}>
              {sharedPhrases.slice(0, 5).map((phrase) => {
                const canKeepPhrasePairPrivate = phrase.participantIds.includes('user') && phrase.participantIds.some((id) => id !== 'user' && id !== characterId);
                return (
                  <Box key={phrase.id} sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.25 }}>
                        <Chip size="small" label={formatSharedPhraseKindLabel(phrase.kind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                      {developerMode ? (
                        <>
                          <Typography variant="caption" color="text.secondary">{formatSharedPhraseVisibilityLabel(phrase.visibility)}</Typography>
                          <Typography variant="caption" color="text.secondary">权重 {phrase.emotionalWeight}</Typography>
                          {phrase.reuseCount > 1 ? <Typography variant="caption" color="text.secondary">复用 {phrase.reuseCount}</Typography> : null}
                        </>
                      ) : null}
                    </Stack>
                      {editingPhraseId === phrase.id ? (
                        <Stack spacing={0.75}>
                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75}>
                            <TextField
                              select
                              size="small"
                              label="类型"
                              value={editingPhraseKind}
                              onChange={(event) => setEditingPhraseKind(event.target.value as SharedPhrase['kind'])}
                              slotProps={{ select: { native: true } }}
                              sx={{ minWidth: { sm: 116 } }}
                            >
                              {(['pet_name', 'inside_joke', 'promise_line', 'comfort_line', 'confession_line', 'secret_code', 'other'] as SharedPhrase['kind'][]).map((kind) => (
                                <option key={kind} value={kind}>{formatSharedPhraseKindLabel(kind)}</option>
                              ))}
                            </TextField>
                            <TextField
                              select
                              size="small"
                              label="可见性"
                              value={editingPhraseVisibility}
                              onChange={(event) => setEditingPhraseVisibility(event.target.value as SharedPhrase['visibility'])}
                              slotProps={{ select: { native: true } }}
                              sx={{ minWidth: { sm: 124 } }}
                            >
                              {(['private', 'between_actors', 'public_hint'] as SharedPhrase['visibility'][]).map((visibility) => (
                                <option key={visibility} value={visibility}>{formatSharedPhraseVisibilityLabel(visibility)}</option>
                              ))}
                            </TextField>
                          </Stack>
                          <TextField
                            size="small"
                            value={editingPhraseText}
                            onChange={(event) => setEditingPhraseText(event.target.value)}
                            fullWidth
                            multiline
                            minRows={1}
                            maxRows={3}
                            autoFocus
                            placeholder="改成更合适的话"
                          />
                        </Stack>
                      ) : (
                        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>「{phrase.text}」</Typography>
                      )}
                      {developerMode && phrase.evidence ? (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
                          证据：{clipRuntimeText(phrase.evidence, 96)}
                        </Typography>
                      ) : null}
                      {developerMode && phrase.sourceMessageIds?.length ? (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                          来源消息：{phrase.sourceMessageIds.join(' / ')}
                        </Typography>
                      ) : null}
                      <Box sx={{ mt: 0.5 }}>
                        <ParticipantEditor
                          selectedIds={phrase.participantIds}
                          options={participantOptions}
                          resolveCharacterName={resolveCharacterName}
                          requiredIds={[characterId, 'user']}
                          onSave={(participantIds) => onUpdateSharedPhraseParticipants(phrase, participantIds)}
                        />
                      </Box>
                    </Box>
                    {editingPhraseId === phrase.id ? (
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                        <Button
                          size="small"
                          variant="text"
                          disabled={!editingPhraseText.trim() || (editingPhraseText.trim() === phrase.text && editingPhraseKind === phrase.kind && editingPhraseVisibility === phrase.visibility)}
                          onClick={() => {
                            const nextText = editingPhraseText.trim();
                            if (!nextText) return;
                            if (nextText === phrase.text && editingPhraseKind === phrase.kind && editingPhraseVisibility === phrase.visibility) return;
                            onUpdateSharedPhrase(phrase, { text: nextText, kind: editingPhraseKind, visibility: editingPhraseVisibility });
                            setEditingPhraseId(null);
                            setEditingPhraseText('');
                          }}
                          sx={{ minWidth: 0 }}
                        >
                          保存
                        </Button>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => {
                            setEditingPhraseId(null);
                            setEditingPhraseText('');
                            setEditingPhraseKind('other');
                            setEditingPhraseVisibility('between_actors');
                          }}
                          sx={{ minWidth: 0 }}
                        >
                          取消
                        </Button>
                      </Box>
                    ) : (
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => {
                            setEditingPhraseId(phrase.id);
                            setEditingPhraseText(phrase.text);
                            setEditingPhraseKind(phrase.kind);
                            setEditingPhraseVisibility(phrase.visibility);
                          }}
                          sx={{ minWidth: 0 }}
                        >
                          修改
                        </Button>
                        {canKeepPhrasePairPrivate ? (
                          <Button size="small" variant="text" onClick={() => onKeepSharedPhrasePairPrivate(phrase)} sx={{ minWidth: 0 }}>
                            只保留我和角色
                          </Button>
                        ) : null}
                        <Button size="small" variant="text" onClick={() => onSuppressSharedPhrase(phrase)} sx={{ minWidth: 0 }}>
                          不再使用
                        </Button>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Box>
        ) : null}
        {trace?.userProfileCues.length ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
              关于我的线索
            </Typography>
            <Stack spacing={0.75}>
              {trace.userProfileCues.slice(0, 6).map((item, index) => {
                const cueKey = `${item.kind}-${item.text}-${index}`;
                return (
                  <Box key={cueKey} sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.25 }}>
                        <Chip size="small" label={formatUserProfileMemoryKindLabel(item.kind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                        {item.sensitive ? <Typography variant="caption" color="warning.main">敏感</Typography> : null}
                        {developerMode ? <Typography variant="caption" color="text.secondary">置信 {Math.round(item.confidence * 100)}%</Typography> : null}
                      </Stack>
                      {editingProfileCueKey === cueKey ? (
                        <Stack spacing={0.75}>
                          <TextField
                            select
                            size="small"
                            label="类型"
                            value={editingProfileCueKind}
                            onChange={(event) => setEditingProfileCueKind(event.target.value as UserProfileMemoryKind)}
                            slotProps={{ select: { native: true } }}
                          >
                            {(['display_name', 'address_preference', 'schedule_hint', 'pressure_source', 'preference', 'dislike', 'boundary', 'important_date', 'recent_plan', 'emotional_pattern'] as UserProfileMemoryKind[]).map((kind) => (
                              <option key={kind} value={kind}>{formatUserProfileMemoryKindLabel(kind)}</option>
                            ))}
                          </TextField>
                          <TextField
                            size="small"
                            label="内容"
                            value={editingProfileCueText}
                            onChange={(event) => setEditingProfileCueText(event.target.value)}
                            fullWidth
                            multiline
                            minRows={1}
                            maxRows={3}
                          />
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                            <Chip
                              size="small"
                              label={editingProfileCueSensitive ? '敏感' : '普通'}
                              color={editingProfileCueSensitive ? 'warning' : 'default'}
                              variant="outlined"
                              onClick={() => setEditingProfileCueSensitive((value) => !value)}
                              sx={{ height: 24, borderRadius: 999 }}
                            />
                            <Button
                              size="small"
                              variant="text"
                              disabled={!editingProfileCueText.trim()}
                              onClick={() => {
                                const text = editingProfileCueText.trim();
                                if (!text) return;
                                onUpdateProfileCue({
                                  ...item,
                                  kind: editingProfileCueKind,
                                  text,
                                  confidence: 1,
                                  sensitive: editingProfileCueSensitive,
                                  evidence: item.evidence || 'manual_profile_cue_edit_from_character_relationship_tab',
                                });
                                setEditingProfileCueKey(null);
                                setEditingProfileCueText('');
                              }}
                              sx={{ minWidth: 0 }}
                            >
                              保存
                            </Button>
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => {
                                setEditingProfileCueKey(null);
                                setEditingProfileCueText('');
                              }}
                              sx={{ minWidth: 0 }}
                            >
                              取消
                            </Button>
                          </Box>
                        </Stack>
                      ) : (
                        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{safeRuntimePrivateText(item.text, '有一条私域画像线索已隐藏原文')}</Typography>
                      )}
                      {developerMode && item.evidence ? (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
                          证据：{clipRuntimeText(safeRuntimePrivateText(item.evidence), 96)}
                        </Typography>
                      ) : null}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingProfileCueKey(cueKey);
                          setEditingProfileCueKind(item.kind);
                          setEditingProfileCueText(item.text);
                          setEditingProfileCueSensitive(Boolean(item.sensitive));
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        修改
                      </Button>
                      <Button size="small" variant="text" onClick={() => onRevokeProfileCue(item)} sx={{ minWidth: 0 }}>
                        撤回
                      </Button>
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          </Box>
        ) : null}
        {trace?.attachmentProfile ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 0.65, flexWrap: 'wrap' }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  互动节奏
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {trace.attachmentProfile.confidence <= 0 ? '已关闭自动适配' : formatInteractionPacePreferenceLabel(trace.attachmentProfile.inferredStyle)}
                </Typography>
              </Box>
              {trace.attachmentProfile.confidence <= 0 ? (
                <Button size="small" variant="outlined" onClick={onEnableAttachment} sx={{ borderRadius: 999, flexShrink: 0 }}>
                  恢复自动
                </Button>
              ) : (
                <Button size="small" variant="text" onClick={onDisableAttachment} sx={{ flexShrink: 0 }}>
                  暂停适配
                </Button>
              )}
            </Box>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {INTERACTION_PACE_OPTIONS.map((option) => {
                const selected = Boolean(trace.attachmentProfile && trace.attachmentProfile.confidence > 0 && trace.attachmentProfile.inferredStyle === option.style);
                return (
                  <Tooltip key={option.style} title={option.description} arrow>
                    <span>
                      <Button
                        size="small"
                        variant={selected ? 'contained' : 'outlined'}
                        disabled={selected}
                        onClick={() => onCorrectAttachment(option.style)}
                        sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
                      >
                        {option.label}
                      </Button>
                    </span>
                  </Tooltip>
                );
              })}
              <Tooltip title="交给系统根据长期互动继续判断。" arrow>
                <span>
                  <Button
                    size="small"
                    variant={trace.attachmentProfile.confidence > 0 ? 'outlined' : 'contained'}
                    disabled={trace.attachmentProfile.confidence <= 0}
                    onClick={onEnableAttachment}
                    sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
                  >
                    自动适配
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        ) : null}
        {signature.addressing?.forbiddenAddresses.length ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary">禁用称呼：</Typography>
            {signature.addressing.forbiddenAddresses.map((address) => (
              <Chip
                key={address}
                size="small"
                label={address}
                variant="outlined"
                onDelete={() => onUnforbidAddress(address)}
                sx={{ height: 24, borderRadius: 999 }}
              />
            ))}
          </Box>
        ) : null}
        {sharedSecrets.length ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
              小秘密边界
            </Typography>
            <Stack spacing={0.75}>
              {sharedSecrets.slice(0, 4).map((secret) => (
                <Box key={secret.id} sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.25 }}>
                      <Chip size="small" label={secret.leakState === 'sealed' ? '密封' : secret.leakState === 'hinted_publicly' ? '公开暗示' : secret.leakState === 'leaked' ? '已泄露' : '已坦白'} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                      <Chip size="small" label={formatSharedSecretConsequenceLabel(secret.consequenceKind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                      {developerMode ? <Typography variant="caption" color="text.secondary">权重 {secret.emotionalWeight}</Typography> : null}
                    </Stack>
                    {editingSecretId === secret.id ? (
                      <TextField
                        size="small"
                        value={editingSecretMask}
                        onChange={(event) => setEditingSecretMask(event.target.value)}
                        fullWidth
                        autoFocus
                        multiline
                        minRows={1}
                        maxRows={2}
                        slotProps={{ htmlInput: { maxLength: 80 } }}
                        sx={{ mt: 0.5 }}
                      />
                    ) : (
                      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{secret.publicMask}</Typography>
                    )}
                    {developerMode ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
                        参与者：{secret.participantIds.join(' × ')}
                      </Typography>
                    ) : null}
                    {developerMode && secret.sourceMessageIds?.length ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                        来源消息：{secret.sourceMessageIds.join(' / ')}
                      </Typography>
                    ) : null}
                    <Box sx={{ mt: 0.5 }}>
                      <ParticipantEditor
                        selectedIds={secret.participantIds}
                        options={participantOptions}
                        resolveCharacterName={resolveCharacterName}
                        requiredIds={[characterId, 'user']}
                        onSave={(participantIds) => onUpdateSharedSecretParticipants(secret, participantIds)}
                      />
                    </Box>
                    {(secret.leakState === 'leaked' || secret.leakState === 'confessed') ? (
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.65 }}>
                        {sharedSecretConsequenceOptions(secret).map((option) => (
                          <Button
                            key={option}
                            size="small"
                            variant={secret.consequenceKind === option ? 'contained' : 'outlined'}
                            onClick={() => onCorrectSharedSecretConsequence(secret, option)}
                            sx={{ minHeight: 24, px: 1, py: 0.1, borderRadius: 999, fontSize: 12 }}
                          >
                            {formatSharedSecretConsequenceLabel(option)}
                          </Button>
                        ))}
                      </Stack>
                    ) : null}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                    {editingSecretId === secret.id ? (
                      <>
                        <Button
                          size="small"
                          variant="text"
                          disabled={!editingSecretMask.trim() || editingSecretMask.trim() === secret.publicMask}
                          onClick={() => {
                            const nextMask = editingSecretMask.trim();
                            if (!nextMask || nextMask === secret.publicMask) return;
                            onUpdateSharedSecretMask(secret, nextMask);
                            setEditingSecretId(null);
                            setEditingSecretMask('');
                          }}
                          sx={{ minWidth: 0 }}
                        >
                          保存
                        </Button>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => {
                            setEditingSecretId(null);
                            setEditingSecretMask('');
                          }}
                          sx={{ minWidth: 0 }}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingSecretId(secret.id);
                          setEditingSecretMask(secret.publicMask);
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        修改
                      </Button>
                    )}
                    {secret.participantIds.includes('user') && secret.participantIds.some((id) => id !== 'user' && id !== characterId) ? (
                      <Button size="small" variant="text" onClick={() => onKeepSharedSecretPairPrivate(secret)} sx={{ minWidth: 0 }}>
                        只保留我和角色
                      </Button>
                    ) : null}
                    <Button size="small" variant="text" onClick={() => onRevokeSharedSecret(secret)} sx={{ minWidth: 0 }}>
                      撤回
                    </Button>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>
        ) : null}
        {rituals.length ? (
          <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
              关系仪式
            </Typography>
            <Stack spacing={0.75}>
              {rituals.slice(0, 5).map((ritual) => (
                <Box key={ritual.id} sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.25 }}>
                      <Chip size="small" label={formatRitualKindLabel(ritual.kind)} variant="outlined" sx={{ height: 22, borderRadius: 999 }} />
                      <Typography variant="caption" color={ritual.executionState === 'suppressed' ? 'warning.main' : 'text.secondary'}>
                        {formatRitualExecutionLabel(ritual.executionState)}
                      </Typography>
                      {developerMode && ritual.nextAvailableAt ? <Typography variant="caption" color="text.secondary">下次 {new Date(ritual.nextAvailableAt).toLocaleString()}</Typography> : null}
                    </Stack>
                    {editingRitualId === ritual.id ? (
                      <TextField
                        size="small"
                        value={editingRitualContent}
                        onChange={(event) => setEditingRitualContent(event.target.value)}
                        fullWidth
                        multiline
                        minRows={1}
                        maxRows={3}
                        autoFocus
                        slotProps={{ htmlInput: { maxLength: 180 } }}
                        sx={{ mt: 0.5 }}
                      />
                    ) : (
                      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{ritual.content}</Typography>
                    )}
                    {developerMode && ritual.boundaryReasons.length ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
                        边界：{ritual.boundaryReasons.slice(0, 2).join(' / ')}
                      </Typography>
                    ) : null}
                    {developerMode && ritual.sourceMessageIds?.length ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                        来源消息：{ritual.sourceMessageIds.join(' / ')}
                      </Typography>
                    ) : null}
                  </Box>
                  {editingRitualId === ritual.id ? (
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                      <Button
                        size="small"
                        variant="text"
                        disabled={!editingRitualContent.trim() || editingRitualContent.trim() === ritual.content}
                        onClick={() => {
                          const nextContent = editingRitualContent.trim();
                          if (!nextContent || nextContent === ritual.content) return;
                          onUpdateRitual(ritual, nextContent);
                          setEditingRitualId(null);
                          setEditingRitualContent('');
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        保存
                      </Button>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingRitualId(null);
                          setEditingRitualContent('');
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        取消
                      </Button>
                    </Box>
                  ) : (
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          setEditingRitualId(ritual.id);
                          setEditingRitualContent(ritual.content);
                        }}
                        sx={{ minWidth: 0 }}
                      >
                        修改
                      </Button>
                      {ritual.executionState === 'suppressed' ? (
                        <Button size="small" variant="text" onClick={() => onRestoreRitual(ritual)} sx={{ minWidth: 0 }}>
                          恢复使用
                        </Button>
                      ) : (
                        <Button size="small" variant="text" onClick={() => onSuppressRitual(ritual)} sx={{ minWidth: 0 }}>
                          不再使用
                        </Button>
                      )}
                    </Box>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>
        ) : null}
        {developerMode ? (
          <Stack spacing={1}>
            <Box sx={{ p: 1.1, borderRadius: 1, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.65 }}>
                阶段修正
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {PHASE_CORRECTION_OPTIONS.map((option) => {
                  const selected = isSameCompanionshipPhaseCorrection(trace, option);
                  return (
                    <Button
                      key={`${option.phase}-${option.style}`}
                      size="small"
                      variant={selected ? 'contained' : 'outlined'}
                      disabled={selected}
                      onClick={() => onCorrectPhase(option.phase, option.style)}
                      sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
                    >
                      {option.label}
                    </Button>
                  );
                })}
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onRevokePhase}
                  sx={{ borderRadius: 999, minWidth: 0, px: 1.1 }}
                >
                  恢复自动判断
                </Button>
              </Stack>
            </Box>
            <CompanionshipDeveloperTracePanel
              trace={trace}
              onDisableAttachment={onDisableAttachment}
              onEnableAttachment={onEnableAttachment}
              onCorrectAttachment={onCorrectAttachment}
              onRestoreAttachment={onRestoreAttachment}
              onRestoreAddress={onSetAddress}
              onRestoreConflict={onRestoreConflict}
              onRestorePhase={onRestorePhase}
              onRestoreUserProfile={onRestoreUserProfile}
              onRestoreCareTopic={onRestoreCareTopic}
              onRestorePromise={onRestorePromise}
              onRestoreSharedAnchor={onRestoreSharedAnchor}
              onRestoreSharedSecretPublic={onRestoreSharedSecretPublic}
              onRestoreSharedPhrase={onRestoreSharedPhrase}
              onRestoreRitualFromHistory={onRestoreRitualFromHistory}
            />
            <Box sx={{ display: 'grid', gap: 0.5 }}>
              {signature.debugLines.map((line) => (
                <Typography key={line} variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-word' }}>
                  {safeRuntimePrivateText(line, '有一条私域调试线索已隐藏原文')}
                </Typography>
              ))}
            </Box>
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}

function isLikelyInternalCharacterId(value: string) {
  return /^[0-9a-f-]{18,}$/i.test(value);
}

function resolveFallbackCharacterName(id: string, fallback?: string) {
  if (fallback && fallback !== id) return fallback;
  if (id.startsWith('draft-')) return '未命名关系';
  if (!id || isLikelyInternalCharacterId(id)) return '未知角色';
  return id;
}

function getStrongestRelationship(character: Partial<AICharacter>, resolveCharacterName: (id: string, fallback?: string) => string) {
  const relation = (character.relationships || [])
    .slice()
    .sort((a, b) => {
      const score = (entry: NonNullable<AICharacter['relationships']>[number]) => Math.abs(entry.warmth || 0) + Math.abs(entry.trust || 0) + Math.abs(entry.threat || 0) + Math.abs(entry.competence || 0) * 0.5;
      return score(b) - score(a);
    })[0];
  if (!relation) return null;
  const dominant = [
    { label: '亲和', value: relation.warmth || 0 },
    { label: '信任', value: relation.trust || 0 },
    { label: '威胁感', value: relation.threat || 0 },
    { label: '能力判断', value: relation.competence || 0 },
  ].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  const level = relationshipLevel(dominant.value);
  return `${resolveCharacterName(relation.characterId, relation.note)} · ${dominant.label}${level || '有变化'}`;
}

function SoulOverviewPanel({
  character,
  resolveCharacterName,
  developerMode,
}: {
  character: Partial<AICharacter>;
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
}) {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const soulChips = character.id ? buildMemberInnerLifeChips(character as AICharacter, i18n.language).map((item) => item.label) : [];
  const relationship = getStrongestRelationship(character, resolveCharacterName);
  const memoryCount = (character.layeredMemories || []).filter((item) => !item.archivedAt).length;
  const feedbackSignals = summarizeExpressionFeedbackInfluence(character.layeredMemories || []).filter((signal) => signal.strength > 0.08).slice(0, 2);
  const core = character.coreProfile;
  const coreLine = [core?.coreDesire, core?.coreFear ? `${isZh ? '怕' : 'Fears'} ${core.coreFear}` : '', core?.socialMask ? `${isZh ? '面具' : 'Mask'} ${core.socialMask}` : ''].filter(Boolean).join(' / ');
  const chips = [
    ...soulChips,
    relationship ? `${isZh ? '牵挂' : 'Tie'} ${relationship}` : '',
    memoryCount ? `${isZh ? '记忆' : 'Memory'} ${memoryCount}` : '',
    ...feedbackSignals.map((signal) => `${signal.label} ${Math.round(signal.strength * 100)}%`),
  ].filter(Boolean);
  return (
    <SurfaceCard>
      <SectionHeader title={isZh ? '灵魂概览' : 'Soul Overview'} dense action={developerMode ? <DebugChip /> : undefined} />
      <Stack spacing={1}>
        <Typography variant="body2" color="text.secondary">
          {clipRuntimeText(buildSoulSummary(character, i18n.language), 108)}
        </Typography>
        {chips.length ? <StatChipRow items={chips} /> : <Typography variant="caption" color="text.secondary">{isZh ? '还没有足够的关系、记忆或内心痕迹。' : 'Not enough relationship, memory, or inner traces yet.'}</Typography>}
        {coreLine ? (
          <Tooltip title={coreLine} arrow>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', width: 'fit-content', cursor: 'help', '&:hover': { textDecoration: 'underline' } }}>
              {isZh ? '核心画像' : 'Core profile'}：{clipRuntimeText(coreLine, 76)}
            </Typography>
          </Tooltip>
        ) : null}
        {developerMode && feedbackSignals.length ? (
          <Typography variant="caption" color="text.secondary">
            {feedbackSignals.map((signal) => `${signal.label}：负向 ${signal.negativeCount} / 正向 ${signal.positiveCount} / 强度 ${Math.round(signal.strength * 100)}%`).join('；')}
          </Typography>
        ) : null}
      </Stack>
    </SurfaceCard>
  );
}

function RuntimeTimelinePanel({
  filteredTimeline,
  developerMode,
  members = [],
}: {
  filteredTimeline: Array<{ type: 'memory' | 'relationship' | 'drift'; text: string; createdAt: number }>;
  developerMode: boolean;
  members?: Array<{ id: string; name?: string }>;
}) {
  const typeLabel = (type: 'memory' | 'relationship' | 'drift') => type === 'memory' ? '记忆' : type === 'relationship' ? '关系' : '漂移';
  const isReactivated = (text: string) => /旧记忆.*重新唤醒|重新激活|回温/.test(text);
  const tone = (item: { type: 'memory' | 'relationship' | 'drift'; text: string }) => {
    if (isReactivated(item.text)) return 'rgba(255, 152, 0, 0.08)';
    if (item.type === 'relationship') return 'rgba(46, 125, 50, 0.08)';
    if (item.type === 'drift') return 'rgba(25, 118, 210, 0.08)';
    return 'action.hover';
  };
  return filteredTimeline.length ? (
    <Stack spacing={0.85}>
      {filteredTimeline.slice().reverse().slice(0, developerMode ? 8 : 5).map((item, index) => (
        <Tooltip key={`${item.type}-${item.createdAt}-${index}`} title={developerMode ? sanitizeUserFacingText(item.text, members) : ''} arrow placement="top-start">
          <Box sx={{ p: { xs: 0.9, sm: 1 }, borderRadius: 2, bgcolor: tone(item), '&:hover .timeline-text': { textDecoration: developerMode ? 'underline' : 'none' } }}>
            <Stack direction="row" spacing={0.65} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 0.55 }}>
              <Chip size="small" label={typeLabel(item.type)} variant="outlined" sx={{ height: 22 }} />
              {isReactivated(item.text) ? <Chip size="small" label="旧记忆回温" color="warning" variant="outlined" sx={{ height: 22 }} /> : null}
              {developerMode ? <Typography variant="caption" color="text.secondary">{new Date(item.createdAt).toLocaleString()}</Typography> : null}
            </Stack>
            <Typography className="timeline-text" variant="body2">{sanitizeUserFacingText(item.text, members)}</Typography>
          </Box>
        </Tooltip>
      ))}
    </Stack>
  ) : <Typography variant="caption" color="text.secondary">{developerMode ? '当前筛选下暂无时间线数据' : '当前暂无关键变化'}</Typography>;
}

function RelationshipAxisPills({
  relation,
  developerMode,
}: {
  relation: NonNullable<AICharacter['relationships']>[number];
  developerMode: boolean;
}) {
  const items = developerMode ? buildRelationshipDebugChips(relation) : buildRelationshipReadableChips(relation);
  return items.length ? <StatChipRow items={items} /> : null;
}

function RelationshipGraphPanel({ relationships, developerMode, resolveCharacterName, members }: { relationships: NonNullable<AICharacter['relationships']>; developerMode: boolean; resolveCharacterName: (id: string, fallback?: string) => string; members: AICharacter[] }) {
  return relationships.length ? (
    <Stack spacing={1}>
      {relationships.slice(0, developerMode ? 8 : 4).map((relation, index) => {
        return (
          <Box key={`${relation.characterId}-graph-${index}`} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Stack spacing={0.65} sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>{resolveCharacterName(relation.characterId, relation.note)}</Typography>
              <Tooltip title={developerMode ? buildRelationshipDebugHint(relation) : buildRelationshipUserHint(relation, members)} arrow placement="top-start">
                <Box sx={{ width: 'fit-content', '&:hover': { textDecoration: 'underline' } }}>
                  <RelationshipAxisPills relation={relation} developerMode={developerMode} />
                </Box>
              </Tooltip>
              {relation.note && relation.note !== relation.characterId ? <Typography variant="body2" color="text.secondary">{sanitizeUserFacingText(relation.note, members)}</Typography> : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  ) : <Typography variant="caption" color="text.secondary">暂无关系数据</Typography>;
}

function RelationshipOverviewPanel({
  relationships,
  relationshipMemories,
  resolveCharacterName,
  developerMode,
  members,
}: {
  relationships: NonNullable<AICharacter['relationships']>;
  relationshipMemories: MemoryItem[];
  resolveCharacterName: (id: string, fallback?: string) => string;
  developerMode: boolean;
  members: AICharacter[];
}) {
  const memoryByTarget = new Map(relationshipMemories.map((item) => [item.subjectIds?.[1] || '', item]));
  return relationships.length ? (
    <Stack spacing={1}>
      {relationships.slice(0, 8).map((relation, index) => {
        const memory = memoryByTarget.get(relation.characterId);
        const readableChips = buildRelationshipReadableChips(relation);
        return (
          <Box key={`${relation.characterId}-overview-${index}`} sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
            <Stack spacing={0.6} sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>{resolveCharacterName(relation.characterId, relation.note)}</Typography>
              {readableChips.length ? (
                <Tooltip title={developerMode ? buildRelationshipDebugHint(relation) : buildRelationshipUserHint(relation, members)} arrow placement="top-start">
                  <Box sx={{ width: 'fit-content', '&:hover': { textDecoration: 'underline' } }}>
                    <StatChipRow items={developerMode ? buildRelationshipDebugChips(relation) : readableChips} />
                  </Box>
                </Tooltip>
              ) : null}
              {relation.note && relation.note !== relation.characterId ? <Typography variant="body2" color="text.secondary">{sanitizeUserFacingText(relation.note, members)}</Typography> : null}
              {memory ? (
                <Tooltip title={sanitizeUserFacingText(memory.evidenceText || memory.text, members)} arrow>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 'fit-content', cursor: 'help', '&:hover': { textDecoration: 'underline' } }}>
                    {developerMode ? `强化 ${memory.reinforcementCount} · 置信 ${(memory.confidence * 100).toFixed(0)}%` : '有记忆沉淀'}
                  </Typography>
                </Tooltip>
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  ) : <Typography variant="caption" color="text.secondary">暂无关系数据</Typography>;
}

const EXPERIENCE_ARTIFACT_TABS: Array<{ key: CharacterExperienceArtifactKind; label: string }> = [
  { key: 'birth_letter', label: '诞生' },
  { key: 'diary', label: '日记' },
  { key: 'growth', label: '成长' },
  { key: 'final_letter', label: '信' },
];

function CharacterExperienceArtifactPanel({ character, relatedCharacters }: { character: Partial<AICharacter>; relatedCharacters: AICharacter[] }) {
  const { i18n } = useTranslation();
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const selectedProfile = useMemo(() => getPreferredAIProfile(aiProfiles, 'text') || aiProfiles[0] || null, [aiProfiles]);
  const [kind, setKind] = useState<CharacterExperienceArtifactKind>('diary');
  const [generatedTexts, setGeneratedTexts] = useState<Partial<Record<CharacterExperienceArtifactKind, string>>>({});
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = useMemo(() => (
    kind === 'final_letter'
      ? buildCharacterFinalLetterContext(character, relatedCharacters)
      : buildCharacterExperienceArtifactContext(character, relatedCharacters)
  ), [character, kind, relatedCharacters]);
  const localPreview = useMemo(() => buildLocalCharacterExperienceArtifact(kind, context), [kind, context]);
  const hasGeneratedText = Boolean(generatedTexts[kind]);
  const displayedText = generatedTexts[kind] || localPreview;
  const canGenerate = isAIProfileUsable(selectedProfile);

  const handleGenerate = async () => {
    if (!selectedProfile || !canGenerate) return;
    setGenerating(true);
    setError(null);
    try {
      const text = await generateCharacterExperienceArtifact({
        config: selectedProfile,
        kind,
        character,
        relatedCharacters,
        language: i18n.language.startsWith('zh') ? 'zh' : 'en',
      });
      setGeneratedTexts((prev) => ({ ...prev, [kind]: text.trim() || localPreview }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <SurfaceCard>
      <SectionHeader
        title="角色经历"
        dense
        action={(
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Button size="small" variant="text" disabled={!canGenerate || generating} onClick={handleGenerate}>{generating ? '生成中' : '生成'}</Button>
            <DebugChip />
          </Box>
        )}
      />
      <Stack spacing={1}>
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          {EXPERIENCE_ARTIFACT_TABS.map((tab) => (
            <Chip
              key={tab.key}
              size="small"
              label={tab.label}
              color={kind === tab.key ? 'primary' : 'default'}
              variant={kind === tab.key ? 'filled' : 'outlined'}
              onClick={() => setKind(tab.key)}
            />
          ))}
        </Box>
        <Box sx={{ p: { xs: 1, sm: 1.15 }, borderRadius: 2.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'rgba(148, 163, 184, 0.12)' }}>
          <Typography variant="body2" color={hasGeneratedText ? 'text.primary' : 'text.secondary'} sx={{ whiteSpace: 'pre-wrap' }}>{displayedText}</Typography>
        </Box>
        {error ? <Typography variant="caption" color="error">{error}</Typography> : null}
      </Stack>
    </SurfaceCard>
  );
}

interface RuntimeInsightsPanelProps {
  character: Partial<AICharacter>;
}

export function CharacterMemoryInspector({ character }: RuntimeInsightsPanelProps) {
  const factArchive = useDetailedFacts(character.id);
  const allLayeredMemories = useMemo(() => buildCharacterLayeredMemories(character), [character]);
  const characters = useCharacterStore((state) => state.characters);
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showDeveloperMemory = useSettingsStore((state) => state.developerUI.showMemoryDebug);
  const showCompanionshipDebug = useSettingsStore((state) => state.developerUI.showCompanionshipDebug);
  const includeRuntimeEvidence = developerMode && Boolean(showDeveloperMemory || showCompanionshipDebug);
  const memoryMembers = useMemo(() => {
    const selfMember = character.id ? [{ id: character.id, name: character.name || '当前角色' }] : [];
    return [...characters, ...selfMember];
  }, [character.id, character.name, characters]);

  return (
    <PageSection spacing={2}>
      <LayeredMemoryPanel title="记忆沉淀" memories={allLayeredMemories} emptyText="暂无沉淀记忆" includeRuntimeEvidence={includeRuntimeEvidence} members={memoryMembers}
        hideFilterHints
        detailedFactsCount={factArchive.loading || factArchive.error ? undefined : factArchive.items.length}
        detailedFacts={character.id ? <DetailedFactsPanel key={character.id} archive={factArchive} /> : undefined} />
    </PageSection>
  );
}

export function CharacterRelationshipInspector({ character }: RuntimeInsightsPanelProps) {
  const characters = useCharacterStore((state) => state.characters);
  const chats = useChatStore((state) => state.chats);
  const updateChat = useChatStore((state) => state.updateChat);
  const relatedChatIds = useMemo(() => new Set(chats
    .filter((chat) => character.id && chat.memberIds.includes(character.id))
    .map((chat) => chat.id)), [character.id, chats]);
  const messages = useMessageStore(useShallow((state) => (
    state.messages.filter((message) => relatedChatIds.has(message.chatId))
  )));
  const messageWindowsByChatId = useMessageStore(useShallow((state) => Object.fromEntries(
    Array.from(relatedChatIds)
      .map((chatId) => [chatId, state.messageWindowsByChatId[chatId]] as const)
      .filter(([, window]) => Boolean(window)),
  )));
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showDeveloperMemory = useSettingsStore((state) => state.developerUI.showMemoryDebug);
  const showCompanionshipDebug = useSettingsStore((state) => state.developerUI.showCompanionshipDebug);
  const isDeveloperView = developerMode && Boolean(showDeveloperMemory || showCompanionshipDebug);
  const relationships = useMemo(() => character.relationships || [], [character.relationships]);
  const resolveCharacterName = useMemo(() => {
    const byId = new Map(characters.map((item) => [item.id, item.name]));
    return (id: string, fallback?: string) => {
      const matched = byId.get(id);
      if (matched) return matched;
      return resolveFallbackCharacterName(id, fallback);
    };
  }, [characters]);
  const participantOptions = useMemo<ParticipantOption[]>(() => {
    const options = new Map<string, string>();
    options.set('user', '我');
    if (character.id) options.set(character.id, character.name || '当前角色');
    characters.forEach((item) => {
      if (item.id) options.set(item.id, item.name || item.id);
    });
    chats
      .filter((chat) => character.id && chat.memberIds.includes(character.id))
      .flatMap((chat) => chat.memberIds)
      .forEach((id) => {
        if (!id) return;
        options.set(id, resolveCharacterName(id));
      });
    return Array.from(options, ([id, name]) => ({ id, name })).slice(0, 80);
  }, [character.id, character.name, characters, chats, resolveCharacterName]);
  const relationshipMemories = useMemo(() => {
    const items = buildRelationshipMemoryItems(character).map((item) => ({
      ...item,
      text: resolveCharacterName(item.subjectIds?.[1] || '', item.text),
    }));
    return items.slice(0, 8);
  }, [character, resolveCharacterName]);
  const characterCompanionshipStates = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const relatedChat = recentByTime(chats.filter((chat) => chat.memberIds.includes(character.id || '') && chat.type !== 'direct'), 1)[0]
      || recentByTime(chats.filter((chat) => chat.memberIds.includes(character.id || '')), 1)[0];
    return buildCharacterCompanionshipStates(character as AICharacter, character.updatedAt || character.createdAt || 0, relatedChat);
  }, [character, chats]);
  const privateThreadScheduleDiagnostics = useMemo(() => {
    if (!character.id) return [];
    const seen = new Set<string>();
    return recentByTime(chats.filter((chat) => chat.type !== 'direct' && chat.memberIds.includes(character.id || '')), 8)
      .flatMap((chat) => buildCompanionshipPrivateThreadScheduleDiagnostics({
        chat,
        characterId: character.id,
        limit: 6,
      }).map((diagnostic) => ({ chatName: chat.name || '群聊', diagnostic })))
      .filter((item) => {
        if (seen.has(item.diagnostic.id)) return false;
        seen.add(item.diagnostic.id);
        return true;
      })
      .sort((a, b) => b.diagnostic.occurredAt - a.diagnostic.occurredAt)
      .slice(0, 8);
  }, [character.id, chats]);
  const roleSharedAnchorItems = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const seen = new Set<string>();
    return recentByTime(chats.filter((chat) => chat.type !== 'direct' && chat.memberIds.includes(character.id || '')), 5)
      .flatMap((chat) => buildSharedMemoryAnchors(character as AICharacter, chat.updatedAt || Date.now(), chat)
        .filter((anchor) => anchor.participantIds.includes(character.id || '') && !anchor.participantIds.includes('user'))
        .map((anchor) => ({ chat, chatName: chat.name || '群聊', anchor })))
      .filter((item) => {
        const key = `${item.chat.id}:${item.anchor.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }, [character, chats]);
  const roleSharedPhraseItems = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const seen = new Set<string>();
    return recentByTime(chats.filter((chat) => chat.type !== 'direct' && chat.memberIds.includes(character.id || '')), 5)
      .flatMap((chat) => {
        const chatMessages = [
          ...(chat.latestMessage ? [chat.latestMessage] : []),
          ...messages.filter((message) => message.chatId === chat.id),
          ...(messageWindowsByChatId[chat.id]?.messages || []),
        ].filter((message, index, source): message is Message => Boolean(message) && source.findIndex((item) => item?.id === message?.id) === index);
        return buildSharedPhrases(character as AICharacter, chat.updatedAt || Date.now(), chat, chatMessages)
          .filter((phrase) => phrase.participantIds.includes(character.id || '') && !phrase.participantIds.includes('user'))
          .map((phrase) => ({ chat, chatName: chat.name || '群聊', phrase }));
      })
      .filter((item) => {
        const key = `${item.chat.id}:${item.phrase.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }, [character, chats, messageWindowsByChatId, messages]);
  const roleSharedSecretItems = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const seen = new Set<string>();
    return recentByTime(chats.filter((chat) => chat.type !== 'direct' && chat.memberIds.includes(character.id || '')), 5)
      .flatMap((chat) => buildSharedSecrets(character as AICharacter, chat.updatedAt || Date.now(), chat)
        .filter((secret) => secret.participantIds.includes(character.id || '') && !secret.participantIds.includes('user'))
        .map((secret) => ({ chat, chatName: chat.name || '群聊', secret })))
      .filter((item) => {
        const key = `${item.chat.id}:${item.secret.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }, [character, chats]);
  const roleRitualItems = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const seen = new Set<string>();
    return recentByTime(chats.filter((chat) => chat.type !== 'direct' && chat.memberIds.includes(character.id || '')), 5)
      .flatMap((chat) => {
        const chatMessages = [
          ...(chat.latestMessage ? [chat.latestMessage] : []),
          ...messages.filter((message) => message.chatId === chat.id),
          ...(messageWindowsByChatId[chat.id]?.messages || []),
        ].filter((message, index, source): message is Message => Boolean(message) && source.findIndex((item) => item?.id === message?.id) === index);
        return buildRitualRegistry({
          character: character as AICharacter,
          chat,
          messages: chatMessages,
          now: chat.updatedAt || Date.now(),
        })
          .filter((ritual) => ritual.participantIds.includes(character.id || '') && !ritual.participantIds.includes('user'))
          .map((ritual) => ({ chat, chatName: chat.name || '群聊', ritual }));
      })
      .filter((item) => {
        const key = `${item.chat.id}:${item.ritual.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
  }, [character, chats, messageWindowsByChatId, messages]);
  const sharedMemoryAnchors = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return [];
    const directChat = recentByTime(chats.filter((chat) => chat.type === 'direct' && chat.memberIds.includes(character.id || '')), 1)[0];
    return buildSharedMemoryAnchors(character as AICharacter, character.updatedAt || character.createdAt || 0, directChat);
  }, [character, chats]);
  const latestUserDirectChat = useMemo(() => {
    if (!character.id) return undefined;
    return recentByTime(chats.filter((chat) => chat.type === 'direct' && chat.memberIds.includes(character.id || '')), 1)[0];
  }, [character.id, chats]);
  const companionshipView = useMemo(() => {
    if (!character.id || !character.personality || !character.memory) return null;
    const directChats = chats.filter((chat) => chat.type === 'direct' && chat.memberIds.includes(character.id || ''));
    const views = recentByTime(directChats, 3).map((directChat) => {
      const chatMessages = [
        ...(directChat.latestMessage ? [directChat.latestMessage] : []),
        ...messages.filter((message) => message.chatId === directChat.id),
        ...(messageWindowsByChatId[directChat.id]?.messages || []),
      ].filter((message, index, source): message is Message => Boolean(message) && source.findIndex((item) => item?.id === message?.id) === index);
      const projection = buildUserCompanionshipProjection({
        chat: directChat,
        character: character as AICharacter,
        messages: chatMessages,
      });
      const signature = buildCompanionshipStatusSignature({
        chat: directChat,
        character: character as AICharacter,
        messages: chatMessages,
      });
      if (!signature) return null;
      const trace = buildCompanionshipRuntimeTrace({
        chat: directChat,
        character: character as AICharacter,
        messages: chatMessages,
      });
      const sharedSecrets = buildSharedSecrets(character as AICharacter, directChat.updatedAt || Date.now(), directChat)
        .filter((secret) => secret.participantIds.includes('user'));
      const sharedPhrases = buildSharedPhrases(character as AICharacter, directChat.updatedAt || Date.now(), directChat, chatMessages)
        .filter((phrase) => phrase.participantIds.includes('user'));
      const rituals = buildRitualRegistry({
        character: character as AICharacter,
        chat: directChat,
        messages: chatMessages,
        now: directChat.updatedAt || Date.now(),
      }).filter((ritual) => ritual.participantIds.includes('user'));
      return {
        chatId: directChat.id,
        chatName: directChat.name,
        chat: directChat,
        signature,
        trace,
        pendingCareTopics: projection.userBond?.pendingCareTopics || [],
        pendingPromises: projection.userBond?.pendingPromises || [],
        sharedPhrases,
        sharedSecrets,
        rituals,
      };
    }).filter(Boolean) as Array<{
      chatId: string;
      chatName: string;
      chat: GroupChat;
      signature: NonNullable<ReturnType<typeof buildCompanionshipStatusSignature>>;
      trace: CompanionshipRuntimeTrace | null;
      pendingCareTopics: PendingCareTopic[];
      pendingPromises: PendingPromise[];
      sharedPhrases: SharedPhrase[];
      sharedSecrets: SharedSecret[];
      rituals: RitualRegistryEntry[];
    }>;
    return views.length ? views : null;
  }, [character, chats, messageWindowsByChatId, messages]);

  const appendManualCompanionshipEvents = async (chat: GroupChat, events: RuntimeEventV2[]) => {
    if (!events.length) return;
    const derivedEvents = events.flatMap((event) => buildSharedPhraseEventsFromCompanionshipEvent({ chat, character: character as AICharacter, event }));
    const allEvents = [...events, ...derivedEvents];
    const eventIds = new Set(allEvents.map((item) => item.id));
    const nextRuntimeEvents = [...(chat.runtimeEventsV2 || []).filter((item) => !eventIds.has(item.id)), ...allEvents];
    const nextRelationshipLedger = events.reduce(
      (ledger, event) => applyCompanionshipLedgerBackflow({ ...chat, relationshipLedger: ledger, runtimeEventsV2: nextRuntimeEvents }, event),
      chat.relationshipLedger || [],
    );
    await updateChat(chat.id, {
      runtimeEventsV2: nextRuntimeEvents,
      relationshipLedger: nextRelationshipLedger,
    });
  };

  const appendManualCompanionshipEvent = async (chat: GroupChat, event: RuntimeEventV2) => appendManualCompanionshipEvents(chat, [event]);

  return (
    <PageSection spacing={2}>
      <SurfaceCard>
        <SectionHeader title="关系概览" dense />
        <RelationshipOverviewPanel relationships={relationships} relationshipMemories={relationshipMemories} resolveCharacterName={resolveCharacterName} developerMode={isDeveloperView} members={characters} />
      </SurfaceCard>
      <SurfaceCard>
        <SectionHeader title="角色陪伴" dense action={isDeveloperView ? <DebugChip /> : undefined} />
        <CharacterCompanionshipPanel states={characterCompanionshipStates} resolveCharacterName={resolveCharacterName} developerMode={isDeveloperView} />
        {isDeveloperView ? (
          <PrivateThreadScheduleDiagnosticsPanel
            items={privateThreadScheduleDiagnostics}
            currentCharacterId={character.id || ''}
            resolveCharacterName={resolveCharacterName}
          />
        ) : null}
      </SurfaceCard>
      {roleSharedAnchorItems.length ? (
        <SurfaceCard>
          <SectionHeader title="角色共同锚点" dense action={isDeveloperView ? <DebugChip /> : undefined} />
          <Stack spacing={0.65}>
            {roleSharedAnchorItems.slice(0, isDeveloperView ? 10 : 6).map(({ chat, chatName, anchor }) => (
              <Box key={`${chat.id}-${anchor.id}`}>
                {isDeveloperView ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.35 }}>
                    {chatName}
                  </Typography>
                ) : null}
                <SharedMemoryAnchorPanel
                  characterId={character.id || ''}
                  anchors={[anchor]}
                  participantOptions={participantOptions}
                  resolveCharacterName={resolveCharacterName}
                  developerMode={isDeveloperView}
                  allowNonUserAnchors
                  onArchiveAnchor={(item) => {
                    void appendManualCompanionshipEvent(chat, buildManualSharedAnchorArchiveEvent(chat, character as AICharacter, item));
                  }}
                  onUpdateAnchor={(item, patch) => {
                    void appendManualCompanionshipEvent(chat, buildManualSharedAnchorUpsertEvent(chat, character as AICharacter, item, patch));
                  }}
                  onKeepCharacterPair={(item, targetId) => {
                    void appendManualCompanionshipEvent(chat, buildManualSharedAnchorParticipantsEvent(chat, character as AICharacter, item, [character.id || '', targetId]));
                  }}
                  onUpdateParticipants={(item, participantIds) => {
                    void appendManualCompanionshipEvent(chat, buildManualSharedAnchorParticipantsEvent(chat, character as AICharacter, item, participantIds));
                  }}
                />
              </Box>
            ))}
          </Stack>
        </SurfaceCard>
      ) : null}
      {roleSharedPhraseItems.length ? (
        <SurfaceCard>
          <SectionHeader title="角色共同话语" dense action={isDeveloperView ? <DebugChip /> : undefined} />
          <RoleSharedPhrasePanel
            items={roleSharedPhraseItems}
            characterId={character.id || ''}
            participantOptions={participantOptions}
            resolveCharacterName={resolveCharacterName}
            developerMode={isDeveloperView}
            onUpdateSharedPhrase={(chat, phrase, patch) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedPhraseUpsertEvent(chat, character as AICharacter, phrase, patch));
            }}
            onSuppressSharedPhrase={(chat, phrase) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedPhraseSuppressedEvent(chat, character as AICharacter, phrase));
            }}
            onKeepCharacterPair={(chat, phrase, targetId) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedPhraseParticipantsEvent(chat, character as AICharacter, phrase, [character.id || '', targetId]));
            }}
            onUpdateParticipants={(chat, phrase, participantIds) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedPhraseParticipantsEvent(chat, character as AICharacter, phrase, participantIds));
            }}
          />
        </SurfaceCard>
      ) : null}
      {roleSharedSecretItems.length ? (
        <SurfaceCard>
          <SectionHeader title="角色小秘密" dense action={isDeveloperView ? <DebugChip /> : undefined} />
          <RoleSharedSecretPanel
            items={roleSharedSecretItems}
            characterId={character.id || ''}
            participantOptions={participantOptions}
            resolveCharacterName={resolveCharacterName}
            developerMode={isDeveloperView}
            onUpdateSharedSecretMask={(chat, secret, publicMask) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedSecretMaskEvent(chat, character as AICharacter, secret, publicMask));
            }}
            onRevokeSharedSecret={(chat, secret) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedSecretRevokedEvent(chat, character as AICharacter, secret));
            }}
            onKeepCharacterPair={(chat, secret, targetId) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedSecretParticipantsEvent(chat, character as AICharacter, secret, [character.id || '', targetId]));
            }}
            onUpdateParticipants={(chat, secret, participantIds) => {
              void appendManualCompanionshipEvent(chat, buildManualSharedSecretParticipantsEvent(chat, character as AICharacter, secret, participantIds));
            }}
          />
        </SurfaceCard>
      ) : null}
      {roleRitualItems.length ? (
        <SurfaceCard>
          <SectionHeader title="角色共同仪式" dense action={isDeveloperView ? <DebugChip /> : undefined} />
          <RoleRitualPanel
            items={roleRitualItems}
            characterId={character.id || ''}
            resolveCharacterName={resolveCharacterName}
            developerMode={isDeveloperView}
            onUpdateRitual={(chat, ritual, content) => {
              void appendManualCompanionshipEvent(chat, buildManualRitualUpdateEvent(chat, character as AICharacter, ritual, content));
            }}
            onSuppressRitual={(chat, ritual) => {
              void appendManualCompanionshipEvent(chat, buildManualRitualActionEvent(chat, character as AICharacter, ritual, 'suppressed'));
            }}
            onRestoreRitual={(chat, ritual) => {
              void appendManualCompanionshipEvent(chat, buildManualRitualActionEvent(chat, character as AICharacter, ritual, 'restored'));
            }}
          />
        </SurfaceCard>
      ) : null}
      {sharedMemoryAnchors.length ? (
        <SurfaceCard>
          <SectionHeader title="共同锚点" dense action={isDeveloperView ? <DebugChip /> : undefined} />
          <SharedMemoryAnchorPanel
            characterId={character.id || ''}
            anchors={sharedMemoryAnchors}
            participantOptions={participantOptions}
            resolveCharacterName={resolveCharacterName}
            developerMode={isDeveloperView}
            onArchiveAnchor={latestUserDirectChat ? (anchor) => {
              if (!anchor.participantIds.includes('user')) return;
              void appendManualCompanionshipEvent(latestUserDirectChat, buildManualSharedAnchorArchiveEvent(latestUserDirectChat, character as AICharacter, anchor));
            } : undefined}
            onUpdateAnchor={latestUserDirectChat ? (anchor, patch) => {
              if (!anchor.participantIds.includes('user')) return;
              void appendManualCompanionshipEvent(latestUserDirectChat, buildManualSharedAnchorUpsertEvent(latestUserDirectChat, character as AICharacter, anchor, patch));
            } : undefined}
            onKeepPairPrivate={latestUserDirectChat ? (anchor) => {
              if (!anchor.participantIds.includes('user')) return;
              void appendManualCompanionshipEvent(latestUserDirectChat, buildManualSharedAnchorPairPrivateEvent(latestUserDirectChat, character as AICharacter, anchor));
            } : undefined}
            onUpdateParticipants={latestUserDirectChat ? (anchor, participantIds) => {
              if (!anchor.participantIds.includes('user')) return;
              void appendManualCompanionshipEvent(latestUserDirectChat, buildManualSharedAnchorParticipantsEvent(latestUserDirectChat, character as AICharacter, anchor, participantIds));
            } : undefined}
          />
        </SurfaceCard>
      ) : null}
      <SurfaceCard>
        <SectionHeader title="陪伴关系" dense action={isDeveloperView ? <DebugChip /> : undefined} />
        {companionshipView?.length ? (
          <Stack spacing={1.25}>
            {companionshipView.map((view) => (
              <UserCompanionshipCard
                key={view.chatId}
                characterId={character.id || ''}
                chatName={view.chatName}
                signature={view.signature}
                trace={view.trace}
                participantOptions={participantOptions}
                resolveCharacterName={resolveCharacterName}
                pendingCareTopics={view.pendingCareTopics}
                pendingPromises={view.pendingPromises}
                sharedPhrases={view.sharedPhrases}
                sharedSecrets={view.sharedSecrets}
                rituals={view.rituals}
                onBlockCareTopic={(topic) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualCareTopicBlockedEvent(view.chat, character as AICharacter, topic));
                }}
                onUpdatePromiseLifecycle={(promise, action) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualPromiseLifecycleEvent(view.chat, character as AICharacter, promise, action));
                }}
                onUpdatePromise={(promise, patch) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualPromiseUpsertEvent(view.chat, character as AICharacter, promise, patch));
                }}
                onMergePromise={(promise, target) => {
                  const index = view.pendingPromises.findIndex((item) => item.id === promise.id);
                  const kept = target === 'previous' ? view.pendingPromises[index - 1] : view.pendingPromises[index + 1];
                  if (!kept) return;
                  void appendManualCompanionshipEvents(view.chat, buildManualPromiseMergeEvents(view.chat, character as AICharacter, kept, promise));
                }}
                onSetAddress={(action, address) => {
                  if (!address.trim()) return;
                  void appendManualCompanionshipEvent(view.chat, buildManualAddressingSetEvent(view.chat, character as AICharacter, action, address));
                }}
                onForbidAddress={(address) => {
                  if (!address.trim()) return;
                  void appendManualCompanionshipEvent(view.chat, buildManualAddressingEvent(view.chat, character as AICharacter, 'forbid', address));
                }}
                onUnforbidAddress={(address) => {
                  if (!address.trim()) return;
                  void appendManualCompanionshipEvent(view.chat, buildManualAddressingEvent(view.chat, character as AICharacter, 'unforbid', address));
                }}
                onResolveConflict={(conflict) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualIntimateConflictResolvedEvent(view.chat, character as AICharacter, conflict));
                }}
                onDismissConflict={(conflict) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualIntimateConflictDismissedEvent(view.chat, character as AICharacter, conflict));
                }}
                onDisableAttachment={() => {
                  void appendManualCompanionshipEvent(view.chat, buildManualAttachmentProfileEvent(view.chat, character as AICharacter, 'disabled'));
                }}
                onEnableAttachment={() => {
                  void appendManualCompanionshipEvent(view.chat, buildManualAttachmentProfileEvent(view.chat, character as AICharacter, 'enabled'));
                }}
                onCorrectAttachment={(style) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualAttachmentProfileEvent(view.chat, character as AICharacter, 'corrected', style));
                }}
                onRestoreAttachment={(item) => {
                  if (!item.inferredStyle) return;
                  void appendManualCompanionshipEvent(
                    view.chat,
                    buildManualAttachmentProfileEvent(
                      view.chat,
                      character as AICharacter,
                      'corrected',
                      item.inferredStyle,
                      `用户在开发者诊断中从互动节奏历史 ${item.id} 恢复为${formatInteractionPacePreferenceLabel(item.inferredStyle)}。`,
                    ),
                  );
                }}
                onRestoreConflict={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualIntimateConflictRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestorePhase={(item) => {
                  if (!item.phase) return;
                  void appendManualCompanionshipEvent(view.chat, buildManualPhaseRestoreFromHistoryEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreUserProfile={(item) => {
                  if (!item.items.length) return;
                  void appendManualCompanionshipEvent(view.chat, buildManualUserProfileMemoryRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreCareTopic={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualCareTopicRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestorePromise={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualPromiseRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreSharedAnchor={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedAnchorRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreSharedSecretPublic={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretRestorePublicEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreSharedPhrase={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedPhraseRestoreEvent(view.chat, character as AICharacter, item));
                }}
                onRestoreRitualFromHistory={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualRitualRestoreFromHistoryEvent(view.chat, character as AICharacter, item));
                }}
                onUpdateProfileCue={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualUserProfileMemoryUpsertEvent(view.chat, character as AICharacter, item));
                }}
                onRevokeProfileCue={(item) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualUserProfileMemoryRevokeEvent(view.chat, character as AICharacter, item));
                }}
                onRevokeSharedSecret={(secret) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretRevokedEvent(view.chat, character as AICharacter, secret));
                }}
                onUpdateSharedSecretMask={(secret, publicMask) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretMaskEvent(view.chat, character as AICharacter, secret, publicMask));
                }}
                onCorrectSharedSecretConsequence={(secret, consequenceKind) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretConsequenceEvent(view.chat, character as AICharacter, secret, consequenceKind));
                }}
                onKeepSharedSecretPairPrivate={(secret) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretPairPrivateEvent(view.chat, character as AICharacter, secret));
                }}
                onUpdateSharedSecretParticipants={(secret, participantIds) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedSecretParticipantsEvent(view.chat, character as AICharacter, secret, participantIds));
                }}
                onUpdateSharedPhrase={(phrase, patch) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedPhraseUpsertEvent(view.chat, character as AICharacter, phrase, patch));
                }}
                onSuppressSharedPhrase={(phrase) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedPhraseSuppressedEvent(view.chat, character as AICharacter, phrase));
                }}
                onKeepSharedPhrasePairPrivate={(phrase) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedPhrasePairPrivateEvent(view.chat, character as AICharacter, phrase));
                }}
                onUpdateSharedPhraseParticipants={(phrase, participantIds) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualSharedPhraseParticipantsEvent(view.chat, character as AICharacter, phrase, participantIds));
                }}
                onUpdateRitual={(ritual, content) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualRitualUpdateEvent(view.chat, character as AICharacter, ritual, content));
                }}
                onSuppressRitual={(ritual) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualRitualActionEvent(view.chat, character as AICharacter, ritual, 'suppressed'));
                }}
                onRestoreRitual={(ritual) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualRitualActionEvent(view.chat, character as AICharacter, ritual, 'restored'));
                }}
                onCorrectPhase={(phase, style) => {
                  void appendManualCompanionshipEvent(view.chat, buildManualPhaseCorrectionEvent(view.chat, character as AICharacter, phase, style));
                }}
                onRevokePhase={() => {
                  void appendManualCompanionshipEvent(view.chat, buildManualPhaseRevokeEvent(view.chat, character as AICharacter));
                }}
                developerMode={isDeveloperView}
              />
            ))}
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">
            暂无可投影的用户单聊陪伴关系。建立单聊并产生互动后，这里会显示称呼、关心事项和关系边界。
          </Typography>
        )}
      </SurfaceCard>
    </PageSection>
  );
}

export default function RuntimeInsightsPanel({ character }: RuntimeInsightsPanelProps) {
  const { i18n } = useTranslation();
  const [viewMode, setViewMode] = useState<'timeline' | 'graph'>('timeline');
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'memory' | 'relationship' | 'drift'>('all');
  const characters = useCharacterStore((state) => state.characters);
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showDeveloperMemory = useSettingsStore((state) => state.developerUI.showMemoryDebug);
  const showCompanionshipDebug = useSettingsStore((state) => state.developerUI.showCompanionshipDebug);
  const isDeveloperView = developerMode && Boolean(showDeveloperMemory || showCompanionshipDebug);
  const relationships = useMemo(() => character.relationships || [], [character.relationships]);
  const resolveCharacterName = useMemo(() => {
    const byId = new Map(characters.map((item) => [item.id, item.name]));
    return (id: string, fallback?: string) => {
      const matched = byId.get(id);
      if (matched) return matched;
      return resolveFallbackCharacterName(id, fallback);
    };
  }, [characters]);
  const behavior = character.behavior;
  const personalityDrift = useMemo(() => character.personalityDrift || {}, [character.personalityDrift]);
  const effectiveBehavior = useMemo(
    () => (character.behavior ? applyDriftToBehavior(character as AICharacter) : null),
    [character]
  );
  const fallbackTimelineAt = character.updatedAt || character.createdAt || 0;
  const driftSummary = formatLocalizedDriftSummary(personalityDrift, i18n.language);
  const timeline = useMemo(() => character.runtimeTimeline || [
    ...relationships.slice(-3).map((relation) => ({ type: 'relationship' as const, text: `${relation.note || relation.characterId} · ${relation.updatedAt ? new Date(relation.updatedAt).toLocaleString() : '最近更新'}`, createdAt: relation.updatedAt || fallbackTimelineAt })),
    ...(driftSummary ? [{ type: 'drift' as const, text: driftSummary, createdAt: fallbackTimelineAt }] : []),
  ], [character.runtimeTimeline, relationships, fallbackTimelineAt, driftSummary]);
  const filteredTimeline = timelineFilter === 'all' ? timeline : timeline.filter((item) => item.type === timelineFilter);
  const dominantEmotionLabel = getDominantEmotionLabel(character.emotionalState, i18n.language);
  const runtimeSummaryItems = [
    relationships[0] ? `关系 ${relationships[0].warmth + relationships[0].competence + relationships[0].trust >= relationships[0].threat + 12 ? '升温' : '紧张'}` : '',
    ...buildDriftChips(personalityDrift, i18n.language, isDeveloperView).slice(0, 1),
    dominantEmotionLabel ? `情绪 ${dominantEmotionLabel}` : '',
  ].filter(Boolean);
  const behaviorFormulaHints = useMemo(() => {
    const drift = personalityDrift || {};
    const d = (key: string) => Number(drift[key as keyof typeof drift] || 0);
    const isZh = i18n.language.startsWith('zh');
    const fmt = (value: number) => (value > 0 ? `+${value}` : `${value}`);
    return {
      proactivity: isZh
        ? `主动性 = 基础值 + 外向性×0.6 + 果断度×0.35\n当前值：${fmt(Math.round(d('extroversion') * 0.6))} + ${fmt(Math.round(d('assertiveness') * 0.35))}`
        : `Proactivity = base + extroversion×0.6 + assertiveness×0.35\nCurrent: ${fmt(Math.round(d('extroversion') * 0.6))} + ${fmt(Math.round(d('assertiveness') * 0.35))}`,
      aggressiveness: isZh
        ? `攻击性 = 基础值 + 敏感度×0.5 + 果断度×0.3\n当前值：${fmt(Math.round(d('neuroticism') * 0.5))} + ${fmt(Math.round(d('assertiveness') * 0.3))}`
        : `Aggressiveness = base + neuroticism×0.5 + assertiveness×0.3\nCurrent: ${fmt(Math.round(d('neuroticism') * 0.5))} + ${fmt(Math.round(d('assertiveness') * 0.3))}`,
      humorIntensity: isZh
        ? `幽默感 = 基础值 + 幽默×0.45 + 创造力×0.25\n当前值：${fmt(Math.round(d('humor') * 0.45))} + ${fmt(Math.round(d('creativity') * 0.25))}`
        : `Humor = base + humor×0.45 + creativity×0.25\nCurrent: ${fmt(Math.round(d('humor') * 0.45))} + ${fmt(Math.round(d('creativity') * 0.25))}`,
      empathyLevel: isZh
        ? `共情度 = 基础值 + 共情力×0.8 + 宜人性×0.35\n当前值：${fmt(Math.round(d('empathy') * 0.8))} + ${fmt(Math.round(d('agreeableness') * 0.35))}`
        : `Empathy = base + empathy×0.8 + agreeableness×0.35\nCurrent: ${fmt(Math.round(d('empathy') * 0.8))} + ${fmt(Math.round(d('agreeableness') * 0.35))}`,
      summarizing: isZh
        ? `总结倾向 = 基础值 + 开放性×0.35\n当前值：${fmt(Math.round(d('openness') * 0.35))}`
        : `Summarizing = base + openness×0.35\nCurrent: ${fmt(Math.round(d('openness') * 0.35))}`,
      offTopic: isZh
        ? `跑题倾向 = 基础值 + 开放性×0.25 + 创造力×0.2\n当前值：${fmt(Math.round(d('openness') * 0.25))} + ${fmt(Math.round(d('creativity') * 0.2))}`
        : `Off-topic = base + openness×0.25 + creativity×0.2\nCurrent: ${fmt(Math.round(d('openness') * 0.25))} + ${fmt(Math.round(d('creativity') * 0.2))}`,
    } as Record<string, string>;
  }, [i18n.language, personalityDrift]);

  const behaviorChartItems = useMemo(
    () => Object.entries(effectiveBehavior || behavior || {}).map(([key, value]) => ({
      label: getTraitLabel(key, i18n.language),
      value: Number(value),
      hint: behaviorFormulaHints[key] || undefined,
    })),
    [behavior, behaviorFormulaHints, effectiveBehavior, i18n.language]
  );
  const runtimeAffectHints = getAffectSummaryLines(character as AICharacter, i18n.language).slice(0, isDeveloperView ? 4 : 2);
  const hasRuntimeSummary = runtimeSummaryItems.length > 0;
  const emotionChips = buildEmotionChips(character, i18n.language);
  const shouldShowEmotionCard = isDeveloperView || !character.emotionalState || emotionChips.length > 0;

  return (
    <PageSection spacing={2}>
      <SoulOverviewPanel character={character} resolveCharacterName={resolveCharacterName} developerMode={isDeveloperView} />

      <SurfaceCard>
        <SectionHeader title="运行态观察" dense action={isDeveloperView ? <DebugChip /> : undefined} />
        {hasRuntimeSummary ? <Box sx={{ mt: 0.5 }}><StatChipRow items={runtimeSummaryItems} /></Box> : <Typography variant="caption" color="text.secondary">暂无运行态观察结果</Typography>}
      </SurfaceCard>

      <SoulStatePanel character={character} developerMode={isDeveloperView} />

      {shouldShowEmotionCard ? (
        <SurfaceCard>
          <SectionHeader title="情绪状态" dense action={isDeveloperView && runtimeAffectHints.length ? <Chip size="small" label="变化" color="warning" variant="outlined" /> : undefined} />
          <Stack spacing={1}>
            <EmotionPanel character={character} developerMode={isDeveloperView} emotionChips={emotionChips} />
            {isDeveloperView && runtimeAffectHints.length ? <StatChipRow items={runtimeAffectHints} /> : null}
          </Stack>
        </SurfaceCard>
      ) : null}

      <SurfaceCard>
        <SectionHeader title="行为 / 漂移" dense />
        <Stack spacing={1.25}>
          {isDeveloperView ? (
            <SimpleBarChart
              title={i18n.language.startsWith('zh') ? '行为强度' : 'Behavior intensity'}
              items={behaviorChartItems}
            />
          ) : null}
          <Stack spacing={0.75}>
            <Typography variant="subtitle2" color="text.primary" sx={{ fontWeight: 700 }}>
              {i18n.language.startsWith('zh') ? '人格漂移' : 'Personality drift'}
            </Typography>
            {Object.keys(personalityDrift).length
              ? <StatChipRow items={buildDriftChips(personalityDrift, i18n.language, isDeveloperView)} />
              : <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '暂无显著漂移' : 'No significant drift yet'}</Typography>}
          </Stack>
        </Stack>
      </SurfaceCard>

      <SurfaceCard>
        <SectionHeader title="运行时间线" dense action={<StatChipRow items={[viewMode === 'timeline' ? '时间线' : '关系摘要']} />} />
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1.25 }}>
          <Chip size="small" label="时间线" color={viewMode === 'timeline' ? 'primary' : 'default'} variant={viewMode === 'timeline' ? 'filled' : 'outlined'} onClick={() => setViewMode('timeline')} />
          <Chip size="small" label="关系摘要" color={viewMode === 'graph' ? 'primary' : 'default'} variant={viewMode === 'graph' ? 'filled' : 'outlined'} onClick={() => setViewMode('graph')} />
        </Box>
        {viewMode === 'timeline' ? (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.25 }}>
              {[
                ['all', '全部'],
                ['memory', '记忆'],
                ['relationship', '关系'],
                ['drift', '漂移'],
              ].map(([value, label]) => (
                <Chip key={value} size="small" label={label} color={timelineFilter === value ? 'primary' : 'default'} variant={timelineFilter === value ? 'filled' : 'outlined'} onClick={() => setTimelineFilter(value as 'all' | 'memory' | 'relationship' | 'drift')} />
              ))}
            </Box>
            <RuntimeTimelinePanel filteredTimeline={filteredTimeline} developerMode={isDeveloperView} members={characters} />
          </>
        ) : (
          <RelationshipGraphPanel relationships={relationships} developerMode={isDeveloperView} resolveCharacterName={resolveCharacterName} members={characters} />
        )}
      </SurfaceCard>

      {developerMode ? <CharacterExperienceArtifactPanel character={character} relatedCharacters={characters} /> : null}
    </PageSection>
  );
}
