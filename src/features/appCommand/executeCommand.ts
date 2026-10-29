import { api } from '../../services/api';
import { generateResponse } from '../../services/aiClient';
import { buildAssistantChatDraft, buildDirectChatDraft, buildGroupChatDraft } from '../../services/chatDraftBuilder';
import { generateCharacterProfilesSafe } from '../../services/characterGenerator';
import { resolveRoomTemplateCapabilityDefaults } from '../../services/conversationCapabilities';
import { getRoomTemplate, ROOM_TEMPLATES, type RoomTemplateDefinition, type RoomTemplateKey } from '../../services/roomTemplates';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useMessageStore } from '../../stores/useMessageStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { GroupChat } from '../../types/chat';
import type { AICharacter } from '../../types/character';
import { DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_CHARACTER_MEMORY, DEFAULT_PERSONALITY, normalizeCharacterGroup } from '../../types/character';
import { getUsablePreferredAIProfile } from '../../types/settings';
import { formatAiBalanceAmount } from '../../utils/aiPoints';
import type { AppCommandCandidate, AppCommandChoice, AppCommandContext, AppCommandExecutionResult, AppCommandRoute, LocalActionPlan, PlannedCharacter } from './commandTypes';
import { savePendingAppCommand } from './pendingCommandStore';
import { resolveSecretRef } from './secretRedaction';
import { parseAppLink, resolveAppLinkToWebPath, serializeAppLink } from '../../services/appLink';
import { characterSearchText, normalizeResourceKey, rankCharacterResources, rankChatResources, scoreResourceText } from './resourceIndex';
import { validateAppCommandPlan } from './toolRegistry';
import { searchLocalChatRecords, type ChatRecordSearchMatch } from '../../services/chatRecordSearch';

function clean(value?: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeName(value?: string | null) {
  return normalizeResourceKey(value);
}

function buildCharacterDraft(input: PlannedCharacter, profile?: Awaited<ReturnType<typeof generateCharacterProfilesSafe>>['success'][number]['profile']) {
  return {
    name: clean(input.name),
    avatar: profile?.avatar || '🤖',
    personality: profile?.personality || DEFAULT_PERSONALITY,
    behavior: profile?.behavior || DEFAULT_CHARACTER_BEHAVIOR,
    expertise: profile?.expertise || [],
    speakingStyle: profile?.speakingStyle || '',
    background: profile?.background || clean(input.roleHint),
    group: clean(input.group) || null,
    relationships: [],
    memory: DEFAULT_CHARACTER_MEMORY,
    intervention: DEFAULT_CHARACTER_INTERVENTION,
    speechProfile: profile?.speechProfile,
    coreProfile: profile?.coreProfile,
    visualIdentity: profile?.visualIdentity,
    bubbleStyle: profile?.bubbleStyle || null,
  };
}

function findCharacterByName(characters: AICharacter[], name: string) {
  const target = normalizeName(name);
  return characters.find((character) => normalizeName(character.name) === target);
}

function normalizeMemberSet(memberIds: string[]) {
  return Array.from(new Set(memberIds.filter(Boolean))).sort();
}

export function findReusableGroupChat(params: {
  chats: Array<{
    id: string;
    type: string;
    deletedAt?: number | null;
    name: string;
    topic?: string;
    sessionKind?: { scenarioId?: string };
    memberIds: string[];
  }>;
  title: string;
  topic: string;
  memberIds: string[];
  scenarioId?: string;
}) {
  const expectedMembers = normalizeMemberSet(params.memberIds);
  const scenarioId = clean(params.scenarioId);
  return params.chats.find((chat) => {
    if (chat.type !== 'group' || chat.deletedAt) return false;
    if (clean(chat.name) !== clean(params.title)) return false;
    if (clean(chat.topic) !== clean(params.topic)) return false;
    if (scenarioId && chat.sessionKind?.scenarioId !== scenarioId) return false;
    const actualMembers = normalizeMemberSet(chat.memberIds);
    return actualMembers.length === expectedMembers.length
      && actualMembers.every((memberId, index) => memberId === expectedMembers[index]);
  }) || null;
}

async function ensureCharacters(planCharacters: PlannedCharacter[], context: AppCommandContext) {
  const existing = useCharacterStore.getState().characters;
  const found: AICharacter[] = [];
  const missing: PlannedCharacter[] = [];
  planCharacters.forEach((item) => {
    const current = findCharacterByName(existing, item.name);
    if (current) found.push(current);
    else missing.push(item);
  });
  if (!missing.length) return found;
  const profile = getUsablePreferredAIProfile(context.aiProfiles, 'text') || context.apiConfig;
  const generated = await generateCharacterProfilesSafe(
    {
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
    },
    missing.map((item) => item.name),
    'zh',
    { theme: context.input, description: context.input },
  );
  const profileByName = new Map(generated.success.map((item) => [normalizeName(item.name), item.profile]));
  const created = await useCharacterStore.getState().addCharacters(
    missing.map((item) => buildCharacterDraft(item, profileByName.get(normalizeName(item.name)))),
  );
  return [...found, ...created];
}

function chatWebPath(chatId: string, tab: number, target?: { messageId?: string; timestamp?: number }) {
  const params = new URLSearchParams({ fromTab: String(tab) });
  if (target?.messageId) params.set('messageId', target.messageId);
  if (target?.timestamp !== undefined) params.set('aroundTimestamp', String(target.timestamp));
  return `/chats/${encodeURIComponent(chatId)}?${params.toString()}`;
}

function navigateToChat(context: AppCommandContext, chatId: string, tab: number, openingMessage?: string) {
  const url = chatWebPath(chatId, tab);
  const message = clean(openingMessage);
  context.navigate?.(url, message ? { state: { homeCommandInitialMessage: message } } : undefined);
  return url;
}

function chatAppLink(chatId: string, tab: number, target?: { messageId?: string; timestamp?: number }) {
  return serializeAppLink({
    target: 'chat',
    id: chatId,
    action: 'open',
    params: {
      fromTab: String(tab),
      ...(target?.messageId ? { messageId: target.messageId } : {}),
      ...(target?.timestamp !== undefined ? { aroundTimestamp: String(target.timestamp) } : {}),
    },
  });
}

function markdownChatLink(label: string, chatId: string, tab: number, target?: { messageId?: string; timestamp?: number }) {
  return `[${label}](${chatAppLink(chatId, tab, target)})`;
}

function resolveCommandUrlForWeb(url: string) {
  const link = parseAppLink(url);
  return link ? resolveAppLinkToWebPath(link) || url : url;
}

function candidateChoices(candidates: AppCommandCandidate[]): AppCommandChoice[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    url: candidate.url,
    kind: 'execute' as const,
  })).slice(0, 5);
}

function buildPlannedCharacters(plan: LocalActionPlan, fallbackInput?: string): PlannedCharacter[] {
  const planned = plan.characters?.filter((item) => clean(item.name)) || [];
  if (planned.length) return planned;
  const fallbackName = clean(plan.characterName || plan.title || fallbackInput);
  return fallbackName ? [{ name: fallbackName, group: null, roleHint: plan.summary }] : [];
}

function shouldOpenSingleCharacterFromHome(plan: LocalActionPlan, context: AppCommandContext) {
  if (context.source !== 'home') return false;
  if (plan.action !== 'create_character' && plan.action !== 'create_characters') return false;
  const explicitCreate = /创建|新建|生成|批量|角色|人物|设定/.test(context.input);
  if (explicitCreate) return false;
  return buildPlannedCharacters(plan, context.input).length === 1;
}

function normalizeLooseKey(value?: string | null) {
  return clean(value).replace(/[\s_-]+/g, '').toLowerCase();
}

function scoreRoomTemplate(template: RoomTemplateDefinition, query: string) {
  const normalized = normalizeLooseKey(query);
  if (!normalized) return 0;
  const fields = [
    template.key,
    template.label,
    template.description,
    template.structure,
    template.category,
    template.categoryLabel,
    template.sessionKind.scenarioId,
    template.sessionKind.family,
    template.presetLabel,
    template.presetDescription,
    ...(template.sellingPoints || []),
  ].filter(Boolean).join('\n');
  const compact = normalizeLooseKey(fields);
  if (compact === normalized) return 100;
  if (compact.includes(normalized) || normalized.includes(compact)) return 50;
  return scoreResourceText(fields, query);
}

function resolveRoomTemplate(plan: LocalActionPlan) {
  const explicitKey = clean(plan.roomTemplateKey);
  if (explicitKey && ROOM_TEMPLATES.some((item) => item.key === explicitKey)) {
    return getRoomTemplate(explicitKey as RoomTemplateKey);
  }
  const scenarioId = clean(plan.scenarioId);
  if (scenarioId) {
    const byScenario = ROOM_TEMPLATES.find((item) => item.sessionKind.scenarioId === scenarioId || item.key === scenarioId);
    if (byScenario) return byScenario;
  }
  const query = clean(plan.roomKind || plan.roomTemplateKey || plan.scenarioId);
  if (!query) return getRoomTemplate('open_chat');
  const ranked = ROOM_TEMPLATES
    .map((template) => ({ template, score: scoreRoomTemplate(template, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.template || getRoomTemplate('open_chat');
}

function characterAppLink(characterId: string) {
  return serializeAppLink({ target: 'character', id: characterId, action: 'edit' });
}

function markdownCharacterLink(label: string, characterId: string) {
  return `[${label}](${characterAppLink(characterId)})`;
}

function getChatSearchMessagesByChatId() {
  const state = useMessageStore.getState();
  const messagesByChatId = Object.entries(state.messageWindowsByChatId).reduce<Record<string, typeof state.messages>>((acc, [chatId, window]) => {
    acc[chatId] = [...(window.messages || [])];
    return acc;
  }, {});
  state.messages.forEach((message) => {
    const current = messagesByChatId[message.chatId] || [];
    const existingIndex = current.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) current[existingIndex] = message;
    else current.push(message);
    messagesByChatId[message.chatId] = current;
  });
  return messagesByChatId;
}

function getChatSearchSpeakerCandidates(chats: GroupChat[]) {
  const characters = useCharacterStore.getState().characters.filter((character) => !character.deletedAt);
  const usedNames = new Set<string>();
  const candidates: { id: string; name: string; aliases?: string[] }[] = [];
  const chatMemberCharacterIds = new Set(
    chats.flatMap((chat) => Array.isArray(chat.memberIds) ? chat.memberIds : []),
  );
  const matchNames = (characterName: string) => {
    const normalized = normalizeName(characterName);
    if (!normalized || usedNames.has(normalized)) return false;
    usedNames.add(normalized);
    return true;
  };
  characters.forEach((character) => {
    if (!matchNames(character.name)) return;
    const aliases = Array.from(new Set([
      character.name,
      character.group || '',
      character.voiceConfig?.role || '',
      character.coreProfile?.socialMask || '',
    ].filter(Boolean).map((item) => clean(item)).filter(Boolean)));
    candidates.push({
      id: character.id,
      name: character.name,
      aliases,
    });
  });
  Array.from(chatMemberCharacterIds).forEach((characterId) => {
    const character = characters.find((item) => item.id === characterId);
    if (!character) return;
    if (candidates.some((item) => item.id === character.id)) return;
    candidates.push({
      id: character.id,
      name: character.name,
      aliases: [character.name, character.group || ''].filter(Boolean) as string[],
    });
  });
  return candidates;
}

function formatCharacterForAgent(character: AICharacter) {
  return [
    `名称：${character.name}`,
    `分组：${character.group || '未分组'}`,
    `专长：${character.expertise?.length ? character.expertise.join('、') : '未设置'}`,
    `性格参数：开放性 ${character.personality.openness}，外向性 ${character.personality.extroversion}，宜人性 ${character.personality.agreeableness}，神经质 ${character.personality.neuroticism}，幽默 ${character.personality.humor}，创造力 ${character.personality.creativity}，主见 ${character.personality.assertiveness}，共情 ${character.personality.empathy}`,
    `行为参数：主动性 ${character.behavior.proactivity}，攻击性 ${character.behavior.aggressiveness}，幽默强度 ${character.behavior.humorIntensity}，共情强度 ${character.behavior.empathyLevel}，总结倾向 ${character.behavior.summarizing}，跑题倾向 ${character.behavior.offTopic}`,
    `说话风格：${character.speakingStyle || '未设置'}`,
    `背景：${character.background || '未设置'}`,
    character.coreProfile ? `核心画像：${JSON.stringify(character.coreProfile)}` : '',
  ].filter(Boolean).join('\n');
}

function characterCollectionQuery(plan: LocalActionPlan) {
  return clean(plan.characterQuery || plan.characterName);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function filterCharacterCollectionWithAI(params: {
  query: string;
  candidates: AICharacter[];
  context: AppCommandContext;
}) {
  const candidates = params.candidates.slice(0, 24);
  if (!candidates.length) return { matches: candidates, classified: true };
  const profile = getUsablePreferredAIProfile(params.context.aiProfiles, 'text') || params.context.apiConfig;
  try {
    const raw = await generateResponse(
      {
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
      },
      [
        '你是 Sense Murmur 的角色库筛选器。',
        '根据用户问题，从候选角色中筛选角色自身身份、职业、头衔、能力或设定符合条件的对象。',
        '不能因为候选资料仅提及目标人物、服务于目标人物、研究目标人物或与目标人物有关，就把它选中。',
        '只能返回候选中给出的 id；拿不准时不选。',
        '只输出严格 JSON：{"matchingIds":["..."]}。',
      ].join('\n'),
      [{
        role: 'user',
        content: JSON.stringify({
          question: params.context.input,
          query: params.query,
          candidates: candidates.map((character) => ({
            id: character.id,
            name: character.name,
            group: character.group || '',
            expertise: character.expertise || [],
            speakingStyle: character.speakingStyle || '',
            background: character.background || '',
            voiceRole: character.voiceConfig?.role || '',
            coreProfile: character.coreProfile || null,
          })),
        }),
      }],
      undefined,
      {
        responseFormat: 'json',
        maxTokens: 320,
        aiUsage: {
          type: 'other',
          label: '角色集合筛选',
          scope: 'app-command',
        },
      },
    );
    const parsed = parseJsonObject(raw);
    if (!Array.isArray(parsed?.matchingIds)) return { matches: candidates, classified: false };
    const matchingIds = new Set(
      parsed.matchingIds
        .filter((id): id is string => typeof id === 'string')
        .filter((id) => candidates.some((character) => character.id === id)),
    );
    return {
      matches: candidates.filter((character) => matchingIds.has(character.id)),
      classified: true,
    };
  } catch (error) {
    console.warn('[app-command:character-collection-filter-failed]', error);
    return { matches: candidates, classified: false };
  }
}

function formatCharacterCollection(params: {
  query: string;
  characters: AICharacter[];
  classified: boolean;
}) {
  const visibleCharacters = params.characters.slice(0, 16);
  const lines = visibleCharacters.map((character) => {
    const description = [
      character.group || '',
      character.expertise?.slice(0, 3).join('、') || '',
      character.background?.replace(/\s+/g, ' ').slice(0, 84) || '',
    ].filter(Boolean).join(' · ');
    return `- ${markdownCharacterLink(character.name, character.id)}${description ? `：${description}` : ''}`;
  });
  const suffix = params.characters.length > visibleCharacters.length
    ? `\n\n其余 ${params.characters.length - visibleCharacters.length} 个匹配角色未展开。`
    : '';
  const fallbackHint = params.classified ? '' : '\n\nAI 筛选暂不可用，以下为关键词召回的候选角色。';
  return `找到 ${params.characters.length} 个与“${params.query}”匹配的角色：\n${lines.join('\n')}${suffix}${fallbackHint}`;
}

function resolveCharacterMatches(plan: LocalActionPlan, input: string) {
  const characters = useCharacterStore.getState().characters.filter((character) => !character.deletedAt);
  const queries = [
    ...(plan.characters?.map((item) => item.name) || []),
    plan.characterName,
    plan.characterQuery,
  ].map((item) => clean(item)).filter(Boolean);
  const sourceGroup = normalizeCharacterGroup(plan.sourceGroup);
  if (sourceGroup && !queries.length) {
    return characters.filter((character) => normalizeCharacterGroup(character.group) === sourceGroup);
  }
  const effectiveQueries = queries.length ? queries : [input];
  return rankCharacterResources({ characters, queries: effectiveQueries, sourceGroup });
}

function resolveDeletedCharacterMatches(plan: LocalActionPlan, input: string) {
  const characters = useCharacterStore.getState().characters.filter((character) => character.deletedAt);
  const queries = [
    ...(plan.characters?.map((item) => item.name) || []),
    plan.characterName,
    plan.characterQuery,
  ].map((item) => clean(item)).filter(Boolean);
  const effectiveQueries = queries.length ? queries : [input];
  const matches = new Map<string, { character: AICharacter; score: number }>();
  for (const query of effectiveQueries) {
    const normalizedQuery = normalizeName(query);
    characters.forEach((character) => {
      const score = scoreResourceText(characterSearchText(character), query) + (normalizeName(character.name) === normalizedQuery ? 40 : 0);
      if (score <= 0) return;
      const existing = matches.get(character.id);
      if (!existing || score > existing.score) matches.set(character.id, { character, score });
    });
  }
  return Array.from(matches.values()).sort((a, b) => b.score - a.score).map((item) => item.character);
}

function resolveChatMatches(plan: LocalActionPlan, input: string, includeDeleted = false) {
  const chats = useChatStore.getState().chats.filter((chat) => includeDeleted ? chat.deletedAt : !chat.deletedAt);
  if (plan.chatId) {
    return chats.filter((chat) => chat.id === plan.chatId);
  }
  const query = clean(plan.chatName || plan.chatQuery || plan.groupName || plan.title || input);
  const ranked = rankChatResources({ chats, query, messagesByChatId: getChatSearchMessagesByChatId(), includeMessages: true, chatTypePreference: plan.chatTypePreference });
  return ranked.map((item) => item.chat);
}

function characterCandidates(characters: AICharacter[]): AppCommandCandidate[] {
  return characters.slice(0, 8).map((character) => ({
    id: character.id,
    label: character.name,
    description: [character.group || '未分组', character.expertise?.slice(0, 3).join('、')].filter(Boolean).join(' · '),
    url: characterAppLink(character.id),
    kind: 'character',
  }));
}

function chatCandidates(chats: GroupChat[]): AppCommandCandidate[] {
  return chats.slice(0, 8).map((chat) => {
    const tab = chat.type === 'assistant' ? 3 : chat.type === 'direct' ? 1 : 0;
    return {
      id: chat.id,
      label: chat.name,
      description: [chat.type === 'group' ? '群聊' : chat.type === 'direct' ? '单聊' : '助手', chat.topic || ''].filter(Boolean).join(' · '),
      url: chatAppLink(chat.id, tab),
      kind: chat.type,
    };
  });
}

function tabForChatType(type: GroupChat['type']) {
  return type === 'assistant' ? 3 : type === 'direct' || type === 'ai_direct' ? 1 : 0;
}

function shouldUseCloudChatSearch(plan: LocalActionPlan, input: string, localFound: boolean) {
  if (plan.chatSearchScope === 'cloud') return true;
  if (plan.chatSearchScope === 'local') return false;
  if (!localFound) return true;
  return /云端|服务器|数据库|全部|所有聊天|完整历史|全量/.test(`${input}\n${plan.chatQuery || ''}`);
}

function normalizeChatSearchLimit(value: unknown) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.floor(parsed) : 20, 1), 100);
}

function normalizeChatSearchOffset(value: unknown) {
  const parsed = Number(value);
  return Math.max(Number.isFinite(parsed) ? Math.floor(parsed) : 0, 0);
}

function normalizeChatSearchSortBy(plan: LocalActionPlan, input: string): 'relevance' | 'time_desc' | 'time_asc' {
  if (plan.chatSearchSortBy === 'time_asc' || plan.chatSearchSortBy === 'time_desc' || plan.chatSearchSortBy === 'relevance') return plan.chatSearchSortBy;
  if (/最早|从早到晚|时间正序/.test(input)) return 'time_asc';
  if (/最近|最新|从新到旧|时间|时间倒序/.test(input)) return 'time_desc';
  return 'relevance';
}

function chatRecordSearchCandidate(match: ChatRecordSearchMatch): AppCommandCandidate {
  const tab = tabForChatType(match.chatType);
  return {
    id: `${match.chatId}:${match.messageId || 'chat'}`,
    label: match.chatName,
    description: [
      chatSearchRoomLabel(match),
      match.senderName ? `${match.senderName}：${match.snippet}` : match.snippet,
      match.source === 'cloud' ? '云端' : '本地',
    ].filter(Boolean).join(' · '),
    url: chatAppLink(match.chatId, tab, { messageId: match.messageId, timestamp: match.timestamp }),
    score: match.score,
    kind: match.chatType,
  };
}

function chatSearchRoomLabel(match: Pick<ChatRecordSearchMatch, 'chatType' | 'chatMode' | 'scenarioId'>) {
  const scenarioId = match.scenarioId || '';
  if (scenarioId.includes('story') || match.chatMode === 'scripted_play') return '故事房';
  if (scenarioId.includes('mystery') || match.chatMode === 'murder_mystery') return '剧本杀';
  if (scenarioId.includes('study')) return '学习房';
  if (scenarioId.includes('agent')) return '任务房';
  if (match.chatType === 'assistant') return '助手';
  if (match.chatType === 'group') return '群聊';
  return '单聊';
}

function formatChatRecordMatches(params: {
  query: string;
  speakerQuery?: string;
  matches: ChatRecordSearchMatch[];
  sourceLabel: string;
  totalCount: number;
  offset: number;
  hasMore: boolean;
  sortBy: 'relevance' | 'time_desc' | 'time_asc';
}) {
  const lines = params.matches.map((match) => {
    const tab = tabForChatType(match.chatType);
    const title = markdownChatLink(match.chatName, match.chatId, tab, { messageId: match.messageId, timestamp: match.timestamp });
    const time = match.timestamp ? new Date(match.timestamp).toLocaleString() : '';
    const meta = [match.senderName, time].filter(Boolean).join(' · ');
    return `- ${title}${meta ? `（${meta}）` : ''}：${match.snippet || '命中会话信息'}`;
  });
  const sortLabel = params.sortBy === 'time_desc' ? '时间倒序' : params.sortBy === 'time_asc' ? '时间正序' : '相关性';
  const rangeStart = params.matches.length ? params.offset + 1 : 0;
  const rangeEnd = params.offset + params.matches.length;
  const suffix = params.hasMore ? `\n- ...还有 ${params.totalCount - rangeEnd} 条未展开，可以点“查看更多”。` : '';
  const speakerText = params.speakerQuery ? `，发言人限定为“${params.speakerQuery}”` : '';
  return `${params.sourceLabel}找到 ${params.totalCount} 条和“${params.query}”相关的记录${speakerText}，当前按${sortLabel}列出第 ${rangeStart}-${rangeEnd} 条：\n${lines.join('\n')}${suffix}`;
}

function chatActionChoices(chats: GroupChat[], plan: LocalActionPlan): AppCommandChoice[] {
  return chats.slice(0, 8).map((chat) => ({
    id: chat.id,
    label: chat.name,
    description: [chat.type === 'group' ? '群聊' : chat.type === 'direct' ? '单聊' : '助手', chat.topic || ''].filter(Boolean).join(' · '),
    kind: 'execute' as const,
    plan: {
      action: plan.action,
      plan: {
        ...plan,
        chatId: chat.id,
        chatName: chat.name,
        chatQuery: chat.name,
        chatTypePreference: chat.type === 'group' || chat.type === 'direct' || chat.type === 'assistant' ? chat.type : 'any',
      },
    },
  }));
}

function chatSearchSpeakerLabel(plan: LocalActionPlan, input: string) {
  return clean(plan.chatSearchSpeakerQuery);
}

function explicitCharacterNames(plan: LocalActionPlan) {
  return Array.from(new Set([
    ...(plan.characters?.map((item) => item.name) || []),
    plan.characterName,
  ].map((item) => clean(item)).filter(Boolean)));
}

function characterActionChoices(characters: AICharacter[], plan: LocalActionPlan): AppCommandChoice[] {
  return characters.slice(0, 8).map((character) => ({
    id: character.id,
    label: character.name,
    description: [character.group || '未分组', character.expertise?.slice(0, 3).join('、')].filter(Boolean).join(' · '),
    kind: 'execute' as const,
    plan: {
      action: plan.action,
      plan: {
        ...plan,
        characterName: character.name,
        characterQuery: character.name,
        characters: [{ name: character.name, group: character.group || null }],
        sourceGroup: undefined,
      },
    },
  }));
}

function shouldAskCharacterMatch(plan: LocalActionPlan, context: AppCommandContext, matches: AICharacter[]) {
  if (matches.length <= 1) return false;
  const query = normalizeName(plan.characterQuery || plan.characterName || plan.characters?.[0]?.name || context.input);
  const exactMatches = matches.filter((character) => normalizeName(character.name) === query);
  if (exactMatches.length === 1 && !plan.sourceGroup) return false;
  return true;
}

async function generateAgentText(context: AppCommandContext, system: string, user: string, label: string) {
  const profile = getUsablePreferredAIProfile(context.aiProfiles, 'text') || context.apiConfig;
  return generateResponse(
    {
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
    },
    system,
    [{ role: 'user', content: user }],
    undefined,
    {
      responseFormat: 'text',
      maxTokens: 900,
      aiUsage: { type: 'other', label, scope: 'app-command' },
    },
  );
}

function getPendingScopeKey(context: AppCommandContext) {
  return context.source === 'assistant' ? `assistant:${context.chatId || 'default'}` : 'home';
}

function savePendingRoute(context: AppCommandContext, route: AppCommandRoute, secrets: Record<string, string>, candidates?: AppCommandCandidate[], choices?: AppCommandChoice[]) {
  savePendingAppCommand({
    scopeKey: getPendingScopeKey(context),
    source: context.source,
    input: context.input,
    route,
    secrets,
    candidates,
    choices,
  });
}

async function openExistingChat(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const query = clean(plan.chatQuery || plan.groupTopic || plan.characterName || plan.title);
  const chats = useChatStore.getState().chats.filter((chat) => !chat.deletedAt);
  const ranked = rankChatResources({ chats, query, messagesByChatId: getChatSearchMessagesByChatId(), includeMessages: true, chatTypePreference: plan.chatTypePreference });
  const top = ranked.slice(0, 5);
  const best = top[0]?.chat;
  if (!best) {
    return {
      status: 'info',
      title: '没有找到会话',
      message: query ? `没有找到和“${query}”相关的会话。` : '没有找到可打开的会话。',
      recoverable: true,
      reasonType: 'chat_not_found',
      observation: {
        attemptedAction: 'open_existing_chat',
        query,
        chatTypePreference: plan.chatTypePreference || 'any',
        foundCount: 0,
        possibleNextActions: ['create_direct_chat', 'read_character_info', 'create_character', 'create_group_chat', 'navigate'],
      },
    };
  }
  const candidates: AppCommandCandidate[] = top.map(({ chat, score }) => {
    const tab = chat.type === 'assistant' ? 3 : chat.type === 'direct' ? 1 : 0;
    return {
      id: chat.id,
      label: chat.name,
      description: [chat.type === 'group' ? '群聊' : chat.type === 'direct' ? '单聊' : '助手', chat.topic].filter(Boolean).join(' · '),
      url: chatAppLink(chat.id, tab),
      score,
      kind: chat.type,
    };
  });
  const secondScore = top[1]?.score || 0;
  const typeMismatch = plan.chatTypePreference && plan.chatTypePreference !== 'any' && best.type !== plan.chatTypePreference;
  const fullMatchCount = top.filter((item) => item.fullMatch).length;
  const shouldAsk = context.source === 'assistant'
    || typeMismatch
    || fullMatchCount > 1
    || (secondScore > 0 && ranked[0].score - secondScore <= 8);
  if (shouldAsk) {
    return {
      status: 'needs_confirmation',
      title: typeMismatch ? '找到的会话类型不完全匹配' : fullMatchCount > 1 ? '找到多个匹配会话' : '找到可打开会话',
      message: typeMismatch
        ? `最相关的是“${best.name}”，但它不是你指定的${plan.chatTypePreference === 'group' ? '群聊' : plan.chatTypePreference === 'direct' ? '单聊' : '助手会话'}。`
        : fullMatchCount > 1 || secondScore > 0
          ? `找到多个和“${query}”相关的会话，请选择要打开哪一个。`
          : `找到“${best.name}”，请确认是否打开。`,
      candidates,
      choices: candidateChoices(candidates),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const tab = best.type === 'assistant' ? 3 : best.type === 'direct' ? 1 : 0;
  const url = chatWebPath(best.id, tab);
  context.navigate?.(url);
  return {
    status: 'success',
    title: '已打开会话',
    message: `已打开 ${best.name}。`,
    markdown: `已找到会话：${markdownChatLink(best.name, best.id, tab)}`,
    navigateTo: url,
    candidates,
  };
}

async function searchChats(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const query = clean(plan.chatQuery || plan.groupTopic || plan.characterName || plan.title);
  const speakerQuery = chatSearchSpeakerLabel(plan, context.input);
  const limit = normalizeChatSearchLimit(plan.chatSearchLimit);
  const offset = normalizeChatSearchOffset(plan.chatSearchOffset);
  const sortBy = normalizeChatSearchSortBy(plan, context.input);
  const chats = useChatStore.getState().chats.filter((chat) => !chat.deletedAt);
  const speakerCandidates = getChatSearchSpeakerCandidates(chats);
  const localResult = searchLocalChatRecords({
    chats,
    query,
    speakerQuery: speakerQuery || undefined,
    speakerCandidates,
    messagesByChatId: getChatSearchMessagesByChatId(),
    chatTypePreference: plan.chatTypePreference,
    limit,
    offset,
    sortBy,
  });
  let matches = localResult.matches;
  let totalCount = localResult.totalCount;
  let hasMore = localResult.hasMore;
  let sourceLabel = '本地';
  let cloudError = '';
  if (query && shouldUseCloudChatSearch(plan, context.input, matches.length > 0)) {
    try {
      const cloud = await api.searchChatRecords(query, {
        limit,
        offset,
        chatTypePreference: plan.chatTypePreference,
        sortBy,
        speakerQuery: speakerQuery || undefined,
      });
      matches = cloud.matches.map((match) => ({ ...match, source: 'cloud' as const }));
      totalCount = cloud.totalCount;
      hasMore = cloud.hasMore;
      sourceLabel = matches.length ? '云端' : sourceLabel;
    } catch (error) {
      cloudError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!matches.length) {
    return {
      status: 'info',
      title: '没有找到会话',
      message: query
        ? `没有找到和“${query}”相关的聊天记录。${cloudError ? `云端搜索失败：${cloudError}` : '可以提供更具体的关键词、时间或人物再试。'}`
        : '没有找到可检索的会话。',
      recoverable: true,
      reasonType: 'chat_not_found',
      observation: {
        attemptedAction: 'search_chats',
        query,
        chatTypePreference: plan.chatTypePreference || 'any',
        foundCount: 0,
        totalCount: 0,
        offset,
        sortBy,
        speakerQuery: speakerQuery || undefined,
        cloudError,
        possibleNextActions: ['open_existing_chat', 'create_direct_chat', 'create_group_chat', 'assistant_agent'],
      },
    };
  }
  const candidates = matches.map(chatRecordSearchCandidate);
  const choices: AppCommandChoice[] = candidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    url: candidate.url,
    kind: 'execute' as const,
  }));
  if (hasMore) {
    choices.push({
      id: `more:${offset + matches.length}`,
      label: '查看更多',
      description: `继续列出第 ${offset + matches.length + 1} 条之后的结果`,
      kind: 'execute' as const,
      plan: {
        action: 'search_chats',
        plan: {
          ...plan,
          chatQuery: query,
          chatSearchSpeakerQuery: speakerQuery || undefined,
          chatSearchLimit: limit,
          chatSearchOffset: offset + matches.length,
          chatSearchSortBy: sortBy,
        },
      },
    });
  }
  return {
    status: 'needs_confirmation',
    title: `找到 ${totalCount} 条记录`,
    message: `找到 ${totalCount} 条和“${query}”相关的记录，当前列出 ${matches.length} 条，请选择要打开的位置。`,
    markdown: formatChatRecordMatches({ query, speakerQuery: speakerQuery || undefined, matches, sourceLabel, totalCount, offset, hasMore, sortBy }),
    candidates,
    choices,
    choicePresentation: candidates.length > 4 ? 'select' : 'list',
    observation: {
      attemptedAction: 'search_chats',
      query,
      speakerQuery: speakerQuery || undefined,
      foundCount: matches.length,
      totalCount,
      offset,
      hasMore,
      sortBy,
      source: sourceLabel === '云端' ? 'cloud' : 'local',
      cloudError,
    },
  };
}

function localActionRouteFromStep(step: Extract<AppCommandRoute, { mode: 'workflow' }>['steps'][number], confirmed = false): AppCommandRoute {
  return {
    mode: 'local_action',
    action: step.action,
    plan: step.plan,
    riskLevel: step.riskLevel,
    requiresConfirmation: confirmed ? false : step.requiresConfirmation,
    confirmationText: step.confirmationText,
  };
}

function workflowStepObservation(step: Extract<AppCommandRoute, { mode: 'workflow' }>['steps'][number], stepIndex: number, observation?: Record<string, unknown>) {
  return {
    ...(observation || {}),
    workflowStepIndex: stepIndex,
    workflowStepAction: step.action,
  };
}

async function createDirectChat(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const name = clean(plan.characterName || plan.characters?.[0]?.name || plan.title);
  if (!name) return {
    status: 'info',
    title: '缺少角色名',
    message: '请告诉我想和哪个角色聊天。',
    recoverable: false,
    reasonType: 'missing_character_name',
    observation: { attemptedAction: 'create_direct_chat', possibleNextActions: ['open_existing_chat', 'assistant_agent'] },
  };
  const [character] = await ensureCharacters([{ name, group: plan.characters?.[0]?.group || null, roleHint: plan.summary }], context);
  const existing = useChatStore.getState().chats.find((chat) => chat.type === 'direct' && chat.memberIds.includes(character.id));
  const chat = existing || await useChatStore.getState().addChat(buildDirectChatDraft(character.id, character.name));
  const url = navigateToChat(context, chat.id, 1, plan.openingMessage);
  return {
    status: 'success',
    title: existing ? '已打开单聊' : '已创建单聊',
    message: existing ? `已打开和 ${character.name} 的单聊。` : `已创建和 ${character.name} 的单聊。`,
    markdown: `${existing ? '已打开单聊' : '已创建单聊'}：${markdownChatLink(character.name, chat.id, 1)}`,
    navigateTo: url,
  };
}

async function createGroupChat(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const plannedCharacters = (plan.characters || []).filter((item) => clean(item.name));
  if (!plannedCharacters.length) return {
    status: 'info',
    title: '缺少角色',
    message: '创建群聊前需要至少一个角色。',
    recoverable: true,
    reasonType: 'missing_group_members',
    observation: { attemptedAction: 'create_group_chat', possibleNextActions: ['create_characters', 'assistant_agent'] },
  };
  const template = resolveRoomTemplate(plan);
  const defaults = template.defaults || {};
  const chatDraftDefaults = useSettingsStore.getState().chatDraftDefaults;
  const includeUserAsMember = typeof plan.includeUserAsMember === 'boolean'
    ? plan.includeUserAsMember
    : chatDraftDefaults.includeUserAsMember;
  const capabilityDefaults = resolveRoomTemplateCapabilityDefaults(template, { showRoleActions: chatDraftDefaults.showRoleActions });
  const showRoleActions = typeof plan.showRoleActions === 'boolean'
    ? plan.showRoleActions
    : capabilityDefaults.showRoleActions;
  const members = await ensureCharacters(plannedCharacters, context);
  const uniqueMembers = Array.from(new Map(members.map((item) => [item.id, item])).values());
  const memberIds = normalizeMemberSet([
    ...(includeUserAsMember ? ['user'] : []),
    ...uniqueMembers.map((item) => item.id),
  ]);
  const title = clean(plan.groupName || plan.title) || `${plannedCharacters.slice(0, 3).map((item) => item.name).join('、')}的群聊`;
  const topic = clean(plan.groupTopic || plan.summary || context.input);
  const existing = findReusableGroupChat({
    chats: useChatStore.getState().chats,
    title,
    topic,
    memberIds,
    scenarioId: template.sessionKind.scenarioId,
  });
  if (existing) {
    const url = navigateToChat(context, existing.id, 0, plan.openingMessage);
    return {
      status: 'success',
      title: '已打开已有群聊',
      message: `已找到已有的“${existing.name}”，没有重复创建。`,
      markdown: `已打开已有群聊：${markdownChatLink(existing.name, existing.id, 0)}`,
      navigateTo: url,
      observation: {
        completedGoal: true,
        reusedChatId: existing.id,
        roomTemplateKey: template.key,
        scenarioId: template.sessionKind.scenarioId,
        family: template.sessionKind.family,
      },
    };
  }
  const chat = await useChatStore.getState().addChat(buildGroupChatDraft({
    type: 'group',
    name: title,
    topic,
    style: template.style || plan.groupStyle || 'free',
    runtimeEvolutionIntensity: template.runtimeEvolutionIntensity || 'balanced',
    sessionKind: template.sessionKind,
    storyBranchMode: defaults.storyBranchMode,
    storyBackground: clean(plan.storyBackground) || defaults.storyBackground || topic,
    storyDirection: clean(plan.storyDirection) || defaults.storyDirection || clean(plan.summary) || topic,
    storyOutline: clean(plan.storyOutline) || defaults.storyOutline || '',
    studyGoalLabel: clean(plan.studyGoalLabel) || defaults.studyGoalLabel || topic,
    agentGoalLabel: clean(plan.agentGoalLabel) || defaults.agentGoalLabel || topic,
    boardColumns: plan.boardColumns || defaults.boardColumns,
    boardRows: plan.boardRows || defaults.boardRows,
    deductionFactionCount: plan.deductionFactionCount || defaults.deductionFactionCount,
    werewolfRoleConfig: clean(plan.werewolfRoleConfig) || defaults.werewolfRoleConfig || topic,
    werewolfPostGameMode: clean(plan.werewolfPostGameMode) || defaults.werewolfPostGameMode,
    mysteryClueCount: plan.mysteryClueCount || defaults.mysteryClueCount,
    mysteryScript: clean(plan.mysteryScript) || defaults.mysteryScript || topic,
    mysteryRoleMappingMode: clean(plan.mysteryRoleMappingMode) || defaults.mysteryRoleMappingMode,
    memberIds,
    operatorIds: [],
    showRoleActions,
    seedMemoryText: '',
    seedArtifactText: '',
    ownerCharacterId: null,
    adminCharacterIds: [],
    autoModeration: true,
    allowMute: false,
    allowPrivateThreads: defaults.allowPrivateThreads ?? false,
    allowCliques: defaults.allowCliques ?? true,
    allowMockery: defaults.allowMockery ?? false,
    mood: '',
    focus: topic,
    recentEvent: '',
    allowSpeakAs: true,
    allowDirectorMode: true,
    allowEventInjection: true,
    allowForcedReply: true,
  }));
  const url = chatWebPath(chat.id, 0);
  navigateToChat(context, chat.id, 0, plan.openingMessage);
  return {
    status: 'success',
    title: `已创建${template.label}`,
    message: `已创建“${chat.name}”，玩法为${template.label}，包含 ${uniqueMembers.length} 个角色。`,
    markdown: `已创建${template.label}：${markdownChatLink(chat.name, chat.id, 0)}`,
    navigateTo: url,
    observation: {
      completedGoal: true,
      createdChatId: chat.id,
      roomTemplateKey: template.key,
      scenarioId: template.sessionKind.scenarioId,
      family: template.sessionKind.family,
    },
  };
}

async function createCharacters(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const plannedCharacters = buildPlannedCharacters(plan, context.input);
  if (!plannedCharacters.length) return {
    status: 'info',
    title: '缺少角色名',
    message: '请告诉我想创建哪个角色。',
    recoverable: true,
    reasonType: 'missing_character_name',
    observation: { attemptedAction: plan.action, possibleNextActions: ['create_direct_chat', 'create_group_chat', 'assistant_agent'] },
  };
  const characters = await ensureCharacters(plannedCharacters, context);
  return {
    status: 'success',
    title: '已创建角色',
    message: `已准备 ${characters.length} 个角色。`,
    markdown: `已准备角色：${characters.map((item) => item.name).join('、')}。可以在[角色库](${serializeAppLink({ target: 'characters', action: 'open' })})查看。`,
    navigateTo: '/characters',
  };
}

async function readCharacterInfo(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveCharacterMatches(plan, context.input);
  if (!matches.length) return {
    status: 'info',
    title: '没有找到角色',
    message: '角色库里没有找到匹配的角色。',
    recoverable: true,
    reasonType: 'character_not_found',
    observation: {
      attemptedAction: 'read_character_info',
      query: plan.characterName || plan.characterQuery || plan.characters?.map((item) => item.name).join('、') || context.input,
      foundCount: 0,
      possibleNextActions: ['create_character', 'create_direct_chat', 'assistant_agent'],
    },
  };
  if (plan.characterQueryMode === 'collection') {
    const query = characterCollectionQuery(plan);
    const selection = await filterCharacterCollectionWithAI({ query, candidates: matches, context });
    if (!selection.matches.length) {
      return {
        status: 'info',
        title: '没有找到角色',
        message: `角色库中没有找到身份或设定符合“${query}”的角色。`,
        recoverable: true,
        reasonType: 'character_not_found',
        observation: {
          attemptedAction: 'read_character_info',
          query,
          foundCount: 0,
          candidateCount: matches.length,
          possibleNextActions: ['create_character', 'assistant_agent'],
        },
      };
    }
    return {
      status: 'success',
      title: `找到 ${selection.matches.length} 个角色`,
      message: formatCharacterCollection({
        query,
        characters: selection.matches,
        classified: selection.classified,
      }),
      markdown: formatCharacterCollection({
        query,
        characters: selection.matches,
        classified: selection.classified,
      }),
    };
  }
  if (shouldAskCharacterMatch(plan, context, matches)) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '找到多个可能匹配的角色，请选择要查看哪一个。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const character = matches[0];
  const summary = await generateAgentText(
    context,
    [
      '你是 Sense Murmur 的站内角色资料助手。',
      '只根据用户给出的角色资料回答，不要编造未提供的信息。',
      '回答要简洁、有判断力，可以引用关键字段，但不要暴露内部 JSON 或 ID。',
    ].join('\n'),
    [`用户问题：${context.input}`, '', '角色资料：', formatCharacterForAgent(character)].join('\n'),
    '角色资料解读',
  );
  return {
    status: 'success',
    title: character.name,
    message: summary,
    markdown: `${summary}\n\n${markdownCharacterLink('打开角色资料', character.id)}`,
    candidates: characterCandidates([character]),
  };
}

async function compareCharacters(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveCharacterMatches(plan, context.input);
  const expectedCount = plan.characters?.length || 2;
  const selected = matches.slice(0, Math.max(expectedCount, 2));
  if (selected.length < 2) return {
    status: 'info',
    title: '角色不足',
    message: '至少需要找到两个角色才能比较。',
    recoverable: true,
    reasonType: 'insufficient_characters',
    observation: { attemptedAction: 'compare_characters', foundCount: selected.length, expectedCount, possibleNextActions: ['read_character_info', 'create_characters', 'assistant_agent'] },
  };
  if (matches.length > selected.length && context.source === 'assistant') {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个可比较角色',
      message: '找到多个相关角色，请先选择要查看的角色资料，或重新说明要比较哪几个角色。',
      candidates,
      choices: characterActionChoices(matches, { ...plan, action: 'read_character_info' }),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const answer = await generateAgentText(
    context,
    [
      '你是 Sense Murmur 的站内角色分析助手。',
      '只根据提供的角色资料做比较，不要编造未提供的信息。',
      '如果资料不足，明确指出依据不足，并给出当前资料下的倾向判断。',
    ].join('\n'),
    [
      `用户问题：${plan.compareQuestion || context.input}`,
      '',
      ...selected.map((character, index) => [`角色 ${index + 1}:`, formatCharacterForAgent(character)].join('\n')),
    ].join('\n\n'),
    '角色能力比较',
  );
  return {
    status: 'success',
    title: '角色比较',
    message: answer,
    markdown: answer,
    candidates: characterCandidates(selected),
  };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function clamp01(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  return Math.max(0, Math.min(1, numberValue));
}

function stringArray(value: unknown, limit = 12) {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => clean(String(item))).filter(Boolean).slice(0, limit);
  return items.length ? items : undefined;
}

function sanitizeCharacterPatch(raw: unknown, character: AICharacter): Partial<AICharacter> {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const patch: Partial<AICharacter> = {};
  if ('group' in record) patch.group = normalizeCharacterGroup(String(record.group || ''));
  if (typeof record.background === 'string') patch.background = record.background.trim().slice(0, 4000);
  if (typeof record.speakingStyle === 'string') patch.speakingStyle = record.speakingStyle.trim().slice(0, 1200);
  const expertise = stringArray(record.expertise);
  if (expertise) patch.expertise = expertise;
  if (record.personality && typeof record.personality === 'object') {
    const source = record.personality as Record<string, unknown>;
    const next = { ...character.personality };
    (Object.keys(DEFAULT_PERSONALITY) as Array<keyof typeof DEFAULT_PERSONALITY>).forEach((key) => {
      const value = clamp01(source[key]);
      if (value !== undefined) next[key] = value;
    });
    patch.personality = next;
  }
  if (record.behavior && typeof record.behavior === 'object') {
    const source = record.behavior as Record<string, unknown>;
    const next = { ...character.behavior };
    (Object.keys(DEFAULT_CHARACTER_BEHAVIOR) as Array<keyof typeof DEFAULT_CHARACTER_BEHAVIOR>).forEach((key) => {
      const value = clamp01(source[key]);
      if (value !== undefined) next[key] = value;
    });
    patch.behavior = next;
  }
  if (record.coreProfile && typeof record.coreProfile === 'object') {
    const source = record.coreProfile as Record<string, unknown>;
    const nextCoreProfile = { ...(character.coreProfile || {}) };
    if (typeof source.coreDesire === 'string') nextCoreProfile.coreDesire = source.coreDesire.trim().slice(0, 240);
    if (typeof source.coreFear === 'string') nextCoreProfile.coreFear = source.coreFear.trim().slice(0, 240);
    const values = stringArray(source.values, 10);
    if (values) nextCoreProfile.values = values;
    const biases = stringArray(source.biases, 10);
    if (biases) nextCoreProfile.biases = biases;
    const sensitivities = stringArray(source.sensitivities, 10);
    if (sensitivities) nextCoreProfile.sensitivities = sensitivities;
    const interactionHabits = stringArray(source.interactionHabits, 10);
    if (interactionHabits) nextCoreProfile.interactionHabits = interactionHabits;
    patch.coreProfile = nextCoreProfile;
  }
  return patch;
}

async function buildCharacterUpdatePatch(character: AICharacter, instruction: string, context: AppCommandContext) {
  const profile = getUsablePreferredAIProfile(context.aiProfiles, 'text') || context.apiConfig;
  const response = await generateResponse(
    {
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
    },
    [
      '你是 Sense Murmur 的角色资料补丁生成器。只输出严格 JSON。',
      '根据用户的修改要求和当前角色资料，返回允许更新的字段。',
      '允许字段：group, background, speakingStyle, expertise, personality, behavior, coreProfile。',
      'personality 和 behavior 的数值范围必须是 0 到 1。不要输出 id、name、avatar、memory、relationships 或其他字段。',
    ].join('\n'),
    [{ role: 'user', content: [`修改要求：${instruction}`, '', '当前角色：', formatCharacterForAgent(character)].join('\n') }],
    undefined,
    {
      responseFormat: 'json',
      maxTokens: 1000,
      aiUsage: { type: 'other', label: '角色资料修改计划', scope: 'app-command' },
    },
  );
  return sanitizeCharacterPatch(JSON.parse(extractJsonObject(response)), character);
}

function mergeExplicitCharacterPatch(plan: LocalActionPlan, patch: Partial<AICharacter>) {
  const targetGroup = normalizeCharacterGroup(plan.targetGroup);
  if (!targetGroup) return patch;
  return { ...patch, group: targetGroup };
}

async function updateCharactersByInstruction(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const instruction = clean(plan.updateInstruction || plan.summary || context.input);
  if (!instruction) return { status: 'info', title: '缺少修改要求', message: '请说明希望怎样修改角色。' };
  const matches = resolveCharacterMatches(plan, context.input);
  if (!matches.length) return { status: 'info', title: '没有找到角色', message: '没有找到要修改的角色。' };
  const allowsBatchUpdate = Boolean(plan.sourceGroup || plan.targetGroup || plan.characterQuery || (plan.characters?.length || 0) > 1);
  if (!allowsBatchUpdate && matches.length > 1) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '找到多个可能要修改的角色，请选择一个，或明确要修改的分组。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const patches = await Promise.all(matches.slice(0, 20).map(async (character) => ({
    id: character.id,
    character,
    updates: mergeExplicitCharacterPatch(plan, await buildCharacterUpdatePatch(character, instruction, context)),
  })));
  const validPatches = patches.filter((patch) => Object.keys(patch.updates).length > 0);
  if (!validPatches.length) return { status: 'info', title: '没有可应用修改', message: '没有生成可安全写入的角色字段修改。' };
  await useCharacterStore.getState().updateCharacters(validPatches.map((patch) => ({ id: patch.id, updates: patch.updates })));
  const names = validPatches.map((patch) => patch.character.name).join('、');
  return {
    status: 'success',
    title: '已更新角色',
    message: `已更新 ${validPatches.length} 个角色：${names}。`,
    markdown: `已更新 ${validPatches.length} 个角色：${names}。`,
    candidates: characterCandidates(validPatches.map((patch) => patch.character)),
  };
}

async function deleteCharactersByInstruction(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const activeCharacters = useCharacterStore.getState().characters.filter((character) => !character.deletedAt);
  const names = explicitCharacterNames(plan);
  const exactMatches = names.length
    ? names.flatMap((name) => {
        const matched = findCharacterByName(activeCharacters, name);
        return matched ? [matched] : [];
      })
    : [];
  const uniqueExactMatches = Array.from(new Map(exactMatches.map((character) => [character.id, character])).values());
  const matches = uniqueExactMatches.length === names.length && names.length > 0
    ? uniqueExactMatches
    : resolveCharacterMatches(plan, context.input);

  if (!matches.length) {
    return {
      status: 'info',
      title: '没有找到角色',
      message: '没有找到要删除的角色。',
      recoverable: true,
      reasonType: 'character_not_found',
      observation: {
        attemptedAction: 'delete_characters',
        query: names.join('、') || plan.characterQuery || plan.sourceGroup || context.input,
        foundCount: 0,
        possibleNextActions: ['read_character_info', 'create_characters', 'navigate'],
      },
    };
  }

  const deletingExplicitNames = names.length > 0 && uniqueExactMatches.length === names.length;
  const deletingSourceGroup = Boolean(plan.sourceGroup && !names.length && !plan.characterQuery);
  if (!deletingExplicitNames && !deletingSourceGroup && matches.length > 1) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '找到多个可能要删除的角色，请选择要删除哪一个，或明确角色名称/分组。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }

  const targets = matches.slice(0, 30);
  await useCharacterStore.getState().deleteCharacters(targets.map((character) => character.id));
  const namesText = targets.map((character) => character.name).join('、');
  return {
    status: 'success',
    title: '已删除角色',
    message: `已将 ${targets.length} 个角色移入回收站：${namesText}。`,
    markdown: `已删除角色：${namesText}。这些角色已移入回收站，可在[角色库](${serializeAppLink({ target: 'characters', action: 'open' })})中查看。`,
  };
}

async function restoreCharactersByInstruction(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveDeletedCharacterMatches(plan, context.input);
  if (!matches.length) return { status: 'info', title: '没有找到角色', message: '回收站里没有找到要恢复的角色。' };
  if (matches.length > 1 && !explicitCharacterNames(plan).length && !plan.characterQuery) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '回收站里找到多个可能匹配的角色，请选择要恢复哪一个。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const targets = matches.slice(0, 30);
  await useCharacterStore.getState().restoreCharacters(targets.map((character) => character.id));
  const namesText = targets.map((character) => character.name).join('、');
  return {
    status: 'success',
    title: '已恢复角色',
    message: `已恢复 ${targets.length} 个角色：${namesText}。`,
    markdown: `已恢复角色：${namesText}。可以在[角色库](${serializeAppLink({ target: 'characters', action: 'open' })})查看。`,
  };
}

async function openCharacter(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveCharacterMatches(plan, context.input);
  if (!matches.length) return { status: 'info', title: '没有找到角色', message: '没有找到要打开的角色。', recoverable: true, reasonType: 'character_not_found' };
  if (shouldAskCharacterMatch(plan, context, matches)) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '找到多个可能匹配的角色，请选择要打开哪一个。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  const webPath = resolveCommandUrlForWeb(characterAppLink(target.id));
  context.navigate?.(webPath);
  return {
    status: 'success',
    title: '已打开角色',
    message: `已打开 ${target.name} 的角色资料。`,
    markdown: `已打开角色资料：${markdownCharacterLink(target.name, target.id)}`,
    navigateTo: webPath,
  };
}

function resolveChatTopicTargets(plan: LocalActionPlan, input: string) {
  const activeChats = useChatStore.getState().chats.filter((chat) => !chat.deletedAt);
  const typeFiltered = activeChats.filter((chat) => {
    if (!plan.chatTypePreference || plan.chatTypePreference === 'any') return true;
    return chat.type === plan.chatTypePreference;
  });
  if (plan.chatId) return typeFiltered.filter((chat) => chat.id === plan.chatId);
  if (plan.selectionMode === 'random') {
    if (!typeFiltered.length) return [];
    return [typeFiltered[Math.floor(Math.random() * typeFiltered.length)]].filter(Boolean);
  }
  if (plan.selectionMode === 'recent') {
    return [...typeFiltered].sort((a, b) => (b.lastMessageAt || b.updatedAt || 0) - (a.lastMessageAt || a.updatedAt || 0)).slice(0, 1);
  }
  return resolveChatMatches(plan, input).filter((chat) => typeFiltered.some((item) => item.id === chat.id)).slice(0, 8);
}

async function renameCharacter(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const newName = clean(plan.newName || plan.summary);
  if (!newName) return { status: 'info', title: '缺少新名称', message: '请告诉我要把角色改成什么名字。' };
  const matches = resolveCharacterMatches(plan, context.input);
  if (!matches.length) return { status: 'info', title: '没有找到角色', message: '没有找到要重命名的角色。' };
  if (matches.length > 1) {
    const candidates = characterCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个角色',
      message: '找到多个可能要重命名的角色，请选择一个。',
      candidates,
      choices: characterActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  await useCharacterStore.getState().updateCharacter(target.id, { name: newName });
  return {
    status: 'success',
    title: '已重命名角色',
    message: `已将 ${target.name} 重命名为 ${newName}。`,
    markdown: `已重命名角色：${markdownCharacterLink(newName, target.id)}`,
  };
}

async function deleteChats(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveChatMatches(plan, context.input).slice(0, 8);
  if (!matches.length) return { status: 'info', title: '没有找到会话', message: '没有找到要删除的会话。', recoverable: true, reasonType: 'chat_not_found' };
  if (matches.length > 1) {
    const candidates = chatCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个会话',
      message: '找到多个可能要删除的会话，请选择目标。',
      candidates,
      choices: chatActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  await useChatStore.getState().deleteChat(target.id);
  return { status: 'success', title: '已删除会话', message: `已将“${target.name}”移入回收站。` };
}

async function restoreChats(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const matches = resolveChatMatches(plan, context.input, true).slice(0, 8);
  if (!matches.length) return { status: 'info', title: '没有找到会话', message: '回收站里没有找到要恢复的会话。' };
  if (matches.length > 1) {
    const candidates = chatCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个会话',
      message: '回收站里找到多个可能匹配的会话，请选择要恢复哪一个。',
      candidates,
      choices: chatActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  await useChatStore.getState().restoreChats([target.id]);
  return {
    status: 'success',
    title: '已恢复会话',
    message: `已恢复“${target.name}”。`,
    markdown: `已恢复会话：${markdownChatLink(target.name, target.id, target.type === 'assistant' ? 3 : target.type === 'direct' ? 1 : 0)}`,
  };
}

async function renameChat(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const newName = clean(plan.newName || plan.chatName || plan.title);
  if (!newName) return { status: 'info', title: '缺少新名称', message: '请告诉我要把会话改成什么名字。' };
  const matches = resolveChatMatches({ ...plan, chatName: undefined, title: undefined }, context.input).slice(0, 8);
  if (!matches.length) return { status: 'info', title: '没有找到会话', message: '没有找到要重命名的会话。' };
  if (matches.length > 1) {
    const candidates = chatCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个会话',
      message: '找到多个可能要重命名的会话，请选择一个。',
      candidates,
      choices: chatActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  await useChatStore.getState().updateChat(target.id, { name: newName });
  return {
    status: 'success',
    title: '已重命名会话',
    message: `已将“${target.name}”重命名为“${newName}”。`,
    markdown: `已重命名会话：${markdownChatLink(newName, target.id, target.type === 'assistant' ? 3 : target.type === 'direct' ? 1 : 0)}`,
  };
}

async function updateChatTopic(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const newTopic = clean(plan.newTopic || plan.groupTopic || plan.summary);
  if (!newTopic) return { status: 'info', title: '缺少新主题', message: '请告诉我要把聊天主题改成什么。' };
  const matches = resolveChatTopicTargets({ ...plan, chatTypePreference: plan.chatTypePreference || 'group' }, context.input);
  if (!matches.length) return { status: 'info', title: '没有找到会话', message: '没有找到要修改主题的会话。', recoverable: true, reasonType: 'chat_not_found' };
  if (matches.length > 1) {
    const candidates = chatCandidates(matches);
    return {
      status: 'needs_confirmation',
      title: '找到多个会话',
      message: '找到多个可能要修改主题的会话，请选择一个。',
      candidates,
      choices: chatActionChoices(matches, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const target = matches[0];
  await useChatStore.getState().updateChat(target.id, { topic: newTopic });
  return {
    status: 'success',
    title: '已更新聊天主题',
    message: `已将“${target.name}”的聊天主题改为“${newTopic}”。`,
    markdown: `已更新聊天主题：${markdownChatLink(target.name, target.id, target.type === 'assistant' ? 3 : target.type === 'direct' ? 1 : 0)}`,
  };
}

async function createAssistantChat(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const auth = useAuthStore.getState();
  const agentAvailable = auth.authMode === 'cloud' && auth.user?.agentEntitled === true;
  const chat = await useChatStore.getState().addChat({
    ...buildAssistantChatDraft({ agentAvailable, aiSearchAvailable: agentAvailable && auth.user?.aiSearchEntitled === true }),
    name: clean(plan.chatName || plan.title) || '新助手会话',
    topic: clean(plan.summary) || '通用助手聊天',
  });
  const url = chatWebPath(chat.id, 3);
  context.navigate?.(url);
  return {
    status: 'success',
    title: '已创建助手会话',
    message: `已创建助手会话“${chat.name}”。`,
    markdown: `已创建助手会话：${markdownChatLink(chat.name, chat.id, 3)}`,
    navigateTo: url,
  };
}

async function manageGroupMembers(plan: LocalActionPlan, context: AppCommandContext): Promise<AppCommandExecutionResult> {
  const operation = plan.memberOperation || 'add';
  const chats = resolveChatMatches({ ...plan, chatTypePreference: 'group' }, context.input).filter((chat) => chat.type === 'group').slice(0, 8);
  if (!chats.length) return { status: 'info', title: '没有找到群聊', message: '没有找到要管理成员的群聊。' };
  if (chats.length > 1) {
    const candidates = chatCandidates(chats);
    return {
      status: 'needs_confirmation',
      title: '找到多个群聊',
      message: '找到多个可能的群聊，请选择要管理哪一个。',
      candidates,
      choices: chatActionChoices(chats, plan),
      choicePresentation: candidates.length > 4 ? 'select' : 'chips',
    };
  }
  const targetChat = chats[0];
  const plannedCharacters = buildPlannedCharacters(plan, context.input);
  if (!plannedCharacters.length) return { status: 'info', title: '缺少角色', message: '请告诉我要添加或移除哪些角色。' };
  const characters = operation === 'remove'
    ? resolveCharacterMatches(plan, context.input)
    : await ensureCharacters(plannedCharacters, context);
  if (!characters.length) return { status: 'info', title: '没有找到角色', message: '没有找到要管理的角色。' };
  const characterIds = characters.map((character) => character.id);
  const currentWithoutTargets = targetChat.memberIds.filter((id) => !characterIds.includes(id));
  const memberIds = operation === 'remove'
    ? currentWithoutTargets
    : operation === 'set'
      ? normalizeMemberSet(['user', ...characterIds])
      : normalizeMemberSet([...targetChat.memberIds, ...characterIds]);
  await useChatStore.getState().updateChat(targetChat.id, { memberIds });
  return {
    status: 'success',
    title: '已更新群聊成员',
    message: `${operation === 'remove' ? '已移除' : operation === 'set' ? '已设置' : '已添加'}：${characters.map((character) => character.name).join('、')}。`,
    markdown: `已更新群聊成员：${markdownChatLink(targetChat.name, targetChat.id, 0)}`,
  };
}

async function queryAiBalance(): Promise<AppCommandExecutionResult> {
  const balance = await api.getAiBalance(undefined, { force: true });
  return {
    status: 'success',
    title: 'AI 点数',
    message: `当前可用 AI 点数：${formatAiBalanceAmount(balance, undefined, { empty: '-' })}`,
  };
}

function updateTheme(plan: LocalActionPlan): AppCommandExecutionResult {
  const theme = plan.theme || 'dark';
  useSettingsStore.getState().setTheme(theme);
  return { status: 'success', title: '已切换主题', message: theme === 'dark' ? '已切换到夜间模式。' : theme === 'light' ? '已切换到浅色模式。' : '已切换为跟随系统。' };
}

function setAiModelKey(plan: LocalActionPlan, secrets: Record<string, string>): AppCommandExecutionResult {
  const key = resolveSecretRef(secrets, plan.apiKeyRef);
  if (!key) return { status: 'info', title: '没有找到秘钥', message: '没有识别到可写入的 API key。' };
  const hint = `${plan.providerHint || ''} ${plan.modelHint || ''}`.toLowerCase();
  const settings = useSettingsStore.getState();
  const target = settings.aiProfiles.find((profile) => {
    const text = `${profile.name} ${profile.provider} ${profile.model}`.toLowerCase();
    return hint ? hint.split(/\s+/).filter(Boolean).some((part) => text.includes(part)) : profile.type === 'text';
  }) || settings.aiProfiles.find((profile) => profile.type === 'text');
  if (!target) return { status: 'info', title: '没有可配置模型', message: '没有找到可写入的文本模型配置。' };
  settings.updateAIProfile(target.id, { apiKey: key });
  return { status: 'success', title: '已更新秘钥', message: `已更新“${target.name || target.model}”的 API key。` };
}

type LocalActionHandler = (plan: LocalActionPlan, context: AppCommandContext, secrets: Record<string, string>) => Promise<AppCommandExecutionResult> | AppCommandExecutionResult;

const LOCAL_ACTION_HANDLERS: Record<LocalActionPlan['action'], LocalActionHandler> = {
  create_character: createCharacters,
  create_characters: createCharacters,
  create_group_chat: createGroupChat,
  create_direct_chat: createDirectChat,
  open_existing_chat: openExistingChat,
  search_chats: searchChats,
  read_character_info: readCharacterInfo,
  compare_characters: compareCharacters,
  update_characters: updateCharactersByInstruction,
  delete_characters: deleteCharactersByInstruction,
  restore_characters: restoreCharactersByInstruction,
  open_character: openCharacter,
  rename_character: renameCharacter,
  delete_chats: deleteChats,
  restore_chats: restoreChats,
  rename_chat: renameChat,
  update_chat_topic: updateChatTopic,
  create_assistant_chat: createAssistantChat,
  manage_group_members: manageGroupMembers,
  query_ai_balance: () => queryAiBalance(),
  update_theme: (plan) => updateTheme(plan),
  set_ai_model_key: (plan, _context, secrets) => setAiModelKey(plan, secrets),
  navigate: (plan, context) => {
    if (!plan.routePath) return { status: 'info', title: '缺少页面', message: '没有找到要打开的页面。' };
    const webPath = resolveCommandUrlForWeb(plan.routePath);
    if (context.source === 'assistant') {
      return {
        status: 'needs_confirmation',
        title: plan.title || '找到可打开页面',
        message: plan.summary || '请确认要打开这个页面。',
        choices: [{ id: 'open-page', label: plan.title || '打开页面', url: plan.routePath, kind: 'execute' }],
        choicePresentation: 'chips',
      };
    }
    context.navigate?.(webPath);
    return { status: 'success', title: '已打开页面', message: '已为你打开对应页面。', navigateTo: webPath };
  },
};

async function executeLocalActionPlan(route: Extract<AppCommandRoute, { mode: 'local_action' }>, context: AppCommandContext, secrets: Record<string, string>): Promise<AppCommandExecutionResult> {
  const plan = route.plan;
  if (shouldOpenSingleCharacterFromHome(plan, context)) {
    return createDirectChat({ ...plan, characterName: buildPlannedCharacters(plan, context.input)[0]?.name }, context);
  }
  const validationIssue = validateAppCommandPlan(plan);
  if (validationIssue) {
    return {
      status: 'info',
      title: validationIssue.title,
      message: validationIssue.message,
      recoverable: validationIssue.recoverable,
      reasonType: validationIssue.reasonType,
      observation: validationIssue.observation,
    };
  }
  const handler = LOCAL_ACTION_HANDLERS[plan.action];
  return handler ? handler(plan, context, secrets) : { status: 'info', title: '暂不支持', message: '这个动作暂时无法直接执行，已建议交给助手处理。' };
}

async function executeWorkflowRoute(route: Extract<AppCommandRoute, { mode: 'workflow' }>, context: AppCommandContext, secrets: Record<string, string>): Promise<AppCommandExecutionResult> {
  const completed: AppCommandExecutionResult[] = [];
  for (const [stepIndex, step] of route.steps.entries()) {
    const stepResult = await executeAppCommandRoute(localActionRouteFromStep(step, true), context, secrets);
    if (stepResult.status === 'needs_confirmation') return stepResult;
    if (stepResult.status !== 'success') {
      return {
        ...stepResult,
        observation: workflowStepObservation(step, stepIndex, stepResult.observation),
      };
    }
    completed.push(stepResult);
  }
  const last = completed.at(-1);
  const summary = completed
    .filter((item) => item.status === 'success')
    .map((item) => item.title)
    .filter(Boolean)
    .join('、');
  return {
    status: last?.status || 'info',
    title: route.title || last?.title || '已完成',
    message: route.summary || (summary ? `已完成：${summary}。` : last?.message || '已完成。'),
    markdown: last?.markdown,
    navigateTo: last?.navigateTo,
    candidates: last?.candidates,
    choices: last?.choices,
    choicePresentation: last?.choicePresentation,
  };
}

export async function executeAppCommandRoute(route: AppCommandRoute, context: AppCommandContext, secrets: Record<string, string> = {}): Promise<AppCommandExecutionResult> {
  if (route.mode === 'final_response') {
    return {
      status: 'success',
      title: route.title,
      message: route.message,
      markdown: route.message,
    };
  }
  if (route.mode === 'assistant_agent') {
    return {
      status: 'info',
      title: '需要助手继续处理',
      message: route.initialMessage,
    };
  }
  if (route.mode === 'workflow') {
    if (route.choices?.length) {
      savePendingRoute(context, route, secrets, undefined, route.choices);
      return {
        status: 'needs_confirmation',
        title: route.title || '请选择操作',
        message: route.confirmationText || route.summary || '请选择一种执行方式。',
        choices: route.choices,
      };
    }
    if (route.requiresConfirmation) {
      savePendingRoute(context, route, secrets, undefined, route.choices);
      return {
        status: 'needs_confirmation',
        title: route.title || '确认执行',
        message: route.confirmationText || route.summary || '这个操作会执行多个步骤，确认后继续。',
        choices: route.choices,
      };
    }
    return executeWorkflowRoute(route, context, secrets);
  }
  const plan = route.plan;
  if (route.choices?.length) {
    savePendingRoute(context, route, secrets, undefined, route.choices);
    return {
      status: 'needs_confirmation',
      title: plan.title || '请选择操作',
      message: route.confirmationText || plan.summary || '请选择一种执行方式。',
      choices: route.choices,
    };
  }
  if (route.requiresConfirmation) {
    savePendingRoute(context, route, secrets, undefined, route.choices);
    return {
      status: 'needs_confirmation',
      title: plan.title || '确认执行',
      message: route.confirmationText || plan.summary || '这个操作会创建或修改内容，确认后继续执行。',
      choices: route.choices,
    };
  }
  const result = await executeLocalActionPlan(route, context, secrets);
  if (result.status === 'needs_confirmation') savePendingRoute(context, route, secrets, result.candidates, result.choices);
  return result;
}
