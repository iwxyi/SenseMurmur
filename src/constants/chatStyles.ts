import type { ChatStyle } from '../types/chat';

export interface ChatStyleDefinition {
  value: ChatStyle;
  icon: string;
  label: {
    zh: string;
    en: string;
  };
  description: {
    zh: string;
    en: string;
  };
  promptDescription: string;
}

export const CHAT_STYLE_DEFINITIONS: ChatStyleDefinition[] = [
  {
    value: 'free',
    icon: 'C',
    label: {
      zh: '轻松',
      en: 'Casual',
    },
    description: {
      zh: '自然接话，适合日常陪伴、轻话题和低压力交流。',
      en: 'Natural back-and-forth for everyday company and low-pressure topics.',
    },
    promptDescription:
      'Casual room: use everyday phrasing and let the actual exchange, character and relationship determine the tone. Low pressure does not require warmth, agreement or reassurance. Replies can have uneven length and partial attention; a small reaction can stand on its own. Do not turn ordinary chat into polished speeches, scene narration, or a chain of complete conclusions unless the user asks for that.',
  },
  {
    value: 'debate',
    icon: 'D',
    label: {
      zh: '讨论',
      en: 'Discussion',
    },
    description: {
      zh: '围绕问题推进观点、证据、反驳和取舍，不做空泛争吵。',
      en: 'Develop positions, evidence, counterpoints, and tradeoffs without empty arguing.',
    },
    promptDescription:
      'Deep discussion room: examine the topic through clear claims, reasons, evidence, counterpoints, and tradeoffs. Challenge weak assumptions respectfully, while keeping the exchange conversational: react to people, show hesitation or conviction when earned, and do not make every turn a formal mini-essay. Move the discussion toward sharper understanding rather than performative conflict.',
  },
  {
    value: 'brainstorm',
    icon: 'I',
    label: {
      zh: '共创',
      en: 'Co-create',
    },
    description: {
      zh: '快速发散、接力补强，再把可执行方向收拢出来。',
      en: 'Explore alternatives, build on them, then converge on usable directions.',
    },
    promptDescription:
      'Co-creation room: generate varied possibilities, build on other participants ideas, make unexpected but relevant connections, and periodically separate raw ideas from actionable next steps. Keep the room lively and human through quick reactions, unfinished ideas, playful turns, doubt, and revision. Do not prematurely dismiss unusual ideas or force every turn into a finished proposal.',
  },
  {
    value: 'roleplay',
    icon: 'R',
    label: {
      zh: '演绎',
      en: 'Roleplay',
    },
    description: {
      zh: '保持角色动机、关系和场景连续性，像真实场面一样推进。',
      en: 'Stay in character and advance the scene through motives, relationships, and consequences.',
    },
    promptDescription:
      'Immersive roleplay room: stay inside the character voice, motives, relationships and established situation. Let the current exchange determine whether anything changes; each turn need not advance the plot, settle a plan or resolve tension. Let characters speak as people inside the scene; do not automatically expand every reply into narrated prose or a polished dramatic monologue. Action visibility follows the room display contract.',
  },
];

export const CHAT_STYLE_PROMPT_DESCRIPTIONS: Record<ChatStyle, string> = CHAT_STYLE_DEFINITIONS.reduce(
  (acc, definition) => {
    acc[definition.value] = definition.promptDescription;
    return acc;
  },
  {} as Record<ChatStyle, string>,
);

export function getChatStyleOption(style: ChatStyle) {
  return CHAT_STYLE_DEFINITIONS.find((definition) => definition.value === style) || CHAT_STYLE_DEFINITIONS[0];
}
