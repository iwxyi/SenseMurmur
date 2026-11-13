import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/useAuthStore';
import { canContinueConversationsInBackground, getBackgroundExecutionPreferences, getMaxBackgroundConversationsEntitled, setBackgroundExecutionMaxActiveConversations } from './backgroundExecutionPreferences';

const originalAuth = useAuthStore.getState();
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ authMode: originalAuth.authMode, user: originalAuth.user });
});

describe('background conversation preferences', () => {
  it('limits the saved choice by the current membership and keeps zero disabled', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    vi.stubGlobal('navigator', { locks: { request: vi.fn() } });
    useAuthStore.setState({ authMode: 'cloud', user: { id: 'test', phone: '', nickname: '', avatar: '', maxBackgroundConversations: 10 } });
    setBackgroundExecutionMaxActiveConversations(10);
    expect(getBackgroundExecutionPreferences().maxActiveConversations).toBe(10);
    useAuthStore.setState({ user: { id: 'test', phone: '', nickname: '', avatar: '', maxBackgroundConversations: 100 } });
    setBackgroundExecutionMaxActiveConversations(100);
    expect(getMaxBackgroundConversationsEntitled()).toBe(100);
    expect(getBackgroundExecutionPreferences().maxActiveConversations).toBe(100);
    useAuthStore.setState({ user: { id: 'test', phone: '', nickname: '', avatar: '', maxBackgroundConversations: 5 } });
    expect(getMaxBackgroundConversationsEntitled()).toBe(5);
    expect(getBackgroundExecutionPreferences().maxActiveConversations).toBe(5);
    setBackgroundExecutionMaxActiveConversations(0);
    expect(canContinueConversationsInBackground()).toBe(false);
    expect(getBackgroundExecutionPreferences().maxActiveConversations).toBe(0);
  });

  it('allows one slot in local mode and prevents background execution without Web Locks', () => {
    useAuthStore.setState({ authMode: 'local', user: null });
    expect(getMaxBackgroundConversationsEntitled()).toBe(1);
    vi.stubGlobal('navigator', {});
    expect(canContinueConversationsInBackground()).toBe(false);
  });
});
