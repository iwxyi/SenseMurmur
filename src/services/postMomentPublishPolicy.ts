import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { SocialEventCandidatePayload, SocialEventKind } from '../types/runtimeEvent';
import { isCharacterFeatureEnabled } from './characterGenerationPolicy';

export type PostMomentPublishGuardResult = {
  allow: true;
} | {
  allow: false;
  reasonType: 'world_attention_moment_disabled' | 'world_attention_moment_quiet_hours' | 'world_attention_moment_spam_window' | 'world_attention_moment_delay_window';
  reasonLabel: string;
  reasonDetail: string;
  nextSuggestedAt?: number;
};

export const POST_MOMENT_DELAY_SOURCE_EVENT_KINDS = [
  'social_outing',
  'check_in',
  'react_to_moment',
  'status_update',
  'gift_exchange',
] as const satisfies readonly SocialEventCandidatePayload['eventKind'][];

const postMomentDelaySourceEventKindSet = new Set<string>(POST_MOMENT_DELAY_SOURCE_EVENT_KINDS);

export function isPostMomentDelaySourceEventKind(eventKind: SocialEventKind | string | null | undefined): eventKind is typeof POST_MOMENT_DELAY_SOURCE_EVENT_KINDS[number] {
  return typeof eventKind === 'string' && postMomentDelaySourceEventKindSet.has(eventKind);
}

export function resolvePostMomentPublishGuard(params: {
  chat: GroupChat;
  payload: SocialEventCandidatePayload;
  actor: AICharacter | null;
  now?: number;
  additionalSocialEventCreatedAts?: number[];
}): PostMomentPublishGuardResult {
  const now = typeof params.now === 'number' ? params.now : Date.now();
  const actorId = params.payload.initiatorId;
  if (!actorId) return { allow: true };
  if (!isCharacterFeatureEnabled(params.actor, 'moments')) {
    return {
      allow: false,
      reasonType: 'world_attention_moment_disabled',
      reasonLabel: '朋友圈功能关闭',
      reasonDetail: '该角色当前不允许自动发朋友圈，已取消本次动态发布。',
    };
  }
  const recentPostMomentArtifacts = (params.chat.runtimeEventsV2 || [])
    .filter((event) => {
      if (event.kind !== 'artifact') return false;
      if ((event.actorIds || [])[0] !== actorId) return false;
      const payload = event.payload as { eventKind?: string; artifactType?: string; processedAt?: number };
      if (now - (payload.processedAt || event.createdAt) > 90 * 60_000) return false;
      return payload.eventKind === 'post_moment' && payload.artifactType === 'moment_text';
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest = recentPostMomentArtifacts[0];
  const latestProcessedAt = latest && ((latest.payload as { processedAt?: number }).processedAt || latest.createdAt);
  if (latestProcessedAt && now - latestProcessedAt < 90 * 60_000) {
    return {
      allow: false,
      reasonType: 'world_attention_moment_spam_window',
      reasonLabel: '发圈冷却中',
      reasonDetail: '短时间内已发布动态，延后本次发布以避免刷屏。',
      nextSuggestedAt: latestProcessedAt + 90 * 60_000,
    };
  }

  const recentSocialArtifactAt = [
    ...(params.additionalSocialEventCreatedAts || []),
    ...(params.chat.runtimeEventsV2 || [])
    .filter((event) => {
      if (event.kind !== 'artifact') return false;
      if ((event.actorIds || [])[0] !== actorId) return false;
      const payload = event.payload as { eventKind?: string };
      return isPostMomentDelaySourceEventKind(payload.eventKind);
    })
    .map((event) => event.createdAt),
  ]
    .sort((a, b) => b - a)[0];
  if (typeof recentSocialArtifactAt === 'number' && now - recentSocialArtifactAt < 18 * 60_000) {
    return {
      allow: false,
      reasonType: 'world_attention_moment_delay_window',
      reasonLabel: '发圈延迟窗口',
      reasonDetail: '最近刚发生社交动作，动态发布延后，避免机械式“立刻发圈”。',
      nextSuggestedAt: recentSocialArtifactAt + 18 * 60_000,
    };
  }
  return { allow: true };
}
