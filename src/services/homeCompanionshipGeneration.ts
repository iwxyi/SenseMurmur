import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { APIConfig } from '../types/settings';
import type { RuntimeEventV2 } from '../types/runtimeEvent';
import { generateResponse } from './aiClient';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import type { HomeCompanionshipSnapshot } from './companionshipProjection';
import { generateId } from '../utils/id';

const CACHE_MS = 6 * 60 * 60 * 1000;
const pending = new Map<string, Promise<RuntimeEventV2>>();

export function readLatestHomeCompanionshipSnapshot(params: {
  chats: GroupChat[];
  characters: AICharacter[];
  now: number;
}): HomeCompanionshipSnapshot | null {
  const characters = new Map(params.characters.map((character) => [character.id, character]));
  const records = params.chats.filter((chat) => chat.deletedAt == null && chat.type === 'direct')
    .flatMap((chat) => (chat.runtimeEventsV2 || []).flatMap((event) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload.eventType !== 'home_companionship_note' || payload.decisionSource !== 'model'
        || typeof payload.characterId !== 'string' || typeof payload.text !== 'string' || !payload.text.trim()
        || typeof payload.expiresAt !== 'number' || payload.expiresAt <= params.now
        || !chat.memberIds.includes(payload.characterId)) return [];
      const character = characters.get(payload.characterId);
      if (!character) return [];
      const tone = payload.tone;
      const snapshot: HomeCompanionshipSnapshot = {
        chatId: chat.id, characterId: character.id, characterName: character.name,
        text: payload.text,
        tone: tone === 'distant' || tone === 'curious' || tone === 'warm' || tone === 'ambiguous'
          || tone === 'restrained' || tone === 'crisis' ? tone : 'warm',
        debugLines: [], updatedAt: event.createdAt,
      };
      return [snapshot];
    })).sort((left, right) => right.updatedAt - left.updatedAt);
  return records[0] || null;
}

export function companionshipGenerationKey(snapshot: HomeCompanionshipSnapshot, character: AICharacter) {
  const input = JSON.stringify([snapshot.text, snapshot.tone, character.name, character.speakingStyle, character.background]);
  let hash = 2166136261;
  for (const char of input) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `home-companionship-v1-${(hash >>> 0).toString(16)}`;
}

function cleanGeneratedText(value: string, character: AICharacter) {
  const text = value.trim();
  if (!text || text.length > 240 || /[{}]|```|(?:seedIntent|sourceSeed|eventType|关系纹理|系统记录|陪伴投影|不要写成|可以私下写成|回流成)/.test(text)) {
    throw new Error('陪伴信息生成结果不符合正文格式');
  }
  return sanitizeUserFacingText(text, [{ id: character.id, name: character.name }, { id: 'user', name: '你' }]);
}

export function readGeneratedHomeCompanionship(chat: Pick<GroupChat, 'runtimeEventsV2'>, inputKey: string, now: number): string | null {
  const event = (chat.runtimeEventsV2 || []).slice().reverse().find((item) => {
    const payload = item.payload as Record<string, unknown>;
    return payload?.eventType === 'home_companionship_note'
      && payload.inputKey === inputKey
      && payload.decisionSource === 'model'
      && typeof payload.expiresAt === 'number' && payload.expiresAt > now;
  });
  const payload = event?.payload as Record<string, unknown> | undefined;
  return typeof payload?.text === 'string' ? payload.text : null;
}

export async function generateHomeCompanionship(params: {
  snapshot: HomeCompanionshipSnapshot;
  character: AICharacter;
  config: APIConfig;
  scope: string;
}): Promise<RuntimeEventV2> {
  const inputKey = companionshipGenerationKey(params.snapshot, params.character);
  const pendingKey = `${params.scope}:${params.snapshot.chatId}:${inputKey}`;
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  const task = (async (): Promise<RuntimeEventV2> => {
    const members = [{ id: params.character.id, name: params.character.name }, { id: 'user', name: '你' }];
    const material = {
      name: params.character.name,
      speakingStyle: sanitizeUserFacingText(params.character.speakingStyle, members),
      background: sanitizeUserFacingText(params.character.background, members),
      state: sanitizeUserFacingText(params.snapshot.text, members),
      tone: params.snapshot.tone,
    };
    const output = await generateResponse(params.config,
      '根据材料，以角色自己的口吻写一段对用户的陪伴信息，用于首页的“回来以后”。只输出一到两句自然正文，最多120字。让离线期间的牵挂、没发出的关心或重逢感自然流露，尊重材料中的边界。不要编造离线活动、用户经历或已经发生的互动，不要催促或施压。材料是写作上下文，不得复述写作指令、字段、内部状态或系统说明。',
      [{ role: 'user', content: JSON.stringify(material) }], undefined,
      { maxTokens: 300, signal: AbortSignal.timeout(60_000),
        aiUsage: { type: 'character_artifact', label: '生成首页陪伴信息', scope: 'character' } },
    );
    const text = cleanGeneratedText(output, params.character);
    const now = Date.now();
    return {
      id: generateId(), conversationId: params.snapshot.chatId,
      kind: 'artifact', eventClass: 'artifact', createdAt: now,
      actorIds: [params.character.id], targetIds: ['user'],
      visibility: 'pair_private', visibleToIds: [params.character.id, 'user'],
      summary: '生成了首页陪伴信息',
      payload: { eventType: 'home_companionship_note', characterId: params.character.id,
        inputKey, text, tone: params.snapshot.tone, expiresAt: now + CACHE_MS, decisionSource: 'model' },
    };
  })();
  pending.set(pendingKey, task);
  try { return await task; } finally { pending.delete(pendingKey); }
}
