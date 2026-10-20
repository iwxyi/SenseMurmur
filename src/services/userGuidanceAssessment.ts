import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import type { Message } from '../types/message';
import type { APIConfig } from '../types/settings';
import { generateJsonResponse } from './aiClient';
import { explicitUserMentionIds } from './characterMentions';
import { reportRecoverableWarning } from './diagnostics';
import { createUndirectedUserGuidance, normalizeUserGuidanceIntent, type UserGuidanceIntent } from './userGuidanceIntent';

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function recentTranscript(messages: Message[], characters: AICharacter[]) {
  const names = new Map(characters.map((character) => [character.id, character.name]));
  return messages
    .filter((message) => !message.isDeleted && message.type !== 'system' && message.type !== 'event')
    .slice(-8)
    .map((message) => ({
      speaker: message.senderName || names.get(message.senderId) || (message.type === 'ai' ? '角色' : '用户'),
      content: message.content.slice(0, 300),
    }));
}

export async function assessUserGuidance(params: {
  config?: APIConfig | null;
  chat: GroupChat;
  characters: AICharacter[];
  message: Pick<Message, 'content' | 'type' | 'senderId' | 'metadata'>;
  recentMessages?: Message[];
}): Promise<UserGuidanceIntent | null> {
  const fallback = createUndirectedUserGuidance(params.message.content);
  if (!fallback || !params.config) return fallback;
  const members = params.characters.map((character) => ({ id: character.id, name: character.name }));
  const systemPrompt = [
    '你是群聊用户意图分析器。理解语境与语用，只输出结构化决策，不生成聊天回复。',
    '不得靠字面关键词机械判断：区分点名回应、谈论某人、否定指令、转述、玩笑、图片理解与图片生成。',
    'explicitMentions 是用户通过艾特选中的成员，只表达引起注意，不自动要求发言。结合原文判断是否要求回答；引述、代码里的名字不是召唤，也不要把每个艾特都填成 actorIds。',
    'actorIds 仅填写用户明确指定必须执行或优先发言的角色；mentionedActorIds 是被谈及但未必需要发言的角色。面向群体的开放邀请不是逐人作答任务，actorIds 留空；只有语义上明确要求每个人分别完成时才填写全体成员。',
    '只要 actorIds 非空，就表示这些角色拥有下一轮发言或执行的优先权，不因 kind 或 beatType 改成随机选人。',
    'suppressedActorIds 是明确不应插话或被否定为执行者的角色；deferredActorIds 是暂缓发言的角色。只能填写成员 id。',
    '普通聊天也要返回 topic_shift，但只持续 1 轮。只有明确需要跨轮完成的要求才提高 maxTurns；不得擅自把短句扩大为长期命令。',
    'kind 只能是 topic_shift、direct_reply、media_request。图片生成/发送才是 media_request；看图、评论图片不是。',
    'beatType 只能是 answer、challenge、defend、escalate、cool_down、reveal、deflect、summarize、invite；invite 只表示交流动作，不等于必须安排线下或社交活动。',
    'pressure 为 0 到 1；maxTurns 为 1 到 8；minTargetTurns 为每个目标最低回应轮数，通常为 1。',
    'hasHardConstraints 仅表示用户明确要求后续必须持续遵守的边界或条件。voiceRequest、stickerRequest 仅在明确请求语音、表情/贴纸时为 true。',
    'mediaRequest 仅在 kind=media_request 时填写：{"kind":"image","subjectActorIds":[],"subjectText":"","actionText":""}。',
    '返回且仅返回：{"kind":"...","actorIds":[],"mentionedActorIds":[],"hardConstraintActorIds":[],"suppressedActorIds":[],"deferredActorIds":[],"hasHardConstraints":false,"voiceRequest":false,"stickerRequest":false,"focusText":"","beatType":"...","pressure":0.5,"maxTurns":1,"minTargetTurns":1,"reason":"","mediaRequest":null}',
  ].join('\n');
  const payload = {
    room: { type: params.chat.type, mode: params.chat.mode, name: params.chat.name, topic: params.chat.topic || '' },
    members,
    recentTranscript: recentTranscript(params.recentMessages || [], params.characters),
    userMessage: params.message.content,
    explicitMentions: explicitUserMentionIds(params.message).filter((id) => members.some((member) => member.id === id)),
  };
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const retryInstruction = attempt === 1
        ? ''
        : '\n上一次结构化输出未能完整解析。这次只返回一份完整、闭合、可直接 JSON.parse 的对象，不要解释。';
      const raw = await generateJsonResponse(params.config, `${systemPrompt}${retryInstruction}`, [{ role: 'user', content: JSON.stringify(payload) }], {
        // Reasoning models may spend most of a small completion budget on
        // hidden thought and then truncate the tiny JSON object itself.
        // This budget is intentionally larger than the visible schema needs;
        // the prompt still constrains the returned object to a compact shape.
        maxTokens: 4_096,
        aiUsage: { type: 'message_analysis', label: attempt === 1 ? '用户引导分析' : '用户引导分析重试', scope: 'chat', resourceId: params.chat.id },
      });
      return normalizeUserGuidanceIntent(JSON.parse(extractJsonObject(raw)) as unknown, params.message.content, params.characters) || fallback;
    } catch (error) {
      lastError = error;
    }
  }
  reportRecoverableWarning({
    location: 'runtime:user-guidance-assessment',
    error: lastError,
    message: '用户引导分析连续失败，本轮将按普通发言继续，不进行本地语义猜测。',
    extra: { chatId: params.chat.id, attempts: 2 },
  });
  return fallback;
}
