import type { AICharacter } from '../types/character';
import type { GroupChat } from '../types/chat';
import { formatConflictPressureLabel, formatConflictTypeLabel } from './runtimeEventFactory';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';

export interface ProjectedConflictItem {
  key: string;
  title: string;
  text: string;
  chips: string[];
}

function cleanText(value: string | undefined | null, members: DisplayTextMember[]) {
  return sanitizeUserFacingText(value || '', members).trim();
}

function memberName(id: string, members: AICharacter[]) {
  if (id === 'user') return '我';
  return members.find((item) => item.id === id)?.name || '成员';
}

export function projectConflictPanelItems(chat: GroupChat, members: AICharacter[]): ProjectedConflictItem[] {
  const seen = new Set<string>();
  const displayMembers: DisplayTextMember[] = [
    { id: 'user', name: '我' },
    ...members.map((member) => ({ id: member.id, name: member.name })),
  ];
  const active = [
    chat.worldState.conflictState?.primaryConflict,
    ...(chat.worldState.conflictState?.activeConflicts || []),
  ].filter(Boolean)
    .filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return item.stage !== 'resolved';
    })
    .map((item) => {
      const participants = [...(item?.participantIds || []), ...(item?.targetIds || [])]
        .filter((id, index, list) => id && list.indexOf(id) === index)
        .map((id) => memberName(id, members));
      return {
        key: item?.id || `conflict-${seen.size}`,
        title: formatConflictTypeLabel(item?.type),
        text: cleanText(item?.summary || '', displayMembers),
        chips: [
          item?.stage === 'cooling' ? '降温中' : item?.stage === 'escalating' ? '升温中' : item?.stage === 'open' ? '公开拉扯' : item?.stage === 'emerging' ? '正在浮现' : '',
          item?.nextPressure ? formatConflictPressureLabel(item.nextPressure) : '',
          ...participants.slice(0, 3),
        ].filter(Boolean).map((chip) => cleanText(chip, displayMembers)),
      };
    });
  const axes = (chat.worldState.conflictAxes || [])
    .filter((axis) => Math.abs(axis.currentTilt || 0) >= 8)
    .map((axis, index) => ({
      key: `axis-${axis.title}-${index}`,
      title: cleanText(axis.title, displayMembers),
      text: cleanText(`${axis.poles[0]} / ${axis.poles[1]}`, displayMembers),
      chips: ['轴配置'],
    }));
  return [...active, ...axes];
}
