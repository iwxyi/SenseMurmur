import type { AICharacter, CharacterSoulState, InnerImpulse } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { InteractionEventPayload } from '../types/runtimeEvent';
import { getExpressionFeedbackSignal, summarizeExpressionFeedbackInfluence } from './expressionFeedbackInfluence';
import { getExplicitReplyTargetIds } from './chatMessageSemantics';

export type InnerLifeTone = 'casual' | 'defensive' | 'teasing' | 'serious' | 'tired' | 'vulnerable';
export type InnerLifeLength = 'micro' | 'short' | 'normal' | 'long';

export interface InnerLifeExpressionPlan {
  tone: InnerLifeTone;
  length: InnerLifeLength;
  messageCount: number;
  typoLevel: number;
  delayMs: number;
  allowWithdraw: boolean;
}

export interface InnerLifeProjection {
  actorId: string;
  impulse: InnerImpulse;
  tone: InnerLifeTone;
  reason: string;
  pressure: number;
  evidence: string[];
  state: CharacterSoulState;
  expressionPlan: InnerLifeExpressionPlan;
  activeAffect?: {
    counterpartId: string;
    kind: InteractionEventPayload['kind'];
    tone: InteractionEventPayload['tone'];
    role: 'received' | 'expressed';
    pressure: number;
    age: number;
  } | null;
  dominantEmotion?: {
    kind: keyof NonNullable<AICharacter['emotionalState']>;
    value: number;
    lead: number;
  } | null;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number) {
  return Math.round(clamp(value));
}

function resolveDominantEmotion(character: AICharacter): NonNullable<InnerLifeProjection['dominantEmotion']> | null {
  const entries = Object.entries(character.emotionalState || {})
    .filter((entry): entry is [keyof NonNullable<AICharacter['emotionalState']>, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .sort((left, right) => right[1] - left[1]);
  const strongest = entries[0];
  if (!strongest || strongest[1] < 12) return null;
  return {
    kind: strongest[0],
    value: strongest[1],
    lead: strongest[1] - (entries[1]?.[1] || 0),
  };
}

function buildExpressionFeedbackBias(character: AICharacter) {
  const signals = summarizeExpressionFeedbackInfluence(character.layeredMemories || []);
  const tooLong = getExpressionFeedbackSignal(signals, 'too_long');
  const tooFormal = getExpressionFeedbackSignal(signals, 'too_formal');
  const tooAssistant = getExpressionFeedbackSignal(signals, 'too_assistant');
  const outOfCharacter = getExpressionFeedbackSignal(signals, 'out_of_character');
  return {
    shorter: (tooLong?.strength || 0) >= 0.34 || (tooAssistant?.strength || 0) >= 0.46,
    strongShorter: (tooLong?.strength || 0) >= 0.72 || (tooAssistant?.strength || 0) >= 0.78,
    lessFormal: (tooFormal?.strength || 0) >= 0.34,
    lessAssistant: (tooAssistant?.strength || 0) >= 0.34,
    closerToRole: (outOfCharacter?.strength || 0) >= 0.34,
    hasAny: signals.length > 0,
  };
}

function shortenLength(length: InnerLifeLength, strong = false): InnerLifeLength {
  if (strong && (length === 'long' || length === 'normal')) return 'short';
  if (length === 'long') return 'normal';
  if (length === 'normal') return 'short';
  return length;
}

function createDefaultSoulState(character: AICharacter): CharacterSoulState {
  const emotional = character.emotionalState;
  return {
    mood: {
      pleasure: clamp((emotional?.affection || 0) + (emotional?.excitement || 0) * 0.35 - (emotional?.irritation || 0) * 0.45 - (emotional?.insecurity || 0) * 0.25, -100, 100),
      arousal: clamp((emotional?.excitement || 0) + (emotional?.irritation || 0) * 0.6 + (emotional?.embarrassment || 0) * 0.25, 0, 100),
      dominance: clamp((character.personality.assertiveness || 50) - (emotional?.embarrassment || 0) * 0.35 - (emotional?.insecurity || 0) * 0.2, 0, 100),
    },
    energy: clamp((character.personality.extroversion || 50) * 0.55 + (character.behavior.proactivity || 50) * 0.35 + (emotional?.excitement || 0) * 0.2),
    attention: clamp(45 + (character.behavior.proactivity || 50) * 0.35),
    loneliness: 0,
    repression: clamp((emotional?.insecurity || 0) * 0.25 + (emotional?.embarrassment || 0) * 0.2),
    shame: clamp((emotional?.embarrassment || 0) * 0.65 + (emotional?.insecurity || 0) * 0.25),
    envy: 0,
    trustInRoom: clamp(55 + (character.personality.agreeableness || 50) * 0.25 - (emotional?.irritation || 0) * 0.25),
    ignoredStreak: 0,
    updatedAt: Date.now(),
  };
}

function countIgnoredTurns(character: AICharacter, messages: Message[]) {
  const active = messages.filter((message) => !message.isDeleted && (message.type === 'ai' || message.type === 'user' || message.type === 'god'));
  const lastOwnIndex = [...active].reverse().findIndex((message) => message.type === 'ai' && message.senderId === character.id);
  if (lastOwnIndex < 0) return character.soulState?.ignoredStreak || 0;
  const ownAbsoluteIndex = active.length - 1 - lastOwnIndex;
  const tail = active.slice(ownAbsoluteIndex + 1);
  const wasAcknowledged = tail.some((message) => {
    const directed = message as Message & {
      addressedTargetIds?: string[];
      primaryAddressedTargetId?: string;
      interactionHints?: Array<{ targetId?: string | null }>;
    };
    return message.senderId === character.id
      || directed.addressedTargetIds?.includes(character.id)
      || directed.primaryAddressedTargetId === character.id
      || directed.interactionHints?.some((hint) => hint.targetId === character.id);
  });
  if (wasAcknowledged) return 0;
  // One intervening turn is normal conversation, not evidence of exclusion.
  return tail.length < 2 ? 0 : Math.min(5, tail.length);
}

function latestOtherMessage(character: AICharacter, messages: Message[]) {
  return messages.filter((message) => !message.isDeleted && message.senderId !== character.id).at(-1) || null;
}

function latestOwnMessage(character: AICharacter, messages: Message[]) {
  return messages.filter((message) => !message.isDeleted && message.type === 'ai' && message.senderId === character.id).at(-1) || null;
}

function latestUnansweredAddress(character: AICharacter, messages: Message[]) {
  const visible = messages.filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event');
  const lastOwnIndex = visible.findLastIndex((message) => message.type === 'ai' && message.senderId === character.id);
  return visible
    .slice(lastOwnIndex + 1)
    .filter((message) => message.senderId !== character.id && getExplicitReplyTargetIds(message).includes(character.id))
    .at(-1) || null;
}

function projectDirectedAffect(chat: GroupChat | null | undefined, characterId: string, messages: Message[]): InnerLifeProjection['activeAffect'] {
  const visible = messages.filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event');
  const latest = visible.at(-1);
  if (!latest) return null;
  const events = (chat?.runtimeEventsV2 || []).filter((event) => event.kind === 'interaction');
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = event.payload as InteractionEventPayload;
    if (!payload?.targetId || !payload.actorId || !payload.kind) continue;
    const role = payload.targetId === characterId ? 'received' : payload.actorId === characterId ? 'expressed' : null;
    if (!role) continue;
    const age = visible.filter((message) => message.timestamp > event.createdAt).length;
    if (age > 5) break;
    // Receiving can spike immediately; expression releases pressure but leaves
    // a shorter residue attached to the same person, never to the next speaker.
    const pressure = clamp01((Number(payload.intensity) / 5) * (role === 'received' ? 1 : 0.48) * Math.pow(0.75, age));
    if (pressure < 0.12) continue;
    return {
      counterpartId: role === 'received' ? payload.actorId : payload.targetId,
      kind: payload.kind,
      tone: payload.tone,
      role,
      pressure,
      age,
    };
  }
  return null;
}

function inferTopicAttention(character: AICharacter, message: Message | null) {
  if (!message) return 0;
  const text = message.content.toLowerCase();
  return character.expertise.some((keyword) => keyword && text.includes(keyword.toLowerCase())) ? 16 : 0;
}

function chooseImpulse(params: {
  character: AICharacter;
  state: CharacterSoulState;
  addressed: boolean;
  repairPressure: number;
  relationship?: AICharacter['relationships'][number];
  activeAffect?: InnerLifeProjection['activeAffect'];
}): { impulse: InnerImpulse; reason: string; pressure: number } {
  const { character, state, addressed, repairPressure, relationship, activeAffect } = params;
  const deference = relationship?.deference || 0;
  const threat = relationship?.threat || 0;
  const trust = relationship?.trust || 0;
  const warmth = relationship?.warmth || 0;
  const attachment = relationship?.attachment || 0;
  const dominantEmotion = resolveDominantEmotion(character);
  const expressiveEmotion = Boolean(activeAffect && dominantEmotion
    && (dominantEmotion.value >= 30 || (activeAffect.pressure >= 0.35 && dominantEmotion.value >= 14))
    && dominantEmotion.lead >= 4);
  if (addressed && deference >= 30) return { impulse: 'answer', reason: '被自己会让位或敬畏的人直接看过来，这不仅是回答问题，也是在承受评价。', pressure: 0.94 };
  if (addressed && (threat >= 24 || trust <= -18)) return { impulse: 'defend_face', reason: '不信任或戒备的对象直接施压，先出现的是防守和保住解释权。', pressure: 0.88 };
  if (addressed && (attachment >= 25 || warmth >= 30)) return { impulse: 'answer', reason: '在意的人直接接话，对方的反应比问题本身更能牵动这一轮。', pressure: 0.9 };
  if (addressed) return { impulse: 'answer', reason: '被点名或被直接接话，需要先回应。', pressure: 0.86 };
  if (activeAffect && activeAffect.pressure >= 0.28) {
    const { kind, role, pressure } = activeAffect;
    if (role === 'received' && ['challenge', 'mock', 'dismiss', 'pile_on', 'probe', 'exclude', 'boundary'].includes(kind)) {
      return { impulse: 'defend_face', reason: '刚才针对自己的话仍有余波，是否反击、解释或沉默取决于关系和角色习惯。', pressure: Math.max(0.56, pressure) };
    }
    if (role === 'received' && ['support', 'defend', 'apologize', 'concede', 'take_responsibility', 'include'].includes(kind)) {
      return { impulse: 'answer', reason: '刚被人偏袒或支持，对方的举动仍牵动注意力。', pressure: Math.max(0.52, pressure) };
    }
    if (role === 'expressed' && ['challenge', 'mock', 'dismiss', 'pile_on', 'exclude', 'boundary'].includes(kind) && pressure >= 0.28) {
      return { impulse: 'repair', reason: '自己的锋芒刚表达出去，余波还在；是否找补取决于性格，不等于必须道歉。', pressure };
    }
  }
  if (repairPressure >= 38 && !(expressiveEmotion && dominantEmotion?.kind === 'irritation' && dominantEmotion.value >= 65)) return { impulse: 'repair', reason: '前面的刺或嘴硬留下了关系余波，现在有一点找补、缓和或别扭靠近的冲动。', pressure: 0.57 };
  if (expressiveEmotion && dominantEmotion?.kind === 'irritation') return { impulse: 'mock', reason: `即时烦躁是当前最强情绪（${Math.round(dominantEmotion.value)}），想把刺递回去但还没到失控。`, pressure: 0.68 };
  if (expressiveEmotion && dominantEmotion?.kind === 'affection') return { impulse: 'comfort', reason: `即时亲近感领先（${Math.round(dominantEmotion.value)}），更想接住对方而不是只处理事实。`, pressure: 0.65 };
  if (expressiveEmotion && dominantEmotion?.kind === 'excitement') return { impulse: 'show_off', reason: `兴奋感把注意力推到前台（${Math.round(dominantEmotion.value)}），想抢先把自己的反应递出去。`, pressure: 0.64 };
  if (expressiveEmotion && (dominantEmotion?.kind === 'insecurity' || dominantEmotion?.kind === 'embarrassment')) return { impulse: 'defend_face', reason: `不安或尴尬突然占上风（${Math.round(dominantEmotion.value)}），先护住面子再决定是否解释。`, pressure: 0.67 };
  if (state.loneliness >= 62 && character.behavior.proactivity >= 45) return { impulse: 'seek_attention', reason: '最近发言没有被接住，想确认自己仍被看见。', pressure: 0.58 };
  if (state.shame >= 58 || state.repression >= 64) return { impulse: 'defend_face', reason: '面子风险和压抑感较高，容易嘴硬或找补。', pressure: 0.62 };
  if (state.energy < 28 || state.trustInRoom < 26) return { impulse: 'avoid', reason: '当前能量或房间安全感偏低，更倾向短句回避。', pressure: 0.42 };
  if (character.behavior.proactivity >= 72 && character.personality.assertiveness >= 75 && character.personality.humor < 30) {
    return { impulse: 'take_control', reason: '主动性和支配感都高，当前更想接管场面、划清责任或作出裁断，而不是证明自己。', pressure: 0.54 };
  }
  if (character.behavior.proactivity >= 72) return { impulse: 'show_off', reason: '主动性较高，想争取解释权或表现自己。', pressure: 0.46 };
  return { impulse: 'stay_silent', reason: '没有强触发，内在动机暂时不足。', pressure: 0.24 };
}

function buildExpressionPlan(impulse: InnerImpulse, impulsePressure: number, state: CharacterSoulState, character: AICharacter, relationship?: AICharacter['relationships'][number], addressed = false, activeAffect?: InnerLifeProjection['activeAffect']): InnerLifeExpressionPlan {
  const defensive = impulse === 'defend_face' || impulse === 'mock' || (addressed && ((relationship?.threat || 0) >= 24 || (relationship?.trust || 0) <= -18));
  const vulnerable = impulse === 'comfort' || impulse === 'repair' || (state.loneliness >= 70 && impulse === 'seek_attention');
  const authorityPressure = addressed && (relationship?.deference || 0) >= 30;
  const emotion = resolveDominantEmotion(character);
  const exposedEmotion = (addressed || (activeAffect?.pressure || 0) >= 0.28)
    && emotion && emotion.value >= 45 && emotion.lead >= 12 ? emotion.kind : null;
  const feedback = buildExpressionFeedbackBias(character);
  const baseLength: InnerLifeLength = impulse === 'answer' || impulse === 'take_control' ? 'short' : impulse === 'show_off' ? 'normal' : state.energy < 30 || impulse === 'avoid' ? 'micro' : 'short';
  const length = feedback.shorter || feedback.lessAssistant ? shortenLength(baseLength, feedback.strongShorter) : baseLength;
  return {
    // Situational pressure outranks the generic "less formal" style memory.
    // A character may speak colloquially while still sounding guarded or
    // authoritative; flattening that to `casual` is what made interrogations
    // and power-difference scenes read emotionally blank in the trace.
    tone: activeAffect && activeAffect.pressure >= 0.35 && ['challenge', 'mock', 'dismiss', 'pile_on', 'exclude', 'boundary'].includes(activeAffect.kind)
      ? 'defensive'
      : activeAffect && activeAffect.pressure >= 0.35 && ['support', 'defend', 'apologize', 'concede', 'take_responsibility', 'include'].includes(activeAffect.kind)
        ? 'vulnerable'
      : defensive
      ? (impulse === 'mock' ? 'teasing' : 'defensive')
      : authorityPressure
        ? 'serious'
        : impulse === 'take_control'
          ? 'serious'
        : addressed && ((relationship?.attachment || 0) >= 25 || (relationship?.warmth || 0) >= 30)
          ? 'vulnerable'
        : exposedEmotion === 'irritation' || exposedEmotion === 'insecurity'
          ? 'defensive'
          : exposedEmotion === 'embarrassment' || exposedEmotion === 'affection'
            ? 'vulnerable'
        : vulnerable
          ? 'vulnerable'
          : impulsePressure >= 0.75
            ? 'serious'
          : state.energy < 30
            ? 'tired'
            : feedback.lessFormal || feedback.lessAssistant
              ? 'casual'
              : 'casual',
    length,
    // Bubble count is a semantic delivery decision made while writing. Inner
    // life supplies pressure and rhythm, not a locally inferred send count.
    messageCount: 1,
    typoLevel: round((character.speechProfile?.sarcasmBias || 0) * 0.06 + (state.mood.arousal || 0) * 0.08),
    delayMs: Math.round(500 + (100 - state.energy) * 22 + (state.repression || 0) * 12),
    allowWithdraw: state.repression >= 56 || state.shame >= 62 || impulse === 'withdraw',
  };
}

export function projectInnerLife(params: {
  chat?: GroupChat | null;
  character: AICharacter;
  messages: Message[];
  now?: number;
  explicitUserAddressed?: boolean;
}): InnerLifeProjection {
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? Math.round(params.now) : Date.now();
  const previous = params.character.soulState || createDefaultSoulState(params.character);
  const lastMessage = latestOtherMessage(params.character, params.messages);
  const lastOwnMessage = latestOwnMessage(params.character, params.messages);
  const unansweredAddress = latestUnansweredAddress(params.character, params.messages);
  const socialTriggerMessage = unansweredAddress || lastMessage;
  const activeAffect = projectDirectedAffect(params.chat, params.character.id, params.messages);
  const addressed = Boolean(params.explicitUserAddressed) || Boolean(unansweredAddress);
  const relationship = socialTriggerMessage
    ? params.character.relationships.find((item) => item.characterId === socialTriggerMessage.senderId)
    : undefined;
  const ignoredStreak = countIgnoredTurns(params.character, params.messages);
  const topicAttention = inferTopicAttention(params.character, lastMessage);
  const emotional = params.character.emotionalState;
  const room = params.chat?.worldState?.structuredRoomState;
  const safetyBaseline = clamp(50 + ((params.character.personality.agreeableness ?? 50) - 50) * 0.24
    + ((room?.cohesion ?? 50) - 50) * 0.16
    - (emotional?.irritation || 0) * 0.16 - (emotional?.insecurity || 0) * 0.2);
  const state: CharacterSoulState = {
    ...previous,
    mood: {
      pleasure: clamp((previous.mood?.pleasure || 0) * 0.65 + (emotional?.affection || 0) * 0.18 + (emotional?.excitement || 0) * 0.1 - (emotional?.irritation || 0) * 0.16, -100, 100),
      arousal: clamp((previous.mood?.arousal || 0) * 0.55 + (emotional?.excitement || 0) * 0.22 + (emotional?.irritation || 0) * 0.18 + (addressed ? 12 : 0)),
      dominance: clamp((previous.mood?.dominance || 45) * 0.7 + (params.character.personality.assertiveness || 50) * 0.2 - (emotional?.embarrassment || 0) * 0.12),
    },
    energy: clamp((previous.energy || 45) * 0.72 + (params.character.personality.extroversion || 50) * 0.12 + (params.character.behavior.proactivity || 50) * 0.12 + (emotional?.excitement || 0) * 0.08 - ignoredStreak * 2),
    attention: clamp((previous.attention || 45) * 0.6 + (addressed ? 28 : 0) + topicAttention + (room?.heat || 0) * 0.08),
    loneliness: clamp((previous.loneliness || 0) * 0.55 + ignoredStreak * 10 - (addressed ? 22 : 0)),
    repression: clamp((previous.repression || 0) * 0.72 + (emotional?.irritation || 0) * 0.08 + (emotional?.insecurity || 0) * 0.08),
    shame: clamp((previous.shame || 0) * 0.66 + (emotional?.embarrassment || 0) * 0.18 + (emotional?.insecurity || 0) * 0.08),
    envy: clamp((previous.envy || 0) * 0.72),
    trustInRoom: clamp((previous.trustInRoom ?? safetyBaseline) * 0.7 + safetyBaseline * 0.3),
    ignoredStreak,
    updatedAt: now,
  };
  const repairPressure = lastOwnMessage && lastMessage && activeAffect?.role === 'expressed'
    && ['challenge', 'mock', 'dismiss', 'pile_on', 'exclude', 'boundary'].includes(activeAffect.kind)
    ? Math.round(activeAffect.pressure * 55) : 0;
  const impulse = chooseImpulse({ character: params.character, state, addressed, repairPressure, relationship, activeAffect });
  const directHumanPressure = Boolean(params.explicitUserAddressed) || (addressed
    && (socialTriggerMessage?.type === 'user' || socialTriggerMessage?.type === 'god')
    && (socialTriggerMessage.content.length >= 12 || /[?？!！]/u.test(socialTriggerMessage.content)));
  const expressionPlan = buildExpressionPlan(impulse.impulse, impulse.pressure, state, params.character, relationship, addressed, activeAffect);
  if (directHumanPressure && expressionPlan.tone === 'casual') {
    expressionPlan.tone = 'serious';
  }
  const dominantEmotion = resolveDominantEmotion(params.character);
  const evidence = [
    unansweredAddress ? '上次发言后仍有一条直接提到或指向该角色的消息尚未回应' : addressed ? '最近消息直接提到或指向该角色' : '',
    ignoredStreak ? `最近 ${ignoredStreak} 轮未被明显接住` : '',
    impulse.impulse === 'repair' ? '前一次模型判定的尖锐表达留下关系修复压力' : '',
    activeAffect ? `定向情绪余波：${activeAffect.role} ${activeAffect.kind}，强度 ${activeAffect.pressure.toFixed(2)}` : '',
    topicAttention ? '当前话题命中角色关注领域' : '',
    state.repression >= 56 ? '压抑值偏高' : '',
    addressed && (relationship?.deference || 0) >= 30 ? '当前对象的评价权会放大即时压力' : '',
    addressed && ((relationship?.threat || 0) >= 24 || (relationship?.trust || 0) <= -18) ? '当前对象触发防守或不信任' : '',
    directHumanPressure ? '用户的直接点名带来即时回应压力' : '',
    buildExpressionFeedbackBias(params.character).hasAny ? '存在用户表达反馈记忆' : '',
  ].filter(Boolean);
  return {
    actorId: params.character.id,
    impulse: impulse.impulse,
    tone: expressionPlan.tone,
    reason: impulse.reason,
    pressure: clamp01(impulse.pressure + Math.max(0, state.attention - 50) / 260 + Math.max(0, state.loneliness - 55) / 320),
    evidence,
    state: {
      ...state,
      lastImpulse: impulse.impulse,
      lastImpulseReason: impulse.reason,
    },
    expressionPlan,
    dominantEmotion,
    activeAffect,
  };
}

export function getInnerLifeSpeakerBias(projection: InnerLifeProjection) {
  const impulseBias: Record<InnerImpulse, number> = {
    answer: 0.34,
    show_off: 0.14,
    take_control: 0.2,
    defend_face: 0.22,
    seek_attention: 0.18,
    comfort: 0.14,
    repair: 0.17,
    mock: 0.16,
    avoid: -0.12,
    change_topic: 0.06,
    stay_silent: -0.18,
    send_emoji: 0.04,
    withdraw: -0.08,
  };
  // These axes are pressures, not bipolar traits. A calm zero must not cancel
  // an explicit impulse such as seek_attention or repair.
  const stateBias = Math.max(0, projection.state.attention - 50) * 0.003
    + Math.max(0, projection.state.loneliness - 50) * 0.002
    + Math.max(0, projection.state.repression - 50) * 0.0015;
  return {
    bias: clamp((impulseBias[projection.impulse] || 0) * projection.pressure + stateBias, -0.22, 0.38),
    reason: `inner:${projection.impulse}`,
  };
}

export function buildInnerLifePromptBlock(projection: InnerLifeProjection, options?: { stateOnly?: boolean }) {
  const residue = [
    projection.state.loneliness >= 62 ? 'unanswered loneliness' : '',
    projection.state.repression >= 62 ? 'suppressed words' : '',
    projection.state.shame >= 62 ? 'face-saving shame' : '',
    projection.impulse === 'repair' ? 'awkward repair impulse' : '',
    projection.state.trustInRoom <= 34 ? 'low room safety' : '',
  ].filter(Boolean).join(', ');
  const emotionLead = projection.dominantEmotion
    ? `${projection.dominantEmotion.kind} ${Math.round(projection.dominantEmotion.value)} (lead ${Math.round(projection.dominantEmotion.lead)})`
    : 'none clearly active';
  if (options?.stateOnly) {
    // Scheduler estimates are not emotional observations. In particular,
    // being addressed by a close friend does not establish vulnerability.
    return `\n## Inner Life\n- Recorded emotional lead: ${emotionLead}; carried state, not a verdict on the live exchange.\n- Recorded residue: ${residue || 'none strong enough to foreground'}.\n- Energy: ${round(projection.state.energy)}; room safety: ${round(projection.state.trustInRoom)}.\n- Infer this person's present feeling and way of expressing it from the exchange, personality and relationship; scheduler urgency is not emotional intensity.`;
  }
  return `\n## Inner Life\n- Current impulse: ${projection.impulse}; tone: ${projection.tone}; pressure: ${projection.pressure.toFixed(2)}.\n- Fast emotional lead: ${emotionLead}. A fast emotion may jump after one line and ease after expression; show it through timing, wording, warmth, defensiveness, teasing, over-explaining, or a sudden stop rather than naming the score.\n- Inner reason: ${projection.reason}\n- Inner residue: ${residue || 'none strong enough to foreground'}.\n- Let this shape omissions, timing, defensiveness, vulnerability, and messiness. Choose whether to send one message or several from the meaning and room style of the whole turn, not from this emotional state alone. Do not explain these fields in the reply.\n- For repair, shame, face-saving, or attention-seeking pressure, keep the character’s social mask and habits alive. Do not turn the pressure into a clean apology, clean confession, generic vulnerability, or generic defiance.\n- For time-limited or mortality-colored pressure, prefer concrete risk judgment, practical care, changed priority, or passing on a usable distinction. Avoid farewell tone, death monologue, and polished aphorisms.\n- Only let wistfulness or fragile hope leak into the message when the current residue or conversation actually earns it; never turn every turn into poetry or farewell.`;
}

export function buildInnerLifeMetadata(projection: InnerLifeProjection, actualMessageCount?: number): NonNullable<NonNullable<Message['metadata']>['runtimeDecision']>['innerLife'] {
  return {
    impulse: projection.impulse,
    tone: projection.tone,
    reason: projection.reason,
    pressure: Number(projection.pressure.toFixed(3)),
    evidence: projection.evidence.slice(0, 4),
    state: {
      energy: round(projection.state.energy),
      attention: round(projection.state.attention),
      loneliness: round(projection.state.loneliness),
      repression: round(projection.state.repression),
      shame: round(projection.state.shame),
      envy: round(projection.state.envy),
      trustInRoom: round(projection.state.trustInRoom),
      ignoredStreak: projection.state.ignoredStreak,
    },
    expressionPlan: {
      length: projection.expressionPlan.length,
      suggestedMessageCount: projection.expressionPlan.messageCount,
      messageCount: actualMessageCount || projection.expressionPlan.messageCount,
      typoLevel: projection.expressionPlan.typoLevel,
      delayMs: projection.expressionPlan.delayMs,
      allowWithdraw: projection.expressionPlan.allowWithdraw,
    },
  };
}
