import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { RuntimeEventV2, SocialEventCandidatePayload } from '../types/runtimeEvent';
import { getUsablePreferredAIProfile, type AIModelProfile } from '../types/settings';
import { generateImageWithAdapter, generateJsonWithAdapter } from './aiGenerationAdapter';
import { isCharacterFeatureEnabled } from './characterGenerationPolicy';
import { updateSourceChatAfterPostMoment } from './directSessionRuntime';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { resolveMemoryDisclosureMetadata } from './memoryDisclosure';
import { persistGeneratedMomentMedia, type StoredMomentMedia } from './momentMediaStorage';
import { resolvePostMomentPublishGuard } from './postMomentPublishPolicy';
import { retainRuntimeEvents } from './runtimeEventRetention';
import { characterPublicationOffset, MOMENT_SPREAD_WINDOW_MS } from './characterPublicationSchedule';

const runningActors = new Set<string>();
const CHAT_QUIET_PERIOD_MS = 18 * 60_000;

interface DailyMomentFailure {
  actorId: string;
  stage: string;
  error: unknown;
  provider?: string;
  model?: string;
}

function createRuntimeEventId() {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `runtime-${Date.now().toString(36)}-${suffix}`;
}

export class DailyMomentFlowError extends AggregateError {
  readonly failures: DailyMomentFailure[];

  constructor(failures: DailyMomentFailure[]) {
    const summaries = failures.map(({ actorId, stage, error }) => {
      const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
        ? error.diagnostic as { status?: number } | undefined : undefined;
      const location = `${actorId} / ${stage}`;
      return diagnostic?.status ? `${location}：HTTP ${diagnostic.status}` : location;
    });
    super(failures.map(({ error }) => error), `每日朋友圈生成失败（${summaries.join('；')}）`);
    this.name = 'DailyMomentFlowError';
    this.failures = failures;
  }
}

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

function memorySignature(items: ReturnType<typeof getDailyMomentMemoryItems>) {
  const source = items.map((item) => `${item.id}:${item.updatedAt || item.createdAt}:${item.text}`).join('|');
  return [...source].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0).toString(36);
}

function hasSkippedMemories(chats: GroupChat[], actorId: string, signature: string, now: number) {
  return chats.some((chat) => chat.deletedAt == null && (chat.runtimeEventsV2 || []).some((event) => {
    const payload = event.payload as { artifactType?: string; memorySignature?: string };
    return event.kind === 'artifact' && event.actorIds?.[0] === actorId && event.createdAt >= startOfDay(now)
      && payload.artifactType === 'daily_moment_skip' && payload.memorySignature === signature;
  }));
}

function parseMomentDecision(raw: string): { publish: boolean; text: string } {
  const parsed: unknown = JSON.parse(raw.trim());
  if (!parsed || typeof parsed !== 'object' || !('publish' in parsed) || typeof parsed.publish !== 'boolean') {
    throw new Error('朋友圈模型未返回有效发布判断');
  }
  const decision = parsed as { publish: boolean; text?: unknown };
  if (decision.publish && (typeof decision.text !== 'string' || !decision.text.trim())) {
    throw new Error('朋友圈模型未返回有效正文');
  }
  return { publish: decision.publish, text: decision.publish ? (decision.text as string).trim() : '' };
}

function dailyTimingMinutes(actorId: string, now: number, salt: string, base: number, spread: number) {
  const date = new Date(now);
  const key = `${actorId}:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}:${salt}`;
  const hash = [...key].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return base + hash % spread;
}

function nextDailyMomentTime(chats: GroupChat[], actorId: string, memoryAt: number, now: number) {
  const latestConversationAt = Math.max(0, ...chats.filter((item) => item.deletedAt == null
    && item.type === 'group' && item.isActive && item.memberIds.includes(actorId))
    .map((item) => item.lastMessageAt || 0).filter((at) => at <= now));
  const memoryDelayMinutes = dailyTimingMinutes(actorId, now, 'memory', 25, 121);
  return Math.max(memoryAt + memoryDelayMinutes * 60_000,
    latestConversationAt + CHAT_QUIET_PERIOD_MS);
}

function getDailyMomentMemoryItems(actor: AICharacter, chat: GroupChat, now: number) {
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
    .filter((item) => item.text.trim())
    .filter((item, index, items) => items.findIndex((candidate) => candidate.text.trim() === item.text.trim()) === index)
    .slice(0, 6);
}

export function getDailyMomentMemories(actor: AICharacter, chat: GroupChat, now = Date.now()) {
  return getDailyMomentMemoryItems(actor, chat, now)
    .map((memory) => memory.text.trim());
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
  const failures: DailyMomentFailure[] = [];
  let nextCheckAt: number | undefined;
  for (const actorId of chat.memberIds) {
    if (actorId === 'user' || runningActors.has(actorId)) continue;
    const ownerRoom = ops.getChats().filter((item) => item.type === 'group' && item.isActive
      && item.deletedAt == null && item.memberIds.includes(actorId)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (ownerRoom?.id !== chatId || hasTodayMoment(ops.getChats(), actorId, Date.now())) continue;
    runningActors.add(actorId);
    let stage = '加载角色';
    try {
      const actor = await ops.loadCharacter(actorId);
      if (!ops.isCurrentSource()) return;
      if (!actor || actor.deletedAt != null || !isCharacterFeatureEnabled(actor, 'moments')) continue;
      const currentChat = ops.getChats().find((item) => item.id === chatId);
      if (!currentChat || !currentChat.isActive || currentChat.deletedAt != null) continue;
      const now = Date.now();
      const memoryItems = getDailyMomentMemoryItems(actor, currentChat, now);
      const memories = getDailyMomentMemories(actor, currentChat, now);
      if (!memories.length) continue;
      const signature = memorySignature(memoryItems);
      if (hasSkippedMemories(ops.getChats(), actorId, signature, now)) continue;
      const memoryAt = Math.max(...memoryItems.map((item) => item.updatedAt || item.createdAt));
      let appointmentAt = now;
      if (ops.getCharacters().filter((item) => item.deletedAt == null && isCharacterFeatureEnabled(item, 'moments')).length > 1) {
        const schedule = ops.getChats().flatMap((item) => item.deletedAt == null ? item.runtimeEventsV2 || [] : [])
          .find((event) => {
            const payload = event.payload as Record<string, unknown>;
            return event.kind === 'artifact' && event.actorIds?.[0] === actorId
              && event.createdAt >= startOfDay(now) && payload.artifactType === 'daily_moment_schedule'
              && payload.memorySignature === signature;
          });
        const readyAt = (schedule?.payload as Record<string, unknown> | undefined)?.readyAt;
        appointmentAt = typeof readyAt === 'number' ? readyAt
          : now + characterPublicationOffset(`${actorId}:${startOfDay(now)}:moment`, MOMENT_SPREAD_WINDOW_MS);
        if (!schedule) {
          stage = '保存发布预约';
          await ops.applyChatRuntimePatch(chatId, (latest) => {
            if (!ops.isCurrentSource() || latest.deletedAt != null) return null;
            const event: RuntimeEventV2 = { id: createRuntimeEventId(), conversationId: chatId,
              kind: 'artifact', createdAt: now, actorIds: [actorId], visibility: 'role_private',
              summary: '今日分享检查已预约', payload: { artifactType: 'daily_moment_schedule', memorySignature: signature, readyAt: appointmentAt } };
            return { runtimeEventsV2: retainRuntimeEvents([...(latest.runtimeEventsV2 || []), event], 160) };
          });
        }
      }
      const nextPublishAt = Math.max(appointmentAt, nextDailyMomentTime(ops.getChats(), actorId, memoryAt, now));
      if (nextPublishAt > now) {
        nextCheckAt = Math.min(nextCheckAt ?? nextPublishAt, nextPublishAt);
        continue;
      }
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
      stage = '请求发布判断与正文';
      const rawDecision = await generateJsonWithAdapter({
        profile: textProfile,
        systemPrompt: '判断角色今天是否真有值得主动分享到朋友圈的具体新鲜片段。普通聊天、喝茶吃饭等平常记录、重复经历、空泛心情都可以不发；不要为了每日任务凑动态。只根据提供的公开记忆判断，不编造事件或人物。返回 JSON 对象：{"publish":boolean,"text":string}。不发时 text 为空；要发时用角色自己的口吻写 100 字以内正文，不泄露私聊、秘密、用户资料或内部字段。',
        messages: [{ role: 'user', content: [
          `角色：${sanitizeUserFacingText(actor.name, members)}`,
          `背景：${sanitizeUserFacingText(actor.background, members)}`,
          `说话风格：${sanitizeUserFacingText(actor.speakingStyle, members)}`,
          `今天：${date.toLocaleDateString()}`,
          `今天的公开记忆：\n${sourceText}`,
          '只有角色真想分享且内容具体、有新意时才发布；拿不准就不发。',
        ].join('\n') }],
        aiUsage: { type: 'moment_generation', label: '生成每日朋友圈', scope: 'moment', resourceId: chatId },
      });
      if (!ops.isCurrentSource()) return;
      stage = '校验发布判断与正文';
      const decision = parseMomentDecision(rawDecision);
      if (!decision.publish) {
        stage = '保存不发布判断';
        await ops.applyChatRuntimePatch(chatId, (latest) => {
          if (!ops.isCurrentSource() || latest.deletedAt != null || hasSkippedMemories(ops.getChats(), actorId, signature, Date.now())) return null;
          const skip: RuntimeEventV2 = { id: createRuntimeEventId(), conversationId: chatId,
            kind: 'artifact', createdAt: Date.now(), actorIds: [actorId], visibility: 'role_private',
            summary: '今日暂无值得分享的新片段', payload: { artifactType: 'daily_moment_skip', memorySignature: signature } };
          return { runtimeEventsV2: retainRuntimeEvents([...(latest.runtimeEventsV2 || []), skip], 160) };
        });
        continue;
      }
      payload.momentText = sanitizeUserFacingText(decision.text, members);
      if (!payload.momentText || /^[{[]/.test(payload.momentText)) throw new Error('朋友圈模型未返回有效正文');
      stage = '创建朋友圈产物';
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
      stage = '保存朋友圈';
      await ops.applyChatRuntimePatch(chatId, (latest) => {
        const latestActor = ops.getCharacters().find((item) => item.id === actorId);
        if (!ops.isCurrentSource() || !latest.isActive || latest.deletedAt != null || !latest.memberIds.includes(actorId)
          || !latestActor || latestActor.deletedAt != null || !isCharacterFeatureEnabled(latestActor, 'moments')
          || startOfDay(Date.now()) !== startOfDay(now) || hasTodayMoment(ops.getChats(), actorId, Date.now())) return null;
        const nextPublishAt = nextDailyMomentTime(ops.getChats(), actorId, memoryAt, Date.now());
        if (nextPublishAt > Date.now()) {
          nextCheckAt = Math.min(nextCheckAt ?? nextPublishAt, nextPublishAt);
          return null;
        }
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
      const profile = getUsablePreferredAIProfile(ops.getProfiles(), 'text');
      failures.push({ actorId, stage, error, provider: profile?.provider, model: profile?.model });
    } finally {
      runningActors.delete(actorId);
    }
  }
  if (failures.length) throw new DailyMomentFlowError(failures);
  return { nextCheckAt };
}
