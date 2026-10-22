import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { scopedStorageKey } from '../constants/brand';
import { createScopedIndexedDbBufferedJsonStorage } from './storePersistenceScope';
import type { FactArchiveEntry, FactEvidence } from '../services/factualMemoryTypes';

interface ChatFactArchive {
  nodes: Record<string, FactEvidence>;
  entries: Record<string, FactArchiveEntry>;
}

interface FactArchiveState {
  chats: Record<string, ChatFactArchive>;
  capture: (chatId: string, sources: FactEvidence[]) => void;
  save: (chatId: string, entry: FactArchiveEntry) => void;
  invalidate: (ids: string[]) => void;
  clearChat: (chatId: string) => void;
}

export const useFactArchiveStore = create<FactArchiveState>()(persist((set) => ({
  chats: {},
  capture: (chatId, sources) => set((state) => {
    const current = state.chats[chatId] || { nodes: {}, entries: {} };
    const nodes = { ...current.nodes };
    const recordedContent = new Map(Object.values(current.entries).flatMap((entry) => entry.sources.map((source) => [source.id, source.content] as const)));
    // Once captured, audience is historical evidence, never today's membership.
    for (const source of sources) {
      const previous = nodes[source.nodeId];
      const priorContent = previous?.content || recordedContent.get(source.id);
      nodes[source.nodeId] = { ...source, serverId: source.serverId || previous?.serverId,
        content: previous?.content || '', audience: previous?.audience || source.audience,
        invalid: previous?.invalid || source.invalid || (priorContent !== undefined && priorContent !== source.content) };
    }
    return { chats: { ...state.chats, [chatId]: { ...current, nodes } } };
  }),
  save: (chatId, entry) => set((state) => {
    const current = state.chats[chatId];
    if (!current) throw new Error('MEMORY_CAPTURE_MISSING');
    const usedSourceIds = new Set(entry.facts.flatMap((fact) => fact.sourceIds));
    const saved = { ...entry, sources: entry.sources.filter((source) => usedSourceIds.has(source.id)) };
    const entries = { ...current.entries, [entry.messageId]: saved };
    const retained = new Set(Object.values(entries).flatMap((item) => item.sources.map((source) => source.id)));
    const nodes = Object.fromEntries(Object.entries(current.nodes).map(([key, node]) => {
      const source = saved.sources.find((item) => item.nodeId === key);
      if (source) return [key, { ...node, content: source.content }];
      if (retained.has(node.id)) return [key, node];
      return [key, { ...node, content: '' }];
    }));
    return { chats: { ...state.chats, [chatId]: { ...current, nodes, entries } } };
  }),
  invalidate: (ids) => set((state) => ({ chats: Object.fromEntries(Object.entries(state.chats).map(([chatId, archive]) => [chatId, {
    ...archive,
    nodes: Object.fromEntries(Object.entries(archive.nodes).map(([key, node]) => [key, ids.includes(node.id) || ids.includes(node.nodeId) ? { ...node, invalid: true } : node])),
  }])) })),
  clearChat: (chatId) => set((state) => ({ chats: Object.fromEntries(Object.entries(state.chats).filter(([id]) => id !== chatId)) })),
}), {
  name: 'fact-archive',
  storage: createScopedIndexedDbBufferedJsonStorage<{ chats: FactArchiveState['chats'] }>({
    storageName: 'fact-archive', getScopedKey: () => scopedStorageKey('fact-archive'),
  }),
  partialize: (state) => ({ chats: state.chats }),
}));
