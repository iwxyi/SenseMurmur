export interface DisplayTextMember {
  id: string;
  name?: string;
}

const INTERNAL_LABELS: Array<[RegExp, string]> = [
  [/memory_candidate/g, '记忆候选'],
  [/relationship_delta/g, '关系变化'],
  [/room_shift/g, '房间态势'],
  [/message_generated/g, '消息生成'],
  [/trait_evidence/g, '性格证据'],
  [/status_shift/g, '状态变化'],
  [/thread_effect/g, '线程影响'],
  [/long_term/g, '长期记忆'],
  [/episodic/g, '片段记忆'],
  [/working/g, '工作记忆'],
  [/resentment/g, '不满'],
  [/conflict/g, '冲突'],
  [/bond/g, '亲近'],
  [/artifact/g, '产物'],
  [/decision/g, '决策'],
  [/llm_memory_growth_signal/g, '成长信号'],
  [/llm_memory_distillation/g, '记忆沉淀'],
  [/expression_feedback/g, '表达反馈'],
];

const ENGLISH_REASON_LABELS: Array<[RegExp, string]> = [
  [/relationship ledger has become salient/gi, '关系账本中的变化已经足够显著'],
  [/has become a salient faction pressure/gi, '阵营靠拢已经形成可感知的压力'],
  [/active conflict needs a response/gi, '当前矛盾需要有人接话'],
  [/topic drift is high/gi, '当前话题漂移较高'],
  [/continue the current live thread/gi, '延续当前正在进行的话题'],
  [/scenario structure is shaping/gi, '当前场景结构正在影响互动'],
  [/hidden or private chat is creating mystery pressure/gi, '未公开线索正在形成悬念压力'],
  [/has a recent growth signal/gi, '角色成长信号正在影响互动'],
];

function replaceMemberIds(text: string, members: DisplayTextMember[]) {
  let next = text;
  members.forEach((member) => {
    if (!member.id) return;
    const escaped = member.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = member.id.length < 8
      ? new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'gu')
      : new RegExp(escaped, 'g');
    const label = member.name || '成员';
    next = member.id.length < 8
      ? next.replace(pattern, (_match, prefix = '') => `${prefix}${label}`)
      : next.replace(pattern, label);
  });
  return next;
}

export function sanitizeUserFacingText(text: string | undefined | null, members: DisplayTextMember[] = [], options: { preserveLineBreaks?: boolean } = {}) {
  let next = String(text || '');
  next = next.replace(/\{[\s\S]*?"eventType"[\s\S]*?\}/g, '系统事件');
  next = next.replace(/\beventType\s*(?=[\u4e00-\u9fa5A-Za-z0-9"'“”‘’:_-])/g, '');
  next = next.replace(/\b(?:relationship|faction|topic|scene|scenario|growth|goal|mystery):[^\s，。；、/]+/g, '线索');
  next = replaceMemberIds(next, members);
  INTERNAL_LABELS.forEach(([pattern, label]) => {
    next = next.replace(pattern, label);
  });
  ENGLISH_REASON_LABELS.forEach(([pattern, label]) => {
    next = next.replace(pattern, label);
  });
  return next
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12,}/gi, '成员')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '成员')
    .replace(/\b(source events?|sourceEventIds?|salience|tension|momentum|pressure)\b\s*:?\s*[\w.-]*%?/gi, '')
    .replace(/\bNaN\b/g, '0')
    .replace(options.preserveLineBreaks ? /[^\S\n]{2,}/g : /\s{2,}/g, ' ')
    .replace(options.preserveLineBreaks ? /\n{3,}/g : /(?!)/g, '\n\n')
    .replace(/\s+([，。；：、])/g, '$1')
    .trim();
}
