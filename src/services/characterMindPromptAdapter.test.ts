import { describe, expect, it } from 'vitest';
import type { CharacterMindProjection } from './characterMindProjection';
import { adaptCharacterMindProjectionForPrompt } from './characterMindPromptAdapter';

function projection(overrides: Partial<CharacterMindProjection> = {}): CharacterMindProjection {
  return {
    identity: {
      selfModel: ['陪伴角色，重视长期相处。'],
      stableVoice: ['自然、克制，偶尔嘴硬。'],
      desires: ['希望被理解'],
      fears: ['被轻易忘记'],
    },
    continuity: {
      userProfile: ['用户不喜欢太甜的饮料。', '用户只私下说过雨夜便利店暗号。'],
      selfMemories: ['曾经因为说太满而后悔。'],
      relationshipMemories: ['和阿远有雨夜失约的旧事。'],
      sharedHistory: ['一起修过一次聊天节奏，后来约定别公开施压。'],
    },
    relationship: {
      targetId: '8b3d7266-c0c7-4ceb-8dc2-45126f3f2321',
      targetName: '阿远',
      stance: ['认可对方，但不完全放下戒备。'],
      currentRoomPressure: ['目标牵涉当前可见冲突。'],
    },
    currentState: {
      emotionalUndercurrent: ['担心被误解，表达更防御'],
      activeNeeds: ['想确认自己没有被忽略'],
      selfAppraisal: '可能意识到自己刚才太用力。',
    },
    room: {
      topic: '今晚喝什么',
      activeLines: ['旧约定: 那次雨夜我不是故意失约。'],
      worldActivities: ['成长线: 尝试少用完整结论压住情绪。', '主线: 茶馆里有人互相试探。'],
      constraints: ['这是公开多人房间，公开时机、群体压力和可见关系会影响表达。'],
    },
    expression: {
      socialMove: '先处理当前关系压力。',
      temperature: '克制或带防备',
      attention: '注意力暂时落在阿远及其刚才的发言上。',
      length: '不要为了完整而补齐所有观点。',
      omissions: ['私密用户事实', '内部状态分数'],
    },
    hidden: {
      sourceIds: ['3c78729f-e52d-4dde-b27f-01a949960bb8b', 'evt-secret'],
      conflictReasons: ['想靠近与想防备同时存在。'],
      privacyGuards: ['用户相关私密事实只能影响克制和关心。'],
      recallCandidates: ['用户不喜欢太甜的饮料。'],
      memorySource: 'fallback_retrieval',
    },
    ...overrides,
  };
}

describe('characterMindPromptAdapter', () => {
  it('preserves self experience before lifelong motives when the core budget is crowded', () => {
    const value = projection();
    value.continuity.selfMemories = Array.from({ length: 8 }, (_, index) => `个人经历${index + 1}`);
    const output = adaptCharacterMindProjectionForPrompt(value, {
      chatType: 'group', maxCoreLines: 6, visibleMemoryRecall: 'off',
    });

    expect(output.coreContinuityBlock).toContain('个人经历1');
    expect(output.coreContinuityBlock).toContain('个人经历4');
    expect(output.coreContinuityBlock).not.toContain('个人经历5');
    expect(output.coreContinuityBlock).toContain('Recorded emotional state');
    expect(output.coreContinuityBlock).toContain('Stance toward 阿远');
    expect(output.trace.selectedSelfMemoryCount).toBe(8);
    expect(output.trace.renderedSelfMemoryCount).toBe(4);
  });

  it('reports when the entire self continuity line is outside the core budget', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group', maxCoreLines: 4, visibleMemoryRecall: 'off',
    });
    expect(output.trace.selectedSelfMemoryCount).toBe(1);
    expect(output.trace.renderedSelfMemoryCount).toBe(0);
    expect(output.coreContinuityBlock).not.toContain('Self continuity');
  });

  it('reports only identity values that survive the rendered core budget', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      maxCoreLines: 2,
      visibleMemoryRecall: 'off',
    });

    expect(output.renderedIdentityValues).toEqual([
      '陪伴角色，重视长期相处。',
      '自然、克制，偶尔嘴硬。',
    ]);
    expect(output.coreContinuityBlock).not.toContain('希望被理解');
  });

  it('does not fall back to untyped projection prose when structured recall selection supplied no cues', () => {
    const value = projection();
    value.continuity.relationshipMemories = ['一段没有披露级别的关系细节'];

    const result = adaptCharacterMindProjectionForPrompt(value, {
      chatType: 'group',
      visibility: 'public',
      visibleRecallCues: [],
      renderVisibleRecallCues: true,
    });

    expect(result.visibleRecallInput).toEqual([]);
    expect(result.promptBlock).not.toContain('一段没有披露级别的关系细节');
  });

  it('keeps public group prompts safe while preserving continuity as behavioral pressure', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      visibility: 'public',
      visibleMemoryRecall: 'natural',
    });

    expect(output.promptBlock).toContain('Core Character Continuity');
    expect(output.promptBlock).toContain('User continuity exists');
    expect(output.promptBlock).toContain('Relationship continuity exists');
    expect(output.promptBlock).not.toContain('Active room lines');
    expect(output.promptBlock).not.toContain('用户不喜欢太甜');
    expect(output.promptBlock).not.toContain('雨夜便利店');
    expect(output.promptBlock).not.toContain('那次雨夜我不是故意失约');
    expect(output.promptBlock).not.toContain('3c78729f-e52d-4dde-b27f-01a949960bb8b');
    expect(output.trace.omittedPrivateContinuity).toBe(true);
    expect(output.trace.omittedRawRoomLines).toBe(true);
  });

  it('allows private direct prompts to use specific continuity and natural recall cues', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'direct',
      visibility: 'private',
      visibleMemoryRecall: 'natural',
      maxRecallCues: 2,
    });

    expect(output.promptBlock).toContain('用户不喜欢太甜的饮料。');
    expect(output.visibleRecallInput).toHaveLength(2);
    expect(output.visibleRecallInput[0]).toContain('May naturally reference');
    expect(output.promptBlock).not.toContain('3c78729f-e52d-4dde-b27f-01a949960bb8b');
  });

  it('treats AI-private threads as private when visibility is not explicitly supplied', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'ai_direct',
      visibleMemoryRecall: 'natural',
    });

    expect(output.trace.visibility).toBe('private');
    expect(output.promptBlock).toContain('用户不喜欢太甜的饮料。');
    expect(output.promptBlock).toContain('和阿远有雨夜失约的旧事。');
    expect(output.promptBlock).not.toContain('User continuity exists');
  });

  it('turning visible recall off does not remove core character continuity', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'direct',
      visibility: 'private',
      visibleMemoryRecall: 'off',
    });

    expect(output.visibleRecallInput).toEqual([]);
    expect(output.coreContinuityBlock).toContain('Stable self');
    expect(output.coreContinuityBlock).toContain('User continuity');
    expect(output.promptBlock).toContain('用户不喜欢太甜的饮料。');
  });

  it('can summarize user continuity when companionship context owns the details', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection({
      relationship: {
        targetId: 'user',
        targetName: '用户',
        stance: ['更容易靠近、维护或给对方留余地。'],
        currentRoomPressure: [],
      },
    }), {
      chatType: 'direct',
      visibility: 'private',
      visibleMemoryRecall: 'off',
      summarizeUserContinuity: true,
    });

    expect(output.coreContinuityBlock).toContain('User details are handled by the companionship context');
    expect(output.coreContinuityBlock).toContain('User relationship details are handled by the companionship context');
    expect(output.coreContinuityBlock).toContain('Shared user history is handled by the companionship context');
    expect(output.coreContinuityBlock).not.toContain('用户不喜欢太甜的饮料。');
    expect(output.coreContinuityBlock).not.toContain('和阿远有雨夜失约的旧事。');
    expect(output.coreContinuityBlock).not.toContain('一起修过一次聊天节奏');
    expect(output.visibleRecallInput).toEqual([]);
  });

  it('does not summarize non-user target relationship details just because direct companionship is active', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'direct',
      visibility: 'private',
      visibleMemoryRecall: 'off',
      summarizeUserContinuity: true,
    });

    expect(output.coreContinuityBlock).toContain('User details are handled by the companionship context');
    expect(output.coreContinuityBlock).toContain('和阿远有雨夜失约的旧事。');
    expect(output.coreContinuityBlock).toContain('一起修过一次聊天节奏');
  });

  it('can suppress visible recall rendering while keeping selected cues for trace or migration', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'direct',
      visibility: 'private',
      visibleMemoryRecall: 'natural',
      renderVisibleRecallCues: false,
    });

    expect(output.visibleRecallInput.length).toBeGreaterThan(0);
    expect(output.promptBlock).not.toContain('## Visible Recall Cues');
    expect(output.promptBlock).toContain('## Core Character Continuity');
  });

  it('can render externally constrained recall cues inside the mind projection', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      visibility: 'public',
      visibleMemoryRecall: 'natural',
      visibleRecallCues: ['阿远上次主动给紧张的人留过台阶。 | Visible rule: 只作为语气和分寸参考。'],
      renderVisibleRecallCues: true,
    });

    expect(output.promptBlock).toContain('## Visible Recall Cues');
    expect(output.promptBlock).toContain('阿远上次主动给紧张的人留过台阶');
    expect(output.promptBlock).toContain('Visible rule');
    expect(output.visibleRecallInput).toHaveLength(1);
  });

  it('keeps room, world, and growth context available within a small budget', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      visibility: 'public',
      maxCoreLines: 4,
      maxRoomLines: 4,
      visibleMemoryRecall: 'off',
    });

    expect(output.currentRoomBlock).toContain('Current room topic');
    expect(output.currentRoomBlock).not.toContain('Active room lines');
    expect(output.currentRoomBlock).toContain('成长线');
    expect(output.currentRoomBlock).toContain('主线');
    expect(output.coreContinuityBlock.split('\n').length).toBeLessThanOrEqual(5);
  });

  it('can leave expression planning to the unified turn directive without dropping room evidence', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      visibility: 'public',
      includeExpressionGuidance: false,
    });

    expect(output.currentRoomBlock).toContain('Room pressure and constraints');
    expect(output.currentRoomBlock).not.toContain('Active room lines');
    expect(output.currentRoomBlock).not.toContain('Expression guidance');
    expect(output.currentRoomBlock).not.toContain('注意力暂时落在阿远');
  });

  it('reserves relationship and recorded-state evidence inside a small core budget', () => {
    const value = projection();
    value.relationship.targetName = '阿远';
    value.relationship.stance = ['面对阿远时会明显收敛锋芒'];
    value.continuity.relationshipMemories = ['阿远掌握最终裁决权'];
    const output = adaptCharacterMindProjectionForPrompt(value, {
      chatType: 'group',
      visibility: 'public',
      maxCoreLines: 4,
      visibleMemoryRecall: 'off',
    });

    expect(output.coreContinuityBlock).toContain('Stance toward 阿远');
    expect(output.coreContinuityBlock).toContain('面对阿远时会明显收敛锋芒');
    expect(output.coreContinuityBlock).toContain('Recorded emotional state');
  });

  it('can omit room topic when another prompt block already owns topic context', () => {
    const output = adaptCharacterMindProjectionForPrompt(projection(), {
      chatType: 'group',
      visibility: 'public',
      visibleMemoryRecall: 'off',
      includeRoomTopic: false,
    });

    expect(output.currentRoomBlock).not.toContain('Current room topic');
    expect(output.currentRoomBlock).not.toContain('Active room lines');
  });
});
