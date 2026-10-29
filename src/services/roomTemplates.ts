import type { ChatStyle, DiscussionMode, GroupChat, RuntimeEvolutionIntensity, SessionKind } from '../types/chat';
import { createDefaultSessionKind } from '../types/chat';
import roomPresetCatalog from '../data/roomPresetCatalog.json';

export type RoomTemplateStructure = 'free_interaction' | 'story' | 'deliberation' | 'creation' | 'training' | 'task' | 'game' | 'simulation';
export type RoomTemplateCategory =
  | 'free_chat'
  | 'story'
  | 'opinion_review'
  | 'creation'
  | 'training'
  | 'task'
  | 'game'
  | 'simulation';

export type RoomTemplateKey =
  | 'open_chat'
  | 'free_chat_preset'
  | 'companion_hangout'
  | 'fandom_watch_party'
  | 'tea_roast_lounge'
  | 'slice_of_life_room'
  | 'opinion_review'
  | 'roundtable_review'
  | 'role_debate'
  | 'courtroom_deliberation'
  | 'expert_review'
  | 'public_inquiry'
  | 'brainstorm_workshop'
  | 'retrospective_room'
  | 'story_reader'
  | 'default_mystery_story'
  | 'campus_story'
  | 'romance_story'
  | 'palace_intrigue_story'
  | 'detective_case_story'
  | 'urban_secret_story'
  | 'entertainment_circle_story'
  | 'xianxia_trial_story'
  | 'apocalypse_road_story'
  | 'learning_progress'
  | 'ielts_practice'
  | 'programming_learning'
  | 'exam_preparation'
  | 'interview_prep'
  | 'writing_coach'
  | 'single_agent_workflow'
  | 'research_agent_room'
  | 'multi_agent_workflow'
  | 'startup_war_room'
  | 'content_studio'
  | 'board_game'
  | 'chess_study_board'
  | 'werewolf'
  | 'social_deduction_party'
  | 'murder_mystery'
  | 'courtroom_case'
  | 'social_simulation';

export interface RoomTemplateFieldDefinition {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'single_select';
  required?: boolean;
  advanced?: boolean;
  placeholder?: string;
  helperText?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface RoomTemplateDefaults {
  discussionMode?: DiscussionMode;
  storyBranchMode?: 'guided' | 'open';
  studyGoalLabel?: string;
  agentGoalLabel?: string;
  boardColumns?: number;
  boardRows?: number;
  deductionFactionCount?: number;
  mysteryClueCount?: number;
  initialPhase?: string;
  progressLabel?: string;
  progressTarget?: number;
  goalLabel?: string;
  allowPrivateThreads?: boolean;
  allowCliques?: boolean;
  allowMockery?: boolean;
  storyBackground?: string;
  storyDirection?: string;
  storyOutline?: string;
  werewolfRoleConfig?: string;
  werewolfPostGameMode?: string;
  mysteryScript?: string;
  mysteryRoleMappingMode?: string;
}

export interface RoomTemplateConfigGroup {
  key: string;
  label: string;
  description?: string;
  fields: RoomTemplateFieldDefinition[];
}

export interface RoomTemplateDefinition {
  key: RoomTemplateKey;
  label: string;
  description: string;
  parentTemplateKey?: RoomTemplateKey;
  presetLabel?: string;
  presetDescription?: string;
  sellingPoints?: string[];
  structure: RoomTemplateStructure;
  category: RoomTemplateCategory;
  categoryLabel: string;
  sessionKind: SessionKind;
  style: ChatStyle;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
  /** Maximum number of AI members selectable for this room template. */
  maxMembers?: number;
  topicPlaceholder: string;
  defaults?: RoomTemplateDefaults;
  configGroups?: RoomTemplateConfigGroup[];
}

export interface RoomTemplatePreview {
  hook: string;
  direction: string;
  readerPromise: string;
  firstChapterGoal: string;
  trackedAssets: string[];
}

const ROOM_TEMPLATE_STRUCTURE_LABELS: Record<RoomTemplateStructure, string> = {
  free_interaction: '自由互动',
  story: '故事叙事',
  deliberation: '观点审议',
  creation: '创作共创',
  training: '训练模拟',
  task: '任务执行',
  game: '游戏推理',
  simulation: '世界模拟',
};

function createTemplateSessionKind(type: GroupChat['type'], mode: GroupChat['mode'], patch: Partial<SessionKind>): SessionKind {
  return {
    ...createDefaultSessionKind(type, mode),
    ...patch,
  };
}

function createTemplate(definition: RoomTemplateDefinition): RoomTemplateDefinition {
  return definition;
}

type RoomTemplatePresetRecord = Omit<RoomTemplateDefinition, 'structure' | 'category' | 'categoryLabel' | 'sessionKind' | 'configGroups'> & {
  parentTemplateKey: RoomTemplateKey;
};

function createPresetTemplates(kernels: RoomTemplateDefinition[]) {
  return (roomPresetCatalog as RoomTemplatePresetRecord[]).map((preset) => {
    const parent = kernels.find((item) => item.key === preset.parentTemplateKey);
    if (!parent) throw new Error(`Room preset ${preset.key} references missing parent ${preset.parentTemplateKey}`);
    return createTemplate({
      ...preset,
      structure: parent.structure,
      category: parent.category,
      categoryLabel: parent.categoryLabel,
      sessionKind: parent.sessionKind,
      style: preset.style || parent.style,
      runtimeEvolutionIntensity: preset.runtimeEvolutionIntensity || parent.runtimeEvolutionIntensity,
      maxMembers: preset.maxMembers ?? parent.maxMembers,
      topicPlaceholder: preset.topicPlaceholder || parent.topicPlaceholder,
      defaults: { ...(parent.defaults || {}), ...(preset.defaults || {}) },
      configGroups: parent.configGroups,
    });
  });
}

const ROOM_TEMPLATE_KERNELS: RoomTemplateDefinition[] = [
  createTemplate({
    key: 'open_chat',
    label: '自由群聊',
    description: '开放聊天、陪伴闲聊、伴看吐槽等通用多角色互动。',
    presetLabel: '自定义',
    presetDescription: '不套用固定氛围，按你填写的话题和角色自然互动。',
    structure: 'free_interaction',
    category: 'free_chat',
    categoryLabel: '自由互动',
    sessionKind: createTemplateSessionKind('group', 'open_chat', { family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text', topology: 'group' }),
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入一个话题，让角色开始自由互动',
    defaults: { allowPrivateThreads: true, allowCliques: true, allowMockery: true },
    configGroups: [
      {
        key: 'social-advanced',
        label: '互动规则',
        fields: [
          { key: 'allowPrivateThreads', label: '允许角色私聊', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowCliques', label: '允许小圈子', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowMockery', label: '允许冲突和嘲讽', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'story_reader',
    label: '故事房',
    description: '用选项和角色反应推动故事分支。',
    presetLabel: '自定义',
    presetDescription: '从空白故事设定开始，自行填写背景、方向和提纲。',
    structure: 'story',
    category: 'story',
    categoryLabel: '故事叙事',
    sessionKind: createTemplateSessionKind('group', 'scripted_play', { family: 'conversation', scenarioId: 'story-reader', surfaceProfile: 'hybrid', topology: 'group' }),
    style: 'roleplay',
    runtimeEvolutionIntensity: 'slow',
    topicPlaceholder: '例如：雨夜旧医院、失踪名单、枕下长剑',
    defaults: {
      storyBranchMode: 'guided',
      initialPhase: 'scene',
      goalLabel: '主线剧情',
      allowPrivateThreads: false,
      allowCliques: false,
      allowMockery: false,
    },
    configGroups: [
      {
        key: 'story-required',
        label: '故事主设定',
        fields: [
          { key: 'storyBackground', label: '背景设定', kind: 'textarea', required: true, placeholder: '世界背景、时间地点、主要关系' },
          { key: 'storyDirection', label: '发展方向', kind: 'textarea', required: true, placeholder: '希望更偏恋爱、悬疑、成长、修罗场还是冒险' },
        ],
      },
      {
        key: 'story-optional',
        label: '补充设定',
        fields: [
          { key: 'storyOutline', label: '剧情提纲', kind: 'textarea', placeholder: '可选：写下你已有的大纲、伏笔或关键转折' },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'opinion_review',
    label: '观点审议',
    description: '围绕一个议题建立立场、质询、反驳和阶段判断，适合看清观点、责任或方案漏洞。',
    presetLabel: '自定义',
    presetDescription: '不限定审议形态，只保留议题、立场、质询和阶段总结能力。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'group_discussion', { family: 'analysis', scenarioId: 'opinion-review', surfaceProfile: 'text', topology: 'group' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入审议议题，例如：是否应该重构推荐系统？',
    sellingPoints: ['立场可见', '质询反驳', '保留分歧'],
    defaults: { discussionMode: 'open', initialPhase: 'deliberation', goalLabel: '观点审议', progressLabel: '审议发言', allowPrivateThreads: true, allowCliques: true, allowMockery: false },
    configGroups: [
      {
        key: 'deliberation-advanced',
        label: '审议规则',
        description: '这些开关会写入底层能力：角色私聊控制角色能否私下交换信息；小圈子和尖锐表达会影响立场、质询和关系冲突。',
        fields: [
          { key: 'allowPrivateThreads', label: '允许角色私聊', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowCliques', label: '允许结盟与小圈子', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowMockery', label: '允许尖锐或嘲讽', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'roundtable_review',
    label: '圆桌审议',
    description: '强调多立场陈述、追问和保留分歧，适合让不同角色公开表达判断。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'roundtable', { family: 'analysis', scenarioId: 'roundtable-review', surfaceProfile: 'text', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入圆桌议题，例如：这次产品方向是否应该调整？',
    sellingPoints: ['席位立场', '追问分歧', '阶段小结'],
    defaults: { discussionMode: 'roundtable', initialPhase: 'roundtable', progressLabel: '圆桌发言', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'roundtable-advanced',
        label: '圆桌审议规则',
        description: '圆桌默认更克制；需要角色私下交换观点时可以打开角色私聊。',
        fields: [
          { key: 'allowPrivateThreads', label: '允许角色私聊', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'role_debate',
    label: '角色辩论',
    description: '围绕争议命题分配正反和评审席位，交替反驳并检验观点强弱。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'roundtable', { family: 'analysis', scenarioId: 'role-debate', surfaceProfile: 'text', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入正反命题，例如：AI 应该拥有法律人格吗？',
    sellingPoints: ['正反攻防', '评审席位', '立场变化'],
    defaults: { discussionMode: 'debate', initialPhase: 'debate', goalLabel: '角色辩论', progressLabel: '攻防进度', allowPrivateThreads: false, allowCliques: true, allowMockery: true },
    configGroups: [
      {
        key: 'debate-advanced',
        label: '角色辩论规则',
        description: '结盟会让角色更容易形成阵营；尖锐交锋会提高反驳、质疑和冲突表达强度。',
        fields: [
          { key: 'allowCliques', label: '允许结盟', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowMockery', label: '允许尖锐交锋', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'courtroom_deliberation',
    label: '法庭攻防',
    description: '以原告、被告、证人和法官席位审查证据、责任和裁决倾向。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'roundtable', { family: 'analysis', scenarioId: 'courtroom-deliberation', surfaceProfile: 'text', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入案件或争议，例如：谁该为项目延期负责？',
    sellingPoints: ['证据质询', '责任判断', '阶段裁决'],
    defaults: { discussionMode: 'courtroom', initialPhase: 'courtroom', goalLabel: '法庭攻防', progressLabel: '质询进度', allowPrivateThreads: false, allowCliques: true, allowMockery: false },
    configGroups: [
      {
        key: 'courtroom-deliberation-advanced',
        label: '法庭攻防规则',
        description: '法庭攻防默认更重证据和责任判断，允许偏袒时角色关系会影响采信和质询强度。',
        fields: [
          { key: 'allowCliques', label: '允许偏袒和站队', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowMockery', label: '允许尖锐追问', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'expert_review',
    label: '专家评审',
    description: '让不同专业角色按标准评估方案、指出风险并给出修改建议。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'group_discussion', { family: 'analysis', scenarioId: 'expert-review', surfaceProfile: 'text', topology: 'group' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入要评审的方案，例如：新版创作工坊 MVP 设计',
    sellingPoints: ['多标准评估', '风险指出', '修改建议'],
    defaults: { discussionMode: 'expert_review', initialPhase: 'expert_review', goalLabel: '专家评审', progressLabel: '评审进度', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
  }),
  createTemplate({
    key: 'public_inquiry',
    label: '公开质询',
    description: '指定一个角色、方案或事件接受多方追问，集中回应漏洞和责任。',
    structure: 'deliberation',
    category: 'opinion_review',
    categoryLabel: '观点审议',
    sessionKind: createTemplateSessionKind('group', 'group_discussion', { family: 'analysis', scenarioId: 'public-inquiry', surfaceProfile: 'text', topology: 'group' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入质询对象和焦点，例如：让项目负责人解释延期原因',
    sellingPoints: ['集中追问', '回应漏洞', '责任澄清'],
    defaults: { discussionMode: 'public_inquiry', initialPhase: 'public_inquiry', goalLabel: '公开质询', progressLabel: '质询进度', allowPrivateThreads: false, allowCliques: true, allowMockery: true },
  }),
  createTemplate({
    key: 'brainstorm_workshop',
    label: '产品脑暴',
    description: '作为创作工坊能力使用：围绕产物生成候选、扩展变体并沉淀后续筛选方向。',
    structure: 'creation',
    category: 'creation',
    categoryLabel: '创作共创',
    sessionKind: createTemplateSessionKind('group', 'group_discussion', { family: 'analysis', scenarioId: 'brainstorm-workshop', surfaceProfile: 'text', topology: 'group' }),
    style: 'brainstorm',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入创意主题，例如：设计一个未来校园产品',
    sellingPoints: ['自由接力', '多点子发散', '适合共创筛选'],
    defaults: { discussionMode: 'brainstorm', initialPhase: 'brainstorm', goalLabel: '创意生成', progressLabel: '点子进展', allowPrivateThreads: true, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'brainstorm-advanced',
        label: '共创规则',
        description: '私下小组允许角色派生小范围思路碰撞；默认关闭评价冲突，优先发散。',
        fields: [
          { key: 'allowPrivateThreads', label: '允许私下小组', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'retrospective_room',
    label: '任务复盘',
    description: '作为训练与任务能力使用：回顾已发生事件，沉淀事实、原因、经验和行动项。',
    structure: 'training',
    category: 'training',
    categoryLabel: '训练模拟',
    sessionKind: createTemplateSessionKind('group', 'group_discussion', { family: 'analysis', scenarioId: 'task-retrospective', surfaceProfile: 'text', topology: 'group' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'slow',
    topicPlaceholder: '输入要复盘的项目、活动或结果',
    sellingPoints: ['开放复盘', '事实/原因/行动项', '适合改进沉淀'],
    defaults: { discussionMode: 'retrospective', initialPhase: 'retrospective', goalLabel: '复盘改进', progressLabel: '复盘进展', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
  }),
  createTemplate({
    key: 'learning_progress',
    label: '学习进步',
    description: '设定任意学习目标，整理知识点、生成资料与练习，并根据学习记录持续调整下一步。',
    structure: 'training',
    category: 'training',
    categoryLabel: '学习进步',
    sessionKind: createTemplateSessionKind('group', 'classroom', { family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid', topology: 'group' }),
    style: 'free',
    runtimeEvolutionIntensity: 'slow',
    maxMembers: 1,
    topicPlaceholder: '输入总目标，例如：掌握数据库索引、读懂一本经济学入门书',
    sellingPoints: ['目标拆解', '知识点与学习记录', '资料、试卷和 HTML 练习'],
    defaults: { studyGoalLabel: '', initialPhase: 'mapping', progressLabel: '学习进展', progressTarget: 0, allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'learning-progress-required',
        label: '学习主设定',
        fields: [
          { key: 'studyGoalLabel', label: '总学习目标', kind: 'textarea', required: true, placeholder: '例如：三个月内能独立完成一个 React 项目' },
          { key: 'teachingMode', label: '教学模式', kind: 'single_select', options: [{ label: '娱乐陪练', value: 'entertainment' }, { label: '轻松学习', value: 'casual' }, { label: '严肃训练', value: 'serious' }] },
          { key: 'teacherExpertise', label: '教师专长（可选）', kind: 'textarea', placeholder: '例如：数据库索引、查询优化；不填写则由角色自行发挥' },
          { key: 'assessmentPolicy', label: '评估口径', kind: 'single_select', options: [{ label: '仅记录可观察证据', value: 'evidence_only' }, { label: '允许引导式估计', value: 'guided_estimate' }, { label: '严格核验后标记', value: 'strict' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'interview_prep',
    label: '面试训练',
    description: '适合模拟面试、追问和反馈。',
    structure: 'training',
    category: 'training',
    categoryLabel: '训练模拟',
    sessionKind: createTemplateSessionKind('group', 'interview', { family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid', topology: 'group' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入岗位、方向或训练目标',
    defaults: { studyGoalLabel: '完成一轮结构化面试训练', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'interview-required',
        label: '训练主设定',
        fields: [
          { key: 'studyGoalLabel', label: '训练目标', kind: 'text', required: true, placeholder: '例如：前端工程师一面模拟' },
        ],
      },
      {
        key: 'interview-advanced',
        label: '训练风格',
        fields: [
          { key: 'allowMockery', label: '允许尖锐追问', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'writing_coach',
    label: '写作辅导',
    description: '适合论文、文案、作文和长期写作改进。',
    structure: 'training',
    category: 'training',
    categoryLabel: '训练模拟',
    sessionKind: createTemplateSessionKind('group', 'classroom', { family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid', topology: 'group' }),
    style: 'free',
    runtimeEvolutionIntensity: 'slow',
    topicPlaceholder: '输入写作目标，例如：完成一篇申请文书',
    defaults: { studyGoalLabel: '完成一篇高质量写作任务', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'writing-required',
        label: '写作主设定',
        fields: [
          { key: 'studyGoalLabel', label: '写作目标', kind: 'text', required: true, placeholder: '例如：申请文书、小说开篇、产品长文' },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'single_agent_workflow',
    label: '单Agent房',
    description: '适合任务拆解、执行和持续推进。',
    structure: 'task',
    category: 'task',
    categoryLabel: '任务执行',
    sessionKind: createTemplateSessionKind('group', 'agent_workflow', { family: 'agent', scenarioId: 'single-agent-workflow', surfaceProfile: 'dashboard', topology: 'team' }),
    style: 'free',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入任务目标，例如：写一份产品分析报告',
    defaults: { agentGoalLabel: '完成任务并输出结果', initialPhase: 'planning', progressLabel: '任务进度', progressTarget: 100, allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'agent-required',
        label: '任务主设定',
        fields: [
          { key: 'agentGoalLabel', label: '任务目标', kind: 'textarea', required: true, placeholder: '希望这个房间最终完成什么' },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'research_agent_room',
    label: '研究助手房',
    description: '适合调研、资料整理和持续产出。',
    structure: 'task',
    category: 'task',
    categoryLabel: '任务执行',
    sessionKind: createTemplateSessionKind('group', 'agent_workflow', { family: 'agent', scenarioId: 'single-agent-workflow', surfaceProfile: 'dashboard', topology: 'team' }),
    style: 'free',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入调研主题，例如：AI 陪伴产品市场格局',
    defaults: { agentGoalLabel: '完成研究并沉淀结论', allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'research-agent-required',
        label: '研究主设定',
        fields: [
          { key: 'agentGoalLabel', label: '研究目标', kind: 'textarea', required: true, placeholder: '明确要研究什么、沉淀什么' },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'multi_agent_workflow',
    label: '多Agent房',
    description: '适合程序员、产品、测试、市场等多角色协作。',
    structure: 'task',
    category: 'task',
    categoryLabel: '任务执行',
    sessionKind: createTemplateSessionKind('group', 'agent_workflow', { family: 'agent', scenarioId: 'multi-agent-workflow', surfaceProfile: 'dashboard', topology: 'team' }),
    style: 'brainstorm',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入协作目标，例如：从0到1设计一款产品',
    defaults: { agentGoalLabel: '多角色协作推进目标', allowPrivateThreads: false, allowCliques: true, allowMockery: false },
    configGroups: [
      {
        key: 'multi-agent-required',
        label: '协作主设定',
        fields: [
          { key: 'agentGoalLabel', label: '协作目标', kind: 'textarea', required: true, placeholder: '最终要一起完成什么' },
        ],
      },
      {
        key: 'multi-agent-advanced',
        label: '协作风格',
        fields: [
          { key: 'allowCliques', label: '允许形成小组分工', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'startup_war_room',
    label: '创业战情室',
    description: '适合多角色围绕产品、增长、融资做协作。',
    structure: 'task',
    category: 'task',
    categoryLabel: '任务执行',
    sessionKind: createTemplateSessionKind('group', 'agent_workflow', { family: 'agent', scenarioId: 'multi-agent-workflow', surfaceProfile: 'dashboard', topology: 'team' }),
    style: 'brainstorm',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入创业目标、产品阶段或当前问题',
    defaults: { agentGoalLabel: '围绕创业目标完成协作拆解', allowPrivateThreads: false, allowCliques: true, allowMockery: false },
    configGroups: [
      {
        key: 'startup-required',
        label: '战情主设定',
        fields: [
          { key: 'agentGoalLabel', label: '战情目标', kind: 'textarea', required: true, placeholder: '本轮创业协作要达成什么' },
        ],
      },
      {
        key: 'startup-advanced',
        label: '协作规则',
        fields: [
          { key: 'allowCliques', label: '允许小组分工', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'content_studio',
    label: '内容工作室',
    description: '适合作者、编辑、运营、设计协作出内容。',
    structure: 'creation',
    category: 'creation',
    categoryLabel: '创作共创',
    sessionKind: createTemplateSessionKind('group', 'agent_workflow', { family: 'agent', scenarioId: 'multi-agent-workflow', surfaceProfile: 'dashboard', topology: 'team' }),
    style: 'brainstorm',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入选题、栏目或需要共创的内容目标',
    defaults: { agentGoalLabel: '完成一次内容共创与交付', allowPrivateThreads: false, allowCliques: true, allowMockery: false },
    configGroups: [
      {
        key: 'content-required',
        label: '内容主设定',
        fields: [
          { key: 'agentGoalLabel', label: '内容目标', kind: 'textarea', required: true, placeholder: '这次内容协作要产出什么' },
        ],
      },
      {
        key: 'content-advanced',
        label: '协作规则',
        fields: [
          { key: 'allowCliques', label: '允许角色分工', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'board_game',
    label: '棋盘房',
    description: '适合下棋、推演和回合制对局。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'board_game', { family: 'board_game', scenarioId: 'board-game', surfaceProfile: 'board', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入棋局目标或玩法说明',
    defaults: { boardColumns: 8, boardRows: 8, allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'board-required',
        label: '棋盘主设定',
        fields: [
          { key: 'boardColumns', label: '棋盘列数', kind: 'number', required: true },
          { key: 'boardRows', label: '棋盘行数', kind: 'number', required: true },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'chess_study_board',
    label: '棋局复盘',
    description: '适合讲解棋路、训练推演和策略分析。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'board_game', { family: 'board_game', scenarioId: 'board-game', surfaceProfile: 'board', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'slow',
    topicPlaceholder: '输入棋谱、局势或复盘目标',
    defaults: { boardColumns: 8, boardRows: 8, allowPrivateThreads: false, allowCliques: false, allowMockery: false },
    configGroups: [
      {
        key: 'board-review-required',
        label: '棋局主设定',
        fields: [
          { key: 'boardColumns', label: '棋盘列数', kind: 'number', required: true },
          { key: 'boardRows', label: '棋盘行数', kind: 'number', required: true },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'werewolf',
    label: '狼人杀',
    description: '支持身份、阵营、昼夜与投票的推理对抗玩法。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'werewolf', { family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid', topology: 'table' }),
    style: 'roleplay',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入本局规则说明或背景设定',
    defaults: { deductionFactionCount: 2, allowPrivateThreads: false, allowCliques: true, allowMockery: true, werewolfRoleConfig: '', werewolfPostGameMode: 'free_talk' },
    configGroups: [
      {
        key: 'werewolf-required',
        label: '本局规则',
        fields: [
          { key: 'deductionFactionCount', label: '阵营数量', kind: 'number', required: true },
          { key: 'werewolfRoleConfig', label: '角色分配方案', kind: 'textarea', required: true, placeholder: '例如：2狼、1预言家、1女巫、其余平民' },
        ],
      },
      {
        key: 'werewolf-advanced',
        label: '进阶流程',
        fields: [
          { key: 'werewolfPostGameMode', label: '结束后交流', kind: 'single_select', advanced: true, options: [{ label: '自由交流', value: 'free_talk' }, { label: '复盘总结', value: 'review' }, { label: '直接重开', value: 'restart' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'social_deduction_party',
    label: '社交推理局',
    description: '适合带私密身份、怀疑与联盟变化的对抗局。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'werewolf', { family: 'deduction', scenarioId: 'werewolf-classic', surfaceProfile: 'hybrid', topology: 'table' }),
    style: 'roleplay',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入局内设定、身份规则或背景故事',
    defaults: { deductionFactionCount: 3, allowPrivateThreads: false, allowCliques: true, allowMockery: true, werewolfRoleConfig: '', werewolfPostGameMode: 'review' },
    configGroups: [
      {
        key: 'social-deduction-required',
        label: '对抗主设定',
        fields: [
          { key: 'deductionFactionCount', label: '阵营数量', kind: 'number', required: true },
          { key: 'werewolfRoleConfig', label: '身份规则', kind: 'textarea', required: true, placeholder: '写下身份、人数和特殊规则' },
        ],
      },
      {
        key: 'social-deduction-advanced',
        label: '对局尾声',
        fields: [
          { key: 'werewolfPostGameMode', label: '结束后交流', kind: 'single_select', advanced: true, options: [{ label: '自由交流', value: 'free_talk' }, { label: '复盘总结', value: 'review' }, { label: '直接重开', value: 'restart' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'murder_mystery',
    label: '剧本杀',
    description: '支持角色卡、线索、搜证和私密信息的剧情玩法。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'murder_mystery', { family: 'mystery', scenarioId: 'murder-mystery', surfaceProfile: 'hybrid', topology: 'table' }),
    style: 'roleplay',
    runtimeEvolutionIntensity: 'slow',
    topicPlaceholder: '输入剧本背景或案件设定',
    defaults: { mysteryClueCount: 6, allowPrivateThreads: false, allowCliques: true, allowMockery: false, mysteryScript: '', mysteryRoleMappingMode: 'alias' },
    configGroups: [
      {
        key: 'mystery-required',
        label: '剧本主设定',
        fields: [
          { key: 'mysteryScript', label: '剧本内容 / 背景', kind: 'textarea', required: true, placeholder: '输入案件背景、人物关系、冲突和关键秘密' },
          { key: 'mysteryClueCount', label: '线索数量', kind: 'number', required: true },
        ],
      },
      {
        key: 'mystery-advanced',
        label: '身份映射与展示',
        fields: [
          { key: 'mysteryRoleMappingMode', label: '群内昵称显示', kind: 'single_select', advanced: true, options: [{ label: '原名（身份名）', value: 'alias' }, { label: '只显示身份名', value: 'role_only' }, { label: '保持原名', value: 'original' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'courtroom_case',
    label: '法庭案件房',
    description: '适合法庭辩论、证据比对和案件还原。',
    structure: 'game',
    category: 'game',
    categoryLabel: '游戏推理',
    sessionKind: createTemplateSessionKind('group', 'murder_mystery', { family: 'mystery', scenarioId: 'murder-mystery', surfaceProfile: 'hybrid', topology: 'table' }),
    style: 'debate',
    runtimeEvolutionIntensity: 'balanced',
    topicPlaceholder: '输入案件、证据方向或法庭议题',
    defaults: { mysteryClueCount: 8, allowPrivateThreads: false, allowCliques: true, allowMockery: false, mysteryScript: '', mysteryRoleMappingMode: 'alias' },
    configGroups: [
      {
        key: 'courtroom-required',
        label: '案件主设定',
        fields: [
          { key: 'mysteryScript', label: '案件背景 / 证据框架', kind: 'textarea', required: true, placeholder: '案件背景、证据点、争议焦点' },
          { key: 'mysteryClueCount', label: '证据数量', kind: 'number', required: true },
        ],
      },
      {
        key: 'courtroom-advanced',
        label: '身份展示',
        fields: [
          { key: 'mysteryRoleMappingMode', label: '群内昵称显示', kind: 'single_select', advanced: true, options: [{ label: '原名（身份名）', value: 'alias' }, { label: '只显示身份名', value: 'role_only' }, { label: '保持原名', value: 'original' }] },
        ],
      },
    ],
  }),
  createTemplate({
    key: 'social_simulation',
    label: '世界模拟房',
    description: '适合社区、校园、公司、论坛等长期世界演化。',
    structure: 'simulation',
    category: 'simulation',
    categoryLabel: '世界模拟',
    sessionKind: createTemplateSessionKind('group', 'open_chat', { family: 'simulation', scenarioId: 'open-chat', surfaceProfile: 'timeline', topology: 'group' }),
    style: 'roleplay',
    runtimeEvolutionIntensity: 'fast',
    topicPlaceholder: '输入世界背景、群体关系和初始事件',
    defaults: { allowPrivateThreads: true, allowCliques: true, allowMockery: true },
    configGroups: [
      {
        key: 'simulation-advanced',
        label: '世界互动规则',
        fields: [
          { key: 'allowPrivateThreads', label: '允许角色私聊', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowCliques', label: '允许结盟和派系', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
          { key: 'allowMockery', label: '允许冲突和嘲讽', kind: 'single_select', advanced: true, options: [{ label: '允许', value: 'true' }, { label: '关闭', value: 'false' }] },
        ],
      },
    ],
  }),
];

export const ROOM_TEMPLATES: RoomTemplateDefinition[] = [
  ...ROOM_TEMPLATE_KERNELS,
  ...createPresetTemplates(ROOM_TEMPLATE_KERNELS),
];

export function getRoomTemplate(key: RoomTemplateKey) {
  return ROOM_TEMPLATES.find((item) => item.key === key) || ROOM_TEMPLATES[0];
}

export function isRoomTemplatePreset(template: RoomTemplateDefinition) {
  return Boolean(template.parentTemplateKey);
}

export function getRoomTemplateKernel(templateOrKey: RoomTemplateDefinition | RoomTemplateKey) {
  const template = typeof templateOrKey === 'string' ? getRoomTemplate(templateOrKey) : templateOrKey;
  return template.parentTemplateKey ? getRoomTemplate(template.parentTemplateKey) : template;
}

const PUBLIC_ROOM_TEMPLATE_KERNEL_KEYS = new Set<RoomTemplateKey>([
  'open_chat',
  'opinion_review',
  'story_reader',
  'learning_progress',
]);

export function isRoomTemplateAvailableForStandardUsers(template: RoomTemplateDefinition) {
  return PUBLIC_ROOM_TEMPLATE_KERNEL_KEYS.has(getRoomTemplateKernel(template).key);
}

export function filterRoomTemplatesForAvailability(
  templates: RoomTemplateDefinition[],
  options: { developerMode: boolean },
) {
  if (options.developerMode) return templates;
  return templates.filter(isRoomTemplateAvailableForStandardUsers);
}

export function getRoomTemplatePresetLabel(template: RoomTemplateDefinition) {
  return template.presetLabel || template.label;
}

export function getRoomTemplatePresetDescription(template: RoomTemplateDefinition) {
  return template.presetDescription || template.description;
}

export function listRoomTemplateKernels() {
  return ROOM_TEMPLATES.filter((item) => !isRoomTemplatePreset(item));
}

export function listRoomTemplateKernelsByStructure(structure: RoomTemplateStructure) {
  return listRoomTemplateKernels().filter((item) => item.structure === structure);
}

export function listRoomTemplatePresets(kernelKey: RoomTemplateKey) {
  const kernel = getRoomTemplate(kernelKey);
  return [kernel, ...ROOM_TEMPLATES.filter((item) => item.parentTemplateKey === kernel.key)];
}

export function listTemplateStructures() {
  return Array.from(new Map(listRoomTemplateKernels().map((item) => [item.structure, item])).values()).map((item) => ({
    value: item.structure,
    label: ROOM_TEMPLATE_STRUCTURE_LABELS[item.structure] || item.categoryLabel,
    family: item.sessionKind.family,
  }));
}

export function listTemplateCategories(structure: RoomTemplateStructure) {
  return Array.from(new Map(listRoomTemplateKernels().filter((item) => item.structure === structure).map((item) => [item.category, item])).values()).map((item) => ({
    value: item.category,
    label: item.categoryLabel,
  }));
}

export function listTemplatesByStructureAndCategory(structure: RoomTemplateStructure, category: RoomTemplateCategory) {
  return listRoomTemplateKernels().filter((item) => item.structure === structure && item.category === category);
}

export function findRoomTemplateBySessionKind(sessionKind: Pick<SessionKind, 'scenarioId' | 'family'>) {
  return ROOM_TEMPLATES.find((item) => item.sessionKind.scenarioId === sessionKind.scenarioId && item.sessionKind.family === sessionKind.family) || null;
}

export function getRoomTemplateDefaultsBySessionKind(sessionKind: Pick<SessionKind, 'scenarioId' | 'family'>) {
  return findRoomTemplateBySessionKind(sessionKind)?.defaults || {};
}

export function getRoomTemplateKeyBySessionKind(sessionKind: Pick<SessionKind, 'scenarioId' | 'family'>) {
  return findRoomTemplateBySessionKind(sessionKind)?.key || null;
}

function compactPreviewText(value: string | undefined, maxLength: number) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildRoomTemplatePreview(template: RoomTemplateDefinition): RoomTemplatePreview | null {
  if (template.sessionKind.scenarioId !== 'story-reader') return null;
  const hook = compactPreviewText(template.defaults?.storyBackground, 86);
  const direction = compactPreviewText(template.defaults?.storyDirection, 86);
  const firstChapterGoal = compactPreviewText(template.defaults?.storyOutline?.split(/[；;]/)[0], 72);
  const trackedAssets = (template.sellingPoints || []).slice(0, 3);
  const readerPromise = compactPreviewText(trackedAssets.length
    ? `你的选择会影响${trackedAssets.join('、')}，并在章节回看里留下结果。`
    : '', 72);
  if (!hook || !direction || !readerPromise || !firstChapterGoal || trackedAssets.length < 3) return null;
  return { hook, direction, readerPromise, firstChapterGoal, trackedAssets };
}

export function hasTemplateDefault<K extends keyof RoomTemplateDefaults>(
  defaults: RoomTemplateDefaults | undefined,
  key: K,
): defaults is RoomTemplateDefaults & Required<Pick<RoomTemplateDefaults, K>> {
  return defaults?.[key] !== undefined;
}
