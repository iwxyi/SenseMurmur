import { describe, expect, it } from 'vitest';
import { selectConstrainedMemoryCues } from './memoryCueSelection';
import type { MemoryItem } from './memoryTypes';

function memory(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: overrides.id || 'memory-1',
    scope: overrides.scope || 'conversation',
    layer: overrides.layer || 'long_term',
    kind: overrides.kind || 'bias',
    ownerId: overrides.ownerId || 'char-a',
    subjectIds: overrides.subjectIds || ['user'],
    text: overrides.text || '用户不喜欢太甜的东西，喝了会腻。',
    summary: overrides.summary,
    evidenceText: overrides.evidenceText,
    salience: overrides.salience ?? 0.8,
    confidence: overrides.confidence ?? 0.85,
    recency: overrides.recency ?? 0.8,
    reinforcementCount: overrides.reinforcementCount ?? 2,
    sourceEventIds: overrides.sourceEventIds || ['event-1'],
    sourceTag: overrides.sourceTag || 'direct_user_message',
    origin: overrides.origin || 'distilled',
    distilledFromIds: overrides.distilledFromIds || [],
    distilledAt: overrides.distilledAt || null,
    distillationVersion: overrides.distillationVersion || null,
    createdAt: overrides.createdAt || 1,
    updatedAt: overrides.updatedAt || 1,
    lastActivatedAt: overrides.lastActivatedAt || null,
    archivedAt: overrides.archivedAt || null,
    relatedConversationId: overrides.relatedConversationId,
    subjectOwner: overrides.subjectOwner,
    sourceType: overrides.sourceType,
    privacyRisk: overrides.privacyRisk ?? 0.08,
    visibility: overrides.visibility ?? 'public_safe',
    validity: overrides.validity,
    semanticTags: overrides.semanticTags,
    associations: overrides.associations,
  };
}

describe('selectConstrainedMemoryCues', () => {
  it.each([
    ['llm_memory_character_perspective', '角色的主观理解，不代表他人真实动机'],
    ['llm_memory_relationship_imprint', '角色留下的关系印象，不代表对方的内心事实'],
  ])('preserves the perspective and uncertainty of %s in recall text', (sourceTag, label) => {
    const cues = selectConstrainedMemoryCues([memory({
      kind: 'bond', sourceTag, validity: 'uncertain',
      text: '经理一直不回消息，是在针对自己。', summary: '经理不回消息就是针对自己。',
    })], { targetActorIds: ['user'], visibleRecallMode: 'direct' });
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe(`【${label}；尚未确认】经理不回消息就是针对自己。`);
  });

  it('keeps ordinary recorded facts free of inferred subjective labels', () => {
    const cues = selectConstrainedMemoryCues([memory({
      kind: 'decision', text: '昨晚等回复等到十一点。', validity: 'active',
    })], { targetActorIds: ['user'] });
    expect(cues[0].text).toBe('昨晚等回复等到十一点。');
  });

  it('keeps only the most relevant 1-3 cues', () => {
    const cues = selectConstrainedMemoryCues([
      memory({ id: 'sweet', text: '用户不喜欢太甜的东西，喝了会腻。', salience: 0.9 }),
      memory({ id: 'cat', text: '用户家里有很多猫。', salience: 0.9 }),
      memory({ id: 'rain', text: '用户喜欢雨后散步。', salience: 0.7 }),
      memory({ id: 'seat', text: '用户喜欢咖啡店靠窗角落的位置。', salience: 0.7 }),
    ], {
      cueText: '我想点杯奶茶，别太甜太腻',
      maxCues: 2,
    });

    expect(cues.map((item) => item.id)).toEqual(['sweet']);
    expect(cues[0]?.mode).toBe('light_reference');
  });

  it('downgrades recently used memory to implicit only', () => {
    const cues = selectConstrainedMemoryCues([
      memory({ id: 'sweet', text: '用户喝奶茶等饮品时不喜欢太甜，喝了会腻。', salience: 0.95 }),
    ], {
      cueText: '我又想买奶茶了',
      recentMemoryUseIds: ['sweet'],
    });

    expect(cues[0]?.id).toBe('sweet');
    expect(cues[0]?.mode).toBe('implicit_only');
    expect(cues[0]?.rule).toContain('Do not say');
  });

  it('does not surface third-party health memory as a user trait', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'friend-allergy',
        text: '用户说朋友对猫毛过敏，不是用户本人过敏。',
        subjectOwner: 'third_party',
        visibility: 'private',
        privacyRisk: 0.8,
        salience: 0.9,
        confidence: 0.95,
      }),
      memory({
        id: 'user-cats',
        text: '用户说自己家里有好几只猫，经常会晒猫。',
        salience: 0.82,
        confidence: 0.92,
      }),
    ], {
      cueText: '附近新开了个猫咖，我想去看看',
    });

    expect(cues.map((item) => item.id)).toEqual(['user-cats']);
    expect(cues[0]?.mode).toBe('light_reference');
  });

  it('allows corrective cues when the user directly asks about uncertain memory ownership', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'friend-allergy',
        text: '用户说朋友对猫毛过敏，不是用户本人过敏。',
        subjectOwner: 'third_party',
        visibility: 'private',
        privacyRisk: 0.8,
        salience: 0.9,
        confidence: 0.95,
      }),
      memory({
        id: 'user-cats',
        text: '用户说自己家里有好几只猫，经常会晒猫。',
        salience: 0.82,
        confidence: 0.92,
      }),
    ], {
      cueText: '你还记得我是不是猫毛过敏吗？',
      explicitRecallRequested: true,
    });

    expect(cues.map((item) => item.id)).toContain('friend-allergy');
    expect(cues.find((item) => item.id === 'friend-allergy')?.mode).toBe('corrective');
  });

  it('keeps public-channel sensitive work memory implicit', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'work',
        scope: 'relationship',
        text: '用户最近提过某个同事说话很冲，让自己有点烦。',
        visibility: 'private',
        privacyRisk: 0.75,
        salience: 0.86,
        confidence: 0.84,
      }),
    ], {
      cueText: '刚刚工作群又有人说话特别冲',
      isPublicChannel: true,
    });

    expect(cues[0]?.mode).toBe('implicit_only');
  });

  it('uses associations when the stored memory text has no direct topic keyword overlap', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'low-sweet',
        text: '用户不喜欢太甜的东西，容易觉得腻。',
        semanticTags: ['低糖偏好'],
        associations: ['奶茶', '饮料', '甜品', '喝的'],
        salience: 0.88,
        confidence: 0.9,
      }),
    ], {
      cueText: '我想买杯奶茶，顺便点些喝的',
    });

    expect(cues[0]?.id).toBe('low-sweet');
    expect(cues[0]?.mode).toBe('light_reference');
  });

  it('uses the current target subject when text overlap is weak', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'target-relationship',
        subjectIds: ['char-b'],
        scope: 'relationship',
        text: '角色 A 对角色 B 上次爽约仍然有些介意。',
        salience: 0.9,
        confidence: 0.9,
        recency: 0.9,
      }),
    ], {
      cueText: '你刚才是不是又躲开了？',
      targetActorIds: ['char-b'],
    });

    expect(cues[0]?.id).toBe('target-relationship');
  });

  it('keeps visible recall implicit when the user chooses implicit mode', () => {
    const cues = selectConstrainedMemoryCues([
      memory({ id: 'sweet', text: '用户喝奶茶等饮品时不喜欢太甜，喝了会腻。', salience: 0.95 }),
    ], {
      cueText: '我又想买奶茶了',
      visibleRecallMode: 'implicit',
    });

    expect(cues[0]?.id).toBe('sweet');
    expect(cues[0]?.mode).toBe('implicit_only');
  });

  it('blocks memories marked as never surface', () => {
    const cues = selectConstrainedMemoryCues([
      memory({
        id: 'private-health',
        text: '用户私下提过健康情况。',
        visibility: 'never_surface',
        privacyRisk: 1,
        semanticTags: ['健康'],
        associations: ['喝的', '饮料'],
        salience: 1,
        confidence: 1,
      }),
    ], {
      cueText: '今天想买点喝的',
    });

    expect(cues).toHaveLength(0);
  });
});
