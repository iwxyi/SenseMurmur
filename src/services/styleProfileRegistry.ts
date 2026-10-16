import type { ChatStyle } from '../types/chat';
import type { SessionGenerationPromptContext } from '../types/sessionEngine';

export type ChatStyleProfile = 'assistant_room' | 'casual_room' | 'discovery_room' | 'analytical_room' | 'companion_room' | 'dramatic_room' | 'task_room';

export type RichDeliveryProactivity = 'off' | 'low' | 'medium' | 'high';
export type MessageOrganizationStyle = 'conversational' | 'balanced' | 'structured';

export interface RichDeliveryPolicy {
  multiBubble: {
    proactivity: RichDeliveryProactivity;
    maxBubbles: number;
    organization?: MessageOrganizationStyle;
  };
  image: { proactivity: RichDeliveryProactivity; explicitRequest: boolean };
  audio: { proactivity: RichDeliveryProactivity; explicitRequest: boolean };
  sticker: { proactivity: RichDeliveryProactivity; explicitRequest: boolean };
}

export interface StyleProfileDefinition {
  key: ChatStyleProfile;
  label: string;
  promptContext: SessionGenerationPromptContext;
  richDelivery: RichDeliveryPolicy;
}

const requestedOnlyDelivery = { proactivity: 'off', explicitRequest: true } as const;

const styleProfiles = new Map<ChatStyleProfile, StyleProfileDefinition>([
  ['assistant_room', {
    key: 'assistant_room',
    label: 'Assistant room',
    promptContext: {
      styleProfile: 'assistant_room',
      additionalConstraints: ['Answer objectively and directly. Do not roleplay or add character-specific voice.'],
      responseStyle: 'professional',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'off', maxBubbles: 1, organization: 'structured' }, image: requestedOnlyDelivery, audio: requestedOnlyDelivery, sticker: requestedOnlyDelivery },
  }],
  ['casual_room', {
    key: 'casual_room',
    label: 'Casual room',
    promptContext: {
      styleProfile: 'casual_room',
      additionalConstraints: ['Keep ordinary chat low-pressure and conversational. The character and exchange determine the tone; no agreement, reassurance or invitation to continue is required.'],
      responseStyle: 'chat',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'low', maxBubbles: 5, organization: 'conversational' }, image: { proactivity: 'medium', explicitRequest: true }, audio: { proactivity: 'medium', explicitRequest: true }, sticker: { proactivity: 'high', explicitRequest: true } },
  }],
  ['discovery_room', {
    key: 'discovery_room',
    label: 'Discovery room',
    promptContext: {
      styleProfile: 'discovery_room',
      additionalConstraints: ['Prefer adding materially new examples, angles, or practical discoveries over simply endorsing the latest example.'],
      responseStyle: 'chat',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'medium', maxBubbles: 3, organization: 'balanced' }, image: { proactivity: 'high', explicitRequest: true }, audio: { proactivity: 'low', explicitRequest: true }, sticker: { proactivity: 'low', explicitRequest: true } },
  }],
  ['analytical_room', {
    key: 'analytical_room',
    label: 'Analytical room',
    promptContext: {
      styleProfile: 'analytical_room',
      additionalConstraints: ['Prefer clarifying distinctions, tradeoffs, counterpoints, or synthesis over casual agreement.'],
      responseStyle: 'professional',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'medium', maxBubbles: 3, organization: 'structured' }, image: { proactivity: 'medium', explicitRequest: true }, audio: requestedOnlyDelivery, sticker: requestedOnlyDelivery },
  }],
  ['companion_room', {
    key: 'companion_room',
    label: 'Companion room',
    promptContext: {
      styleProfile: 'companion_room',
      additionalConstraints: ['Private companionship grows from this relationship: care can be playful, awkward, quiet, direct, or resisted. Low-pressure is about tone and consent, not a short-answer rule; honor the substance and format when the user requests a deliverable.'],
      responseStyle: 'chat',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'low', maxBubbles: 5, organization: 'conversational' }, image: { proactivity: 'medium', explicitRequest: true }, audio: { proactivity: 'high', explicitRequest: true }, sticker: { proactivity: 'medium', explicitRequest: true } },
  }],
  ['dramatic_room', {
    key: 'dramatic_room',
    label: 'Dramatic room',
    promptContext: {
      styleProfile: 'dramatic_room',
      additionalConstraints: ['Let established motives and relationships shape expression in the current scene. Tension or friction may matter when supported by the exchange; do not require progress or resolution in each turn.'],
      responseStyle: 'creative',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'medium', maxBubbles: 4, organization: 'balanced' }, image: { proactivity: 'medium', explicitRequest: true }, audio: { proactivity: 'medium', explicitRequest: true }, sticker: requestedOnlyDelivery },
  }],
  ['task_room', {
    key: 'task_room',
    label: 'Task room',
    promptContext: {
      styleProfile: 'task_room',
      additionalConstraints: ['Answer the actual task directly and completely before adding side banter.'],
      responseStyle: 'professional',
      allowMarkdown: true,
    },
    richDelivery: { multiBubble: { proactivity: 'low', maxBubbles: 3, organization: 'structured' }, image: requestedOnlyDelivery, audio: requestedOnlyDelivery, sticker: requestedOnlyDelivery },
  }],
]);

const scenarioDefaults = new Map<string, ChatStyleProfile>([
  ['general-assistant', 'assistant_room'],
  ['open-chat', 'casual_room'],
  ['direct-chat', 'companion_room'],
  ['ai-private-thread', 'companion_room'],
  ['opinion-review', 'analytical_room'],
  ['roundtable-review', 'analytical_room'],
  ['role-debate', 'analytical_room'],
  ['courtroom-deliberation', 'analytical_room'],
  ['expert-review', 'analytical_room'],
  ['public-inquiry', 'analytical_room'],
  ['brainstorm-workshop', 'analytical_room'],
  ['task-retrospective', 'analytical_room'],
  ['panel-interview', 'task_room'],
  ['ielts-coach', 'task_room'],
  ['learning-progress', 'task_room'],
  ['story-reader', 'dramatic_room'],
  ['werewolf-classic', 'dramatic_room'],
  ['murder-mystery', 'dramatic_room'],
]);

const familyDefaults = new Map<string, ChatStyleProfile>([
  ['assistant', 'assistant_room'],
  ['conversation', 'casual_room'],
  ['analysis', 'analytical_room'],
  ['interview', 'task_room'],
  ['study', 'task_room'],
  ['deduction', 'dramatic_room'],
  ['mystery', 'dramatic_room'],
  ['simulation', 'dramatic_room'],
]);

const chatStyleProfiles = new Map<ChatStyle, ChatStyleProfile>([
  ['free', 'casual_room'],
  ['debate', 'analytical_room'],
  ['brainstorm', 'discovery_room'],
  ['roleplay', 'dramatic_room'],
]);

export function getStyleProfile(key: ChatStyleProfile | null | undefined) {
  return key ? styleProfiles.get(key) || null : null;
}

export function resolveRichDeliveryPolicy(key: string | null | undefined) {
  return getStyleProfile(key as ChatStyleProfile)?.richDelivery || getStyleProfile('casual_room')!.richDelivery;
}

export function resolveDefaultStyleProfile(input: { scenarioId?: string; family?: string }) {
  const familyDefault = input.family ? familyDefaults.get(input.family) : undefined;
  const scenarioDefault = input.scenarioId ? scenarioDefaults.get(input.scenarioId) : undefined;
  return (scenarioDefault && (!familyDefault || scenarioDefault === familyDefault || input.family === 'conversation'))
    ? scenarioDefault
    : familyDefault
      || scenarioDefault
      || 'casual_room';
}

export function resolveChatStyleProfile(style: ChatStyle | null | undefined) {
  return style ? chatStyleProfiles.get(style) || null : null;
}
