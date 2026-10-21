import type { AICharacter } from '../types/character';
import type { DriverMessageCommitResult, GroupChat } from '../types/chat';
import type { APIConfig } from '../types/settings';
import { consolidateMemoryCandidates } from './memoryConsolidation';
import { createMemoryDistillationRuntimeEvent, localizeDistillationEventInfo, shouldEmitMemoryDistillationEvent } from './memoryDistillation';
import {
  buildLlmDistillationSource,
  debugLlmCharacterDistillation,
  debugLlmChatDistillation,
  distillCharacterCoreProfileWithLlm,
  distillCharacterMemoriesWithLlm,
  distillChatMemoriesWithLlm,
  shouldRunLlmCharacterDistillation,
  shouldRunLlmChatDistillation,
} from './llmMemoryDistillation';
import { createRuntimeMemoryTimer, recordRuntimeMemoryIfEnabled } from './runtimeMemoryTimer';
import type { MemoryCandidate } from './memoryTypes';
import { normalizeRuntimeSeedArtifactLines } from './runtimeSeed';
import { reportRecoverableError } from './diagnostics';

interface DeferredMemoryAnalysisState {
  running: boolean;
  rerunRequested: boolean;
  lastSettledFingerprint: string | null;
  cancelled: boolean;
}

const deferredMemoryAnalysisStates = new Map<string, DeferredMemoryAnalysisState>();
const deferredMemoryAnalysisTasks = new Set<Promise<void>>();

function getDeferredMemoryAnalysisState(ownerKey: string) {
  const existing = deferredMemoryAnalysisStates.get(ownerKey);
  if (existing) return existing;
  const created: DeferredMemoryAnalysisState = {
    running: false,
    rerunRequested: false,
    lastSettledFingerprint: null,
    cancelled: false,
  };
  deferredMemoryAnalysisStates.set(ownerKey, created);
  return created;
}

function buildAnalysisOwnerKey(ownerType: 'chat' | 'character', ownerId: string) {
  return `${ownerType}:${ownerId}`;
}

function buildMemoryAnalysisFingerprint(owner: { layeredMemories?: AICharacter['layeredMemories'] | GroupChat['layeredMemories'] }, ownerType: 'chat' | 'character') {
  const source = buildLlmDistillationSource(owner, ownerType);
  if (!source.length) return '';
  return source
    .map((item) => [
      item.id,
      item.updatedAt,
      item.distilledAt || 0,
      item.sourceTag || '',
      (item.sourceEventIds || []).join(','),
    ].join(':'))
    .join('|');
}

function uniqueSeedLines(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function buildArtifactSeedPatch(chat: GroupChat, distilled: MemoryCandidate[]) {
  const artifacts = normalizeRuntimeSeedArtifactLines(distilled
    .filter((item) => item.kind === 'artifact' && (item.scoreBreakdown?.specificity || 0) >= 0.7 && (item.scoreBreakdown?.durability || 0) >= 0.7)
    .map((item) => item.text.trim())
    .filter(Boolean));
  if (!artifacts.length) return null;
  const nextArtifacts = uniqueSeedLines([...(chat.runtimeSeed?.artifacts || []), ...artifacts]).slice(-8);
  if (nextArtifacts.join('\n') === (chat.runtimeSeed?.artifacts || []).join('\n')) return null;
  return {
    runtimeSeed: {
      notes: chat.runtimeSeed?.notes || [],
      artifacts: nextArtifacts,
    },
  } satisfies Partial<GroupChat>;
}

function scheduleDeferredMemoryAnalysis(ownerKey: string, runner: (state: DeferredMemoryAnalysisState) => Promise<void>) {
  const state = getDeferredMemoryAnalysisState(ownerKey);
  if (state.cancelled) return;
  state.rerunRequested = true;
  if (state.running) return;
  state.running = true;
  const task = Promise.resolve().then(async () => {
    try {
      while (!state.cancelled && state.rerunRequested) {
        state.rerunRequested = false;
        await runner(state);
      }
    } catch (error) {
      reportRecoverableError({
        location: 'memory-analysis.deferred-run',
        error,
        userMessage: '记忆沉淀失败，已保留原始聊天。',
        extra: { ownerKey },
      });
    } finally {
      state.running = false;
      state.rerunRequested = false;
      deferredMemoryAnalysisTasks.delete(task);
    }
  });
  deferredMemoryAnalysisTasks.add(task);
  void task;
}

export function __resetDeferredMemoryAnalysisStateForTests() {
  deferredMemoryAnalysisStates.forEach((state) => {
    state.cancelled = true;
    state.rerunRequested = false;
  });
  deferredMemoryAnalysisStates.clear();
}

export async function __flushDeferredMemoryAnalysisForTests() {
  await Promise.allSettled(Array.from(deferredMemoryAnalysisTasks));
}

export function getDeferredMemoryAnalysisDebugState() {
  let running = 0;
  let rerunRequested = 0;
  let cancelled = 0;
  for (const state of deferredMemoryAnalysisStates.values()) {
    if (state.running) running += 1;
    if (state.rerunRequested) rerunRequested += 1;
    if (state.cancelled) cancelled += 1;
  }
  return {
    stateCount: deferredMemoryAnalysisStates.size,
    taskCount: deferredMemoryAnalysisTasks.size,
    running,
    rerunRequested,
    cancelled,
  };
}

export async function scheduleAsyncMemoryAnalysis(params: {
  api: APIConfig;
  chat: GroupChat;
  characters: AICharacter[];
  characterIdsToCheck?: string[];
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  updateCharacter: (id: string, patch: Partial<AICharacter>) => Promise<void>;
  appendEventMessage: (chatId: string, payload: DriverMessageCommitResult['runtimeEvents'][number], sourceMessageId?: string) => Promise<void>;
  sourceMessageId?: string;
  getCurrentChat?: (id: string) => GroupChat | undefined;
  getCurrentCharacters?: () => AICharacter[];
}) {
  const getCurrentCharacters = () => params.getCurrentCharacters?.() || params.characters;
  const getCurrentChat = () => params.getCurrentChat?.(params.chat.id) || params.chat;

  scheduleDeferredMemoryAnalysis(buildAnalysisOwnerKey('chat', params.chat.id), async (state) => {
    const currentChat = getCurrentChat();
    if (!shouldRunLlmChatDistillation(currentChat, 0)) {
      recordRuntimeMemoryIfEnabled('llm-distillation-chat:skip', {
        chatId: currentChat.id,
        chat: currentChat,
        characters: getCurrentCharacters(),
        extra: { reason: 'not-eligible' },
      });
      return;
    }
    const startFingerprint = buildMemoryAnalysisFingerprint(currentChat, 'chat');
    if (!startFingerprint || state.lastSettledFingerprint === startFingerprint) {
      recordRuntimeMemoryIfEnabled('llm-distillation-chat:skip', {
        chatId: currentChat.id,
        chat: currentChat,
        characters: getCurrentCharacters(),
        extra: {
          reason: !startFingerprint ? 'empty-fingerprint' : 'same-fingerprint',
          fingerprintLength: startFingerprint.length,
        },
      });
      return;
    }

    const timer = createRuntimeMemoryTimer('llm-distillation-chat', {
      chatId: currentChat.id,
      chat: currentChat,
      characters: getCurrentCharacters(),
      extra: { fingerprintLength: startFingerprint.length },
    });
    const distilled = await distillChatMemoriesWithLlm(params.api, currentChat);
    timer.mark('after-generate', {
      chat: getCurrentChat(),
      characters: getCurrentCharacters(),
      extra: { distilledCount: distilled.length },
    });
    const latestChat = getCurrentChat();
    const latestFingerprint = buildMemoryAnalysisFingerprint(latestChat, 'chat');
    if (!latestFingerprint) {
      timer.finish({
        chat: latestChat,
        characters: getCurrentCharacters(),
        extra: { result: 'empty-latest-fingerprint' },
      });
      return;
    }
    if (latestFingerprint !== startFingerprint) {
      state.rerunRequested = true;
      timer.finish({
        chat: latestChat,
        characters: getCurrentCharacters(),
        extra: { result: 'fingerprint-changed', latestFingerprintLength: latestFingerprint.length },
      });
      return;
    }

    state.lastSettledFingerprint = startFingerprint;
    if (!distilled.length) {
      timer.finish({
        chat: latestChat,
        characters: getCurrentCharacters(),
        extra: { result: 'empty-distilled' },
      });
      return;
    }

    const layeredMemories = consolidateMemoryCandidates(latestChat.layeredMemories || [], distilled);
    timer.mark('after-consolidate', {
      chat: { ...latestChat, layeredMemories } as GroupChat,
      characters: getCurrentCharacters(),
      extra: { layeredMemoryCount: layeredMemories.length },
    });
    const artifactSeedPatch = buildArtifactSeedPatch(latestChat, distilled);
    await params.updateChat(latestChat.id, {
      layeredMemories,
      ...(artifactSeedPatch || {}),
    });
    timer.mark('after-update-chat', {
      chat: getCurrentChat(),
      characters: getCurrentCharacters(),
      extra: { layeredMemoryCount: layeredMemories.length },
    });

    const llmDebug = debugLlmChatDistillation({ ...latestChat, layeredMemories } as GroupChat);
    const llmSource = buildLlmDistillationSource({ layeredMemories }, 'chat');
    const llmInfo = {
      ownerType: 'chat' as const,
      ownerId: latestChat.id,
      ownerName: latestChat.name,
      triggered: true,
      reason: 'llm_distilled',
      eligibleCount: llmDebug.eligibleCount,
      newEvidenceCount: Array.from(new Set(llmSource.flatMap((item) => item.sourceEventIds || []))).length,
      candidateTexts: distilled.map((item) => item.text),
    };
    if (!shouldEmitMemoryDistillationEvent(llmInfo)) {
      timer.finish({
        chat: getCurrentChat(),
        characters: getCurrentCharacters(),
        extra: { result: 'event-not-emitted', eligibleCount: llmInfo.eligibleCount, newEvidenceCount: llmInfo.newEvidenceCount },
      });
      return;
    }

    const participants = getCurrentCharacters().map((item) => ({ id: item.id, name: item.name }));
    await params.appendEventMessage(
      latestChat.id,
      createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(llmInfo, participants)),
      params.sourceMessageId,
    );
    timer.finish({
      chat: getCurrentChat(),
      characters: getCurrentCharacters(),
      extra: { result: 'event-emitted', eligibleCount: llmInfo.eligibleCount, newEvidenceCount: llmInfo.newEvidenceCount },
    });
  });

  const characterIdsToCheck = new Set(params.characterIdsToCheck || []);
  for (const characterId of characterIdsToCheck) {
    const seedCharacter = getCurrentCharacters().find((item) => item.id === characterId) || params.characters.find((item) => item.id === characterId);
    if (!seedCharacter) continue;
    scheduleDeferredMemoryAnalysis(buildAnalysisOwnerKey('character', characterId), async (state) => {
      const currentCharacter = getCurrentCharacters().find((item) => item.id === characterId) || seedCharacter;
      if (!shouldRunLlmCharacterDistillation(currentCharacter, 0)) {
        recordRuntimeMemoryIfEnabled('llm-distillation-character:skip', {
          chatId: params.chat.id,
          speakerId: characterId,
          characters: [currentCharacter],
          extra: { reason: 'not-eligible' },
        });
        return;
      }
      const startFingerprint = buildMemoryAnalysisFingerprint(currentCharacter, 'character');
      if (!startFingerprint || state.lastSettledFingerprint === startFingerprint) {
        recordRuntimeMemoryIfEnabled('llm-distillation-character:skip', {
          chatId: params.chat.id,
          speakerId: characterId,
          characters: [currentCharacter],
          extra: {
            reason: !startFingerprint ? 'empty-fingerprint' : 'same-fingerprint',
            fingerprintLength: startFingerprint.length,
          },
        });
        return;
      }

      const timer = createRuntimeMemoryTimer('llm-distillation-character', {
        chatId: params.chat.id,
        speakerId: characterId,
        characters: [currentCharacter],
        extra: { fingerprintLength: startFingerprint.length },
      });
      const [distilled, coreProfile] = await Promise.all([
        distillCharacterMemoriesWithLlm(params.api, currentCharacter),
        distillCharacterCoreProfileWithLlm(params.api, currentCharacter),
      ]);
      timer.mark('after-generate', {
        characters: [getCurrentCharacters().find((item) => item.id === characterId) || currentCharacter],
        extra: { distilledCount: distilled.length, coreProfileUpdated: Boolean(coreProfile) },
      });
      const latestCharacter = getCurrentCharacters().find((item) => item.id === characterId) || currentCharacter;
      const latestFingerprint = buildMemoryAnalysisFingerprint(latestCharacter, 'character');
      if (!latestFingerprint) {
        timer.finish({
          characters: [latestCharacter],
          extra: { result: 'empty-latest-fingerprint' },
        });
        return;
      }
      if (latestFingerprint !== startFingerprint) {
        state.rerunRequested = true;
        timer.finish({
          characters: [latestCharacter],
          extra: { result: 'fingerprint-changed', latestFingerprintLength: latestFingerprint.length },
        });
        return;
      }

      state.lastSettledFingerprint = startFingerprint;
      if (!distilled.length && !coreProfile) {
        timer.finish({
          characters: [latestCharacter],
          extra: { result: 'empty-distilled' },
        });
        return;
      }

      const layeredMemories = consolidateMemoryCandidates(latestCharacter.layeredMemories || [], distilled);
      timer.mark('after-consolidate', {
        characters: [{ ...latestCharacter, layeredMemories, ...(coreProfile ? { coreProfile } : {}) } as AICharacter],
        extra: { layeredMemoryCount: layeredMemories.length },
      });
      await params.updateCharacter(latestCharacter.id, { layeredMemories, ...(coreProfile ? { coreProfile } : {}) });
      timer.mark('after-update-character', {
        characters: [getCurrentCharacters().find((item) => item.id === characterId) || latestCharacter],
        extra: { layeredMemoryCount: layeredMemories.length },
      });

      const llmDebug = debugLlmCharacterDistillation({ ...latestCharacter, layeredMemories } as AICharacter);
      const llmSource = buildLlmDistillationSource({ layeredMemories }, 'character');
      const llmInfo = {
        ownerType: 'character' as const,
        ownerId: latestCharacter.id,
        ownerName: latestCharacter.name,
        triggered: true,
        reason: 'llm_distilled',
        eligibleCount: llmDebug.eligibleCount,
        newEvidenceCount: Array.from(new Set(llmSource.flatMap((item) => item.sourceEventIds || []))).length,
        candidateTexts: distilled.map((item) => item.text),
      };
      if (!shouldEmitMemoryDistillationEvent(llmInfo)) {
        timer.finish({
          characters: [getCurrentCharacters().find((item) => item.id === characterId) || latestCharacter],
          extra: { result: 'event-not-emitted', eligibleCount: llmInfo.eligibleCount, newEvidenceCount: llmInfo.newEvidenceCount },
        });
        return;
      }

      const participants = getCurrentCharacters().map((item) => ({ id: item.id, name: item.name }));
      await params.appendEventMessage(
        params.chat.id,
        createMemoryDistillationRuntimeEvent(localizeDistillationEventInfo(llmInfo, participants)),
        params.sourceMessageId,
      );
      timer.finish({
        characters: [getCurrentCharacters().find((item) => item.id === characterId) || latestCharacter],
        extra: { result: 'event-emitted', eligibleCount: llmInfo.eligibleCount, newEvidenceCount: llmInfo.newEvidenceCount },
      });
    });
  }
}
