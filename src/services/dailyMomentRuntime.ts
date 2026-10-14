import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { getUsablePreferredAIProfile, normalizeMaxOutputTokens, type AIModelProfile } from '../types/settings';
import { generateImageWithAdapter, generateTextWithAdapter } from './aiGenerationAdapter';
import { isCharacterFeatureEnabled } from './characterGenerationPolicy';
import { updateSourceChatAfterPostMoment } from './directSessionRuntime';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { resolveMemoryDisclosureMetadata } from './memoryDisclosure';
import { persistGeneratedMomentMedia, type StoredMomentMedia } from './momentMediaStorage';
import { resolvePostMomentPublishGuard } from './postMomentPublishPolicy';
import { retainRuntimeEvents } from './runtimeEventRetention';

const runningActors = new Set<string>();

function startOfDay(now: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function hasTodayMoment(chats: GroupChat[], actorId: string, now: number) {
  return chats.some((chat) => chat.deletedAt == null && (chat.runtimeEventsV2 || []).some((event) => {
    const payload = event.payload as { eventKind?: string; artifactType?: string };
    return event.kind === 'artifact' && event.actorIds?.[0] === actorId && event.createdAt >= startOfDay(now)
      && payload.eventKind === 'post_moment' && payload.artifactType === 'moment_text';
  }));
}

export function getDailyMomentMemories(actor: AICharacter, chat: GroupChat, now = Date.now()) {
  const today = startOfDay(now);
  return [...(actor.layeredMemories || []), ...(chat.layeredMemories || [])]
    .filter((memory) => {
      const disclosure = resolveMemoryDisclosureMetadata(memory);
      const timestamp = memory.updatedAt || memory.createdAt;
      return !memory.archivedAt && timestamp >= today && timestamp <= now
        && (memory.ownerId === actor.id || memory.subjectIds?.includes(actor.id))
        && memory.scope !== 'system_runtime' && memory.kind !== 'taboo'
        && disclosure.visibility === 'public_safe' && disclosure.validity === 'active'
        && disclosure.privacyRisk < 0.3 && disclosure.subjectOwner !== 'user'
        && !memory.subjectIds?.includes('user');
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((memory) => memory.text.trim())
    .filter(Boolean)
    .filter((text, index, texts) => texts.indexOf(text) === index)
    .slice(0, 6);
}

interface DailyMomentOps {
  isCurrentSource: () => boolean;
  getChats: () => GroupChat[];
  getCharacters: () => AICharacter[];
  getProfiles: () => AIModelProfile[];
  loadCharacter: (id: string) => Promise<AICharacter | null>;
  applyChatRuntimePatch: (id: string, build: (chat: GroupChat) => Partial<GroupChat> | null) => Promise<boolean>;
  onImageError: (error: unknown) => void;
}

// One owner room per character prevents parallel room timers from publishing twice.
export async function runDailyMomentFlow(chatId: string, ops: DailyMomentOps) {
  if (!ops.isCurrentSource()) return;
  const chat = ops.getChats().find((item) => item.id === chatId);
  if (!chat || chat.deletedAt != null || chat.type !== 'group' || !chat.isActive) return;
  if (!getUsablePreferredAIProfile(ops.getProfiles(), 'text')) return;
  const errors: unknown[] = [];
  for (const actorId of chat.memberIds) {
    if (actorId === 'user' || runningActors.has(actorId)) continue;
    const ownerRoom = ops.getChats().filter((item) => item.type === 'group' && item.isActive
      && item.deletedAt == null && item.memberIds.includes(actorId)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (ownerRoom?.id !== chatId || hasTodayMoment(ops.getChats(), actorId, Date.now())) continue;
    runningActors.add(actorId);
    try {
      const actor = await ops.loadCharacter(actorId);
      if (!ops.isCurrentSource()) return;
      if (!actor || actor.deletedAt != null || !isCharacterFeatureEnabled(actor, 'moments')) continue;
      const currentChat = ops.getChats().find((item) => item.id === chatId);
      if (!currentChat || !currentChat.isActive || currentChat.deletedAt != null) continue;
      const now = Date.now();
      const memories = getDailyMomentMemories(actor, currentChat, now);
      if (!memories.length) continue;
      const members = ops.getCharacters().map((item) => ({ id: item.id, name: item.name }));
      const sourceText = memories.map((text) => sanitizeUserFacingText(text, members)).join('\n');
      const date = new Date(now);
      const dateKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      const payload: SocialEventCandidatePayload = {
        eventKind: 'post_moment', initiatorId: actorId, participantIds: [actorId], targetIds: [],
        reasonType: 'world_attention_share_moment_event', confidence: 0.9, urgency: 'soon',
        seedIntent: '从今天自己的公开记忆里，挑一个想留下的片段。', sourceText,
        visibilityPlan: 'public', expectedArtifacts: ['moment_text'],
        title: '今日碎片', activityType: '日常动态', dedupeKey: `daily-moment-${actorId}-${dateKey}`,
      };
      const guardChat = { ...currentChat, runtimeEventsV2: ops.getChats().flatMap((item) => item.deletedAt == null ? item.runtimeEventsV2 || [] : []) };
      if (!resolvePostMomentPublishGuard({ chat: guardChat, actor, payload, now }).allow) continue;
      const textProfile = getUsablePreferredAIProfile(ops.getProfiles(), 'text');
      if (!textProfile) continue;
      const rawText = await generateTextWithAdapter({
        profile: textProfile,
        systemPrompt: '用角色自己的语气写一条公开朋友圈。只输出正文，不要标题、JSON或系统说明。只能使用提供的公开记忆，不编造活动、经历或人物，不点名用户，不泄露私聊、秘密、内部字段或身份标识。',
        messages: [{ role: 'user', content: [
          `角色：${sanitizeUserFacingText(actor.name, members)}`,
          `背景：${sanitizeUserFacingText(actor.background, members)}`,
          `说话风格：${sanitizeUserFacingText(actor.speakingStyle, members)}`,
          `今天：${date.toLocaleDateString()}`,
          `今天的公开记忆：\n${sourceText}`,
          '选一个具体片段，写成100字以内自然、简短的随手记录或心情。不复述全部记忆。',
        ].join('\n') }],
        // Reasoning models share their output budget with thinking; use the profile limit.
        maxTokens: normalizeMaxOutputTokens(textProfile.maxOutputTokens),
        aiUsage: { type: 'moment_generation', label: '生成每日朋友圈', scope: 'moment', resourceId: chatId },
      });
      if (!ops.isCurrentSource()) return;
      payload.momentText = sanitizeUserFacingText(rawText.replace(/^```(?:text)?\s*|\s*```$/gi, '').trim(), members);
      if (!payload.momentText || /^[{[]/.test(payload.momentText)) throw new Error('朋友圈模型未返回有效正文');
      const candidate: RuntimeEventV2 = {
        id: payload.dedupeKey!, conversationId: chatId, kind: 'event_candidate', createdAt: now,
        actorIds: [actorId], targetIds: [], visibility: 'derived_public', summary: `${actor.name} 想记录今天的片段`, payload,
      };
      const prepared = updateSourceChatAfterPostMoment(currentChat, payload, actor.name, { createdAt: now });
      const artifact = prepared.runtimeEventsV2?.find((event) => event.createdAt === now + 2
        && event.kind === 'artifact' && (event.payload as { dedupeKey?: string }).dedupeKey === payload.dedupeKey);
      if (!artifact) throw new Error('朋友圈发布产物未创建');
      let media: StoredMomentMedia[] = [];
      const imageProfile = getUsablePreferredAIProfile(ops.getProfiles(), 'image');
      const imageDay = [...`${actorId}:${dateKey}`].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 2 === 0;
      if (imageProfile && imageDay) {
        try {
          const images = await generateImageWithAdapter({ profile: imageProfile,
            prompt: `Create a candid image illustrating this character's public memory. Do not invent additional people or events. No text, no watermark. Character: ${sanitizeUserFacingText(actor.name, members)}. Memory: ${sourceText}. Post: ${payload.momentText}`,
            count: 1, intent: 'chat-image', character: actor, characters: [actor],
            allowCharacterReferenceImages: true, useCharacterReferenceImages: true,
            negativePrompt: actor.visualIdentity?.negativePrompt, seed: actor.visualIdentity?.seed,
            aiUsage: { type: 'moment_generation', label: '生成朋友圈配图', scope: 'moment', resourceId: chatId },
          });
          if (!images[0]?.dataUrl) throw new Error('朋友圈图片模型未返回图片');
          const stored = await persistGeneratedMomentMedia({ chatId, eventId: artifact.id, actor,
            dataUrl: images[0].dataUrl, mimeType: images[0].mimeType, alt: '今日碎片' });
          if (!stored) throw new Error('朋友圈图片未保存');
          media = [stored];
        } catch (error) {
          ops.onImageError(error);
        }
      }
      await ops.applyChatRuntimePatch(chatId, (latest) => {
        const latestActor = ops.getCharacters().find((item) => item.id === actorId);
        if (!ops.isCurrentSource() || !latest.isActive || latest.deletedAt != null || !latest.memberIds.includes(actorId)
          || !latestActor || latestActor.deletedAt != null || !isCharacterFeatureEnabled(latestActor, 'moments')
          || startOfDay(Date.now()) !== startOfDay(now) || hasTodayMoment(ops.getChats(), actorId, Date.now())) return null;
        const latestGuardChat = { ...latest, runtimeEventsV2: ops.getChats().flatMap((item) => item.deletedAt == null ? item.runtimeEventsV2 || [] : []) };
        if (!resolvePostMomentPublishGuard({ chat: latestGuardChat, actor: latestActor, payload }).allow) return null;
        const patch = updateSourceChatAfterPostMoment(latest, payload, actor.name, { createdAt: now });
        const handled: RuntimeEventV2 = {
          id: `${candidate.id}-handled`, conversationId: chatId, kind: 'artifact', createdAt: now + 3,
          actorIds: [actorId], visibility: 'derived_public', summary: `handled_social_event:${candidate.id}`,
          payload: { artifactType: 'handled_social_event', eventId: candidate.id },
        };
        return { ...patch, runtimeEventsV2: retainRuntimeEvents([
          candidate,
          ...(patch.runtimeEventsV2 || []).map((event) => event.id === artifact.id
            ? { ...event, payload: { ...event.payload, candidateId: candidate.id, media } } : event),
          handled,
        ], 160) };
      });
    } catch (error) {
      errors.push(error);
    } finally {
      runningActors.delete(actorId);
    }
  }
  if (errors.length) throw new AggregateError(errors, '每日朋友圈生成失败');
}
