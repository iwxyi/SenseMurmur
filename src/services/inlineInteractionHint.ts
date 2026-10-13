import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { MediaGenerationDecision, Message, MessageActivityUpdate, MessagePresenceUpdate, StudyTurnUpdate } from '../types/message';
import { canUpdateSpeakerActivity, normalizeActivityUpdate, normalizePresenceUpdate } from './characterPresence';
import type { AddressedTargetHintEnvelope, ConflictFocusPayload, InteractionHintCollection, InteractionHintEnvelope, RecentSocialEventSummary, ReplyDebtTargetHintEnvelope, SocialEventHintEnvelope } from '../types/runtimeEvent';
import { normalizeSocialEventHints } from '../types/runtimeEvent';
import type { TurnPlan } from './turnPlanner';
import type { RichDeliveryPolicy } from './styleProfileRegistry';
import { hasVisibleStoryEvents, normalizeStoryEvents, resolveStoryBeatPlan } from './narrativeRuntime';
import { resolveStoryReaderRole } from './storyChoices';
import { resolveSessionFamilyKey } from './sessionEngineKeys';
import { getPromptSpeakerLabel, getPromptTurnTypeLabel, isHumanDirectedMessage } from './chatMessageSemantics';
import { buildConversationContinuityContext, normalizeConversationUpdate, usesConversationContinuity } from './conversationContinuity';
import type { ConversationUpdate } from '../types/conversationContinuity';
import { sanitizeUserFacingText } from './displayTextSanitizer';
import { projectWorldCalendar } from './worldRuntimeProjection';

export interface InlineStoryChoice {
  label: string;
  prompt?: string | null;
  intent?: string | null;
  risk?: string | null;
  reward?: string | null;
}

export type InlineStoryEventKind = 'narration' | 'speech' | 'choice_point' | 'chapter_update';

export interface InlineStoryEvent {
  type: InlineStoryEventKind;
  actorId?: string | null;
  actorName?: string | null;
  text?: string | null;
  choices?: InlineStoryChoice[] | null;
  title?: string | null;
  summary?: string | null;
  status?: 'active' | 'completed' | null;
  startNewChapter?: boolean | null;
  keyChoices?: string[] | null;
}

export interface InlineStoryBlock {
  actorId: string;
  actorName?: string | null;
  kind: 'prose' | 'dialogue';
  text: string;
}

export interface InlineStoryAssets {
  currentScene?: {
    location?: string | null;
    time?: string | null;
    presentActorIds?: string[] | null;
    visibleThreat?: string | null;
    summary?: string | null;
  } | null;
  openQuestions?: string[] | null;
  clues?: string[] | null;
  stakes?: string[] | null;
  relationshipShifts?: string[] | null;
  chapterMemory?: string | null;
  storyGoal?: string | null;
  storySituation?: string | null;
}

export interface InlineDeliberationArtifacts {
  claims?: Array<{
    text: string;
    stance?: 'support' | 'oppose' | 'neutral' | 'review' | 'inquiry';
    reason?: string;
    confidence?: number;
  }>;
  evidence?: Array<{
    text: string;
    reason?: string;
    confidence?: number;
  }>;
  issues?: Array<{
    text: string;
    targetActorId?: string | null;
    reason?: string;
    confidence?: number;
  }>;
  verdicts?: Array<{
    text: string;
    tendency?: 'support' | 'oppose' | 'mixed' | 'undecided';
    reason?: string;
    confidence?: number;
  }>;
  summary?: {
    text: string;
    reason?: string;
    confidence?: number;
  } | null;
  overallReason?: string | null;
}

export interface InlineInteractionEnvelope {
  conversationUpdate?: ConversationUpdate | null;
  content: string;
  messages?: Array<{
    content: string;
    mediaDecision?: MediaGenerationDecision | null;
  }> | null;
  narrativeText?: string | null;
  storyEvents?: InlineStoryEvent[] | null;
  storyAssets?: InlineStoryAssets | null;
  narrativeBlocks?: InlineStoryBlock[] | null;
  extraMessages?: string[] | null;
  intentionalRepeat?: boolean | null;
  interactionHints?: InteractionHintCollection | null;
  incomingImpact?: InteractionHintEnvelope | null;
  addressedTargets?: AddressedTargetHintEnvelope | null;
  replyDebtTargets?: ReplyDebtTargetHintEnvelope | null;
  socialEventHints?: SocialEventHintEnvelope[] | null;
  conflictFocus?: ConflictFocusPayload | null;
  mediaDecision?: MediaGenerationDecision | null;
  storyChoices?: InlineStoryChoice[] | null;
  deliberationArtifacts?: InlineDeliberationArtifacts | null;
  presenceUpdate?: MessagePresenceUpdate | null;
  activityUpdate?: MessageActivityUpdate | null;
  studyUpdate?: StudyTurnUpdate | null;
  toolRequest?: {
    type: 'web_search';
    query: string;
    reason?: string | null;
  } | null;
}

function cleanJsonLikeText(value: string) {
  return value
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function unescapeJsonStringContent(value: string) {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .trim();
}

function extractJsonStringField(raw: string, fieldName: string) {
  const cleaned = cleanJsonLikeText(raw);
  const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const fieldMatch = fieldPattern.exec(cleaned);
  if (!fieldMatch) return null;
  let index = fieldMatch.index + fieldMatch[0].length;
  let escaped = false;
  let value = '';
  while (index < cleaned.length) {
    const char = cleaned[index];
    if (escaped) {
      value += `\\${char}`;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    if (char === '"') break;
    value += char;
    index += 1;
  }
  return value ? unescapeJsonStringContent(value) : null;
}

function salvageContentFromMalformedEnvelope(raw: string): InlineInteractionEnvelope | null {
  const content = extractJsonStringField(raw, 'content');
  return content ? { content, interactionHints: null, socialEventHints: null, conflictFocus: null } : null;
}

function isContractPlaceholderText(value: unknown) {
  return typeof value === 'string'
    && /(write a fresh one-sentence summary|explain the actual contradiction|placeholder|字段占位符|member-id|speaker-id|根据证据新写|当前请求自然作答)/i.test(value);
}

function sanitizeConflictFocus(conflictFocus: ConflictFocusPayload | null | undefined) {
  if (!conflictFocus) return conflictFocus ?? null;
  if (isContractPlaceholderText(conflictFocus.summary) || isContractPlaceholderText(conflictFocus.why)) return null;
  return conflictFocus;
}

function normalizeConfidence(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function cleanArtifactText(value: unknown, max = 180) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || isContractPlaceholderText(trimmed)) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function normalizeArtifactList<T extends Record<string, unknown>>(
  value: unknown,
  map: (item: Record<string, unknown>) => T | null,
  limit = 3,
) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => (item && typeof item === 'object') ? map(item as Record<string, unknown>) : null)
    .filter(Boolean) as T[];
  return normalized.length ? normalized.slice(0, limit) : undefined;
}

function sanitizeDeliberationArtifacts(value: InlineDeliberationArtifacts | null | undefined): InlineDeliberationArtifacts | null {
  if (!value || typeof value !== 'object') return null;
  const claims = normalizeArtifactList(value.claims, (item) => {
    const text = cleanArtifactText(item.text);
    if (!text) return null;
    const stance = ['support', 'oppose', 'neutral', 'review', 'inquiry'].includes(String(item.stance)) ? item.stance as NonNullable<NonNullable<InlineDeliberationArtifacts['claims']>[number]['stance']> : 'neutral';
    return { text, stance, reason: cleanArtifactText(item.reason, 100), confidence: normalizeConfidence(item.confidence) };
  });
  const evidence = normalizeArtifactList(value.evidence, (item) => {
    const text = cleanArtifactText(item.text);
    return text ? { text, reason: cleanArtifactText(item.reason, 100), confidence: normalizeConfidence(item.confidence) } : null;
  });
  const issues = normalizeArtifactList(value.issues, (item) => {
    const text = cleanArtifactText(item.text);
    return text ? {
      text,
      targetActorId: typeof item.targetActorId === 'string' ? item.targetActorId : null,
      reason: cleanArtifactText(item.reason, 100),
      confidence: normalizeConfidence(item.confidence),
    } : null;
  });
  const verdicts = normalizeArtifactList(value.verdicts, (item) => {
    const text = cleanArtifactText(item.text);
    if (!text) return null;
    const tendency = ['support', 'oppose', 'mixed', 'undecided'].includes(String(item.tendency)) ? item.tendency as NonNullable<NonNullable<InlineDeliberationArtifacts['verdicts']>[number]['tendency']> : 'mixed';
    return { text, tendency, reason: cleanArtifactText(item.reason, 100), confidence: normalizeConfidence(item.confidence) };
  });
  const summaryText = cleanArtifactText(value.summary?.text, 220);
  const summary = summaryText ? {
    text: summaryText,
    reason: cleanArtifactText(value.summary?.reason, 100),
    confidence: normalizeConfidence(value.summary?.confidence),
  } : null;
  const overallReason = cleanArtifactText(value.overallReason, 140) || null;
  if (!claims && !evidence && !issues && !verdicts && !summary && !overallReason) return null;
  return { claims, evidence, issues, verdicts, summary, overallReason };
}

function sanitizePresenceUpdate(value: MessagePresenceUpdate | null | undefined): MessagePresenceUpdate | null {
  return normalizePresenceUpdate(value);
}

function sanitizeStudyTurnUpdate(value: StudyTurnUpdate | null | undefined): StudyTurnUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const allowedStatuses = new Set(['unknown', 'exposed', 'learning', 'practicing', 'usable', 'verified', 'stale']);
  const observations = Array.isArray(value.knowledgeObservations)
    ? value.knowledgeObservations.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const title = cleanArtifactText(item.title, 80);
        const knowledgeItemId = cleanArtifactText(item.knowledgeItemId, 100) || null;
        if (!title || !allowedStatuses.has(item.status)) return [];
        const evidenceSummary = cleanArtifactText(item.evidenceSummary, 240);
        const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : undefined;
        return [{ knowledgeItemId, title, status: item.status, evidenceSummary: evidenceSummary || null, confidence }];
      }).slice(0, 12)
    : [];
  const phase = value.phase === 'mapping' || value.phase === 'learning' || value.phase === 'review' ? value.phase : null;
  return phase || observations.length ? { phase, knowledgeObservations: observations } : null;
}

function sanitizeEnvelope(envelope: InlineInteractionEnvelope): InlineInteractionEnvelope {
  const cleanMessages = Array.isArray(envelope.messages)
    ? envelope.messages
      .filter((part): part is NonNullable<InlineInteractionEnvelope['messages']>[number] => Boolean(part && typeof part === 'object' && typeof part.content === 'string' && part.content.trim()))
      .map((part) => ({
        content: part.content.trim(),
        mediaDecision: part.mediaDecision && typeof part.mediaDecision === 'object' ? part.mediaDecision : null,
      }))
    : null;
  // The room policy is a soft norm for the model. This is only a defensive
  // transport cap for malformed/runaway output; overflow text remains visible.
  const messages = cleanMessages && cleanMessages.length > 8
    && !cleanMessages.slice(8).some((part) => part.mediaDecision)
    ? [
        ...cleanMessages.slice(0, 7),
        {
          content: cleanMessages.slice(7).map((part) => part.content).join('\n'),
          mediaDecision: cleanMessages[7]?.mediaDecision || null,
        },
      ]
    : cleanMessages;
  return {
    ...envelope,
    content: messages?.[0]?.content || (typeof envelope.content === 'string' ? envelope.content : ''),
    messages,
    socialEventHints: normalizeSocialEventHints(envelope.socialEventHints),
    conflictFocus: sanitizeConflictFocus(envelope.conflictFocus),
    conversationUpdate: normalizeConversationUpdate(envelope.conversationUpdate),
    storyEvents: normalizeStoryEvents(envelope.storyEvents),
    deliberationArtifacts: sanitizeDeliberationArtifacts(envelope.deliberationArtifacts),
    presenceUpdate: sanitizePresenceUpdate(envelope.presenceUpdate),
    activityUpdate: normalizeActivityUpdate(envelope.activityUpdate),
    studyUpdate: sanitizeStudyTurnUpdate(envelope.studyUpdate),
  };
}

function hasVisibleEnvelopeContent(envelope: InlineInteractionEnvelope) {
  if (typeof envelope.content === 'string' && envelope.content.trim()) return true;
  if (Array.isArray(envelope.messages) && envelope.messages.some((item) => item && typeof item.content === 'string' && item.content.trim())) return true;
  if (typeof envelope.narrativeText === 'string' && envelope.narrativeText.trim()) return true;
  if (Array.isArray(envelope.extraMessages) && envelope.extraMessages.some((item) => typeof item === 'string' && item.trim())) return true;
  if (Array.isArray(envelope.narrativeBlocks) && envelope.narrativeBlocks.some((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim())) return true;
  return hasVisibleStoryEvents(envelope.storyEvents);
}

export function hasInvalidStateEvidence(envelope: InlineInteractionEnvelope) {
  const parts = envelope.messages?.length
    ? envelope.messages.map((part) => part.content)
    : [envelope.content, ...(envelope.extraMessages || [])];
  const update = envelope.conversationUpdate;
  const evidence = [
    ...(update?.items || []).map((item) => item.evidenceText),
    update?.room?.evidenceText, update?.settled?.evidenceText,
    envelope.activityUpdate?.evidenceText, envelope.presenceUpdate?.evidenceText,
    envelope.conflictFocus?.evidenceText,
  ].filter((quote): quote is string => typeof quote === 'string' && quote.length > 0);
  return evidence.some((quote) => !parts.some((part) => typeof part === 'string' && part.includes(quote)));
}

/**
 * Structured continuity updates must not be silently reduced at commit time.
 * Unknown member ids are a protocol error so the same speaker can retry with
 * the member registry that was supplied in the prompt.
 */
export function hasInvalidConversationMemberReferences(
  envelope: InlineInteractionEnvelope,
  memberIds: Iterable<string>,
) {
  const update = envelope.conversationUpdate;
  if (!update) return false;
  const members = new Set(memberIds);
  members.add('user');
  const valid = (id: string) => members.has(id);
  if (update.items.some((item) => item.participantIds.some((id) => !valid(id)))) return true;
  const room = update.room;
  if (!room) return false;
  const pairs = [
    ...(room.addAlliances || []),
    ...(room.removeAlliances || []),
    ...(room.addConflictPairs || []),
    ...(room.removeConflictPairs || []),
  ];
  if (pairs.some((pair) => pair.some((id) => !valid(id)))) return true;
  if (room.pileOnTarget && !valid(room.pileOnTarget)) return true;
  return Boolean(room.silencedActors?.some((id) => !valid(id)));
}

function buildMemberReference(params: { chat: GroupChat; characters: AICharacter[]; speakerId?: string }) {
  const memberIds = new Set(params.chat.memberIds);
  const characterLines = params.characters
    .filter((character) => memberIds.has(character.id))
    .map((character) => `- id=${character.id}; name=${character.name}; aliases=${[character.name, character.group || ''].filter(Boolean).join(', ')}${character.id === params.speakerId ? '; current speaker: valid participant, never an outgoing interaction or reply target' : ''}`);
  const userLine = params.chat.memberIds.includes('user') ? ['- id=user; name=用户/我; aliases=用户,我'] : [];
  return [...characterLines, ...userLine].join('\n') || '- No valid targets.';
}

function buildRecentSocialEventContext(chat: GroupChat, limit = 4): RecentSocialEventSummary[] {
  return (chat.runtimeEventsV2 || [])
    .filter((event) => event.kind === 'event_candidate' || event.kind === 'artifact')
    .slice(-24)
    .reverse()
    .flatMap<RecentSocialEventSummary>((event) => {
      const payload = event.payload as Record<string, unknown>;
      const eventKind = typeof payload.eventKind === 'string' ? payload.eventKind : null;
      if (!eventKind) return [];
      return [{
        eventKind: eventKind as RecentSocialEventSummary['eventKind'],
        title: typeof payload.title === 'string' ? payload.title : undefined,
        activityType: typeof payload.activityType === 'string' ? payload.activityType : undefined,
        participantIds: Array.isArray(payload.participantIds) ? payload.participantIds.filter((id): id is string => typeof id === 'string') : undefined,
        targetIds: Array.isArray(event.targetIds) ? event.targetIds : undefined,
        createdAt: event.createdAt,
        summary: event.summary,
      }];
    })
    .slice(0, limit);
}

function buildRecentTranscriptScope(messages: Message[]) {
  const recent = messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .slice(-8);
  if (!recent.length) return '- No recent transcript turns are available.';
  const humanCount = recent.filter(isHumanDirectedMessage).length;
  const aiCount = recent.filter((message) => message.type === 'ai').length;
  const latest = recent.at(-1);
  const speakers = Array.from(new Set(recent.map((message) => getPromptSpeakerLabel(message)))).slice(-6);
  return [
    '- The complete recent transcript is supplied as separate chat messages. Only the current speaker\'s own prior visible turns are assistant messages. This contract intentionally does not repeat raw dialogue.',
    `- Recent window for judging interaction fields: ${recent.length} turns (${humanCount} human / ${aiCount} AI).`,
    `- Latest turn: ${latest ? `${getPromptTurnTypeLabel(latest)} from ${getPromptSpeakerLabel(latest)}` : 'none'}.`,
    `- Speakers in window: ${speakers.join(', ') || 'none'}.`,
  ].join('\n');
}

function buildImageReferenceRegistry(messages: Message[]) {
  const latestImageMessageId = messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .filter((message) => message.metadata?.attachments?.some((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url)))
    .sort((left, right) => right.timestamp - left.timestamp)[0]?.id;
  return messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .sort((left, right) => right.timestamp - left.timestamp)
    .flatMap((message) => (message.metadata?.attachments || [])
      .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
      .slice(0, 6)
      .map((attachment) => ({
        refId: `${message.id}:${attachment.id}`,
        messageId: message.id,
        messageRole: message.type === 'ai' ? 'assistant' : isHumanDirectedMessage(message) ? 'user' : 'other',
        senderName: message.senderName,
        altText: attachment.altText,
        caption: attachment.caption || '',
        promptText: message.id === latestImageMessageId ? attachment.promptText?.trim().slice(0, 800) || '' : '',
        semanticSummary: attachment.semanticSummary?.trim().slice(0, 800) || '',
        messageContentPreview: message.content.trim().slice(0, 180),
        messageTimestamp: message.timestamp,
      })))
    .slice(0, 36);
}

export function buildInlineInteractionContract(params: {
  chat: GroupChat;
  speaker: AICharacter;
  characters: AICharacter[];
  recentMessages: Message[];
  turnPlan?: TurnPlan | null;
  mediaCapabilities?: {
    image: boolean;
    audio: boolean;
    sticker?: boolean;
  };
  richDelivery?: RichDeliveryPolicy;
  mediaRequested?: boolean;
  webSearchEnabled?: boolean;
  webSearchResultInjected?: boolean;
}) {
  const isStoryReader = params.chat.sessionKind?.scenarioId === 'story-reader';
  const storyBeatPlan = isStoryReader ? resolveStoryBeatPlan(params.chat) : null;
  const storyReaderRole = isStoryReader ? resolveStoryReaderRole(params.chat) : null;
  const isAnalysisRoom = resolveSessionFamilyKey(params.chat) === 'analysis';
  const isStudyRoom = resolveSessionFamilyKey(params.chat) === 'study';
  const isOrdinaryConversation = resolveSessionFamilyKey(params.chat) === 'conversation'
    && !isStoryReader
    && !isAnalysisRoom
    && !isStudyRoom;
  const mediaCapabilities = params.mediaCapabilities || { image: false, audio: false };
  const richDelivery = params.richDelivery;
  const shouldIncludeMediaDecision = Boolean(!isStoryReader && (mediaCapabilities.image || mediaCapabilities.audio || mediaCapabilities.sticker));
  const transcriptScope = buildRecentTranscriptScope(params.recentMessages);
  const imageReferenceRegistry = shouldIncludeMediaDecision && mediaCapabilities.image
    ? buildImageReferenceRegistry(params.recentMessages)
    : [];
  const recentSocialEvents = buildRecentSocialEventContext(params.chat)
    .map((event) => `- ${event.eventKind}${event.title ? ` / ${event.title}` : ''}${event.activityType ? ` / ${event.activityType}` : ''}: ${event.summary}`)
    .join('\n');

  const mediaExampleFields = [
    mediaCapabilities.image ? `"images": [{"shouldGenerate": false, "reason": "只有当这条消息确实需要视觉补充时才为 true", "prompt": null, "altText": null, "aspectRatio": null, "imageSize": null, "targetImageIds": [], "referenceImageIds": [], "styleImageIds": []}]` : '',
    mediaCapabilities.audio ? `"audio": {"shouldGenerate": false, "reason": "只有当这条消息特别适合语音播放时才为 true", "text": null, "voiceProfileId": null}` : '',
    mediaCapabilities.sticker ? `"sticker": {"shouldSend": false, "keyword": null, "altText": null}` : '',
  ].filter(Boolean);
  const mediaExample = shouldIncludeMediaDecision
    ? `,\n  "mediaDecision": {${mediaExampleFields.map((field) => `\n    ${field}`).join(',')}\n  }`
    : '';
  const deliberationExample = isAnalysisRoom
    ? `,\n  "deliberationArtifacts": {"claims":[{"text":"从本条可见回复中抽取的论点","stance":"review","reason":"这条可见回复为什么支持该论点","confidence":0.8}]}`
    : '';
  const studyUpdateExample = isStudyRoom
    ? ',"studyUpdate":{"phase":"learning","knowledgeObservations":[{"knowledgeItemId":null,"title":"本轮实际涉及的知识点","status":"exposed","evidenceSummary":"本轮可见对话中支持这一判断的事实","confidence":0.8}]}'
    : '';
  const toolRequestExample = params.webSearchEnabled && !params.webSearchResultInjected && !isStoryReader
    ? ', "toolRequest": null'
    : '';
  const mediaCapabilityInstruction = shouldIncludeMediaDecision
    ? `\n\nAvailable delivery capabilities for this turn: ${[mediaCapabilities.image ? 'image generation' : '', mediaCapabilities.audio ? 'voice synthesis' : '', mediaCapabilities.sticker ? 'keyword meme sticker search' : ''].filter(Boolean).join(' + ')}. These are real runtime capabilities. When the user explicitly asks for a meme/sticker, set mediaDecision.sticker.shouldSend=true and use a short concrete search keyword; do not use it for ordinary image requests.\n`
    : '';

  const deliveryPolicyRules = richDelivery
    ? `\nDelivery policy for this room: later text sends=${richDelivery.multiBubble.proactivity}; organization=${richDelivery.multiBubble.organization || 'balanced'}; image=${richDelivery.image.proactivity}; audio=${richDelivery.audio.proactivity}; sticker=${richDelivery.sticker.proactivity}. These are willingness priors, not a quota or target. “off” means do not initiate that form, but honor explicit requests when available; other levels adjust willingness only. Keep media relevant.`
    : '';
  const mediaRules = (shouldIncludeMediaDecision
    ? `\n\nRules for mediaDecision:\n1. Media is optional. Follow this room's delivery policy before deciding; never pretend media was sent when no task is queued.\n${mediaCapabilities.image ? `2. Use images for requested or genuinely useful visual content. Infer the user's actual image goal from the latest message plus recent conversation. images is an array of 1-9 distinct image tasks; use one entry per image, never repeat the same prompt. Each image prompt must be final model-ready text and altText must be concise and specific.\n3. imageReferenceRegistry below lists recent chat images. Use IDs only when the request clearly identifies a reference; never output URLs, base64, or markdown image links.\nImage reference registry:\n${JSON.stringify(imageReferenceRegistry)}\n` : ''}${mediaCapabilities.audio ? '4. Use audio when the user asks for a voice reply or when the delivery policy permits it and speaking is a natural expression of the character\'s current emotion and relationship context. audio.text is the exact spoken content and must not add facts beyond the visible reply. When audio is selected, keep visible text concise and semantically aligned with the spoken content; do not send a long essay followed by a short unrelated audio clip.\n' : ''}5. Text, audio, and images may be combined in one turn. Each messages[] item has content and its own optional mediaDecision. A voice item must be a standalone bubble; text and images may be combined or sent separately when there are distinct communicative acts.`
    : '');
  const expressiveAudioOverride = mediaCapabilities.audio
    ? '\n\nAudio policy clarification: decide from the user\'s actual intent and the character\'s situation, not from a local keyword rule. If the latest user request explicitly asks to hear the reply, speak, sing, or send a voice message, audio is required when TTS is available. Character identity, habitual voice-message preference, affection, urgency, teasing, singing, crying, anger, or an emotionally important scene may also justify proactive audio. Consecutive audio turns are allowed when natural for the scene; do not suppress them merely because the previous turn also used audio. Keep each spoken text aligned with its visible message.\n'
    : '';

  const turnPlanMaxBubbles = Math.max(2, params.richDelivery?.multiBubble.maxBubbles || params.turnPlan?.maxBubbleCount || 1);
  const messageOrganization = richDelivery?.multiBubble.organization || 'balanced';
  const organizationRule = messageOrganization === 'conversational'
    ? 'In conversational chat, a turn is a contribution to an ongoing exchange, not a complete answer to everything. A brief reaction can be enough; when there is more to say, bubbles can follow the natural rhythm of thought, feeling, or addressing different people.'
    : messageOrganization === 'structured'
      ? 'For structured answers, keep connected reasoning or steps together with paragraphs or lists; separate sends are available when the interaction calls for them.'
      : 'Let the exchange decide whether this is a brief reaction, a developed answer, or several conversational beats.';
  const sendBoundaryRule = params.turnPlan?.allowExtraMessages === false
    ? '\nSend boundaries: this turn uses one bubble; paragraphs may organize related thoughts within it.'
    : `\nSend boundaries: ${organizationRule} Use messages[] for the sends this person would actually make; their boundaries may be semantic, expressive, or temporal. A shift from speaking to one person to speaking to another can be a separate send; connected reasoning can stay in one send. Neither one send nor several is the default target. The room's soft ceiling is ${turnPlanMaxBubbles}, not a target or hard limit. Honor explicit multi-message requests and preserve meaningful sends rather than splitting mechanically.`;
  const aiDirectInteractionRules = params.chat.type === 'ai_direct'
    ? '\n8. In AI direct chats, target the other participant when the turn clearly supports, challenges, probes, defends, mocks, or dismisses them; do not target the speaker or the user unless the user is an actual participant.'
    : '';
  const toolRule = params.webSearchEnabled && !params.webSearchResultInjected
    ? 'toolRequest: null unless current external facts are genuinely required; then return a short in-character waiting line and {"type":"web_search","query":"specific query","reason":"why live facts are needed"}.'
    : params.webSearchResultInjected
      ? 'Search results are already supplied. Use them when relevant and keep toolRequest=null.'
      : '';
  // Shorten semantic guidance, not the shared wire format.
  const compactInteractionRule = `Appraise the exchange as this person, then write the visible reply. Report only effects supported by a short exact evidenceText quote.
Interaction shape: {"targetId":"member-id","kind":"support|challenge|mock|dismiss|defend|evade|probe|pile_on|redirect|apologize|concede|take_responsibility|include|exclude|boundary","tone":"warm|annoyed|defensive|excited|sarcastic|cold","intensity":1,"confidence":0.8,"evidenceText":"exact quote","immediateImpact":{},"relationship":null}.
interactionHints is {"primary":interaction,"secondary":[]} when this reply clearly affects a member; otherwise null. incomingImpact uses the same shape for a clear latest user/director effect on this speaker, quoting that incoming turn rather than this reply.
immediateImpact accepts speakerEmotionDelta/targetEmotionDelta axes irritation, affection, insecurity, excitement, embarrassment (signed integers -40..40), and roomDelta axes heat, cohesion, topicDrift (-20..20). Positive raises, negative releases. incomingImpact uses targetEmotionDelta for this speaker. Put speaker release and room changes on primary only; secondary contains only its own target effect.
Short-term emotion is not a lasting relationship change. Set relationship=null unless the turn establishes one; then use {"delta":{"warmth":0,"competence":0,"trust":0,"threat":0,"attachment":0,"deference":0},"labels":[],"stance":""}; attachment/deference are slow, within -2..2. These are optional diagnostics, not goals for the dialogue.`;
  const storyNarrativeRules = isStoryReader
    ? `\n\nRules for story event DSL:
1. Story-reader turns must use storyEvents as the authoritative visible story body. Do not copy the JSON shape with storyEvents=null for a normal story turn.
2. storyEvents must be an ordered array for every normal story-reader turn and must include at least one visible narration or speech event. Do not set storyEvents=null; even a single spoken line must be represented as a speech event. Use as many narration and speech events as the current story beat needs; suggested event counts are guidance, not enforcement. Do not pad, truncate, or stop early just to fit a fixed count. Each event is one of:
   - {"type":"narration","actorId":"narrator","text":"brief external scene action or visible consequence"}
   - {"type":"speech","actorId":"character-id-or-null","actorName":"exact display name or null","text":"spoken line only"}
   ${storyBeatPlan?.choicePolicy === 'forbid' ? '' : `- {"type":"choice_point","choices":[{"label":"具体行动主体做具体动作","prompt":"选择后要推进的具体后果","intent":"选择的戏剧功能","risk":"可能付出的代价","reward":"可能获得的信息或关系推进"}]}`}
   - {"type":"chapter_update","title":"4-10 Chinese characters, concrete and memorable","summary":"optional short recap","status":"active or completed","startNewChapter":false}
3. narration carries action, movement, consequences, inner pressure, scene changes, clue reveals, and time jumps. Narration renders as正文段落.
4. speech is optional. Use it only for words actually spoken aloud by a character; every speech event must include either a valid actorId or an exact actorName. Never use actorId="narrator" or actorName="旁白" for a character's line; narrator is reserved for narration.
5. A whole turn may contain only narration. This is valid when the beat needs setting, consequence, or pressure more than dialogue.
6. Speech text must be chat-like. A common speech event is 1-3 sentences, but scene and character pressure decide the actual size: it can be terse, interrupted, or more developed when needed. No camera direction, omniscient analysis, private inner monologue, or describing the whole room's reaction.
7. Do not let one character inherit another character's private object, gesture, memory, clothing detail, wording, or sensory detail unless that detail was explicitly spoken aloud or publicly visible.
8. Put each narration and each character line in its own event, preserving story order. Do not merge narration and speech into one event.
9. Do not output alternate rewrites of the same moment. If you revise a narration or spoken line, keep only the final version; do not include both drafts in storyEvents.
10. ${storyBeatPlan?.choicePolicy === 'forbid' ? 'This beat forbids choice_point. Do not emit one anywhere in storyEvents.' : storyBeatPlan?.choicePolicy === 'require' ? 'This beat requires exactly one choice_point after the visible pressure has landed.' : 'choice_point appears only at a genuine decision point. Never add choices on a fixed cadence.'}
11. Put user decision pauses in a choice_point event. Do not render choices in any top-level field outside storyEvents or in a separate visible prose block.
12. Write visible scene execution, not author notes, beat analysis, future outline, or summaries like "接下来剧情将". If the user just chose a branch, first show what immediately changes on screen: a cost, clue, relationship shift, danger, or opportunity.
13. For non-choice beats, write a satisfying readable section rather than a minimal stub. Let the scene breathe with consequences, sensory detail, movement, and dialogue when useful. Stop only when the beat naturally lands on a hook or a genuine choice point.
14. chapter_update is structured metadata for the chapter sidebar. It is not visible body text. Use it when opening a new chapter, renaming the current chapter, or settling a chapter; do not invent a generic title such as "阶段回顾".
15. Do not put visible story prose or dialogue in any top-level field outside storyEvents.`
    : '';
  const storyChoiceRules = isStoryReader
    ? `\n\nRules for story choice points:
1. The authoritative runtime policy for this beat is choicePolicy=${storyBeatPlan?.choicePolicy || 'allow'} (${storyBeatPlan?.reason || 'scene-dependent'}).
2. ${storyBeatPlan?.choicePolicy === 'forbid' ? 'Do not output a choice_point in this beat.' : storyBeatPlan?.choicePolicy === 'require' ? 'Output exactly one storyEvents choice_point with 2-4 options after showing the decision pressure.' : 'Add exactly one storyEvents choice_point with 2-4 options only when user participation would improve the story.'}
3. Do not ask for choices just because a fixed number of turns passed. There is no fixed cadence.
4. It is allowed to ask again soon if the scene truly demands it, but the room must not remain in a constant choose-operate loop.
5. Each option must read like a concrete character action: name who does what to whom or what object/place. Avoid abstract plot directions such as investigate clues, deepen emotion, advance plot, face the key person, continue the branch.
6. Each choice_point option must be shaped as {"label":"具体行动主体做具体动作","prompt":"选择后要推进的具体后果","intent":"选择的戏剧功能","risk":"可能代价","reward":"可能收益"}. ${storyReaderRole === 'participant' ? 'The user is a participant: every label uses “我” as its action subject.' : 'The user directs the cast: every label begins with the exact acting character name; do not phrase it as “让某人…”.'}
7. Do not output top-level storyChoices for the primary path. storyEvents.choice_point is the source of truth. If a legacy storyChoices field is emitted for compatibility, it must exactly mirror the choice_point options and will have lower priority than storyEvents.`
    : '';
  if (isStoryReader) {
    return `\n\nOutput contract:
Return one valid JSON object only. This is the required shape for story-reader turns:
{
      "storyEvents": [
    { "type": "chapter_update", "title": "短章节名", "summary": "可选章节摘要", "status": "active" },
    { "type": "narration", "actorId": "narrator", "text": "写一段当前场景中可见的动作或后果。" },
    { "type": "speech", "actorId": "member-id", "actorName": "角色显示名", "text": "写一句角色真正说出口的话。" }
  ],
  "intentionalRepeat": false,
  "storyAssets": {"currentScene": null, "openQuestions": [], "clues": [], "stakes": [], "relationshipShifts": [], "chapterMemory": null, "storyGoal": null, "storySituation": null}${mediaExample},
  "conflictFocus": null,
  "interactionHints": null,
  "socialEventHints": null
}

JSON validity rules:
1. The response must be parseable by JSON.parse.
2. Do not output TypeScript syntax such as string | null, undefined, comments, or trailing commas.
3. Use null for absent optional fields. Never use undefined.
4. Escape ASCII double quote characters inside string values with a backslash. Prefer Chinese quotes inside Chinese text.
5. intensity must be an integer from 1 to 5 if emitted inside optional diagnostic fields. confidence must be a decimal from 0 to 1, not 0 to 100.
6. The example values above are structural placeholders, not dialogue content, conflict content, or memory.${storyNarrativeRules}${storyChoiceRules}${mediaRules}${expressiveAudioOverride}

Story-reader visible body rule:
1. storyEvents is the only visible story body.
2. Never put story prose or dialogue in markdown, plain text outside JSON, or any top-level field outside storyEvents.
3. Every normal story turn needs at least one storyEvents narration or speech event, even if it also contains a chapter_update or choice_point.
4. interactionHints, conflictFocus, and socialEventHints are optional diagnostics; keep them null unless the current story event itself provides specific evidence.
5. storyAssets is required for story-reader turns. It is the authoritative structured reading of this turn: include only assets actually established or changed on screen, and use empty arrays/null when there is no new item. Do not copy visible prose wholesale into every field.

social_outing diagnostics:
socialEventHints is the model-authored source for shared social outing creation and updates; the runtime will not invent or patch a social_outing from local keyword matching. When the visible storyEvents clearly propose, arrange, update, or commit to a shared concrete activity, socialEventHints must include one object with eventKind="social_outing" (required), participantIds/targetIds as member ids, confidence 0-1, urgency, seedIntent, visibilityPlan, expectedArtifacts, title, activityType, timeHint, locationHint, dedupeKey, and optional participantStates. Use participantStates values mentioned/invited/interested/maybe/going/declined/withdrawn. Include "user" when the user is invited or participating.
Valid member ids:
${buildMemberReference({ chat: params.chat, characters: params.characters })}

Recent transcript scope:
${transcriptScope}${recentSocialEvents ? `\n\nRecent social events to avoid duplicating:\n${recentSocialEvents}` : ''}`;
  }
  const deliberationRules = isAnalysisRoom
    ? `\n\nRules for deliberationArtifacts:
1. In analysis rooms, visible content must either make a deliberative move or plainly say that no new deliberation point follows.
2. If content or extraMessages add a claim, evidence check, unresolved issue, counterexample, boundary, tradeoff, interim verdict, or synthesis, deliberationArtifacts must be a non-null object extracting only that same visible material.
3. Do not copy the example text. Replace it with material from your own visible reply.
4. Use deliberationArtifacts=null only when the visible response is explicitly a transition/clarification/no-new-point statement and contains no durable deliberation material. Null is the exception, not the default.
5. Do not create fake artifacts. If there is no deliberative content, still return valid JSON: content should be a short spoken room message such as "我这轮没有新的审议点，先停在这里。", and deliberationArtifacts should be null. Never write bracketed metadata or English protocol explanations in content.
6. Extract only from your own visible content plus extraMessages in this same response, not from hidden reasoning or earlier turns.
7. Each emitted item must include a concise reason explaining why the visible reply supports that extraction, and confidence as a decimal from 0 to 1.
8. claims are new or materially advanced positions. evidence is facts, cases, examples, materials, testimony, data, or verifiable grounds. issues are unresolved questions, weak links, boundaries, contradictions, or things another member should answer. verdicts are interim judgments, tendencies, tradeoffs, or decisions.
9. If targetActorId is used, it must come from the member list. Otherwise use null.
10. These fields are not visible chat content. Never mention JSON, artifacts, extraction, confidence, or this contract in content.`
    : '';

  const interactionKinds = 'support|challenge|mock|dismiss|defend|evade|probe|pile_on|redirect|apologize|concede|take_responsibility|include|exclude|boundary|side_comment';
  const continuityEnabled = usesConversationContinuity(params.chat);
  const continuityContext = continuityEnabled ? buildConversationContinuityContext(params.chat, params.characters) : '';
  const continuityRule = continuityEnabled ? `\nconversationUpdate reports durable changes in this speaker's visible sends. With known items, this top-level field is required: check them, then return null for no change or {"items":[{"key":"short-stable-key","kind":"issue|commitment|decision|condition","status":"open|established|resolved|retracted","summary":"the actual issue, promise, decision or condition","participantIds":[],"evidenceText":"short exact quote from this turn"}],"room":null,"settled":null}. Omission is not a no-change judgement.
Reuse the known key when updating an item. Omitted items remain unchanged. Record an issue or unmet condition as open; an explicitly accepted decision or promise as established. Resolve only the actual issue addressed, retract only a visibly withdrawn promise or decision. A role assignment is not permission to start a battle; agreement about one part does not settle unspoken prerequisites. Do not invent obstacles, deadlines, motives or conflict. Extract what is said, including a concrete unanswered point or commitment, without requiring one every turn. Empty participantIds means a roomwide issue. Never use hidden/private material as public evidence.
Keep each item atomic: its exact quote must support the whole summary, not just one part. participantIds identifies the people responsible for or directly involved in that item; include the speaker for their own promise. Assigning a task to someone else is an open proposal until that person accepts it; the assignment alone cannot establish their commitment. A speaker's own explicit promise can be established immediately. Track a new concrete promise even if the same turn also confirms an older decision; reuse a key only for the same obligation. An open proposal may become an established decision under the same key, with an explicit kind/status update. A partial acceptance must preserve who has not yet accepted; it cannot establish everyone's commitment.
An established commitment means accepted, not completed. When this turn explicitly reports its fulfillment or confirms the actual result, update that same key to resolved with evidence supporting completion. Work in progress stays established; accepting a task or announcing a future action is not fulfillment. A withdrawn commitment is retracted. Keep any separate unanswered issue open; completing one obligation does not complete other obligations.
room optionally reports explicit structural changes: {"addAlliances":[],"removeAlliances":[],"addConflictPairs":[],"removeConflictPairs":[],"pileOnTarget":null,"silencedActors":[],"evidenceText":"short exact quote from this turn"}. Pairs use two valid member ids. Omit unchanged fields; null pileOnTarget explicitly clears it. Agreement alone does not form an alliance; disagreement alone does not form a lasting opposition.
settled is {"evidenceText":"short exact quote from this turn"} only when the visible exchange can pause here, with no immediate answer still requested. Unfinished matters may remain for later; do not repeatedly reconfirm a completed decision or invent a new issue to keep airtime. This pauses automatic chat, not the unresolved facts. These are internal protocol fields, never visible dialogue.
Before choosing null, compare known open items with the newer visible exchange and this turn. If this speaker accepts a pending proposal or explicitly confirms that the involved people have accepted it, update that same key with the exact supporting quote. Keep partial acceptance open with an accurate summary of what remains. A recorded summary may lag behind the transcript; do not ask again merely because it still says open. Never fabricate a spoken confirmation just to update bookkeeping.
Known public continuity (keys are only for writeback):\n${continuityContext || '(none recorded)'}` : '';
  const interactionRule = isOrdinaryConversation
    ? `${compactInteractionRule}${aiDirectInteractionRules}`
    : `Before writing, appraise the latest visible human turn's immediate effect on the current speaker. If that latest turn is from the user or director and it clearly warms, needles, embarrasses, pressures, reassures, alarms, or excites this speaker, emit incomingImpact as {"kind":"${interactionKinds}","tone":"warm|annoyed|defensive|excited|sarcastic|cold","intensity":3,"confidence":0.86,"evidenceText":"exact short quote from the human turn","reason":"why that quote has this effect","immediateImpact":{"targetEmotionDelta":{"irritation":8,"insecurity":4}}}; otherwise incomingImpact is null. The incoming targetEmotionDelta is the immediate effect on the current speaker, not a relationship change. Let that appraisal genuinely shape the visible reply before reporting it. interactionHints is the outgoing fast-affect channel: emit it whenever the speaker's own words clearly land on a particular member by warming them, needling them, embarrassing them, putting them on the spot, defending them, dismissing them, apologizing or conceding to them, taking responsibility toward them, including or excluding them, setting a boundary, making them wary, or making them excited. Do not omit a hint merely because the exchange is ordinary or because the slow relationship does not change. Use null only when no member-specific emotional effect is visible. When used, targetId must be a member id: {"primary":{"targetId":"member-id","kind":"${interactionKinds}","tone":"warm|annoyed|defensive|excited|sarcastic|cold","intensity":3,"confidence":0.86,"evidenceText":"exact short quote from this reply","reason":"why the quote has this effect","immediateImpact":{"speakerEmotionDelta":{"irritation":-8},"targetEmotionDelta":{"insecurity":12},"roomDelta":{"heat":5,"cohesion":-2,"topicDrift":0}},"relationship":null},"secondary":[]}. immediateImpact is your semantic judgement of this visible line, not a local keyword score: use signed integer deltas, emotion axes within -40..40 and room axes within -20..20. Positive raises an axis and negative releases it. Put the whole-turn speaker release and room effect on primary only; secondary hints contain only their own targetEmotionDelta so effects are not duplicated. Omit zero axes. evidenceText is required, must be a short exact substring of the visible source turn, and must support the chosen kind, tone, and impact by itself; never use the whole reply as evidence. Classify what the quoted words actually do, not their hoped-for outcome: admitting fault is apologize or take_responsibility, yielding a point is concede, and naming who was left out is exclude rather than support. intensity is the immediate spike (1-5), not a permanent score: one sharp line may be 4-5, a small sting or warmth 1-2. The interaction event may exist without any lasting relationship change. Include relationship only when this turn itself gives evidence for a slow relationship update: {"delta":{"warmth":0,"competence":0,"trust":0,"threat":0,"attachment":0,"deference":0},"labels":["meaning"],"stance":"stance"}. attachment and deference are especially slow axes: omit them or keep them within -2..2 unless this turn contains a real turning point. Omit uncertain hints.${aiDirectInteractionRules}`;
  const addressedTargetRule = `addressedTargets records the current visible addressee, even when this is simply a reply and does not require another turn. Emit {"targetIds":["member-id"],"primaryTargetId":"member-id","confidence":0.9,"reason":"why this turn is directed to this member"} when the speaker is replying to, speaking to, or emotionally directing a line at a member. A member merely mentioned or affected is not addressed. replyDebtTargets is a separate field: emit {"targetIds":["member-id"],"primaryTargetId":"member-id","confidence":0.9,"reason":"why this member is expected to answer next"} only when the visible reply directly asks, calls on, challenges, or hands the floor to that member. Use null for replyDebtTargets when no next answer is expected. Both fields must use valid member ids below.`;
  const ownActivityContext = projectWorldCalendar([params.chat], params.characters, { inferTemporalStatus: false, publicOnly: true }).items
    .filter((item) => !item.derivedFromItemId && item.participantIds.includes(params.speaker.id))
    .slice(0, 8)
    .map((item) => ({
      calendarItemId: item.id,
      writebackChannel: canUpdateSpeakerActivity(params.chat, params.speaker, item.id) ? 'activityUpdate' : 'socialEventHints',
      title: item.title,
      kind: item.kind,
      status: item.status,
      startAt: item.startAt ?? null,
      endAt: item.endAt ?? null,
      timeHint: item.timeHint ?? null,
      locationHint: item.locationHint ?? null,
      participantStates: item.participantStates,
    }));
  const socialRule = `socialEventHints: null unless the visible turn itself proposes, commits to, updates, or cancels a concrete social event. For a shared outing, use [{"eventKind":"social_outing","title":"actual activity","activityType":"actual type","participantIds":["member-id"],"targetIds":["member-id"],"timeHint":"time as stated","locationHint":"place as stated","participantStates":{"member-id":"invited"},"dedupeKey":"stable-activity-key","confidence":0.9}]. eventKind is REQUIRED. Reuse the existing dedupeKey when updating. Participant states: mentioned, invited, interested, maybe, going, declined, withdrawn. Include "user" when invited or participating. This channel proposes shared social events; use activityUpdate for the speaker's own actual activity or departure, and never emit both channels for the same activity.`;
  const activityRule = `activityUpdate records an actual calendar arrangement, including solo activities: {"title":"actual activity","kind":"activity|travel|rest|preparation|blocked_time|reminder","status":"planned|in_progress|completed|cancelled","participantIds":["member-id"],"startsNow":true,"startAt":null,"durationMinutes":60,"timeHint":"time as spoken","locationHint":"place as spoken","availability":"away|online","calendarItemId":null,"evidenceText":"short exact quote from one visible send"}. Use null when nothing changes. Describe only what this turn actually establishes. Other participants are invited, never forced offline. availability changes ONLY this speaker and is optional: doing an activity may still allow chatting. Use away when actually leaving now; a goodbye may still address someone, but with no expected immediate reply it has replyDebtTargets=null. Do not keep saying goodbye to someone who has left. startsNow is true only for actually starting now; future plans are planned and never set current availability. startAt is Unix milliseconds only when an exact real-world time is known, otherwise omit it and keep timeHint; never convert a fictional historical date to today's date. Duration is minutes, 3..43200, default away duration 30 when unknown. A three-day report interval is not a three-day absence: set 4320 only if the absence itself lasts three days. For returning or cancelling use the known calendarItemId, completed/cancelled; presenceUpdate online also ends the linked absence. Current speaker activity key: ${params.speaker.presence?.calendarItemId || '(none)'}. Do not expose these internal fields in dialogue.`;
  return `${mediaCapabilityInstruction}\n## Output Contract
Return exactly one JSON object. It must be parseable. messages is the ordered list of this speaker's visible sends, including a single send; use null for absent fields and never expose protocol text.
{"messages":[{"content":"visible send"${mediaExample}}],"intentionalRepeat":false${deliberationExample}${studyUpdateExample},"presenceUpdate":null,"activityUpdate":null,"conflictFocus":null,"incomingImpact":null,"interactionHints":null,"addressedTargets":null,"replyDebtTargets":null,"socialEventHints":null${continuityEnabled ? ',"conversationUpdate":null' : ''}${toolRequestExample}}

Each messages[] item has non-empty content and optional mediaDecision. No duplicate top-level content or extraMessages is needed. Audio must be the only media in its item. Write only this speaker. Unless a formal deliverable is requested, this is chat even when the topic is serious: punctuation follows the voice and moment, not a mandatory full stop on every bubble.${sendBoundaryRule}${deliveryPolicyRules}

intentionalRepeat is false unless repeating wording, cadence, or a marker is the deliberate social move; do not use it to excuse template drift. presenceUpdate is null unless the speaker explicitly goes away, returns, or states an actual availability change. Its shape is {"status":"away|online","activity":"what the speaker does","reason":"visible grounds","durationMinutes":30,"evidenceText":"short exact quote from one visible send"}. Prefer activityUpdate when the activity has calendar details; do not duplicate presenceUpdate for that activity.
${activityRule}
For activityUpdate, participantIds means people doing or explicitly invited to THIS activity, never the people receiving this message. Solo activity uses [] or only the speaker id. People staying behind, seeing the speaker off, waiting for a report, or merely addressed are not participants. Being in the same room is not participation. An activity already in progress uses status=in_progress even when its original start time is unknown; the runtime records it from now, without inventing elapsed time. First revealing a concrete ongoing activity in this turn is a calendar change even if the speaker can keep chatting; record it with availability=online when stated. Unknown time, duration or place may be omitted; do not invent them or require them before recording the activity. durationMinutes is the remaining planned duration, not how long the speaker has already been doing it. Use the exact known calendarItemId for updates, not a newly invented key. Known speaker activity records: ${JSON.stringify(ownActivityContext)}.
Every non-null activityUpdate requires title, kind, status and evidenceText. Known activities are last recorded facts: a visible report of a changed location, status or remaining duration updates that same activity even when it is still in progress and the speaker stays online. Reuse calendarItemId and unchanged title/kind, with an exact quote supporting the change; null means this turn establishes no activity change. Follow explicit current circumstances and newer visible progress rather than restating an older record or inventing a different place. Use its writebackChannel; socialEventHints uses the calendarItemId as dedupeKey. Participation in a shared invitation does not authorize activityUpdate for the whole event. Omit unchanged optional timing and participants; the runtime preserves them. The record-from-now rule and unknown-away default apply when first recording an activity or establishing an absence without a known end, not on every location or title update. Do not resend a default duration as though it were a newly stated remaining duration. Existing participants retain their individual accepted or declined states.
${interactionRule}
${addressedTargetRule}
${continuityRule}
${socialRule}
${isStudyRoom ? 'studyUpdate is required for every learning-progress reply: this is the teacher\'s explicit judgement of the most recent learner turn, not optional bookkeeping. Return a non-null object with phase and knowledgeObservations. Record only knowledge actually introduced, practiced, demonstrated, corrected, or checked in the visible exchange. For the same underlying knowledge point already in the known learning map, copy its exact knowledgeItemId as one ID token even if you phrase its title differently; never shorten the ID or append the title to it. Use null only for a genuinely new point. Use exposed for newly introduced material, practicing when the learner attempts it, usable when they apply it successfully with some support, and verified only after clear independent evidence. If the learner gives no assessable answer, still return knowledgeObservations:[] with the phase; never use null merely because the turn is conversational. Never infer mastery from encouragement, topic mention, or one untested explanation. evidenceSummary must point to the exact learner attempt or the concrete material just taught.' : ''}
Valid member ids:
${buildMemberReference({ chat: params.chat, characters: params.characters, speakerId: params.speaker.id })}
conflictFocus tracks the current live contradiction, not only brand-new conflicts. Use {"present":true,"conflictId":null,"type":"goal_conflict","severity":0.6,"stage":"open","summary":"concrete contradiction","participantIds":[],"primaryTargetIds":[],"nextPressure":"stabilize","developmentHooks":[],"why":"visible grounds","evidenceText":"short exact quote from one visible send"}. Valid stages: latent, emerging, open, escalating, fragmented, cooling, resolved. Use the existing conflictId to update, cool or resolve the same contradiction. Lower severity is allowed for an existing conflict; cooling is not resolution. Null means no update, never resolution. The quote must support the change in this contradiction, including any cooling or resolution; why explains the judgement and does not replace spoken evidence. Include only directly involved people, not everyone present. Do not invent a contradiction merely to add drama.
Known conflicts for writeback: ${JSON.stringify(Array.from(new Map([
    ...(params.chat.worldState?.conflictState?.primaryConflict ? [params.chat.worldState.conflictState.primaryConflict] : []),
    ...(params.chat.worldState?.conflictState?.activeConflicts || []),
  ].map((conflict) => [conflict.id, conflict])).values()).map((conflict) => ({ conflictId: conflict.id, summary: sanitizeUserFacingText(conflict.summary, params.characters), stage: conflict.stage })))}.${mediaRules}${expressiveAudioOverride}${deliberationRules}
${toolRule}
Recent transcript scope: ${transcriptScope}${recentSocialEvents ? `\nRecent social events: ${recentSocialEvents}` : ''}`;
}

function isValidActivityUpdateInput(update: InlineInteractionEnvelope['activityUpdate']) {
  if (update == null) return true;
  if (!normalizeActivityUpdate(update)) return false;
  if (update.availability != null && update.availability !== 'away' && update.availability !== 'online') return false;
  if (update.startsNow != null && typeof update.startsNow !== 'boolean') return false;
  if (update.startAt != null && (typeof update.startAt !== 'number' || !Number.isFinite(update.startAt) || update.startAt < 0)) return false;
  if (update.durationMinutes != null && (typeof update.durationMinutes !== 'number' || !Number.isFinite(update.durationMinutes) || update.durationMinutes <= 0)) return false;
  if (update.participantIds != null && (!Array.isArray(update.participantIds)
    || update.participantIds.some((id) => typeof id !== 'string' || !id.trim()))) return false;
  return [update.calendarItemId, update.timeHint, update.locationHint].every((value) => value == null || typeof value === 'string');
}

export function parseInlineInteractionEnvelope(raw: string, options: {
  allowContentSalvage?: boolean;
  requireConversationUpdate?: boolean;
  validateActivityUpdate?: boolean;
} = {}): InlineInteractionEnvelope | null {
  try {
    const jsonMatch = cleanJsonLikeText(raw).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as InlineInteractionEnvelope;
    if (!parsed || !hasVisibleEnvelopeContent(parsed)) return null;
    if (options.validateActivityUpdate && !isValidActivityUpdateInput(parsed.activityUpdate)) return null;
    if (options.requireConversationUpdate && (!Object.hasOwn(parsed, 'conversationUpdate')
      || (parsed.conversationUpdate !== null && (!parsed.conversationUpdate
        || !Array.isArray(parsed.conversationUpdate.items))))) return null;
    return sanitizeEnvelope(parsed);
  } catch {
    if (options.allowContentSalvage === false || options.requireConversationUpdate || options.validateActivityUpdate) return null;
    const salvaged = salvageContentFromMalformedEnvelope(raw);
    return salvaged ? sanitizeEnvelope(salvaged) : null;
  }
}
