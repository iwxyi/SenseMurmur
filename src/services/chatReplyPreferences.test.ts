import { describe, expect, it } from 'vitest';
import type { GroupChat } from '../types/chat';
import { DEFAULT_CHAT_REPLY_PREFERENCE_TEXT, normalizeChatReplyPreferences } from '../types/chatReplyPreferences';
import { buildChatReplyPreferencesPrompt } from './chatReplyPreferences';

const chat = { type: 'group', mode: 'open_chat' } as const;

describe('chat reply preferences', () => {
  it('uses the current default for legacy settings and preserves an explicitly empty custom preference', () => {
    expect(buildChatReplyPreferencesPrompt(chat, undefined)).toContain(DEFAULT_CHAT_REPLY_PREFERENCE_TEXT);
    expect(buildChatReplyPreferencesPrompt(chat, { mode: 'custom', text: '' })).toBe('');
    expect(normalizeChatReplyPreferences({ mode: 'custom', text: '' })).toEqual({ mode: 'custom', text: '' });
  });

  it('uses custom preferences and preserves the priority of chat rules', () => {
    const preferences = { mode: 'custom', text: '正式一些，必要时分点。' } as const;
    const prompt = buildChatReplyPreferencesPrompt(chat, preferences);
    expect(prompt).toContain(preferences.text);
    expect(prompt).toContain('explicit user requests');
    expect(prompt).not.toContain(DEFAULT_CHAT_REPLY_PREFERENCE_TEXT);
    expect(buildChatReplyPreferencesPrompt(chat, { ...preferences, mode: 'off' })).toBe('');
  });

  it.each(['open_chat', 'interview', 'group_discussion', 'roundtable', 'classroom', 'werewolf', 'murder_mystery', 'board_game', 'scripted_play', 'bargaining', 'service_roleplay'] as GroupChat['mode'][])(
    'applies chat preferences to non-Agent mode %s', (mode) => {
      expect(buildChatReplyPreferencesPrompt({ ...chat, mode }, undefined)).toContain(DEFAULT_CHAT_REPLY_PREFERENCE_TEXT);
    },
  );

  it.each(['direct', 'ai_direct', 'assistant'] as const)('applies chat preferences to %s', (type) => {
    expect(buildChatReplyPreferencesPrompt({ ...chat, type }, undefined)).toContain(DEFAULT_CHAT_REPLY_PREFERENCE_TEXT);
  });

  it('excludes Agent sessions by both current family and legacy mode', () => {
    expect(buildChatReplyPreferencesPrompt({ ...chat, mode: 'agent_workflow' }, undefined)).toBe('');
    expect(buildChatReplyPreferencesPrompt({ ...chat, sessionKind: { topology: 'group', surfaceProfile: 'dashboard', family: 'agent', scenarioId: 'single-agent-workflow' } }, undefined)).toBe('');
    expect(buildChatReplyPreferencesPrompt({ ...chat, sessionKind: { topology: 'team', surfaceProfile: 'dashboard', family: 'agent', scenarioId: 'multi-agent-workflow' } }, undefined)).toBe('');
  });

  it('includes story-reader sessions even though they use a separate prompt assembly', () => {
    expect(buildChatReplyPreferencesPrompt({ ...chat, sessionKind: { topology: 'group', surfaceProfile: 'hybrid', family: 'conversation', scenarioId: 'story-reader' } }, undefined)).toContain(DEFAULT_CHAT_REPLY_PREFERENCE_TEXT);
  });
});
