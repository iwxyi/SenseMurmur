import { generateResponse } from './aiClient';
import type { APIConfig } from '../types/settings';
import type { PersonalityParams, CharacterBehaviorParams, CharacterSpeechProfile, CharacterCoreProfile, CharacterVoiceConfig } from '../types/character';
import { DEFAULT_PERSONALITY, DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_SPEECH_PROFILE, DEFAULT_CORE_PROFILE } from '../types/character';
import type { BubbleStyleDefinition, BubbleBorderStyle, BubbleGradientDirection, BubbleShadowLevel } from '../types/bubbleStyle';
import { DEFAULT_BUBBLE_STYLE_FORM } from '../types/bubbleStyle';
import { AVATAR_OPTIONS } from '../constants/presets';
import { assignGeneratedVoiceProfile, assignGeneratedVoiceProfiles, type GeneratedVoiceProfile } from './speechVoiceAssignment';

export interface GeneratedCharacterProfile {
  avatar?: string;
  personality?: Partial<PersonalityParams>;
  behavior?: Partial<CharacterBehaviorParams>;
  expertise?: string[];
  speakingStyle?: string;
  background?: string;
  speechProfile?: Partial<CharacterSpeechProfile>;
  voiceProfile?: Partial<GeneratedVoiceProfile>;
  voiceConfig?: Partial<CharacterVoiceConfig>;
  coreProfile?: Partial<CharacterCoreProfile>;
  bubbleStyle?: Partial<BubbleStyleDefinition>;
  visualIdentity?: {
    description?: string;
    styleHint?: string;
    negativePrompt?: string;
    seed?: string | number | null;
  };
}

export interface CharacterVisualIdentityDraftInput {
  name: string;
  background?: string;
  speakingStyle?: string;
  expertise?: string[];
  group?: string | null;
  personality?: Partial<PersonalityParams>;
  coreProfile?: Partial<CharacterCoreProfile>;
  visualIdentity?: GeneratedCharacterProfile['visualIdentity'];
}

export interface CharacterVisualGenerationPlan {
  prompt: string;
  negativePrompt: string;
  fallbackUsed: boolean;
}

function characterVisualGlobalNegativePrompt(language: 'zh' | 'en') {
  return language === 'zh'
    ? '文字、水印、logo、多人、重复人物、额外肢体、畸形手部、主体遮挡、塑料皮肤、蜡像质感、过度磨皮、僵硬摆拍、无来源高光、背景与人物光线不一致、通用棚拍、廉价特效'
    : 'text, watermark, logo, multiple people, duplicate subject, extra limbs, malformed hands, obscured subject, plastic skin, waxy texture, excessive retouching, stiff posing, unmotivated highlights, inconsistent lighting, generic studio portrait, cheap visual effects';
}

export function buildFallbackCharacterVisualImagePrompt(input: CharacterVisualIdentityDraftInput, language: 'zh' | 'en') {
  const visual = input.visualIdentity || {};
  return [
    language === 'zh' ? `为聊天角色“${input.name.trim() || '未命名角色'}”生成一张标志性形象图。` : `Generate an iconic character image for the chat character "${input.name.trim() || 'Unnamed character'}".`,
    visual.description?.trim() ? (language === 'zh' ? `视觉形象：${visual.description.trim()}` : `Visual identity: ${visual.description.trim()}`) : '',
    input.background?.trim() ? (language === 'zh' ? `角色背景：${input.background.trim()}` : `Background: ${input.background.trim()}`) : '',
    input.speakingStyle?.trim() ? (language === 'zh' ? `表达气质：${input.speakingStyle.trim()}` : `Speaking vibe: ${input.speakingStyle.trim()}`) : '',
    visual.styleHint?.trim() ? (language === 'zh' ? `风格：${visual.styleHint.trim()}` : `Style: ${visual.styleHint.trim()}`) : '',
    language === 'zh'
      ? '以一个和身份、欲望、能力或气质直接相关的标志性瞬间构图；单人主体，脸部、发型、服装轮廓和标志性道具清晰，环境与光影服务于人物。'
      : 'Compose one iconic moment directly tied to identity, desire, ability, or temperament; one clear subject with recognizable face, hair, silhouette, signature props, and character-serving environment and lighting.',
  ].filter(Boolean).join('\n');
}

// 保留旧导出，供外部兼容；所有新形象图入口应改用 generateCharacterVisualGenerationPlan。
export const buildCharacterVisualImagePrompt = buildFallbackCharacterVisualImagePrompt;

function visualDirectorSource(input: CharacterVisualIdentityDraftInput, language: 'zh' | 'en') {
  const visual = input.visualIdentity || {};
  const expertise = (input.expertise || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const values = (input.coreProfile?.values || input.coreProfile?.valuePriority || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  return [
    language === 'zh' ? `角色：${input.name.trim() || '未命名角色'}` : `Character: ${input.name.trim() || 'Unnamed character'}`,
    visual.description?.trim() ? (language === 'zh' ? `稳定视觉档案：${visual.description.trim()}` : `Stable visual identity: ${visual.description.trim()}`) : '',
    visual.styleHint?.trim() ? (language === 'zh' ? `长期艺术方向：${visual.styleHint.trim()}` : `Long-term art direction: ${visual.styleHint.trim()}`) : '',
    input.group?.trim() ? (language === 'zh' ? `世界/主题：${input.group.trim()}` : `World/theme: ${input.group.trim()}`) : '',
    input.background?.trim() ? (language === 'zh' ? `角色经历：${input.background.trim()}` : `Background: ${input.background.trim()}`) : '',
    input.speakingStyle?.trim() ? (language === 'zh' ? `表达气质：${input.speakingStyle.trim()}` : `Speaking vibe: ${input.speakingStyle.trim()}`) : '',
    expertise ? (language === 'zh' ? `专长：${expertise}` : `Expertise: ${expertise}`) : '',
    values ? (language === 'zh' ? `价值取向：${values}` : `Values: ${values}`) : '',
  ].filter(Boolean).join('\n');
}

function normalizeVisualPlan(value: unknown): Omit<CharacterVisualGenerationPlan, 'fallbackUsed'> | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const negativePrompt = typeof raw.negativePrompt === 'string' ? raw.negativePrompt.trim() : '';
  if (prompt.length < 80 || prompt.length > 1800) return null;
  return { prompt, negativePrompt };
}

export async function generateCharacterVisualGenerationPlan(config: APIConfig, input: CharacterVisualIdentityDraftInput, language: 'zh' | 'en'): Promise<CharacterVisualGenerationPlan> {
  const source = visualDirectorSource(input, language);
  const system = language === 'zh'
    ? '你是角色形象图的视觉导演。只返回严格 JSON：{"prompt":"...","negativePrompt":"..."}。prompt 必须是精简、可直接交给图片模型的中文提示词，约 180-350 字。先确保稳定外观锚点，再选择一个标志性瞬间、一个心理神态重点、少量服化道细节、一个构图和一组有明确来源的光影。允许与角色匹配的艺术夸张，但不能堆砌特效。现实或现代角色可选择电影感写实：自然皮肤、发丝、织物、真实重心、合理阴影；不要塑料或棚拍 AI 人像。幻想角色可选择更合适的媒介。细节冲突时牺牲环境，不牺牲人物识别。'
    : 'You are a visual director for character identity images. Return strict JSON only: {"prompt":"...","negativePrompt":"..."}. prompt must be a compact, image-ready English prompt, about 120-220 tokens. Prioritize stable appearance anchors, then choose one iconic moment, one psychological micro-expression, a few wardrobe/prop details, one composition, and one lighting relationship with a clear source. Allow character-driven artistic exaggeration without effect clutter. For realistic modern characters, use cinematic realism with natural skin, hair, fabric, believable weight and coherent shadows; avoid plastic, studio-like AI portraits. If details conflict, sacrifice environment before character recognition.';
  const request = async (repair = false) => {
    const content = await generateResponse(config, system, [{ role: 'user', content: repair
      ? `${source}\n\n上次输出不符合 JSON 或提示词长度。请重新输出仅含 prompt 和 negativePrompt 的合法 JSON。`
      : `${source}\n\n请为这一次角色形象图做视觉导演，并输出最终精简提示词。` }], undefined, { maxTokens: 900, aiUsage: { type: 'character_visual_identity', label: '设计角色形象图', scope: 'character' } });
    return normalizeVisualPlan(parseGeneratedJsonPayload<unknown>(content));
  };
  const plan = await request() || await request(true);
  if (!plan) throw new Error(language === 'zh' ? '视觉导演未返回有效的形象图方案，请稍后重试。' : 'The visual director did not return a valid image plan. Please try again.');
  return { ...plan, negativePrompt: [characterVisualGlobalNegativePrompt(language), input.visualIdentity?.negativePrompt?.trim(), plan.negativePrompt].filter(Boolean).join(language === 'zh' ? '；' : '; '), fallbackUsed: false };
}

export function buildFallbackCharacterVisualGenerationPlan(input: CharacterVisualIdentityDraftInput, language: 'zh' | 'en'): CharacterVisualGenerationPlan {
  return {
    prompt: buildFallbackCharacterVisualImagePrompt(input, language),
    negativePrompt: [characterVisualGlobalNegativePrompt(language), input.visualIdentity?.negativePrompt?.trim()].filter(Boolean).join(language === 'zh' ? '；' : '; '),
    fallbackUsed: true,
  };
}

export interface CharacterVoiceProfileDraftInput {
  name: string;
  background?: string;
  speakingStyle?: string;
  expertise?: string[];
  group?: string | null;
  coreProfile?: Partial<CharacterCoreProfile>;
  speechProfile?: Partial<CharacterSpeechProfile>;
}

export const CHARACTER_GENERATOR_SYSTEM_PROMPT = `You generate structured AI role profiles for a group chat app.
Keep profile fields semantically distinct:
- speakingStyle describes HOW the character talks: rhythm, word choice, tone, humor, verbal habits, and how these change under pressure. A job title or identity summary is not a speaking style.
- background describes WHO they are and WHY: setting, identity, formative experiences, important relationships, and current circumstances. Expand short identity hints into a coherent background; do not simply repeat them.
- expertise lists concrete skills or knowledge domains.
Never copy the same text into speakingStyle and background. For established fictional characters, use the requested work/group to identify the character and preserve their recognizable traits; do not invent unsupported canonical events.
Return strict JSON only, with this shape:
{
  "avatar": "single emoji from common emoji only",
  "personality": {
    "openness": 0-100,
    "extroversion": 0-100,
    "agreeableness": 0-100,
    "neuroticism": 0-100,
    "humor": 0-100,
    "creativity": 0-100,
    "assertiveness": 0-100,
    "empathy": 0-100
  },
  "behavior": {
    "proactivity": 0-100,
    "aggressiveness": 0-100,
    "humorIntensity": 0-100,
    "empathyLevel": 0-100,
    "summarizing": 0-100,
    "offTopic": 0-100
  },
  "expertise": ["short domain", "short domain", "short domain", "short domain"],
  "speakingStyle": "1-2 concise sentences",
  "background": "2-4 concise sentences",
  "speechProfile": {
    "catchphrases": ["0-3 short catchphrases"],
    "fillers": ["0-4 short filler words or spoken tics"],
    "tabooPhrases": ["0-3 phrases they avoid saying"],
    "preferredOpeners": ["0-3 common openers"],
    "preferredClosers": ["0-3 common closers"],
    "sentenceLengthBias": "short|mixed|long",
    "questionBias": 0-100,
    "sarcasmBias": 0-100
  },
  "voiceProfile": {
    "gender": "female|male|neutral|unknown",
    "age": "child|young|adult|senior|unknown",
    "language": "BCP-47 language such as zh-CN",
    "traits": ["2-6 voice timbre or temperament keywords"],
    "styles": ["0-4 speaking style keywords"],
    "emotions": ["0-4 suitable default emotions"],
    "energy": "low|medium|high"
  },
  "coreProfile": {
    "coreDesire": "long-term desire or need",
    "coreFear": "long-term fear, avoidance, or vulnerable point",
    "socialMask": "how they protect themselves in public interactions",
    "values": ["0-5 value priorities"],
    "sensitivities": ["0-5 sensitive points"],
    "perceptionBiases": ["0-5 likely misreadings or attention filters"],
    "interactionHabits": ["0-5 interaction habits"],
    "expressionHabits": ["0-5 characteristic expression habits"],
    "attachmentStyle": "relationship or attachment tendency",
    "conflictStyle": "how they handle conflict",
    "unmetNeeds": ["0-5 unmet emotional needs"],
    "selfImage": "how they tend to see themselves",
    "hiddenSoftSpots": ["0-5 private soft spots"]
  },
  "bubbleStyle": {
    "name": "2-4 word style name",
    "backgroundColor": "#RRGGBB or rgba(...)",
    "textColor": "#RRGGBB or rgba(...)",
    "borderColor": "#RRGGBB or rgba(...)",
    "borderWidth": 0-4,
    "borderStyle": "solid|dashed|dotted",
    "radius": 4-32,
    "shadow": "none|soft|medium|strong",
    "gradientFrom": "optional color string",
    "gradientTo": "optional color string",
    "gradientDirection": "135deg|160deg|180deg"
  },
  "visualIdentity": {
    "description": "optional, 1-3 concise sentences describing stable visual anchors plus one iconic action or scene for image generation",
    "styleHint": "optional style guidance",
    "negativePrompt": "optional negative prompt",
    "seed": "optional seed"
  }
}
Rules:
- Infer the profile from the provided name and likely public persona/archetype.
- Make personality and behavior numerically distinctive for the role. Avoid leaving all axes at 50 unless the role is intentionally neutral on that exact axis.
- behavior controls social expression and discussion style: proactivity = initiates topics, aggressiveness = confronts/pushes back, humorIntensity = jokes/playfulness, empathyLevel = emotional attunement, summarizing = organizes/summarizes, offTopic = tangent-prone.
- If the name is fictional, meme-like, or ambiguous, still create a vivid but usable role profile.
- Keep expertise practical for conversation.
- Make coreProfile psychologically specific to this role, not generic labels. It should describe long-term inner drives, vulnerabilities, relationship style, conflict style, self-image, and likely perception filters.
- voiceProfile describes the desired voice, not a provider voice ID. Gender is a strict safety constraint: use female or male only when the character context clearly establishes it; otherwise use neutral or unknown. Never infer gender from stereotypes alone.
- Make visualIdentity specific: preserve stable physical anchors and signature props, then choose one memorable action or scene that embodies this character rather than an ordinary portrait pose.
- Make bubbleStyle visually distinctive and aligned with the character's vibe, role, and speaking style.
- Keep bubbleStyle practical for chat readability with strong text/background contrast.
- Do not wrap in markdown fences.
- Output valid JSON only.`;

function clampScore(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeStringList(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, limit)
    : [];
}

function normalizeShortText(value: unknown, limit = 220) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeBubbleBorderStyle(value: unknown): BubbleBorderStyle {
  return value === 'dashed' || value === 'dotted' ? value : 'solid';
}

function normalizeBubbleShadow(value: unknown): BubbleShadowLevel {
  return value === 'none' || value === 'medium' || value === 'strong' ? value : 'soft';
}

function normalizeBubbleGradientDirection(value: unknown): BubbleGradientDirection {
  return value === '160deg' || value === '180deg' ? value : '135deg';
}

function normalizeColor(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBubbleStyle(raw: Partial<BubbleStyleDefinition> | undefined): BubbleStyleDefinition {
  return {
    id: 'generated-bubble-style',
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Generated Style',
    backgroundColor: normalizeColor(raw?.backgroundColor, DEFAULT_BUBBLE_STYLE_FORM.backgroundColor),
    textColor: normalizeColor(raw?.textColor, DEFAULT_BUBBLE_STYLE_FORM.textColor),
    borderColor: normalizeColor(raw?.borderColor, DEFAULT_BUBBLE_STYLE_FORM.borderColor),
    borderWidth: clampInteger(raw?.borderWidth, 0, 4, DEFAULT_BUBBLE_STYLE_FORM.borderWidth),
    borderStyle: normalizeBubbleBorderStyle(raw?.borderStyle),
    radius: clampInteger(raw?.radius, 4, 32, DEFAULT_BUBBLE_STYLE_FORM.radius),
    shadow: normalizeBubbleShadow(raw?.shadow),
    gradientFrom: typeof raw?.gradientFrom === 'string' && raw.gradientFrom.trim() ? raw.gradientFrom.trim() : undefined,
    gradientTo: typeof raw?.gradientTo === 'string' && raw.gradientTo.trim() ? raw.gradientTo.trim() : undefined,
    gradientDirection: normalizeBubbleGradientDirection(raw?.gradientDirection),
  };
}

export function normalizeGeneratedProfile(raw: GeneratedCharacterProfile) {
  const avatar = typeof raw.avatar === 'string' && raw.avatar.trim() ? raw.avatar.trim() : '🤖';
  const personality = {
    openness: clampScore(raw.personality?.openness, DEFAULT_PERSONALITY.openness),
    extroversion: clampScore(raw.personality?.extroversion, DEFAULT_PERSONALITY.extroversion),
    agreeableness: clampScore(raw.personality?.agreeableness, DEFAULT_PERSONALITY.agreeableness),
    neuroticism: clampScore(raw.personality?.neuroticism, DEFAULT_PERSONALITY.neuroticism),
    humor: clampScore(raw.personality?.humor, DEFAULT_PERSONALITY.humor),
    creativity: clampScore(raw.personality?.creativity, DEFAULT_PERSONALITY.creativity),
    assertiveness: clampScore(raw.personality?.assertiveness, DEFAULT_PERSONALITY.assertiveness),
    empathy: clampScore(raw.personality?.empathy, DEFAULT_PERSONALITY.empathy),
  };
  const behavior = {
    proactivity: clampScore(raw.behavior?.proactivity, DEFAULT_CHARACTER_BEHAVIOR.proactivity),
    aggressiveness: clampScore(raw.behavior?.aggressiveness, DEFAULT_CHARACTER_BEHAVIOR.aggressiveness),
    humorIntensity: clampScore(raw.behavior?.humorIntensity, DEFAULT_CHARACTER_BEHAVIOR.humorIntensity),
    empathyLevel: clampScore(raw.behavior?.empathyLevel, DEFAULT_CHARACTER_BEHAVIOR.empathyLevel),
    summarizing: clampScore(raw.behavior?.summarizing, DEFAULT_CHARACTER_BEHAVIOR.summarizing),
    offTopic: clampScore(raw.behavior?.offTopic, DEFAULT_CHARACTER_BEHAVIOR.offTopic),
  };

  const expertise = Array.isArray(raw.expertise)
    ? raw.expertise
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const speechProfile: CharacterSpeechProfile = {
    ...DEFAULT_SPEECH_PROFILE,
    ...(raw.speechProfile || {}),
    catchphrases: normalizeStringList(raw.speechProfile?.catchphrases, 3),
    fillers: normalizeStringList(raw.speechProfile?.fillers, 4),
    tabooPhrases: normalizeStringList(raw.speechProfile?.tabooPhrases, 3),
    preferredOpeners: normalizeStringList(raw.speechProfile?.preferredOpeners, 3),
    preferredClosers: normalizeStringList(raw.speechProfile?.preferredClosers, 3),
    sentenceLengthBias: raw.speechProfile?.sentenceLengthBias === 'short' || raw.speechProfile?.sentenceLengthBias === 'long' ? raw.speechProfile.sentenceLengthBias : 'mixed',
    questionBias: clampScore(raw.speechProfile?.questionBias, DEFAULT_SPEECH_PROFILE.questionBias),
    sarcasmBias: clampScore(raw.speechProfile?.sarcasmBias, DEFAULT_SPEECH_PROFILE.sarcasmBias),
  };
  const rawVoiceProfile = raw.voiceProfile || {};
  const rawGender = rawVoiceProfile.gender;
  const voiceProfile: GeneratedVoiceProfile = {
    gender: rawGender === 'female' || rawGender === 'male' || rawGender === 'neutral' ? rawGender : 'unknown',
    age: normalizeShortText(rawVoiceProfile.age) || 'unknown',
    language: normalizeShortText(rawVoiceProfile.language) || 'zh-CN',
    traits: normalizeStringList(rawVoiceProfile.traits, 6),
    styles: normalizeStringList(rawVoiceProfile.styles, 4),
    emotions: normalizeStringList(rawVoiceProfile.emotions, 4),
    energy: ['low', 'medium', 'high'].includes(String(rawVoiceProfile.energy)) ? String(rawVoiceProfile.energy) : 'medium',
  };

  const rawCoreProfile = raw.coreProfile || {};
  const values = normalizeStringList(rawCoreProfile.values?.length ? rawCoreProfile.values : rawCoreProfile.valuePriority, 6);
  const perceptionBiases = normalizeStringList(rawCoreProfile.perceptionBiases?.length ? rawCoreProfile.perceptionBiases : rawCoreProfile.biases, 6);
  const coreProfile: CharacterCoreProfile = {
    ...DEFAULT_CORE_PROFILE,
    coreDesire: normalizeShortText(rawCoreProfile.coreDesire),
    coreFear: normalizeShortText(rawCoreProfile.coreFear),
    socialMask: normalizeShortText(rawCoreProfile.socialMask),
    values,
    valuePriority: values,
    sensitivities: normalizeStringList(rawCoreProfile.sensitivities, 6),
    perceptionBiases,
    biases: perceptionBiases,
    interactionHabits: normalizeStringList(rawCoreProfile.interactionHabits, 6),
    expressionHabits: normalizeStringList(rawCoreProfile.expressionHabits, 6),
    attachmentStyle: normalizeShortText(rawCoreProfile.attachmentStyle),
    conflictStyle: normalizeShortText(rawCoreProfile.conflictStyle),
    unmetNeeds: normalizeStringList(rawCoreProfile.unmetNeeds, 6),
    selfImage: normalizeShortText(rawCoreProfile.selfImage),
    hiddenSoftSpots: normalizeStringList(rawCoreProfile.hiddenSoftSpots, 6),
  };

  return {
    avatar: AVATAR_OPTIONS.includes(avatar) ? avatar : '🤖',
    personality,
    behavior,
    expertise,
    speakingStyle: typeof raw.speakingStyle === 'string' ? raw.speakingStyle.trim() : '',
    background: typeof raw.background === 'string' ? raw.background.trim() : '',
    speechProfile,
    voiceProfile,
    voiceConfig: raw.voiceConfig,
    coreProfile,
    bubbleStyle: normalizeBubbleStyle(raw.bubbleStyle),
    visualIdentity: {
      description: typeof raw.visualIdentity?.description === 'string' ? raw.visualIdentity.description.trim() : '',
      styleHint: typeof raw.visualIdentity?.styleHint === 'string' ? raw.visualIdentity.styleHint.trim() : '',
      negativePrompt: typeof raw.visualIdentity?.negativePrompt === 'string' ? raw.visualIdentity.negativePrompt.trim() : '',
      seed: raw.visualIdentity?.seed ?? null,
    },
  };
}

export function parseGeneratedProfile(content: string) {
  const parsed = parseGeneratedJsonPayload<GeneratedCharacterProfile>(content);
  return normalizeGeneratedProfile(parsed);
}

type CharacterGenerationContext = string | { theme?: string | null; description?: string | null } | null | undefined;

function formatThemeHint(theme?: string | null) {
  const normalizedTheme = theme?.trim();
  return normalizedTheme ? normalizedTheme : '';
}

function normalizeGenerationContext(context?: CharacterGenerationContext) {
  if (typeof context === 'string') return { theme: formatThemeHint(context), description: '' };
  return {
    theme: formatThemeHint(context?.theme),
    description: context?.description?.trim() || '',
  };
}

export function buildGeneratePrompt(name: string, language: 'zh' | 'en', context?: CharacterGenerationContext) {
  const { theme, description } = normalizeGenerationContext(context);
  if (language === 'zh') {
    return theme || description
      ? `请基于以下用户需求生成一个适合多人群聊讨论的 AI 角色档案。\n主题/分组：${theme || '未指定'}\n描述：${description || '未指定'}\n目标角色：${name}\n必须同时遵守主题和描述，描述里的数量、身份结构、时代、题材和关系约束优先；不要因为角色名或括号内身份而偏离用户需求。如果描述中包含候选角色设定摘要，必须把目标角色与其他角色的关系、秘密、冲突、亲近/敌意/信任/威胁差异写入 background 和 coreProfile，不要抹平成普通朋友或默认中立关系。输出字段必须完整，语气自然，专业领域用简洁短语。visualIdentity 先提供稳定外观锚点，再提供一个最能代表其身份、能力、欲望或气质的标志性动作/场景；不要写成普通站姿或泛日常背景。另请生成适合长期演化的 coreProfile 心理画像。`
      : `请基于名字“${name}”生成一个适合多人群聊讨论的 AI 角色档案。输出字段必须完整，语气自然，专业领域用简洁短语。visualIdentity 先提供稳定外观锚点，再提供一个最能代表其身份、能力、欲望或气质的标志性动作/场景；不要写成普通站姿或泛日常背景。另请生成适合长期演化的 coreProfile 心理画像。`;
  }
  return theme || description
    ? `Generate a complete AI character profile for a multi-person group chat app from this user request.\nTheme/group: ${theme || 'not specified'}\nDescription: ${description || 'not specified'}\nTarget character: ${name}\nFollow both the theme and description; counts, role composition, era, genre, and relationship constraints in the description take priority. Do not let the name or parenthesized role drift away from the user's requested context. If the description contains candidate role setup summaries, preserve the target character's relationships, secrets, conflicts, warmth/hostility, trust/distrust, respect, and threat dynamics with other characters in background and coreProfile. Do not flatten them into generic friendship or neutral defaults. Keep fields concise and usable. For visualIdentity, provide stable appearance anchors plus one iconic action or scene that embodies their identity, ability, desire, or temperament; never a generic standing pose or vague everyday background. Also generate a coreProfile psychological profile for long-term evolution.`
    : `Generate a complete AI character profile for the name "${name}" for a multi-person group chat app. Keep the fields concise and usable. For visualIdentity, provide stable appearance anchors plus one iconic action or scene that embodies their identity, ability, desire, or temperament; never a generic standing pose or vague everyday background. Also generate a coreProfile psychological profile for long-term evolution.`;
}

function sanitizeBatchNames(names: string[]) {
  return names.map((name) => name.trim()).filter(Boolean);
}

function extractJsonBlock(content: string) {
  const trimmed = content.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export function parseGeneratedJsonPayload<T>(content: string): T {
  const candidates = [content.trim(), extractJsonBlock(content)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as { choices?: Array<{ message?: { content?: unknown } }> };
        const nestedContent = envelope.choices?.[0]?.message?.content;
        if (typeof nestedContent === 'string' && nestedContent.trim()) {
          return JSON.parse(extractJsonBlock(nestedContent)) as T;
        }
      }
      return parsed as T;
    } catch {
      // Try the next candidate so wrapped and direct JSON responses are both supported.
    }
  }
  throw new Error(`模型返回的 JSON 无法解析：${content.slice(0, 500)}`);
}

function buildBatchGeneratePrompt(names: string[], language: 'zh' | 'en', context?: CharacterGenerationContext) {
  const normalizedNames = sanitizeBatchNames(names);
  const { theme, description } = normalizeGenerationContext(context);
  if (language === 'zh') {
    return theme || description
      ? `请基于以下用户需求为角色批量生成档案。\n主题/分组：${theme || '未指定'}\n描述：${description || '未指定'}\n角色名单：${normalizedNames.join('、')}\n每个角色都必须同时贴合主题和描述，描述里的数量、身份结构、时代、题材和关系约束优先；不要因为角色名或括号内身份而带偏整体设定。如果描述中包含候选角色设定摘要，必须把每个角色与其他角色的关系、秘密、冲突、亲近/敌意/信任/威胁差异写入 background 和 coreProfile，不要抹平成普通朋友或默认中立关系。每个 visualIdentity 都要先写稳定外观锚点，再写一个最能代表其身份、能力、欲望或气质的标志性动作/场景；不要普通站姿或泛日常背景。返回严格 JSON 数组，每项都包含 name、avatar、personality、behavior、expertise、speakingStyle、background、speechProfile、voiceProfile、coreProfile、bubbleStyle、visualIdentity。voiceProfile 只描述期望声音，不填写供应商音色 ID；性别不明确时必须用 unknown。personality 和 behavior 要按角色差异给出有区分度的 0-100 数值，不要全部填 50。每个名字都必须返回一项，name 必须与输入完全一致，只返回合法 JSON。字符串里的换行请写成 \n，不要输出原始换行。`
      : `请为以下名字批量生成角色档案：${normalizedNames.join('、')}。每个 visualIdentity 都要先写稳定外观锚点，再写一个最能代表其身份、能力、欲望或气质的标志性动作/场景；不要普通站姿或泛日常背景。返回严格 JSON 数组，每项都包含 name、avatar、personality、behavior、expertise、speakingStyle、background、speechProfile、voiceProfile、coreProfile、bubbleStyle、visualIdentity。voiceProfile 只描述期望声音，不填写供应商音色 ID；性别不明确时必须用 unknown。personality 和 behavior 要按角色差异给出有区分度的 0-100 数值，不要全部填 50。每个名字都必须返回一项，name 必须与输入完全一致，只返回合法 JSON。字符串里的换行请写成 \n，不要输出原始换行。`;
  }
  return theme || description
    ? `Generate character profiles from this user request.\nTheme/group: ${theme || 'not specified'}\nDescription: ${description || 'not specified'}\nCharacter list: ${normalizedNames.join(', ')}\nEvery character must fit both the theme and description; counts, role composition, era, genre, and relationship constraints in the description take priority. Do not let names or parenthesized roles drift the overall setting away from the user's request. If the description contains candidate role setup summaries, preserve each character's relationships, secrets, conflicts, warmth/hostility, trust/distrust, respect, and threat dynamics with other characters in background and coreProfile. Do not flatten them into generic friendship or neutral defaults. Every visualIdentity must contain stable appearance anchors plus one iconic action or scene that embodies the character's identity, ability, desire, or temperament; no generic standing poses or vague everyday backgrounds. Return a strict JSON array. Every item must include name, avatar, personality, behavior, expertise, speakingStyle, background, speechProfile, voiceProfile, coreProfile, bubbleStyle, and visualIdentity. voiceProfile describes the desired voice without a provider voice ID; use unknown when gender is not established. personality and behavior must use distinctive 0-100 values for each role; do not set every axis to 50. Every provided name must have one item, and each name must exactly match the input. Escape newlines inside strings as \n. Return only valid JSON.`
    : `Generate character profiles for these names: ${normalizedNames.join(', ')}. Every visualIdentity must contain stable appearance anchors plus one iconic action or scene that embodies the character's identity, ability, desire, or temperament; no generic standing poses or vague everyday backgrounds. Return a strict JSON array. Every item must include name, avatar, personality, behavior, expertise, speakingStyle, background, speechProfile, voiceProfile, coreProfile, bubbleStyle, and visualIdentity. voiceProfile describes the desired voice without a provider voice ID; use unknown when gender is not established. personality and behavior must use distinctive 0-100 values for each role; do not set every axis to 50. Every provided name must have one item, and each name must exactly match the input. Escape newlines inside strings as \n. Return only valid JSON.`;
}

export function parseGeneratedProfileMap(content: string, names: string[]) {
  const parsed = parseGeneratedJsonPayload<Array<GeneratedCharacterProfile & { name?: string }>>(content);
  const items = Array.isArray(parsed) ? parsed : [];
  const nameMap = new Map(items.map((item) => [typeof item.name === 'string' ? item.name.trim() : '', item]));
  return names.map((name) => {
    const normalizedName = name.trim();
    const profile = nameMap.get(normalizedName);
    if (!profile) {
      throw new Error(`Missing generated profile for ${normalizedName}`);
    }
    return { name: normalizedName, profile: normalizeGeneratedProfile(profile) };
  });
}

export async function generateCharacterProfilesIndividually(config: APIConfig, names: string[], language: 'zh' | 'en', context?: CharacterGenerationContext, usedVoiceIds: string[] = []) {
  const normalizedNames = sanitizeBatchNames(names);
  const results = await Promise.allSettled(normalizedNames.map(async (name) => ({
    name,
    profile: await generateCharacterProfileBase(config, name, language, context),
  })));
  const fulfilled = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const assignments = await assignGeneratedVoiceProfiles(fulfilled.map((item) => ({ key: item.name, profile: item.profile.voiceProfile })), usedVoiceIds);
  const assignmentMap = new Map(assignments.assignments.map((item) => [item.key, item.voiceConfig]));
  return results.map((result, index) => ({
    result: result.status === 'fulfilled'
      ? { status: 'fulfilled' as const, value: { ...result.value, profile: { ...result.value.profile, voiceConfig: { ...assignmentMap.get(result.value.name), voiceProfile: result.value.profile.voiceProfile } } } }
      : result,
    name: normalizedNames[index],
  }));
}

export async function generateCharacterProfilesSafe(config: APIConfig, names: string[], language: 'zh' | 'en', context?: CharacterGenerationContext, usedVoiceIds: string[] = []) {
  const normalizedNames = sanitizeBatchNames(names);
  if (!normalizedNames.length) return { success: [] as Array<{ name: string; profile: ReturnType<typeof normalizeGeneratedProfile> }>, failed: [] as Array<{ name: string; reason: string }> };
  try {
    const success = await generateCharacterProfiles(config, normalizedNames, language, context, usedVoiceIds);
    return { success, failed: [] as Array<{ name: string; reason: string }> };
  } catch (error) {
    console.warn('[character-generator:batch:fallback]', error);
    const results = await generateCharacterProfilesIndividually(config, normalizedNames, language, context, usedVoiceIds);
    const success: Array<{ name: string; profile: ReturnType<typeof normalizeGeneratedProfile> }> = [];
    const failed: Array<{ name: string; reason: string }> = [];
    results.forEach(({ result, name }) => {
      if (result.status === 'fulfilled') {
        success.push(result.value);
        return;
      }
      failed.push({
        name,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });
    return { success, failed };
  }
}

export async function generateCharacterProfiles(config: APIConfig, names: string[], language: 'zh' | 'en', context?: CharacterGenerationContext, usedVoiceIds: string[] = []) {
  const normalizedNames = sanitizeBatchNames(names);
  if (!normalizedNames.length) return [];
  const response = await generateResponse(
    config,
    `${CHARACTER_GENERATOR_SYSTEM_PROMPT}\nWhen generating multiple characters, return exactly one valid JSON array. Each item must include the requested name plus the same profile fields as a single-character result. Do not include trailing commas. Do not truncate. Do not add explanations before or after the JSON.`,
    [{ role: 'user', content: buildBatchGeneratePrompt(normalizedNames, language, context) }],
    undefined,
    { aiUsage: { type: 'character_generation', label: '批量生成角色', scope: 'character' } },
  );
  const profiles = parseGeneratedProfileMap(response, normalizedNames);
  const assignments = await assignGeneratedVoiceProfiles(profiles.map((item) => ({ key: item.name, profile: item.profile.voiceProfile })), usedVoiceIds);
  const assignmentMap = new Map(assignments.assignments.map((item) => [item.key, item.voiceConfig]));
  return profiles.map((item) => ({ ...item, profile: { ...item.profile, voiceConfig: { ...assignmentMap.get(item.name), voiceProfile: item.profile.voiceProfile } } }));
}

type RequiredCompletionField = 'personality' | 'profile';

class IncompleteCharacterProfileError extends Error {}

function validateCompletionProfile(raw: GeneratedCharacterProfile, field: RequiredCompletionField) {
  if (field === 'personality') {
    for (const [value, defaults] of [[raw.personality, DEFAULT_PERSONALITY], [raw.behavior, DEFAULT_CHARACTER_BEHAVIOR]] as const) {
      const entries = Object.entries(value || {});
      if (Object.keys(defaults).some((key) => !entries.some(([name, score]) => name === key && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100))
        || entries.every(([, score]) => score === 50) || entries.every(([, score]) => score === 0)) {
        throw new IncompleteCharacterProfileError('AI 未生成有效的人格参数或社交表达、讨论风格，不能用默认值冒充补全结果。');
      }
    }
  } else {
    const core = raw.coreProfile;
    if (['coreDesire', 'coreFear', 'socialMask', 'attachmentStyle', 'conflictStyle', 'selfImage'].some((key) => !normalizeShortText(core?.[key as keyof CharacterCoreProfile]))
      || !normalizeStringList(core?.values?.length ? core.values : core?.valuePriority, 6).length) {
      throw new IncompleteCharacterProfileError('AI 未生成完整的核心画像，不能保存空白画像。');
    }
  }
}

async function generateCharacterProfileBase(config: APIConfig, name: string, language: 'zh' | 'en', context?: CharacterGenerationContext, requiredField?: RequiredCompletionField) {
  const response = await generateResponse(
    config,
    `${CHARACTER_GENERATOR_SYSTEM_PROMPT}\nOutput exactly one valid JSON object. Do not include trailing commas. Do not truncate. Do not add explanations before or after the JSON.`,
    [{ role: 'user', content: `${buildGeneratePrompt(name.trim(), language, context)} ${language === 'zh' ? '只返回合法JSON。' : 'Return only valid JSON.'}` }],
    undefined,
    { maxTokens: 2400, aiUsage: { type: 'character_generation', label: '生成角色', scope: 'character' } },
  );
  const raw = parseGeneratedJsonPayload<GeneratedCharacterProfile>(response);
  if (requiredField) validateCompletionProfile(raw, requiredField);
  return normalizeGeneratedProfile(raw);
}

export async function generateCharacterProfile(config: APIConfig, name: string, language: 'zh' | 'en', context?: CharacterGenerationContext) {
  const profile = await generateCharacterProfileBase(config, name, language, context);
  const assignment = await assignGeneratedVoiceProfile(profile.voiceProfile, name.trim());
  return { ...profile, voiceConfig: { ...assignment.voiceConfig, voiceProfile: profile.voiceProfile } };
}

export async function generateCharacterProfileDraft(config: APIConfig, name: string, language: 'zh' | 'en', context?: CharacterGenerationContext, requiredField?: RequiredCompletionField) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await generateCharacterProfileBase(config, name, language, attempt === 0 ? context : {
        ...normalizeGenerationContext(context),
        description: `${normalizeGenerationContext(context).description}\n${language === 'zh'
          ? '上次输出缺少有效的人格或核心画像。personality 和 behavior 的所有参数都必须按角色特征提供有效且有区分度的数值，禁止全填 50 或 0；coreProfile 必须包含核心欲望、恐惧、社交面具、价值观、依恋倾向、冲突方式和自我认知。'
          : 'The previous personality or core profile was incomplete. Fill every personality and behavior axis with character-specific values, not all 50 or 0. Include core desire, fear, social mask, values, attachment style, conflict style and self image.'}`,
      }, requiredField);
    } catch (error) {
      if (!(error instanceof IncompleteCharacterProfileError) || attempt >= 1) throw error;
    }
  }
}

export async function generateCharacterBasicProfileDraft(config: APIConfig, name: string, language: 'zh' | 'en', context?: CharacterGenerationContext) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const normalizedContext = normalizeGenerationContext(context);
    const profile = await generateCharacterProfileBase(config, name, language, attempt === 0 ? context : {
      ...normalizedContext,
      description: `${normalizedContext.description}\n${language === 'zh'
        ? '上次基本信息不合格：说话风格与背景必须均有内容且不能相同。说话风格写语气、措辞、节奏和语言习惯，背景写身份、经历和人物关系；不能只重复职业标签。speechProfile 必须提供贴合角色的口头习惯或表达偏好，不能省略或全部使用默认值。'
        : 'The previous basic profile was invalid. Provide distinct, nonempty speakingStyle (tone, diction, rhythm, verbal habits) and background (identity, history, relationships), not repeated job labels. Include character-specific speechProfile habits or preferences instead of omitting them or using only defaults.'}`,
    });
    const hasSpeechProfile = Object.entries(DEFAULT_SPEECH_PROFILE).some(([key, fallback]) => {
      const value = profile.speechProfile[key as keyof CharacterSpeechProfile];
      return Array.isArray(value) ? value.length > 0 : value !== fallback;
    });
    if (profile.background && profile.speakingStyle && profile.background !== profile.speakingStyle && profile.expertise.length && hasSpeechProfile) return profile;
  }
  throw new Error(language === 'zh'
    ? 'AI 未生成有效的基本信息：背景、说话风格必须分别描述，专业领域和说话习惯不能为空。请重试。'
    : 'AI returned an invalid basic profile. Provide distinct background and speaking style, expertise, and character-specific speech habits. Please retry.');
}

export async function generateCharacterVisualIdentityDraft(config: APIConfig, input: CharacterVisualIdentityDraftInput, language: 'zh' | 'en') {
  const expertise = (input.expertise || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const prompt = language === 'zh'
    ? [
        `请为聊天角色“${input.name.trim() || '未命名角色'}”生成标志性视觉形象描述。`,
        input.group?.trim() ? `分组/主题：${input.group.trim()}` : '',
        input.background?.trim() ? `背景：${input.background.trim()}` : '',
        input.speakingStyle?.trim() ? `说话气质：${input.speakingStyle.trim()}` : '',
        expertise ? `兴趣/专长：${expertise}` : '',
        '返回严格 JSON：{"description":"1-3句：先写稳定外观锚点（年龄感、发型、气质、常见穿搭、标志性道具），再写一个最能体现人物身份、欲望、能力或气质的标志性动作/场景；拒绝普通站姿和泛日常背景","styleHint":"适合聊天图片、强调叙事动作和光影的风格提示","negativePrompt":"需要避免的内容","seed":null}',
        '不要输出 markdown，不要解释。',
      ].filter(Boolean).join('\n')
    : [
        `Generate an iconic visual identity draft for the chat character "${input.name.trim() || 'Unnamed character'}".`,
        input.group?.trim() ? `Group/theme: ${input.group.trim()}` : '',
        input.background?.trim() ? `Background: ${input.background.trim()}` : '',
        input.speakingStyle?.trim() ? `Speaking vibe: ${input.speakingStyle.trim()}` : '',
        expertise ? `Interests/expertise: ${expertise}` : '',
        'Return strict JSON: {"description":"1-3 sentences: stable appearance anchors such as age impression, hair, vibe, familiar outfit, and signature props, followed by one iconic action or scene that embodies the role; reject generic standing poses and vague everyday backgrounds","styleHint":"style guidance for chat images with narrative action and expressive lighting","negativePrompt":"things to avoid","seed":null}',
        'Do not output markdown or explanations.',
      ].filter(Boolean).join('\n');
  const response = await generateResponse(
    config,
    `${CHARACTER_GENERATOR_SYSTEM_PROMPT}\nOutput exactly one valid JSON object containing only visualIdentity draft fields.`,
    [{ role: 'user', content: prompt }],
    undefined,
    { maxTokens: 700, aiUsage: { type: 'character_visual_identity', label: '生成角色视觉锚点', scope: 'character' } },
  );
  const parsed = parseGeneratedJsonPayload<GeneratedCharacterProfile['visualIdentity']>(response);
  return {
    description: typeof parsed?.description === 'string' ? parsed.description.trim() : '',
    styleHint: typeof parsed?.styleHint === 'string' ? parsed.styleHint.trim() : '',
    negativePrompt: typeof parsed?.negativePrompt === 'string' ? parsed.negativePrompt.trim() : '',
    seed: parsed?.seed ?? null,
  };
}

export async function generateCharacterVoiceProfileDraft(config: APIConfig, input: CharacterVoiceProfileDraftInput, language: 'zh' | 'en') {
  const expertise = (input.expertise || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const values = (input.coreProfile?.values || input.coreProfile?.valuePriority || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const habits = (input.coreProfile?.interactionHabits || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const catchphrases = (input.speechProfile?.catchphrases || []).filter(Boolean).join(language === 'zh' ? '、' : ', ');
  const prompt = language === 'zh'
    ? [
        `请为聊天角色“${input.name.trim() || '未命名角色'}”生成语音形象。`,
        input.group?.trim() ? `分组/主题：${input.group.trim()}` : '',
        input.background?.trim() ? `背景：${input.background.trim()}` : '',
        input.speakingStyle?.trim() ? `说话气质：${input.speakingStyle.trim()}` : '',
        expertise ? `兴趣/专长：${expertise}` : '',
        values ? `价值倾向：${values}` : '',
        habits ? `互动习惯：${habits}` : '',
        catchphrases ? `口头禅：${catchphrases}` : '',
        '返回严格 JSON：{"gender":"female|male|neutral|unknown","age":"child|young|adult|senior|unknown","language":"如 zh-CN","traits":["2-6个音色/气质关键词"],"styles":["0-4个表达风格关键词"],"emotions":["0-4个默认情绪"],"energy":"low|medium|high"}。',
        '性别是严格约束：只有角色设定明确时才填 female 或 male；不明确必须填 unknown，不能从职业、气质或刻板印象猜测。不要写供应商音色 ID，不要输出 markdown 或解释。',
      ].filter(Boolean).join('\n')
    : [
        `Generate a voice identity for the chat character "${input.name.trim() || 'Unnamed character'}".`,
        input.group?.trim() ? `Group/theme: ${input.group.trim()}` : '',
        input.background?.trim() ? `Background: ${input.background.trim()}` : '',
        input.speakingStyle?.trim() ? `Speaking vibe: ${input.speakingStyle.trim()}` : '',
        expertise ? `Interests/expertise: ${expertise}` : '',
        values ? `Values: ${values}` : '',
        habits ? `Interaction habits: ${habits}` : '',
        catchphrases ? `Catchphrases: ${catchphrases}` : '',
        'Return strict JSON: {"gender":"female|male|neutral|unknown","age":"child|young|adult|senior|unknown","language":"such as en-US","traits":["2-6 timbre or temperament keywords"],"styles":["0-4 delivery style keywords"],"emotions":["0-4 default emotions"],"energy":"low|medium|high"}.',
        'Gender is a strict constraint: use female or male only if explicitly established by character context; otherwise use unknown. Never infer it from profession, vibe, or stereotypes. Do not return a provider voice ID, markdown, or explanations.',
      ].filter(Boolean).join('\n');
  const response = await generateResponse(
    config,
    `${CHARACTER_GENERATOR_SYSTEM_PROMPT}\nOutput exactly one valid JSON object containing only voiceProfile fields.`,
    [{ role: 'user', content: prompt }],
    undefined,
    { maxTokens: 500, aiUsage: { type: 'character_generation', label: '生成角色语音形象', scope: 'character' } },
  );
  const parsed = parseGeneratedJsonPayload<GeneratedCharacterProfile['voiceProfile']>(response);
  return normalizeGeneratedProfile({ voiceProfile: parsed }).voiceProfile;
}
