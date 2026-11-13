import type { Message } from '../types/message';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { getUsablePreferredAIProfile } from '../types/settings';
import { generateResponse } from './aiClient';
import { redactAiDiagnosticText } from './aiDiagnosticText';

export type AssistantTaskRoute = { route: 'reply' } | { route: 'team'; goal: string };

export function parseAssistantTaskRoute(raw: string): AssistantTaskRoute {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    console.error('[assistant-team-intent:invalid-json]', {
      error: error instanceof Error ? error.message : 'JSON 解析失败',
      length: raw.length,
      preview: redactAiDiagnosticText(raw, 500),
    });
    throw new Error('助手任务判断返回的格式无效');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('助手任务判断返回的结构无效');
  const route = (value as Record<string, unknown>).route;
  if (route === 'reply') return { route };
  if (route === 'team') {
    const goal = (value as Record<string, unknown>).goal;
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 12_000) throw new Error('团队任务目标无效');
    return { route, goal: goal.trim() };
  }
  throw new Error('助手任务判断缺少有效的执行方式');
}

export async function decideAssistantTaskRoute(params: {
  fallback: APIConfig;
  profiles: AIModelProfile[];
  messages: Message[];
  signal?: AbortSignal;
}): Promise<AssistantTaskRoute> {
  const latest = [...params.messages].reverse().find((message) => message.type === 'user' && !message.isDeleted);
  if (!latest?.content.trim() || latest.metadata?.assistantHtmlSubmission || latest.metadata?.assistantHtmlRuntimeError) return { route: 'reply' };
  const profile = getUsablePreferredAIProfile(params.profiles, 'text');
  const config: APIConfig = profile ? { provider: profile.provider, apiKey: profile.apiKey,
    baseUrl: profile.baseUrl, model: profile.model, maxOutputTokens: profile.maxOutputTokens } : params.fallback;
  const context = params.messages.filter((message) => !message.isDeleted && (message.type === 'user' || message.type === 'ai'))
    .slice(-8).map((message) => ({ role: message.type === 'ai' ? 'assistant' as const : 'user' as const, content: message.content.slice(0, 1500) }));
  const raw = await generateResponse(config, [
    '判断用户当前消息应直接由助手回答，还是启动可后台执行的主 Agent 团队工作流。',
    '用户要求现在执行一个需要自主规划的多步骤目标、调用多种工具、制作多份相互依赖的产物，或明确要求组建/调度 Agent 时选 team。团队可以只有一个岗位，由主 Agent 之后按任务需要动态决定。',
    '简单问答、讨论方案、解释概念、单个产物生成或修改、要求先给建议而非执行时选 reply。不要因为提到“视频”“研究”“Agent”这些词就直接选 team；结合最近对话判断用户是否要求立即执行完整任务。',
    '只返回严格 JSON。直接回复：{"route":"reply"}；团队任务：{"route":"team","goal":"结合近期对话消解指代后的完整用户目标和验收要求"}。goal 保留用户明确约束，不增加用户没有提出的交付要求。',
  ].join('\n'), context, undefined, { responseFormat: 'json', maxTokens: 1024, signal: params.signal,
    aiUsage: { type: 'assistant_chat', label: '助手任务判断', scope: 'chat', resourceId: latest.chatId } });
  return parseAssistantTaskRoute(raw);
}
