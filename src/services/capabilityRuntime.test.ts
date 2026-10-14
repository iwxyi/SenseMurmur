import { describe, expect, it } from 'vitest';
import { DEFAULT_OPEN_CHAT_MODE_CONFIG, DEFAULT_OPEN_CHAT_MODE_STATE, normalizeConversation } from '../types/chat';
import { resolveRoomCapabilities, resolveStudyParticipantProfile } from './capabilityRuntime';

function chat(patch: Record<string, unknown> = {}) {
  return normalizeConversation({
    id: 'capability-room', type: 'group', mode: 'classroom', modeConfig: DEFAULT_OPEN_CHAT_MODE_CONFIG, modeState: DEFAULT_OPEN_CHAT_MODE_STATE,
    name: '学习进步验证房', topic: '学习目标', style: 'free', runtimeEvolutionIntensity: 'slow',
    memberIds: ['user', 'teacher'], speed: 1, isActive: true, allowIntervention: false,
    topicSeed: '', createdAt: 1, updatedAt: 1, lastMessageAt: 1,
    sessionKind: { topology: 'group', family: 'study', scenarioId: 'learning-progress', surfaceProfile: 'hybrid' },
    ...patch,
  });
}

describe('cross-play capability runtime', () => {
  it('enables study capabilities without turning the room into an agent workflow', () => {
    const capabilities = resolveRoomCapabilities({ chat: chat() });
    expect(capabilities.knowledge.mode).toBe('assisted');
    expect(capabilities.artifacts.mode).toBe('assisted');
    expect(capabilities.media.mode).toBe('assisted');
    expect(capabilities.workflow.mode).toBe('off');
  });

  it('keeps existing conversation capability semantics available to legacy rooms', () => {
    const capabilities = resolveRoomCapabilities({
      chat: chat({ mode: 'open_chat', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }),
    });
    expect(capabilities.artifacts.mode).toBe('off');
    expect(capabilities.memory.mode).toBe('assisted');
  });

  it('derives study artifact capabilities from the classroom mode even when session metadata is stale', () => {
    const capabilities = resolveRoomCapabilities({
      chat: chat({ mode: 'classroom', sessionKind: { topology: 'group', family: 'conversation', scenarioId: 'open-chat', surfaceProfile: 'text' } }),
    });
    expect(capabilities['html-interactive'].mode).toBe('assisted');
    expect(capabilities.artifacts.mode).toBe('assisted');
  });

  it('gates optional tools by entitlement', () => {
    const capabilities = resolveRoomCapabilities({ chat: chat(), templateCapabilities: { 'web-search': 'assisted' }, entitlements: { webSearch: false } });
    expect(capabilities['web-search'].mode).toBe('off');
    expect(capabilities['web-search'].reason).toBe('entitlement');
  });

  it('separates teacher identity from study duties and supports entertaining teachers', () => {
    expect(resolveStudyParticipantProfile({ actorId: 'character-x', role: 'teacher', teachingMode: 'entertainment', canAssess: false })).toMatchObject({
      role: 'teacher', teachingMode: 'entertainment', canAssess: false, canWriteKnowledge: true,
    });
  });
});
