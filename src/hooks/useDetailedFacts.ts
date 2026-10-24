import { useEffect, useState } from 'react';
import { listConversationDetailedFacts, listDetailedFacts, setDetailedFactArchived, setDetailedFactDeleted } from '../services/factualMemory';
import type { RecalledFact } from '../services/factualMemoryTypes';
import { reportRecoverableError } from '../services/diagnostics';

export function useDetailedFacts(characterId?: string, sourceChatId?: string) {
  const scopeKey = sourceChatId ? `chat:${sourceChatId}` : characterId ? `character:${characterId}` : '';
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    scopeKey: string;
    revision: number;
    items: RecalledFact[];
    error: string;
  }>();
  useEffect(() => {
    if (!sourceChatId && !characterId) return;
    let current = true;
    const request = sourceChatId ? listConversationDetailedFacts(sourceChatId) : listDetailedFacts(characterId!, undefined, true);
    void request.then((facts) => {
      if (current) setResult({ scopeKey, revision, items: facts.sort((a, b) => b.timestamp - a.timestamp), error: '' });
    }).catch((cause: unknown) => {
      if (current) setResult({ scopeKey, revision, items: [], error: '详细事实读取失败，请重试。' });
      reportRecoverableError({ location: sourceChatId ? 'chat.fact-archive' : 'character.fact-archive', error: cause, userMessage: '详细事实读取失败，请重试。' });
    });
    return () => { current = false; };
  }, [characterId, sourceChatId, scopeKey, revision]);
  const ready = result?.scopeKey === scopeKey && result?.revision === revision;
  return {
    items: ready ? result.items : [],
    loading: Boolean(scopeKey) && !ready,
    error: ready ? result.error : '',
    refresh: () => setRevision((value) => value + 1),
    setDeleted: async (fact: RecalledFact, deleted: boolean) => {
      if (deleted) setResult((value) => value?.scopeKey === scopeKey
        ? { ...value, items: value.items.filter((item) => item.id !== fact.id || item.chatId !== fact.chatId) } : value);
      try {
        await setDetailedFactDeleted(fact, deleted);
        if (!deleted) setRevision((value) => value + 1);
      } catch (cause) {
        setRevision((value) => value + 1);
        reportRecoverableError({ location: 'memory.fact-deletion', error: cause,
          userMessage: deleted ? '详细事实删除失败，原记录已保留。' : '详细事实撤销失败，请重试。' });
        throw cause;
      }
    },
    setArchived: async (fact: RecalledFact, archived: boolean) => {
      try {
        await setDetailedFactArchived(fact, archived);
        setRevision((value) => value + 1);
      } catch (cause) {
        reportRecoverableError({ location: 'memory.fact-lifecycle', error: cause, userMessage: '详细事实归档状态修改失败，请重试。' });
        throw cause;
      }
    },
  };
}
