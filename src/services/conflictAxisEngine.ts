import type { GroupChat, ConversationConflictAxis } from '../types/chat';
const AXIS_DISPLAY_THRESHOLD = 12;

function isMeaningfulTilt(value: number | undefined) {
  return Math.abs(value || 0) >= AXIS_DISPLAY_THRESHOLD;
}

function formatAxisSummary(axis: ConversationConflictAxis) {
  if (!isMeaningfulTilt(axis.currentTilt)) return null;
  return `${axis.title} ${(axis.currentTilt || 0) > 0 ? axis.poles[0] : axis.poles[1]}`;
}

export function createDefaultConflictAxes(chat: Pick<GroupChat, 'topic' | 'style' | 'dramaRules'>): ConversationConflictAxis[] {
  const axes: ConversationConflictAxis[] = [];
  if (chat.style === 'debate') {
    axes.push({ title: '立场冲突', poles: ['支持', '反对'], currentTilt: 0 });
  }
  if (chat.style === 'brainstorm') {
    axes.push({ title: '方法冲突', poles: ['发散创意', '收敛执行'], currentTilt: 0 });
  }
  axes.push({ title: '归属/身份冲突', poles: ['默认认同', '公开争夺'], currentTilt: 0 });
  if (chat.dramaRules.allowCliques) {
    axes.push({ title: '群体关系', poles: ['结盟', '拆台'], currentTilt: 0 });
  }
  if (chat.dramaRules.allowMockery || chat.dramaRules.allowContempt) {
    axes.push({ title: '表达风格', poles: ['克制', '尖锐'], currentTilt: 0 });
  }
  return axes;
}

export function summarizeConflictAxes(axes: ConversationConflictAxis[]) {
  return axes
    .slice()
    .sort((a, b) => Math.abs(b.currentTilt || 0) - Math.abs(a.currentTilt || 0))
    .map(formatAxisSummary)
    .filter((value): value is string => Boolean(value))
    .slice(0, 2)
    .join('；');
}

export function getConflictAxesPriority(axes: ConversationConflictAxis[]) {
  return axes.slice().sort((a, b) => Math.abs(b.currentTilt || 0) - Math.abs(a.currentTilt || 0));
}

export function getConflictAxesSummaryLines(axes: ConversationConflictAxis[]) {
  return getConflictAxesPriority(axes)
    .map(formatAxisSummary)
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
}

export function getConflictAxesNarrative(axes: ConversationConflictAxis[]) {
  return getConflictAxesSummaryLines(axes).join('；');
}

export function getConflictAxesTopSummary(axes: ConversationConflictAxis[]) {
  return summarizeConflictAxes(axes);
}
