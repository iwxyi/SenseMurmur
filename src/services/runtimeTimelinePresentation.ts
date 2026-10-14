import { sanitizeDistillationTexts } from './distillationText';
import { sanitizeUserFacingText, type DisplayTextMember } from './displayTextSanitizer';
import {
  readAttentionFollowupMeta,
  readAttentionInfoMeta,
  readAttentionSourceMeta,
  readActorAuditMeta,
  readCalendarPatchMeta,
  readCalendarPatchApplyResultMeta,
  readCandidateSuppressionMeta,
  readMemoryCandidateMeta,
  readMemoryDistillationMeta,
  readProjectionInfoMeta,
  readRelationshipDeltaMeta,
  readRoomShiftMeta,
  readSocialEventArtifactMeta,
  readSocialEventCandidateMeta,
  readSocialEventClusterMeta,
  readSocialEventEffectMeta,
  readWorldAttentionDecisionMeta,
  readUnifiedWorldDecisionMeta,
  type ProjectedRuntimeTimelineItem,
} from './sessionProjection';
import { buildCalendarPatchSummary, buildCalendarPatchTimelineTitle } from './worldCalendarPatchPresentation';
import { formatRuntimeEventKindLabel, formatSocialEventKindLabel } from './runtimeEventPresentation';

interface AttentionDebugLineParams {
  candidate?: {
    eventKind?: string;
    attentionTrace?: {
      score?: number;
      restraint?: number;
      reasons?: string[];
    };
  } | null;
  language?: 'zh' | 'en';
  reasonMax?: number;
  members?: DisplayTextMember[];
}

function cleanText(text: string | undefined | null, members: DisplayTextMember[] = []) {
  return sanitizeUserFacingText(text || '', members)
    .replace(/relationship_backflow/g, '关系回流')
    .replace(/summary_backflow/g, '摘要回流')
    .replace(/source_chat_patch/g, '群聊投影')
    .replace(/亲近/g, '亲和')
    .replace(/尊重/g, '能力')
    .replace(/态度发生变化/g, '关系发生变化')
    .trim();
}

function clip(text: string, max = 64) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortEventId(value: string | undefined) {
  if (!value) return '';
  if (value.length <= 12) return value;
  return value.slice(-8);
}

function formatSigned(value: number | undefined) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${safeValue > 0 ? '+' : ''}${Math.round(safeValue)}`;
}

function roomDeltaLabel(kind: 'heat' | 'cohesion' | 'topic', value: number | undefined) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  if (safeValue === 0) return '';
  if (kind === 'heat') return safeValue > 0 ? '互动升温' : '互动降温';
  if (kind === 'cohesion') return safeValue > 0 ? '氛围靠拢' : '氛围分散';
  return safeValue > 0 ? '话题发散' : '回到主线';
}

function formatEventKind(kind: string) {
  return formatRuntimeEventKindLabel(kind, 'zh');
}

function formatMemoryKind(kind: string | undefined) {
  const labels: Record<string, string> = {
    decision: '决策',
    conflict: '冲突',
    bond: '亲近',
    resentment: '不满',
    status_shift: '状态变化',
    trait_evidence: '性格证据',
    bias: '偏见',
    taboo: '禁忌',
    obsession: '执念',
    artifact: '产物',
    thread_effect: '线程影响',
  };
  return kind ? labels[kind] || cleanText(kind) : '记忆';
}

function formatClusterStage(stage: 'candidate' | 'artifact' | 'effect' | 'opened' | undefined) {
  const labels: Record<string, string> = { candidate: '候选', artifact: '产物', effect: '回流', opened: '已派生' };
  return stage ? labels[stage] || stage : '事件';
}

function formatSocialEventKind(kind: string | undefined) {
  return formatSocialEventKindLabel(kind, 'zh');
}

function formatActorOrigin(origin: string | undefined) {
  if (origin === 'member') return '成员';
  if (origin === 'operator') return '操作者';
  if (origin === 'external') return '外部';
  return '未知';
}

function formatActivityCandidateStage(candidate: ReturnType<typeof readSocialEventCandidateMeta>) {
  if (candidate?.eventKind !== 'social_outing') return null;
  if (candidate.reasonType === 'chat_activity_invite') return '聊天邀约候选';
  if (candidate.reasonType === 'world_attention_invite_activity') return '关注驱动邀约';
  return '活动候选';
}

function formatActivityCandidateDetail(candidate: ReturnType<typeof readSocialEventCandidateMeta>, members: DisplayTextMember[]) {
  const stage = formatActivityCandidateStage(candidate);
  if (!candidate || !stage) return null;
  const title = candidate.title || candidate.activityType || '线下活动';
  return cleanText([
    stage,
    title,
    candidate.timeHint ? `时间 ${candidate.timeHint}` : '',
    candidate.locationHint ? `地点 ${candidate.locationHint}` : '',
    Number.isFinite(candidate.confidence) ? `置信 ${(candidate.confidence * 100).toFixed(0)}%` : '',
    candidate.dedupeKey ? `key ${shortEventId(candidate.dedupeKey)}` : '',
  ].filter(Boolean).join(' · '), members);
}

function formatCalendarPatchMetaLine(patch: ReturnType<typeof readCalendarPatchMeta>, members: DisplayTextMember[]) {
  if (!patch) return '';
  const stateText = Object.entries(patch.addParticipantStates || {})
    .map(([id, state]) => {
      const name = members.find((member) => member.id === id)?.name || id;
      return `${name}:${state}`;
    })
    .join('、');
  return cleanText([
    patch.source === 'chat_activity_followup' ? '聊天修订' : '',
    patch.timeHint ? `时间 ${patch.timeHint}` : '',
    patch.locationHint ? `地点 ${patch.locationHint}` : '',
    patch.status ? `状态 ${patch.status}` : '',
    stateText ? `参与 ${stateText}` : '',
    patch.calendarItemId ? `item ${shortEventId(patch.calendarItemId)}` : '',
  ].filter(Boolean).join(' · '), members);
}

export function buildRuntimeTimelineTitle(item: ProjectedRuntimeTimelineItem) {
  if (item.event?.kind === 'calendar_item_patch') return buildCalendarPatchTimelineTitle(item.event, true);
  if (readUnifiedWorldDecisionMeta(item)) return '世界决策';
  if (readCandidateSuppressionMeta(item)) return '候选抑制';
  if (readCalendarPatchApplyResultMeta(item)) return '日历草案执行';
  const cluster = readSocialEventClusterMeta(item);
  if (cluster?.eventKind === 'pair_private_thread' && cluster.stage === 'opened') return '双人私聊';
  if (cluster) return `${formatSocialEventKind(cluster.eventKind)} · ${formatClusterStage(cluster.stage)}`;
  return item.event ? formatEventKind(item.event.kind) : item.label;
}

export function buildRuntimeTimelineBody(item: ProjectedRuntimeTimelineItem, members: DisplayTextMember[] = []) {
  if (item.event?.kind === 'calendar_item_patch') {
    return clip(cleanText(buildCalendarPatchSummary(item.event, true, members) || item.text, members), 88);
  }
  const candidate = readSocialEventCandidateMeta(item);
  const artifact = readSocialEventArtifactMeta(item);
  const effect = readSocialEventEffectMeta(item);
  const relation = readRelationshipDeltaMeta(item);
  const distillation = readMemoryDistillationMeta(item);
  const followup = readAttentionFollowupMeta(item);
  const suppression = readCandidateSuppressionMeta(item);
  const worldDecision = readWorldAttentionDecisionMeta(item);
  const worldDecisionUnified = readUnifiedWorldDecisionMeta(item);
  const patchApply = readCalendarPatchApplyResultMeta(item);
  const projectionInfo = readProjectionInfoMeta(item);
  const topicSnippet = projectionInfo?.topicSnippet || null;
  const participantNames = projectionInfo?.participantNames || [];
  if (followup) {
    const statusLabel = followup.status === 'completed' ? '已发言' : '待响应';
    const focus = followup.focus ? ` · ${followup.focus}` : '';
    const targetLabel = followup.kind === 'member'
      ? (followup.targetName || '成员')
      : '我';
    return clip(cleanText(`${followup.actorName} 跟进${targetLabel}指令 ${statusLabel}${focus}`, members), 88);
  }
  if (suppression) {
    const eventKind = suppression.candidateEventKind ? formatSocialEventKind(suppression.candidateEventKind) : '候选';
    const reason = suppression.reasonDetail || suppression.reasonLabel || suppression.reasonType || '已抑制';
    const eta = typeof suppression.nextSuggestedAt === 'number' ? ` · 建议 ${new Date(suppression.nextSuggestedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 后` : '';
    return clip(cleanText(`${eventKind} · ${reason}${eta}`, members), 88);
  }
  if (worldDecisionUnified) {
    const domainLabel = worldDecisionUnified.domain === 'proactive_care'
      ? '主动关怀'
      : worldDecisionUnified.domain === 'open_chat'
        ? '开放群聊'
        : worldDecisionUnified.domain === 'calendar_patch_queue'
          ? '日历草案队列'
          : '世界域';
    const sourceLabel = worldDecisionUnified.decisionSource === 'model'
      ? '模型裁决'
      : worldDecisionUnified.version === 'legacy'
        ? '兼容裁决'
        : '本地裁决';
    const kindLabel = worldDecisionUnified.selectedKind ? formatSocialEventKind(worldDecisionUnified.selectedKind) : '候选';
    const reason = worldDecisionUnified.reason ? ` · ${worldDecisionUnified.reason}` : '';
    return clip(cleanText(`${domainLabel} · ${sourceLabel} · 选择 ${kindLabel}${reason}`, members), 88);
  }
  if (worldDecision) {
    const decisionLabel = worldDecision.decisionType === 'trigger'
      ? '触发'
      : worldDecision.decisionType === 'fallback'
        ? '改道'
        : '抑制';
    const actionLabel = worldDecision.toEventKind ? formatSocialEventKind(worldDecision.toEventKind) : '未触发动作';
    const reason = worldDecision.reasonDetail || worldDecision.reasonLabel || worldDecision.reasonType || '';
    const eta = typeof worldDecision.nextSuggestedAt === 'number' ? ` · 建议 ${new Date(worldDecision.nextSuggestedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
    return clip(cleanText(`世界驱动${decisionLabel} · ${actionLabel}${reason ? ` · ${reason}` : ''}${eta}`, members), 88);
  }
  if (patchApply) {
    const chainBlockedCount = patchApply.skippedReasonCounts?.chain_group_blocked || 0;
    const chainBlockedText = chainBlockedCount > 0 ? ` · 链式阻断 ${chainBlockedCount}` : '';
    const modelText = patchApply.modelArbitration?.attempted
      ? (patchApply.modelArbitration.applied ? ' · 模型已重排' : ' · 模型未改排')
      : '';
    return clip(cleanText(`应用 ${patchApply.appliedCount} · 跳过 ${patchApply.skippedCount} · 失败 ${patchApply.failedCount}${chainBlockedText}${modelText}`, members), 88);
  }
  const activityCandidateDetail = formatActivityCandidateDetail(candidate, members);
  if (activityCandidateDetail) return clip(activityCandidateDetail, 88);
  if (distillation) {
    const candidateTexts = Array.isArray(distillation.candidateTexts)
      ? sanitizeDistillationTexts(distillation.candidateTexts
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value) => cleanText(value, members)))
      : [];
    return clip(cleanText(candidateTexts.join(' / ') || item.text, members), 88);
  }
  if (relation) {
    const parts = [
      relation.delta.warmth ? `亲和${formatSigned(relation.delta.warmth)}` : '',
      relation.delta.competence ? `能力${formatSigned(relation.delta.competence)}` : '',
      relation.delta.trust ? `信任${formatSigned(relation.delta.trust)}` : '',
      relation.delta.threat ? `威胁${formatSigned(relation.delta.threat)}` : '',
    ].filter(Boolean);
    return clip(parts.join(' / '), 88);
  }
  return clip(cleanText(candidate?.title || artifact?.title || artifact?.activityType || (participantNames.length ? `${participantNames.join(' ↔ ')} · ${topicSnippet || effect?.summary || item.text}` : null) || topicSnippet || effect?.summary || item.text, members), 88);
}

export function buildRuntimeTimelineMeta(item: ProjectedRuntimeTimelineItem, members: DisplayTextMember[] = []) {
  if (item.event?.kind === 'calendar_item_patch') {
    const patch = readCalendarPatchMeta(item);
    const detail = formatCalendarPatchMetaLine(patch, members);
    if (detail) return detail;
    return patch?.isAuto ? cleanText('来源 · 自动冲突修正执行器', members) : cleanText('来源 · 手动/常规更新', members);
  }
  const relation = readRelationshipDeltaMeta(item);
  const room = readRoomShiftMeta(item);
  const memory = readMemoryCandidateMeta(item);
  const candidate = readSocialEventCandidateMeta(item);
  const effect = readSocialEventEffectMeta(item);
  const distillation = readMemoryDistillationMeta(item);
  const followup = readAttentionFollowupMeta(item);
  const attentionSource = readAttentionSourceMeta(item);
  const suppression = readCandidateSuppressionMeta(item);
  const worldDecision = readWorldAttentionDecisionMeta(item);
  const worldDecisionUnified = readUnifiedWorldDecisionMeta(item);
  const patchApply = readCalendarPatchApplyResultMeta(item);
  const actorAudit = readActorAuditMeta(item);
  const projectionKind = readProjectionInfoMeta(item)?.projectionKind || null;
  if (followup) {
    const statusLabel = followup.status === 'completed' ? '已发言' : '待响应';
    const scopeLabel = followup.kind === 'member'
      ? `成员跟进动作 · ${followup.actorName} → ${followup.targetName || '成员'}`
      : `用户跟进动作 · ${followup.actorName}`;
    return cleanText(`${scopeLabel} · ${statusLabel}`, members);
  }
  if (item.event?.kind === 'attention_candidate' && attentionSource) {
    return cleanText(`关注候选 · 来源 ${attentionSource.label}`, members);
  }
  if (suppression) {
    const eventKind = suppression.candidateEventKind ? formatSocialEventKind(suppression.candidateEventKind) : '候选';
    const confidenceInfo = (typeof suppression.preferredConfidence === 'number' && typeof suppression.suppressedConfidence === 'number')
      ? ` · 保留 ${suppression.preferredConfidence.toFixed(2)} / 抑制 ${suppression.suppressedConfidence.toFixed(2)}`
      : '';
    const candidateRefInfo = suppression.preferredCandidateId && suppression.suppressedCandidateId
      ? ` · keep ${shortEventId(suppression.preferredCandidateId)} / drop ${shortEventId(suppression.suppressedCandidateId)}`
      : '';
    const hitInfo = suppression.hitEventId
      ? ` · hit ${shortEventId(suppression.hitEventId)}${suppression.hitWindow ? `/${suppression.hitWindow}` : ''}`
      : '';
    return cleanText(`候选抑制 · ${eventKind}${confidenceInfo}${candidateRefInfo}${hitInfo}`, members);
  }
  if (worldDecisionUnified) {
    const domainLabel = worldDecisionUnified.domain === 'proactive_care'
      ? '主动关怀'
      : worldDecisionUnified.domain === 'open_chat'
        ? '开放群聊'
        : worldDecisionUnified.domain === 'calendar_patch_queue'
          ? '日历草案队列'
          : '世界域';
    const sourceLabel = worldDecisionUnified.decisionSource === 'model'
      ? '模型'
      : worldDecisionUnified.version === 'legacy'
        ? '兼容'
        : '本地';
    const candidateInfo = typeof worldDecisionUnified.candidateCount === 'number' ? ` · 候选 ${worldDecisionUnified.candidateCount}` : '';
    const deltaInfo = typeof worldDecisionUnified.confidenceDelta === 'number' ? ` · Δ${worldDecisionUnified.confidenceDelta.toFixed(2)}` : '';
    return cleanText(`世界决策 · ${domainLabel} · ${sourceLabel}${candidateInfo}${deltaInfo}`, members);
  }
  if (worldDecision) {
    const fromInfo = worldDecision.fromEventKind ? `from ${formatSocialEventKind(worldDecision.fromEventKind)}` : '';
    const toInfo = worldDecision.toEventKind ? `to ${formatSocialEventKind(worldDecision.toEventKind)}` : '';
    return cleanText(`世界驱动决策${fromInfo ? ` · ${fromInfo}` : ''}${toInfo ? ` · ${toInfo}` : ''}`, members);
  }
  if (patchApply) {
    const queue = typeof patchApply.queueCount === 'number' ? ` · 队列 ${patchApply.queueCount}` : '';
    const reasonParts = [
      patchApply.skippedReasonCounts?.missing_target_conversation ? `缺少目标会话 ${patchApply.skippedReasonCounts.missing_target_conversation}` : '',
      patchApply.skippedReasonCounts?.target_chat_not_found ? `目标会话不存在 ${patchApply.skippedReasonCounts.target_chat_not_found}` : '',
      patchApply.skippedReasonCounts?.duplicate_idempotency ? `幂等跳过 ${patchApply.skippedReasonCounts.duplicate_idempotency}` : '',
      patchApply.skippedReasonCounts?.chain_group_blocked ? `链式阻断 ${patchApply.skippedReasonCounts.chain_group_blocked}` : '',
    ].filter(Boolean);
    const reasonText = reasonParts.length ? ` · ${reasonParts.join(' / ')}` : '';
    const modelInfo = patchApply.modelArbitration?.attempted
      ? ` · 模型${patchApply.modelArbitration.applied ? '已重排' : '未改排'}(${patchApply.modelArbitration.selectedIndependentCount})`
      : '';
    return cleanText(`日历草案执行 · 应用 ${patchApply.appliedCount} / 跳过 ${patchApply.skippedCount} / 失败 ${patchApply.failedCount}${queue}${reasonText}${modelInfo}`, members);
  }
  if (distillation) {
    const owner = distillation.ownerType === 'character' ? '角色' : '群聊';
    const evidence = typeof distillation.newEvidenceCount === 'number' ? distillation.newEvidenceCount : 0;
    const reason = typeof distillation.reason === 'string' ? cleanText(distillation.reason, members) : '';
    return cleanText(`${owner}蒸馏 · 证据 ${evidence} · ${reason}`, members);
  }
  if (candidate) {
    const activityCandidateDetail = formatActivityCandidateDetail(candidate, members);
    if (activityCandidateDetail) {
      const source = candidate.reasonType === 'chat_activity_invite' ? '聊天本地识别' : candidate.reasonType || '候选生成';
      return cleanText(`${source} · 参与 ${candidate.participantIds?.length || 0} · ${activityCandidateDetail}`, members);
    }
    const attentionMeta = readAttentionInfoMeta(item);
    if (attentionMeta) {
      const actorKind = attentionMeta.actorKindLabel ? `发起 ${attentionMeta.actorKindLabel}` : '';
      const targetKinds = attentionMeta.targetKindLabels?.length ? `目标 ${attentionMeta.targetKindLabels.join('、')}` : '';
      const actorSubtype = attentionMeta.actorSubtypeLabel ? `发起身份 ${attentionMeta.actorSubtypeLabel}` : '';
      const targetSubtypes = attentionMeta.targetSubtypeLabels?.length ? `目标身份 ${attentionMeta.targetSubtypeLabels.join('、')}` : '';
      const source = attentionSource ? ` · 来源 ${attentionSource.label}` : '';
      return cleanText(`候选 · ${formatSocialEventKind(candidate.eventKind)} · 关注${attentionMeta.scoreLabel} / 约束${attentionMeta.restraintLabel}${actorKind ? ` · ${actorKind}` : ''}${targetKinds ? ` · ${targetKinds}` : ''}${actorSubtype ? ` · ${actorSubtype}` : ''}${targetSubtypes ? ` · ${targetSubtypes}` : ''}${source}`, members);
    }
    return cleanText(`候选 · ${formatSocialEventKind(candidate.eventKind)}`, members);
  }
  if (effect) return cleanText(`回流 · ${projectionKind || effect.effectType}`, members);
  if (relation) {
    const from = item.actorNames?.join('、') || '某成员';
    const to = item.targetNames?.join('、') || '某成员';
    return cleanText(`${from} → ${to}`, members);
  }
  if (room?.delta?.heat || room?.delta?.cohesion || room?.delta?.topicDrift) {
    return [
      roomDeltaLabel('heat', room.delta?.heat),
      roomDeltaLabel('cohesion', room.delta?.cohesion),
      roomDeltaLabel('topic', room.delta?.topicDrift),
    ].filter(Boolean).join(' / ');
  }
  if (memory) return cleanText(`${formatMemoryKind(memory.kind)} · 有记忆沉淀`, members);
  if (actorAudit?.actorId || actorAudit?.actorName) {
    const who = cleanText(actorAudit.actorName || actorAudit.actorId || '未知', members);
    const origin = formatActorOrigin(actorAudit.origin);
    const suffix = actorAudit.isOperator ? ' · 非成员操作者' : '';
    return cleanText(`执行者 · ${who} · ${origin}${suffix}`, members);
  }
  return null;
}

export function buildRuntimeTimelineCaption(item: ProjectedRuntimeTimelineItem, members: DisplayTextMember[] = []) {
  const cluster = readSocialEventClusterMeta(item);
  const distillation = readMemoryDistillationMeta(item);
  const attentionInfo = readAttentionInfoMeta(item);
  if (cluster?.eventKind === 'pair_private_thread' && cluster.stage === 'opened') return null;
  if (distillation) return null;
  if (attentionInfo?.reasons?.length) return clip(cleanText(attentionInfo.reasons[0] || '', members), 72);
  if (item.event?.kind === 'interaction' || item.event?.kind === 'relationship_delta') return null;
  const actors = item.actorNames?.length ? item.actorNames.join('、') : null;
  const targets = item.targetNames?.length ? item.targetNames.join('、') : null;
  if (!actors && !targets) return null;
  return clip(cleanText(actors && targets ? `${actors} → ${targets}` : actors || targets || '', members), 36);
}

export function buildRuntimeTimelineTone(item: ProjectedRuntimeTimelineItem) {
  if (readSocialEventClusterMeta(item)) return 'rgba(25, 118, 210, 0.06)';
  if (readRelationshipDeltaMeta(item)) return 'rgba(142, 36, 170, 0.05)';
  if (readRoomShiftMeta(item)) return 'rgba(67, 160, 71, 0.05)';
  return 'action.hover';
}

export function buildRuntimeTimelineTypeLabel(item: ProjectedRuntimeTimelineItem) {
  if (readRelationshipDeltaMeta(item) || item.event?.kind === 'interaction') return '关系';
  if (readCandidateSuppressionMeta(item) || readCalendarPatchApplyResultMeta(item) || readUnifiedWorldDecisionMeta(item)) return '调度';
  if (readSocialEventClusterMeta(item)) return '事件';
  if (item.type === 'artifact') return '产物';
  if (readRoomShiftMeta(item)) return '局势';
  if (readMemoryCandidateMeta(item) || readMemoryDistillationMeta(item)) return '记忆';
  return item.type === 'note' ? '记录' : buildRuntimeTimelineTitle(item);
}

export function buildRuntimeTimelineRelationshipChips(item: ProjectedRuntimeTimelineItem) {
  const relation = readRelationshipDeltaMeta(item);
  if (!relation) return [];
  return [
    relation.delta.warmth ? `亲和 ${formatSigned(relation.delta.warmth)}` : '',
    relation.delta.competence ? `能力 ${formatSigned(relation.delta.competence)}` : '',
    relation.delta.trust ? `信任 ${formatSigned(relation.delta.trust)}` : '',
    relation.delta.threat ? `威胁感 ${formatSigned(relation.delta.threat)}` : '',
  ].filter(Boolean);
}

export function buildRuntimeTimelineRoomShiftChips(item: ProjectedRuntimeTimelineItem) {
  const room = readRoomShiftMeta(item);
  if (!room?.delta) return [];
  return [
    room.delta.heat ? roomDeltaLabel('heat', room.delta.heat) : '',
    room.delta.cohesion ? roomDeltaLabel('cohesion', room.delta.cohesion) : '',
    room.delta.topicDrift ? roomDeltaLabel('topic', room.delta.topicDrift) : '',
  ].filter(Boolean);
}

export interface RuntimeTimelineDisplayItem {
  tone: string;
  title: string;
  typeLabel: string;
  meta: string | null;
  bodyText: string;
  caption: string | null;
  relationshipChips: string[];
  roomShiftChips: string[];
}

export function projectRuntimeTimelineDisplayItem(item: ProjectedRuntimeTimelineItem, members: DisplayTextMember[] = []): RuntimeTimelineDisplayItem {
  return {
    tone: buildRuntimeTimelineTone(item),
    title: buildRuntimeTimelineTitle(item),
    typeLabel: buildRuntimeTimelineTypeLabel(item),
    meta: buildRuntimeTimelineMeta(item, members),
    bodyText: buildRuntimeTimelineBody(item, members),
    caption: buildRuntimeTimelineCaption(item, members),
    relationshipChips: buildRuntimeTimelineRelationshipChips(item),
    roomShiftChips: buildRuntimeTimelineRoomShiftChips(item),
  };
}

export function formatAttentionDebugLine(params: AttentionDebugLineParams) {
  const trace = params.candidate?.attentionTrace;
  if (!trace) return null;
  const isZh = (params.language || 'zh') === 'zh';
  const score = typeof trace.score === 'number' ? `${Math.round(trace.score * 100)}%` : '--';
  const restraint = typeof trace.restraint === 'number' ? `${Math.round(trace.restraint * 100)}%` : '--';
  const reasonMax = typeof params.reasonMax === 'number' && params.reasonMax > 0 ? params.reasonMax : 80;
  const reason = (trace.reasons || []).map((item) => item.trim()).filter(Boolean)[0] || '';
  const sanitizedReason = cleanText(reason, params.members || []);
  const clippedReason = sanitizedReason.length > reasonMax ? `${sanitizedReason.slice(0, reasonMax)}…` : sanitizedReason;
  return [
    isZh ? `关注 ${score}` : `Attention ${score}`,
    isZh ? `克制 ${restraint}` : `Restraint ${restraint}`,
    clippedReason,
  ].filter(Boolean).join(' · ');
}
