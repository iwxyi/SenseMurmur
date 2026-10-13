import { useEffect, useRef } from 'react';
import type { GroupChat } from '../types/chat';

const AUTO_SOCIAL_EVENT_KINDS = new Set([
  'pair_private_thread',
  'post_moment',
  'status_update',
  'check_in',
  'react_to_moment',
  'social_outing',
  'gift_exchange',
  'conflict_expression',
]);

const PENDING_AUTO_SOCIAL_DELAY_MS = 8_000;
const WORLD_SOCIAL_TICK_MIN_IDLE_MS = 2 * 60 * 60_000;
const WORLD_SOCIAL_TICK_READY_DELAY_MS = 12_000;

interface UseChatAutoSocialFlowParams {
  chat: GroupChat | undefined;
  runAutoSocialEventFlow: (chat: GroupChat) => Promise<unknown>;
  onError: (error: unknown) => void;
}

function hasHandledSocialEventMarker(chat: GroupChat, eventId: string) {
  return (chat.runtimeEventsV2 || []).some((event) => (
    event.kind === 'artifact'
    && event.summary === `handled_social_event:${eventId}`
  ));
}

export function hasPendingAutoSocialEventCandidate(chat: GroupChat) {
  return getPendingCandidateIds(chat).length > 0;
}

function getPendingCandidateIds(chat: GroupChat) {
  return (chat.runtimeEventsV2 || []).filter((event) => {
    if (event.kind !== 'event_candidate' || !event.id || hasHandledSocialEventMarker(chat, event.id)) return false;
    const eventKind = (event.payload as { eventKind?: unknown } | null | undefined)?.eventKind;
    return typeof eventKind === 'string' && AUTO_SOCIAL_EVENT_KINDS.has(eventKind);
  }).map((event) => event.id);
}

export function getAutoSocialFlowDelayMs(chat: GroupChat, now = Date.now()) {
  if (hasPendingAutoSocialEventCandidate(chat)) return PENDING_AUTO_SOCIAL_DELAY_MS;
  const updatedAt = typeof chat.updatedAt === 'number' ? chat.updatedAt : now;
  const idleMs = Math.max(0, now - updatedAt);
  if (idleMs >= WORLD_SOCIAL_TICK_MIN_IDLE_MS) return WORLD_SOCIAL_TICK_READY_DELAY_MS;
  return WORLD_SOCIAL_TICK_MIN_IDLE_MS - idleMs;
}

function getSchedule(chat: GroupChat | undefined) {
  if (!chat || chat.type !== 'group') return null;
  const pendingIds = getPendingCandidateIds(chat);
  if (pendingIds.length) {
    return { mode: 'candidate', key: JSON.stringify([chat.id, pendingIds]), delayMs: PENDING_AUTO_SOCIAL_DELAY_MS };
  }
  if (!chat.isActive) return null;
  return { mode: 'world', key: JSON.stringify([chat.id, chat.updatedAt]), delayMs: getAutoSocialFlowDelayMs(chat) };
}

export function createChatAutoSocialScheduler() {
  let latest: UseChatAutoSocialFlowParams | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled: { chatId: string; mode: string; key: string } | undefined;
  let lastAttemptKey: string | undefined;
  let running = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    scheduled = undefined;
  };

  const reconcile = () => {
    const chat = latest?.chat;
    const plan = getSchedule(chat);
    if (disposed || !chat || !plan || plan.key === lastAttemptKey) {
      clearTimer();
      return;
    }
    if (running) return;
    // Keep the pending candidate deadline while messages and callbacks change.
    if (scheduled && scheduled.chatId === chat.id && scheduled.mode === plan.mode
      && (plan.mode === 'candidate' || scheduled.key === plan.key)) return;
    clearTimer();
    scheduled = { chatId: chat.id, mode: plan.mode, key: plan.key };
    timer = setTimeout(() => { void run(); }, plan.delayMs);
  };

  const run = async () => {
    clearTimer();
    const current = latest;
    const plan = getSchedule(current?.chat);
    if (disposed || running || !current?.chat || !plan || plan.key === lastAttemptKey) return;
    lastAttemptKey = plan.key;
    running = true;
    try {
      await current.runAutoSocialEventFlow(current.chat);
    } catch (error) {
      current.onError(error);
    } finally {
      running = false;
      reconcile();
    }
  };

  return {
    update(params: UseChatAutoSocialFlowParams) {
      latest = params;
      reconcile();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

export function useChatAutoSocialFlow(params: UseChatAutoSocialFlowParams) {
  const schedulerRef = useRef<ReturnType<typeof createChatAutoSocialScheduler> | null>(null);
  const chatId = params.chat?.id;
  useEffect(() => {
    const scheduler = createChatAutoSocialScheduler();
    schedulerRef.current = scheduler;
    return () => {
      scheduler.dispose();
      schedulerRef.current = null;
    };
  }, [chatId]);
  useEffect(() => {
    schedulerRef.current?.update(params);
  }, [params]);
}
