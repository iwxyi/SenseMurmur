import type { AICharacter } from '../types/character';
import type { GroupChat, GroupVisualIdentity } from '../types/chat';
import { prepareAvatarUploadDataUrl } from '../utils/avatarUpload';
import type { AIModelProfile, AvatarGenerationSettings } from '../types/settings';
import { getPreferredAIProfile, isAIProfileUsable } from '../types/settings';
import { generateResponse } from './aiClient';
import { parseGeneratedJsonPayload } from './characterGenerator';
import { avatarGenerationQueue } from './avatarGenerationQueue';
import { enqueueChatCompletionTask } from './chatCompletionQueue';
import { notifyDiagnosticToast } from './diagnostics';
import { useChatStore } from '../stores/useChatStore';
import { api } from './api';
import { useAuthStore } from '../stores/useAuthStore';

export type GroupVisualKind = 'avatar' | 'background';
type GroupVisualPlan = { negativePrompt?: string; backgroundOpacity?: number; prompt: string; fallbackUsed: boolean };

function compact(value?: string | null, max = 320) { return value?.trim().replace(/\s+/g, ' ').slice(0, max) || ''; }

async function waitForCloudChat(chatId: string) {
  if (!chatId.startsWith('local-chat-')) return true;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await api.getChat(chatId);
      return true;
    } catch {
      await useChatStore.getState().resumeSync();
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(3000, 250 * (attempt + 1))));
    }
  }
  return false;
}

function buildSource(chat: GroupChat, members: AICharacter[], requirement: string, language: 'zh' | 'en') {
  const memberHints = members.slice(0, 8).map((member) => [member.name, compact(member.background, 100), (member.expertise || []).slice(0, 3).join('、')].filter(Boolean).join('：')).join('\n');
  if (language === 'zh') return [
    `群聊名称：${compact(chat.name, 120)}`, `主题：${compact(chat.topic, 220)}`, `讨论种子：${compact(chat.topicSeed, 180)}`,
    `氛围：${compact(chat.worldState?.mood, 100)}；焦点：${compact(chat.worldState?.focus, 140)}；近期事件：${compact(chat.worldState?.recentEvent, 140)}`,
    `会话风格：${chat.style}；玩法：${chat.sessionKind?.scenarioId || chat.mode}`, memberHints ? `成员轮廓：\n${memberHints}` : '',
    requirement ? `本次用户要求（仅用于本次，不写入长期档案）：${compact(requirement, 420)}` : '',
  ].filter(Boolean).join('\n');
  return [
    `Group name: ${compact(chat.name, 120)}`, `Topic: ${compact(chat.topic, 220)}`, `Seed: ${compact(chat.topicSeed, 180)}`,
    `Mood: ${compact(chat.worldState?.mood, 100)}; focus: ${compact(chat.worldState?.focus, 140)}; recent event: ${compact(chat.worldState?.recentEvent, 140)}`,
    `Conversation style: ${chat.style}; session: ${chat.sessionKind?.scenarioId || chat.mode}`, memberHints ? `Member cues:\n${memberHints}` : '',
    requirement ? `One-off user request (do not persist it): ${compact(requirement, 420)}` : '',
  ].filter(Boolean).join('\n');
}

function fallbackPlan(chat: GroupChat, kind: GroupVisualKind, language: 'zh' | 'en'): GroupVisualPlan {
  const subject = compact(chat.topic || chat.name, 260);
  const style = '';
  if (kind === 'avatar') return {
    prompt: language === 'zh'
      ? `方形群聊头像，围绕“${subject}”，一个居中且占画面大部分的明确象征物或近景场景片段，清晰剪影，1到2个主色块，明暗分离，小尺寸40px仍可辨识，${style || '克制精致的图形化插画'}，无文字、无水印、无人像拼贴、无拥挤背景。`
      : `Square group avatar about ${subject}; one unmistakable centered symbol or close scene fragment filling most of the frame, clear silhouette, one or two color blocks, strong value separation and recognizability at 40px, ${style || 'restrained refined graphic illustration'}, no text, watermark, face collage, or busy background.`,
    negativePrompt: 'text, watermark, collage, multiple tiny people, busy scene, dark muddy image', fallbackUsed: true,
  };
  return {
    backgroundOpacity: 0.16,
    prompt: language === 'zh'
      ? `方形群聊背景图，主题“${subject}”，${style || '浅色纸张、雾感与柔和光影'}，低饱和、低对比、低视觉噪声，中心60%安全区保持干净，重要元素不要贴边，适合横竖屏cover裁切，作为浅色聊天背景仍需保证文字可读，无文字、无人脸、无海报感、无强动作。`
      : `Square group chat background about ${subject}, ${style || 'pale paper, mist, and soft light'}, low saturation, low contrast, low visual frequency; keep the central 60% calm and crop-safe for landscape and portrait cover, preserve text readability in a light chat UI; no text, faces, poster design, or strong action.`,
    negativePrompt: 'text, watermark, faces, people, poster, high contrast, busy details, dark image', fallbackUsed: true,
  };
}

function normalizePlan(value: unknown): Omit<GroupVisualPlan, 'fallbackUsed'> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) return null;
  const backgroundOpacity = typeof record.backgroundOpacity === 'number' && Number.isFinite(record.backgroundOpacity)
    ? Math.min(0.4, Math.max(0.05, record.backgroundOpacity))
    : undefined;
  return { prompt, negativePrompt: typeof record.negativePrompt === 'string' ? record.negativePrompt.trim() : undefined, backgroundOpacity };
}

async function createPlan(profile: AIModelProfile, source: string, kind: GroupVisualKind, language: 'zh' | 'en') {
  const avatar = kind === 'avatar';
  const system = language === 'zh'
    ? avatar
      ? '你是群聊头像视觉导演。只返回严格 JSON：{"prompt":"可直接生图的中文提示词","negativePrompt":"负面词"}。这些内容仅用于本次生成，不能要求保存。头像为1024方图，小尺寸40px识别优先：将群聊主题和成员关系凝练为一个中心符号或近景片段，而不是群像；主体占中心大面积，1到2主色块和清晰明度分离。不能有文字、水印、通用聊天图标、远景、多张小脸或杂乱场景。'
      : '你是群聊背景视觉导演。只返回严格 JSON：{"prompt":"可直接生图的中文提示词","negativePrompt":"负面词","backgroundOpacity":0.16}。除 backgroundOpacity 外，这些内容仅用于本次生成，不能要求保存。backgroundOpacity 是界面显示图片的透明度，取 0.05 到 0.40，默认建议 0.16。输出1024方图，但会被横竖屏cover裁切：核心要留在中心60%安全区且不要靠边。它只在浅色聊天背景显示，须低饱和、低对比、低视觉噪声，用柔和环境、抽象纹理或远景隐喻群主题；禁止文字、人脸、强动作、海报感和抢眼细节。'
    : avatar
      ? 'You are a group-chat avatar visual director. Return strict JSON only: {"prompt":"image-ready English prompt","negativePrompt":"negative prompt"}. This content is for the current generation only and must not be retained. Create a 1024 square image optimized for 40px recognition: condense group theme and relationship into one central symbol or close scene fragment, never a group photo; large central subject, one or two color blocks, clear value separation. No text, watermark, generic chat icon, distant shot, face collage, or clutter.'
      : 'You are a group-chat background visual director. Return strict JSON only: {"prompt":"image-ready English prompt","negativePrompt":"negative prompt","backgroundOpacity":0.16}. Except backgroundOpacity, this content is for the current generation only and must not be retained. backgroundOpacity is the UI display opacity, between 0.05 and 0.40, normally 0.16. Create a 1024 square source image that will be cover-cropped for landscape and portrait: keep its essential motif in the calm central 60% crop-safe zone. It appears only beneath a light chat UI, so use low saturation, low contrast, and low visual frequency—soft environment, abstract texture, or distant metaphor. No text, faces, strong action, poster design, or distracting detail.';
  const request = async (repair = false) => normalizePlan(parseGeneratedJsonPayload(await generateResponse(profile, system, [{ role: 'user', content: `${source}\n\n${repair ? '上次格式无效，请只返回合法 JSON。' : '请根据上述配置设计本次视觉方案。'}` }], undefined, { maxTokens: 750, aiUsage: { type: 'character_visual_identity', label: avatar ? '设计群头像' : '设计群背景', scope: 'chat' } })));
  return await request() || await request(true);
}

export function enqueueGroupVisualGeneration(params: { chat: GroupChat; members: AICharacter[]; profiles: AIModelProfile[]; settings: AvatarGenerationSettings; language: 'zh' | 'en'; kind: GroupVisualKind; requirement?: string }) {
  const { chat, members, profiles, settings, language, kind, requirement = '' } = params;
  const field = kind === 'avatar' ? 'group-avatar' : 'chat-background';
  return enqueueChatCompletionTask({
    kind: 'image', chatId: chat.id, chatName: chat.name || '未命名聊天', field, label: kind === 'avatar' ? '群头像' : '聊天背景',
    run: async () => {
      const imageProfile = getPreferredAIProfile(profiles, 'image');
      if (!isAIProfileUsable(imageProfile)) throw new Error(language === 'zh' ? '请先配置可用的默认图片模型' : 'Configure an available default image model first.');
      const fallback = fallbackPlan(chat, kind, language);
      let plan = fallback;
      let warning: string | undefined;
      const textProfile = getPreferredAIProfile(profiles, 'text');
      if (isAIProfileUsable(textProfile)) {
        try {
          const stylePreference = settings.preferNonPhotorealAvatar && kind === 'avatar'
            ? (language === 'zh' ? '\n全局偏好：优先非写实、图形化或插画表达，但必须保持小尺寸辨识。' : '\nGlobal preference: favor non-photoreal, graphic, or illustrated expression while preserving small-size recognition.')
            : '';
          const generated = await createPlan(textProfile, `${buildSource(chat, members, requirement, language)}${stylePreference}`, kind, language);
          if (!generated) throw new Error(language === 'zh' ? '视觉导演未返回有效方案' : 'The visual director returned no valid plan.');
          plan = { ...generated, fallbackUsed: false };
        } catch (error) {
          warning = error instanceof Error ? error.message : String(error);
        }
      } else warning = language === 'zh' ? '未配置文本 AI，已使用基础模板。' : 'No text AI configured; using the base template.';
      if (warning) notifyDiagnosticToast({ message: `${kind === 'avatar' ? '群头像' : '聊天背景'}视觉方案失败，已使用基础模板继续生成。原因：${warning}`, severity: 'warning', location: 'chat-visual:director' });
      const taskId = avatarGenerationQueue.enqueue(imageProfile, plan.prompt, { targetKey: `chat-${kind}:${chat.id}`, characterId: null, errorReporting: 'caller', negativePrompt: plan.negativePrompt, description: `${chat.name || '未命名聊天'} · ${kind === 'avatar' ? '群头像' : '聊天背景'}${plan.fallbackUsed ? '（基础模板）' : ''}` });
      const result = await avatarGenerationQueue.waitForTask(taskId);
      if (!result.imageDataUrl) throw new Error(language === 'zh' ? '图片生成未返回内容' : 'Image generation returned no content.');
      const latest = useChatStore.getState().chats.find((item) => item.id === chat.id);
      if (!latest) throw new Error(language === 'zh' ? '群聊已不存在' : 'The group chat no longer exists.');
      const current = latest.groupVisual || {};
      let imageUrl = result.imageDataUrl;
      if (useAuthStore.getState().authMode === 'cloud') {
        if (!await waitForCloudChat(chat.id)) {
          throw new Error(language === 'zh' ? '群聊尚未完成云端同步，暂不能保存群聊图片，请稍后重试。' : 'The chat is still syncing to the cloud. Please try again shortly.');
        }
        try {
          const prepared = await prepareAvatarUploadDataUrl(result.imageDataUrl, { maxSize: 1536, quality: 0.9 });
          const asset = await api.createMediaAsset({
            chatId: chat.id,
            messageId: `group-visual-${chat.id}`,
            attachmentId: `${kind}-generated-${Date.now()}`,
            kind: 'image',
            dataUrl: prepared,
            description: `${chat.name || '未命名聊天'} · ${kind === 'avatar' ? '群聊头像' : '聊天背景'}`,
            sourceType: kind === 'avatar' ? 'group-avatar' : 'chat-background',
          });
          imageUrl = asset.url;
        } catch (error) {
          throw new Error(language === 'zh' ? `群聊图片上传失败：${error instanceof Error ? error.message : String(error)}` : `Failed to upload group visual: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const next: GroupVisualIdentity = {
        ...(current.avatarUrl ? { avatarUrl: current.avatarUrl } : {}),
        ...(current.backgroundUrl ? { backgroundUrl: current.backgroundUrl } : {}),
        ...(current.backgroundUrl && current.backgroundOpacity != null ? { backgroundOpacity: current.backgroundOpacity } : {}),
        ...(kind === 'avatar' ? { avatarUrl: imageUrl } : { backgroundUrl: imageUrl, backgroundOpacity: plan.backgroundOpacity ?? current.backgroundOpacity ?? 0.16 }),
      };
      await useChatStore.getState().updateChat(chat.id, { groupVisual: next });
      return warning ? { warning } : undefined;
    },
  });
}

export function enqueueGroupBasicCompletion(params: { chat: GroupChat; members: AICharacter[]; profiles: AIModelProfile[]; language: 'zh' | 'en'; mode: 'empty' | 'complete' | 'regenerate' }) {
  const { chat, members, profiles, language, mode } = params;
  return enqueueChatCompletionTask({
    kind: 'text', chatId: chat.id, chatName: chat.name || '未命名群聊', field: 'group-basics', label: '基础信息',
    run: async () => {
      const profile = getPreferredAIProfile(profiles, 'text');
      if (!isAIProfileUsable(profile)) throw new Error(language === 'zh' ? '请先配置可用的默认文本模型' : 'Configure an available default text model first.');
      const system = language === 'zh'
        ? '你负责补全群聊基础信息。只返回 JSON：{"name":"不超过30字","topic":"不超过120字"}。保留用户已有信息；只有重新生成时才能改写已有信息。不要编造成员或敏感事实。'
        : 'Complete group-chat basics. Return JSON only: {"name":"under 30 words","topic":"under 120 words"}. Preserve user-provided information; only rewrite existing values in regenerate mode. Do not invent members or sensitive facts.';
      const content = await generateResponse(profile, system, [{ role: 'user', content: `${buildSource(chat, members, '', language)}\n处理方式：${mode}` }], undefined, { maxTokens: 360, aiUsage: { type: 'character_visual_identity', label: '补全群聊基础信息', scope: 'chat' } });
      const result = parseGeneratedJsonPayload<Record<string, unknown>>(content);
      if (!result || typeof result !== 'object') throw new Error(language === 'zh' ? '基础信息补全未返回有效内容' : 'No valid basic information was returned.');
      const candidateName = typeof result.name === 'string' ? result.name.trim().slice(0, 100) : '';
      const candidateTopic = typeof result.topic === 'string' ? result.topic.trim().slice(0, 600) : '';
      const patch: Partial<GroupChat> = {};
      if (candidateName && (mode === 'regenerate' || !chat.name.trim())) patch.name = candidateName;
      if (candidateTopic && (mode === 'regenerate' || !chat.topic.trim())) patch.topic = candidateTopic;
      if (!Object.keys(patch).length) return { warning: language === 'zh' ? '没有需要补全的基础信息。' : 'No basic information needs completion.' };
      await useChatStore.getState().updateChat(chat.id, patch);
    },
  });
}
