import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import { buildPublicRoomUserCompanionshipLines, buildUserCompanionshipProjection } from './companionshipProjection';
import { adaptCharacterMindProjectionForPrompt } from './characterMindPromptAdapter';
import { retrieveRelevantMemories } from './memoryRetrieval';
import type { MemoryItem } from './memoryTypes';
import { projectNarrativeLines, type NarrativeLineProjection } from './narrativeProjection';
import { normalizeRelationshipLedgerEntry, resolveEffectiveRelationshipAxes } from './relationshipLedger';

const USER_ACTOR_ID = 'user';

export interface CharacterMindProjection {
  identity: {
    selfModel: string[];
    stableVoice: string[];
    desires: string[];
    fears: string[];
  };
  continuity: {
    userProfile: string[];
    selfMemories: string[];
    relationshipMemories: string[];
    sharedHistory: string[];
  };
  relationship: {
    targetId?: string;
    targetName?: string;
    stance: string[];
    currentRoomPressure: string[];
  };
  currentState: {
    emotionalUndercurrent: string[];
    activeNeeds: string[];
    selfAppraisal?: string;
  };
  room: {
    topic?: string;
    activeLines: string[];
    worldActivities: string[];
    constraints: string[];
  };
  expression: {
    socialMove: string;
    temperature: string;
    attention: string;
    length: string;
    omissions: string[];
  };
  hidden: {
    sourceIds: string[];
    conflictReasons: string[];
    privacyGuards: string[];
    recallCandidates: string[];
    memorySource: 'assembly_candidates' | 'fallback_retrieval';
  };
}

function compactText(text: string | undefined | null, max = 140) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function uniqueText(items: Array<string | undefined | null>, max = 6) {
  return Array.from(new Set(items.map((item) => compactText(item)).filter(Boolean))).slice(0, max);
}

function authoredSelfContinuity(character: AICharacter) {
  const memory = character.memory;
  if (!memory) return [];
  return uniqueText([
    memory.shortTermSummary ? `近期自我状态：${memory.shortTermSummary}` : '',
    ...(memory.longTerm || []).map((item) => `长期经历：${item}`),
    ...(memory.obsessions || []).map((item) => `注意力偏好：${item}`),
    ...(memory.tabooTopics || []).map((item) => `敏感触发：${item}`),
  ], 10);
}

function characterName(id: string | undefined, characters: AICharacter[]) {
  if (id === USER_ACTOR_ID) return '用户';
  return characters.find((item) => item.id === id)?.name || '成员';
}

function visibleMessages(messages: Message[]) {
  return messages.filter((item) => !item.isDeleted && item.type !== 'system' && item.type !== 'event');
}

function resolveTarget(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
  characters: AICharacter[];
  target?: { id: string; name?: string } | null;
}) {
  // null preserves an upstream decision that this turn has no counterpart.
  if (params.target === null) return undefined;
  if (params.target) {
    return { id: params.target.id, name: params.target.name || characterName(params.target.id, params.characters) };
  }
  if (params.chat.type === 'direct') return { id: USER_ACTOR_ID, name: '用户' };

  const latestOther = visibleMessages(params.messages)
    .slice()
    .reverse()
    .find((item) => item.senderId !== params.character.id);
  if (latestOther) {
    return {
      id: latestOther.senderId,
      name: latestOther.senderName || characterName(latestOther.senderId, params.characters),
    };
  }

  const firstOther = params.characters.find((item) => item.id !== params.character.id);
  return firstOther ? { id: firstOther.id, name: firstOther.name } : undefined;
}

interface RelationshipProjectionSource {
  warmth: number;
  competence: number;
  trust: number;
  threat: number;
  attachment?: number;
  deference?: number;
  note: string;
  semanticSummary?: string;
}

interface RelationshipProjectionInputs {
  authored: RelationshipProjectionSource | null;
  ledger: RelationshipProjectionSource | null;
}

function toAuthoredRelationshipSource(relation: AICharacter['relationships'][number] | undefined): RelationshipProjectionSource | null {
  if (!relation) return null;
  return {
    warmth: relation.warmth,
    competence: relation.competence,
    trust: relation.trust,
    threat: relation.threat,
    attachment: relation.attachment || 0,
    deference: relation.deference || 0,
    note: relation.note || '',
  };
}

function toLedgerRelationshipSource(entry: ReturnType<typeof normalizeRelationshipLedgerEntry> | undefined, authored?: AICharacter['relationships'][number], usesRoomAdjustment = false): RelationshipProjectionSource | null {
  if (!entry) return null;
  const current = authored && usesRoomAdjustment && entry.adjustment
    ? resolveEffectiveRelationshipAxes({
      warmth: authored.warmth,
      competence: authored.competence,
      trust: authored.trust,
      threat: authored.threat,
      attachment: authored.attachment || 0,
      deference: authored.deference || 0,
    }, entry.adjustment)
    : entry.current;
  return {
    warmth: current.warmth,
    competence: current.competence,
    trust: current.trust,
    threat: current.threat,
    attachment: current.attachment || 0,
    deference: current.deference || 0,
    note: entry.derived?.semantic?.summary || '',
    semanticSummary: entry.derived?.semantic?.summary || '',
  };
}

function resolveRelationshipInputs(params: {
  character: AICharacter;
  chat: GroupChat;
  targetId?: string;
}): RelationshipProjectionInputs {
  if (!params.targetId) return { authored: null, ledger: null };

  const authored = params.character.relationships.find((item) => item.characterId === params.targetId);
  const rawLedgerEntry = (params.chat.relationshipLedger || [])
    .find((item) => item.actorId === params.character.id && item.targetId === params.targetId);
  const ledgerEntry = rawLedgerEntry ? normalizeRelationshipLedgerEntry(rawLedgerEntry) : undefined;
  return {
    authored: toAuthoredRelationshipSource(authored),
    ledger: toLedgerRelationshipSource(ledgerEntry, authored, Boolean(rawLedgerEntry?.baseline || rawLedgerEntry?.adjustment)),
  };
}

function formatRelationshipStance(relationship: RelationshipProjectionSource | null) {
  if (!relationship) return [];
  // Preserve evidence rather than turning axis thresholds into mandatory behavior.
  return [
    `长期关系底色（-100 至 100）：亲和 ${relationship.warmth}、能力 ${relationship.competence}、信任 ${relationship.trust}、威胁 ${relationship.threat}、在意 ${relationship.attachment ?? 0}、让位 ${relationship.deference ?? 0}。`,
  ];
}

function formatMergedRelationshipStance(inputs: RelationshipProjectionInputs) {
  // Authored relationships are the cross-room source of truth. The room ledger
  // only remains as a migration fallback for characters that have no global
  // relationship yet; mixing both can re-introduce stale, contradictory stance.
  return formatRelationshipStance(inputs.authored || inputs.ledger);
}

function collectRelationshipContinuity(params: {
  chat: GroupChat;
  character: AICharacter;
  characters: AICharacter[];
  targetId?: string;
  relationship: RelationshipProjectionInputs;
}) {
  const targetId = params.targetId;
  const sharedFacts = (params.chat.relationshipStructure?.sharedFacts || [])
    .filter((fact) => fact.memberIds.includes(params.character.id))
    .sort((left, right) => {
      const leftTargetsCurrent = targetId && left.memberIds.includes(targetId) ? 1 : 0;
      const rightTargetsCurrent = targetId && right.memberIds.includes(targetId) ? 1 : 0;
      return rightTargetsCurrent - leftTargetsCurrent;
    });
  const publicRelationshipFacts = params.chat.type === 'group'
    ? sharedFacts.map((fact) => `共同关系：${fact.statement}`)
    : targetId
      ? sharedFacts.filter((fact) => fact.memberIds.includes(targetId)).map((fact) => `共同关系：${fact.statement}`)
      : [];
  if (!targetId) {
    return uniqueText([
      ...publicRelationshipFacts,
      params.relationship.authored?.note,
      params.relationship.ledger?.semanticSummary || params.relationship.ledger?.note,
    ], 3);
  }
  const semanticSummaries = (params.chat.relationshipLedger || [])
    .map(normalizeRelationshipLedgerEntry)
    .filter((entry) => entry.actorId === params.character.id && entry.targetId === params.targetId)
    .map((entry) => entry.derived?.semantic?.summary || '');
  const groupRelationshipNotes = params.chat.type === 'group'
    ? params.character.relationships
      .filter((relation) => relation.characterId !== targetId && params.chat.memberIds.includes(relation.characterId))
      .filter((relation) => Boolean(relation.note?.trim()))
      .slice(0, 3)
      .map((relation) => `对${characterName(relation.characterId, params.characters)}的看法：${relation.note}`)
    : [];
  return uniqueText([
    ...publicRelationshipFacts,
    params.relationship.authored?.note ? `长期关系：${params.relationship.authored.note}` : '',
    !params.relationship.authored && params.relationship.ledger?.semanticSummary ? `当前关系：${params.relationship.ledger.semanticSummary}` : '',
    ...(!params.relationship.authored ? semanticSummaries.map((summary) => summary ? `当前关系：${summary}` : '') : []),
    ...groupRelationshipNotes,
  ], 4);
}

function buildMemoryCueText(chat: GroupChat, messages: Message[]) {
  const recentLines = visibleMessages(messages)
    .slice(-4)
    .map((item) => `${item.senderName || item.senderId}: ${item.content}`)
    .join('\n');
  return compactText([chat.topic, chat.worldState.focus, chat.worldState.recentEvent, recentLines].filter(Boolean).join('\n'), 500);
}

function collectMemoryText(params: {
  character: AICharacter;
  chat: GroupChat;
  messages: Message[];
  targetId?: string;
  now: number;
  memoryCandidates?: MemoryItem[];
}) {
  const memories = params.memoryCandidates
    ? params.memoryCandidates
    : retrieveRelevantMemories(params.character.layeredMemories || [], {
      speakerId: params.character.id,
      targetId: params.targetId,
      conversationId: params.chat.id,
      cueText: buildMemoryCueText(params.chat, params.messages),
      maxItems: 30,
      maxArchivedItems: 3,
      includeArchivedRecall: true,
      relationshipBoost: Boolean(params.targetId),
      selfMemoryBoost: true,
      conversationBoost: true,
      now: params.now,
    });
  const userProfile = [
    ...(params.character.memory?.userMemories || []),
    ...memories
      .filter((item) => item.kind !== 'bond' && item.kind !== 'artifact')
      .filter((item) => item.subjectIds?.includes(USER_ACTOR_ID) || item.sourceTag?.includes('direct_user') || item.text.includes('用户'))
      .map((item) => item.summary || item.text),
  ];
  const selfMemories = memories
    .filter((item) => item.scope === 'character_self')
    .map((item) => item.summary || item.text);
  const relationshipMemories = memories
    .filter((item) => item.scope === 'relationship' && (!params.targetId || item.subjectIds?.includes(params.targetId)))
    .map((item) => item.summary || item.text);
  const sharedHistory = memories
    .filter((item) => item.scope === 'conversation' || item.scope === 'thread')
    .map((item) => item.summary || item.text);
  return {
    userProfile: uniqueText(userProfile, 8),
    selfMemories: uniqueText(selfMemories, 6),
    relationshipMemories: uniqueText(relationshipMemories, 6),
    sharedHistory: uniqueText(sharedHistory, 6),
    sourceIds: memories.map((item) => item.id),
  };
}

function memorySourceEventIds(items: MemoryItem[]) {
  return items.flatMap((item) => item.sourceEventIds || []);
}

function companionshipContinuity(params: {
  chat: GroupChat;
  character: AICharacter;
  messages: Message[];
}) {
  const projection = buildUserCompanionshipProjection({
    chat: params.chat,
    character: params.character,
    messages: params.messages,
  });
  const bond = projection.userBond;
  const publicLines = params.chat.type === 'group'
    ? buildPublicRoomUserCompanionshipLines(params.chat, params.character)
    : [];
  if (!bond) {
    return {
      userProfile: uniqueText(publicLines, 8),
      relationshipMemories: [],
      sharedHistory: [],
      privacyGuards: [],
    };
  }

  return {
    userProfile: uniqueText([
      ...publicLines,
      bond.userProfile.displayName,
      bond.userProfile.addressPreference,
      ...bond.userProfile.preferences,
      ...bond.userProfile.dislikes,
      ...bond.userProfile.scheduleHints,
      ...bond.userProfile.pressureSources,
      ...bond.userProfile.importantDates,
      ...bond.userProfile.recentPlans,
    ], 8),
    relationshipMemories: uniqueText([
      ...bond.pendingPromises.map((item) => item.text),
      ...bond.unresolvedTensions,
    ], 6),
    sharedHistory: uniqueText(projection.evidence, 4),
    privacyGuards: uniqueText(bond.userProfile.boundaries, 4),
  };
}

function formatNarrativeLine(line: NarrativeLineProjection) {
  return `${line.title}: ${compactText(line.summary, 120)}`;
}

function emotionSignals(character: AICharacter) {
  const emotional = character.emotionalState;
  const soul = character.soulState;
  return [
    emotional ? `Recorded emotion axes: irritation ${emotional.irritation}, affection ${emotional.affection}, insecurity ${emotional.insecurity}, excitement ${emotional.excitement}, embarrassment ${emotional.embarrassment}.` : '',
    soul ? `Recorded state: energy ${soul.energy}, loneliness ${soul.loneliness}, repression ${soul.repression}, shame ${soul.shame}, envy ${soul.envy}.` : '',
  ].filter(Boolean);
}

function buildRoomPressure(params: {
  chat: GroupChat;
  targetId?: string;
}) {
  const room = params.chat.worldState.structuredRoomState;
  if (!room) return [];
  return uniqueText([
    room.pileOnTarget === params.targetId ? '目标正在承受房间里的集中压力。' : '',
    params.targetId && room.dominantThread?.includes(params.targetId) ? '目标处于房间主要对话线程。' : '',
    params.targetId && room.alliances.some((pair) => pair.includes(params.targetId as string)) ? '目标牵涉当前可见联盟。' : '',
    params.targetId && room.conflictPairs.some((pair) => pair.includes(params.targetId as string)) ? '目标牵涉当前可见冲突。' : '',
    room.heat >= 65 ? '房间热度较高，普通话需要考虑公开压力。' : '',
    room.cohesion <= -35 ? '房间凝聚度偏低，成员更容易各说各话。' : '',
  ], 6);
}

function buildChannelConstraints(chat: GroupChat) {
  if (chat.type === 'direct') {
    return [
      '这是私密用户会话，亲近感、连续性和个人立场比公开房间态势更重要。',
      '当前要回答的是用户最新一句，不要把用户原话当成自己的发言。',
    ];
  }
  if (chat.type === 'ai_direct') {
    return ['这是 AI 之间的私密对话，优先处理彼此关系、未完张力和成对连续性。'];
  }
  if (chat.type === 'group') {
    return ['这是公开多人房间，公开时机、群体压力和可见关系会影响表达。'];
  }
  return [];
}

function conflictPressureLabel(nextPressure?: string) {
  if (nextPressure === 'cool') return '需要降温';
  if (nextPressure === 'divert') return '可能转移话题';
  if (nextPressure === 'spread') return '可能扩散到更多人';
  if (nextPressure === 'stabilize') return '需要稳住立场';
  if (nextPressure === 'escalate') return '可能升级';
  return '';
}

function buildConflictConstraints(params: {
  chat: GroupChat;
  character: AICharacter;
}) {
  const primary = params.chat.worldState.conflictState?.primaryConflict;
  if (!primary || primary.stage === 'resolved') return [];
  const involved = (primary.participantIds || []).includes(params.character.id)
    || (primary.targetIds || []).includes(params.character.id);
  const pressure = conflictPressureLabel(primary.nextPressure);
  return uniqueText([
    primary.summary ? `当前矛盾：${primary.summary}。` : '',
    `矛盾阶段：${primary.stage || 'active'}，强度 ${Math.round((primary.severity || 0) * 100)}%。${pressure ? ` ${pressure}。` : ''}`,
    involved
      ? '你直接牵涉在这个矛盾里，回应应从自己的立场出发，而不是旁观总结。'
      : '当前矛盾会影响房间温度，回应时可选择注意、回避、缓和或推进。',
  ], 3);
}

export function buildCharacterMindProjection(params: {
  chat: GroupChat;
  character: AICharacter;
  characters: AICharacter[];
  messages: Message[];
  target?: { id: string; name?: string } | null;
  memoryCandidates?: MemoryItem[];
  now?: number;
}): CharacterMindProjection {
  const now = params.now || Date.now();
  const target = resolveTarget(params);
  const relationship = resolveRelationshipInputs({
    character: params.character,
    chat: params.chat,
    targetId: target?.id,
  });
  const relationshipContinuity = collectRelationshipContinuity({
    chat: params.chat,
    character: params.character,
    characters: params.characters,
    targetId: target?.id,
    relationship,
  });
  const memories = collectMemoryText({
    character: params.character,
    chat: params.chat,
    messages: params.messages,
    targetId: target?.id,
    now,
    memoryCandidates: params.memoryCandidates,
  });
  const authoredContinuity = authoredSelfContinuity(params.character);
  const companionship = companionshipContinuity(params);
  const narrativeLines = projectNarrativeLines({
    chat: params.chat,
    characters: params.characters,
    messages: params.messages,
    now,
  });
  const activeLines = narrativeLines.slice(0, 5).map(formatNarrativeLine);
  const worldActivities = narrativeLines
    .filter((line) => line.type === 'scenario' || line.type === 'faction' || line.type === 'goal' || line.type === 'growth')
    .slice(0, 4)
    .map(formatNarrativeLine);
  const identity = params.character.coreProfile;
  const roomPressure = buildRoomPressure({ chat: params.chat, targetId: target?.id });
  const emotionalUndercurrent = emotionSignals(params.character);
  const privacyGuards = uniqueText([
    ...companionship.privacyGuards,
    params.chat.type === 'group' && memories.userProfile.length ? '用户相关私密事实只能影响克制和关心，不要在公开房间直接说出。' : '',
    params.character.memory?.secrets?.length ? '角色有未公开的自有内容，只能影响回避、克制或防御，不要主动揭露正文。' : '',
  ], 5);
  const conflictReasons = uniqueText([
    ...narrativeLines.filter((line) => line.tension >= 0.55).slice(0, 3).map((line) => `${line.title}正在和普通聊天节奏竞争。`),
  ], 5);

  return {
    identity: {
      selfModel: uniqueText([
        params.character.background,
        identity?.selfImage,
        identity?.socialMask,
        identity?.values?.join('、'),
      ], 6),
      stableVoice: uniqueText([
        params.character.speakingStyle,
        identity?.interactionHabits?.join('、'),
        identity?.expressionHabits?.join('、'),
        params.character.speechProfile?.sentenceLengthBias ? `表达长度倾向：${params.character.speechProfile.sentenceLengthBias}` : '',
      ], 5),
      desires: uniqueText([identity?.coreDesire, ...(identity?.unmetNeeds || []), ...(identity?.hiddenSoftSpots || [])], 4),
      fears: uniqueText([identity?.coreFear, ...(identity?.sensitivities || [])], 4),
    },
    continuity: {
      userProfile: uniqueText([...memories.userProfile, ...companionship.userProfile], 10),
      selfMemories: uniqueText([...authoredContinuity, ...memories.selfMemories], 10),
      relationshipMemories: uniqueText([
        ...relationshipContinuity,
        ...memories.relationshipMemories,
        ...companionship.relationshipMemories,
      ], 8),
      sharedHistory: uniqueText([...memories.sharedHistory, ...companionship.sharedHistory], 8),
    },
    relationship: {
      targetId: target?.id,
      targetName: target?.name,
      stance: formatMergedRelationshipStance(relationship),
      currentRoomPressure: roomPressure,
    },
    currentState: {
      emotionalUndercurrent,
      // No model-authored current need is recorded here. Authored lifelong needs
      // belong to identity; scheduler impulse reasons are not emotional evidence.
      activeNeeds: [],
    },
    room: {
      topic: compactText(params.chat.topic, 160) || undefined,
      activeLines,
      worldActivities,
      constraints: uniqueText([
        ...buildConflictConstraints({ chat: params.chat, character: params.character }),
        ...roomPressure,
        ...buildChannelConstraints(params.chat),
      ], 6),
    },
    expression: {
      socialMove: conflictReasons.length ? '先处理当前关系或矛盾压力，再决定是否回答完整。' : '对当前最有注意力的对象做一个具体、自然的回应。',
      temperature: '由当前事件、人物经历和已记录情绪决定；长期关系不是固定口吻。',
      attention: target ? `注意力暂时落在${target.name}及其刚才的发言上。` : '注意力落在当前话题和最新变化上。',
      length: params.character.soulState?.energy !== undefined && params.character.soulState.energy < 35 ? '允许短、半句或不完整回应。' : '不要为了完整而补齐所有观点，按当下注意力自然决定长度。',
      omissions: [
        privacyGuards.some((guard) => guard.includes('用户相关私密事实')) ? '私密用户事实' : '',
        params.character.memory?.secrets?.length ? '未公开的角色自有内容' : '',
        '内部状态分数',
        '没有自然触发的旧事',
      ].filter(Boolean),
    },
    hidden: {
      sourceIds: [
        ...memories.sourceIds,
        ...memorySourceEventIds(params.character.layeredMemories || []).slice(-12),
        ...(params.chat.runtimeEventsV2 || []).slice(-12).map((event) => event.id),
      ].filter((id, index, list) => list.indexOf(id) === index).slice(0, 24),
      conflictReasons,
      privacyGuards,
      recallCandidates: uniqueText([
        ...memories.userProfile,
        ...memories.relationshipMemories,
        ...memories.sharedHistory,
      ], 12),
      memorySource: params.memoryCandidates ? 'assembly_candidates' : 'fallback_retrieval',
    },
  };
}

export interface CharacterMindProjectionPromptOptions {
  visibility?: 'public' | 'private';
  includeActiveRoomLineSummaries?: boolean;
}

export function buildCharacterMindProjectionPromptBlock(projection: CharacterMindProjection, options: CharacterMindProjectionPromptOptions = {}) {
  return adaptCharacterMindProjectionForPrompt(projection, {
    chatType: options.visibility === 'private' ? 'direct' : 'group',
    visibility: options.visibility || 'public',
    includeActiveRoomLineSummaries: options.includeActiveRoomLineSummaries ?? false,
    renderVisibleRecallCues: false,
  }).promptBlock;
}
