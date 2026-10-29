import type { RuntimeEventKind, SocialEventKind } from '../types/runtimeEvent';

export function formatRuntimeEventKindLabel(kind: RuntimeEventKind | string, language: 'zh' | 'en' = 'zh') {
  const zh: Record<string, string> = {
    message_generated: '消息生成',
    interaction: '互动',
    relationship_delta: '关系变化',
    room_shift: '房间态势',
    memory_candidate: '记忆候选',
    artifact: '产物',
    event_candidate: '事件候选',
    director_intervention: '导演干预',
    decision_trace: '决策痕迹',
    phase_transition: '阶段切换',
    action_resolution: '动作结算',
    calendar_item_patch: '日历更新',
    attention_candidate: '关注候选',
    initial_relationship_inference: '初始关系推断',
    board_state: '棋盘状态',
    score_update: '分数更新',
  };
  const en: Record<string, string> = {
    message_generated: 'Message',
    interaction: 'Interaction',
    relationship_delta: 'Relationship delta',
    room_shift: 'Room shift',
    memory_candidate: 'Memory candidate',
    artifact: 'Artifact',
    event_candidate: 'Event candidate',
    director_intervention: 'Director intervention',
    decision_trace: 'Decision trace',
    phase_transition: 'Phase transition',
    action_resolution: 'Action resolution',
    calendar_item_patch: 'Calendar patch',
    attention_candidate: 'Attention candidate',
    initial_relationship_inference: 'Initial relationship inference',
    board_state: 'Board state',
    score_update: 'Score update',
  };
  const map = language === 'zh' ? zh : en;
  return map[kind] || kind;
}

export function formatSocialEventKindLabel(kind: SocialEventKind | string | undefined, language: 'zh' | 'en' = 'zh') {
  if (!kind) return language === 'zh' ? '社交事件' : 'Social event';
  const zh: Record<string, string> = {
    pair_private_thread: '双人私聊',
    social_outing: '线下活动',
    post_moment: '朋友圈动态',
    status_update: '状态更新',
    gift_exchange: '礼物互动',
    conflict_expression: '冲突表达',
    check_in: '问候跟进',
    react_to_moment: '动态回应',
    custom: '自定义事件',
  };
  const en: Record<string, string> = {
    pair_private_thread: 'Character private chat',
    social_outing: 'Social outing',
    post_moment: 'Post moment',
    status_update: 'Status update',
    gift_exchange: 'Gift exchange',
    conflict_expression: 'Conflict expression',
    check_in: 'Check-in',
    react_to_moment: 'React to moment',
    custom: 'Custom event',
  };
  const map = language === 'zh' ? zh : en;
  return map[kind] || kind;
}
