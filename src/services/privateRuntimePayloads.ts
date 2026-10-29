import type { GroupChat, ParticipantInstance } from '../types/chat';
import type { ParticipantRoleCard } from '../types/participantRole';
import { resolveSessionDefinition } from '../types/sessionEngine';
import { getModeratorChannelId, getRoleChannelId } from './sessionTopology';

export interface RolePrivateRuntimePayload {
  key: string;
  title: string;
  text: string;
  visibilityScope: 'role_private' | 'moderator_only' | 'pair_private';
  channelId?: string;
  visibleToRoles?: string[];
  visibleToIds?: string[];
}

function buildWerewolfRoleCard(roleTitle: string, summary: string, details: string[], tags: string[]): ParticipantRoleCard {
  return {
    key: `werewolf-${tags[0] || 'role'}-card`,
    title: roleTitle,
    summary,
    details,
    tags,
  };
}

function buildWerewolfParticipantState(chat: GroupChat, participant: ParticipantInstance): ParticipantInstance {
  if (resolveSessionDefinition(chat).kind.scenarioId !== 'werewolf-classic') return participant;
  const role = typeof participant.flags.role === 'string' ? participant.flags.role : 'villager';
  const alive = participant.flags.alive !== false;
  const publicTitle = alive ? '存活玩家' : '已出局';

  if (role === 'werewolf') {
    return {
      ...participant,
      roleKey: 'werewolf',
      title: publicTitle,
      faction: 'wolfpack',
      publicState: {
        title: publicTitle,
        factionHint: alive ? null : '已出局',
        revealedFacts: participant.publicState?.revealedFacts || [],
      },
      privateState: {
        roleCard: buildWerewolfRoleCard('狼人身份卡', '你属于狼人阵营，夜晚需要与同伴协作处理目标。', ['夜晚可见同阵营线索。', '白天需要隐藏身份并影响投票。'], ['werewolf', 'night-action']),
        hiddenFacts: [{ key: 'wolfpack', text: '你知道哪些玩家属于狼人阵营。' }],
        notes: ['夜晚阶段优先商量刀口，白天避免暴露身份。'],
      },
    };
  }

  if (role === 'seer') {
    return {
      ...participant,
      roleKey: 'seer',
      title: publicTitle,
      faction: 'village',
      publicState: {
        title: publicTitle,
        factionHint: alive ? null : '已出局',
        revealedFacts: participant.publicState?.revealedFacts || [],
      },
      privateState: {
        roleCard: buildWerewolfRoleCard('预言家身份卡', '你属于好人阵营，夜晚可以查验一名目标的阵营。', ['夜晚查验结果仅自己可见。', '白天需要判断何时跳身份。'], ['seer', 'investigation']),
        hiddenFacts: [{ key: 'investigation', text: '你能在夜晚获得一次私有查验结果。' }],
        notes: ['尽量根据查验结果组织白天讨论。'],
      },
    };
  }

  return {
    ...participant,
    roleKey: 'villager',
    title: publicTitle,
    faction: 'village',
    publicState: {
      title: publicTitle,
      factionHint: alive ? null : '已出局',
      revealedFacts: participant.publicState?.revealedFacts || [],
    },
    privateState: {
      roleCard: buildWerewolfRoleCard('村民身份卡', '你属于好人阵营，没有夜晚主动技能。', ['通过白天发言、投票与站边帮助找狼。'], ['villager', 'day-discussion']),
      notes: ['重点观察发言矛盾、投票理由与站边变化。'],
    },
  };
}

function buildWerewolfModeratorPayload(chat: GroupChat): RolePrivateRuntimePayload | null {
  if (resolveSessionDefinition(chat).kind.scenarioId !== 'werewolf-classic') return null;
  return {
    key: 'werewolf-moderator-brief',
    title: '裁判视角',
    text: '主持视角可查看身份分布、夜晚动作与结算提示。',
    visibilityScope: 'moderator_only',
    channelId: getModeratorChannelId(),
    visibleToRoles: ['moderator'],
  };
}

function buildWerewolfRolePayload(chat: GroupChat): RolePrivateRuntimePayload | null {
  if (resolveSessionDefinition(chat).kind.scenarioId !== 'werewolf-classic') return null;
  return {
    key: 'werewolf-role-brief',
    title: '狼人杀私有信息',
    text: '不同身份在夜晚与白天拥有不同可见信息与动作权限。',
    visibilityScope: 'role_private',
    channelId: getRoleChannelId(),
  };
}

function buildWerewolfPackPayload(chat: GroupChat): RolePrivateRuntimePayload | null {
  if (resolveSessionDefinition(chat).kind.scenarioId !== 'werewolf-classic') return null;
  return {
    key: 'werewolf-pack-brief',
    title: '狼人同伴视角',
    text: '狼人夜晚可共享队友信息与刀口协商。',
    visibilityScope: 'pair_private',
    channelId: getRoleChannelId('werewolf'),
    visibleToRoles: ['werewolf'],
  };
}

export function buildInterviewPrivatePayload(chat: GroupChat): RolePrivateRuntimePayload | null {
  if (resolveSessionDefinition(chat).kind.family !== 'interview') return null;
  return {
    key: 'interview-private-brief',
    title: '面试官私有提示',
    text: '优先观察回答是否具体、是否有证据、是否能承受追问压力。',
    visibilityScope: 'moderator_only',
    channelId: getModeratorChannelId(),
    visibleToRoles: ['interviewer'],
  };
}

export function buildDirectPrivatePayload(chat: GroupChat): RolePrivateRuntimePayload | null {
  if (chat.type !== 'direct' && chat.type !== 'ai_direct') return null;
  return {
    key: 'private-thread-context',
    title: chat.type === 'direct' ? '单聊上下文' : '角色私聊上下文',
    text: chat.type === 'direct' ? '该单聊仅对当前用户与目标角色可见。' : '该会话只对当前私聊双方可见，主群只看摘要回流。',
    visibilityScope: 'pair_private',
    channelId: getRoleChannelId(chat.type === 'direct' ? 'user' : 'pair'),
    visibleToRoles: chat.type === 'direct' ? ['user_private'] : ['pair_private'],
    visibleToIds: chat.memberIds,
  };
}

export function buildRolePrivateParticipantState(chat: GroupChat, participant: ParticipantInstance): ParticipantInstance {
  const werewolfState = buildWerewolfParticipantState(chat, participant);
  if (werewolfState !== participant) return werewolfState;

  if (resolveSessionDefinition(chat).kind.family === 'interview' && participant.flags.role === 'interviewer') {
    return {
      ...participant,
      roleKey: 'interviewer',
      title: '面试官',
      publicState: { title: '面试官', factionHint: null, revealedFacts: [] },
      privateState: {
        roleCard: {
          key: 'interviewer-role-card',
          title: '面试官身份卡',
          summary: '你负责提问、追问、观察证据与表达质量。',
          details: ['重点看：具体性、证据、追问承受力。'],
          tags: ['moderator-only', 'interview'],
        },
        notes: ['当前可看私有提示与面试官观察要点。'],
      },
    };
  }

  if (chat.type === 'ai_direct') {
    return {
      ...participant,
      roleKey: 'private_party',
      privateState: {
        roleCard: buildWerewolfRoleCard('私聊上下文卡', '你拥有该角色私聊的完整上下文。', ['这段私聊的细节不会完整广播回主群。'], ['private-chat', 'sample']),
        notes: ['角色私聊的完整上下文只对当前私聊双方可见。'],
      },
    };
  }

  return participant;
}

export function buildRolePrivateParticipantStates(chat: GroupChat, participants: ParticipantInstance[]) {
  return participants.map((participant) => buildRolePrivateParticipantState(chat, participant));
}

export function buildRolePrivatePayloads(chat: GroupChat) {
  return [
    buildInterviewPrivatePayload(chat),
    buildDirectPrivatePayload(chat),
    buildWerewolfModeratorPayload(chat),
    buildWerewolfRolePayload(chat),
    buildWerewolfPackPayload(chat),
  ].filter(Boolean) as RolePrivateRuntimePayload[];
}

export function projectParticipantRoleCards(participants: ParticipantInstance[], viewerRole?: string | null) {
  if (!viewerRole) return participants.map((participant) => participant.privateState?.roleCard).filter(Boolean) as ParticipantRoleCard[];
  if (!['interviewer', 'pair_private', 'user_private', 'werewolf', 'seer', 'villager', 'moderator'].includes(viewerRole)) return [];
  return participants
    .filter((participant) => !participant.roleKey || participant.roleKey === viewerRole || viewerRole === 'moderator')
    .map((participant) => participant.privateState?.roleCard)
    .filter(Boolean) as ParticipantRoleCard[];
}

function uniquePrivatePayloads<T extends { title: string; text: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.title.trim()}\n${item.text.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectPrivateParticipantPayloads(participants: ParticipantInstance[], viewerRole?: string | null) {
  const visibleParticipants = !viewerRole
    ? participants
    : participants.filter((participant) => !participant.roleKey || participant.roleKey === viewerRole || viewerRole === 'moderator');
  const roleCards = projectParticipantRoleCards(visibleParticipants, viewerRole).map((card) => ({
    key: card.key,
    title: card.title,
    text: [card.summary, ...(card.details || [])].join(' / '),
  }));
  const notes = visibleParticipants.flatMap((participant) => participant.privateState?.notes || []).map((note, index) => ({
    key: `note-${index}`,
    title: '私有备注',
    text: note,
  }));
  return uniquePrivatePayloads([...roleCards, ...notes]);
}
