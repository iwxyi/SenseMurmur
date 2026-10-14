import { describe, expect, it } from 'vitest';
import { DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE, normalizeConversation } from '../types/chat';
import { buildLearningProgressSnapshot, mergeLearningKnowledgeFromArtifacts, recordLearningAttempt, recordLearningEvidence } from './learningProgressRuntime';

const chat = normalizeConversation({
  id: 'learning-1', type: 'group', mode: 'classroom', modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG, modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
  name: '学习进步', topic: '掌握数据库索引', style: 'free', runtimeEvolutionIntensity: 'slow',
  memberIds: ['user', 'teacher'], speed: 1, isActive: true, allowIntervention: false,
  topicSeed: '', createdAt: 1, updatedAt: 1, lastMessageAt: 1,
  sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' },
  scenarioState: { learning: { goal: '掌握数据库索引', knowledgeItems: [] } },
});

describe('learning progress runtime', () => {
  it('projects headings from generated study artifacts into knowledge state', () => {
    const patch = mergeLearningKnowledgeFromArtifacts(chat, [{
      id: 'artifact-1', chatId: chat.id, kind: 'document', title: '数据库索引知识地图', currentVersionId: 'v1', sourceMessageId: 'm1', createdAt: 1, updatedAt: 1,
      versions: [{ id: 'v1', artifactId: 'artifact-1', sourceMessageId: 'm1', createdAt: 1, content: '# 索引基础\n## B+树\n## 覆盖索引' }],
    }]);
    expect(patch.scenarioState?.learning?.knowledgeItems.map((item) => item.title)).toEqual(['索引基础', 'B+树', '覆盖索引']);
  });

  it('records evidence and attempts without claiming mastery automatically', () => {
    const mapped = mergeLearningKnowledgeFromArtifacts(chat, [{
      id: 'artifact-2', chatId: chat.id, kind: 'document', title: '索引地图', currentVersionId: 'v1', sourceMessageId: 'm1', createdAt: 1, updatedAt: 1,
      versions: [{ id: 'v1', artifactId: 'artifact-2', sourceMessageId: 'm1', createdAt: 1, content: '# B+树' }],
    }]);
    const mappedChat = normalizeConversation({ ...chat, ...mapped });
    const knowledgeId = mappedChat.scenarioState?.learning?.knowledgeItems[0]?.id || '';
    const evidencePatch = recordLearningEvidence(mappedChat, { id: 'e1', kind: 'answer', summary: '能解释 B+树叶子节点', knowledgeItemIds: [knowledgeId], createdAt: 2 });
    const evidenceChat = normalizeConversation({ ...mappedChat, ...evidencePatch });
    expect(evidenceChat.scenarioState?.learning?.knowledgeItems[0]?.status).toBe('practicing');
    expect(evidenceChat.scenarioState?.learning?.evidence).toHaveLength(1);
    const attemptPatch = recordLearningAttempt(evidenceChat, { id: 'attempt-1', status: 'graded', score: 2, maxScore: 3, createdAt: 3, gradedAt: 4 });
    const finalChat = normalizeConversation({ ...evidenceChat, ...attemptPatch });
    expect(finalChat.scenarioState?.learning?.attempts?.[0]?.score).toBe(2);
    expect(buildLearningProgressSnapshot(finalChat)?.counts.practicing).toBe(1);
  });
});
