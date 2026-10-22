import { useEffect, useState } from 'react';
import { listDetailedFacts } from '../services/factualMemory';
import type { RecalledFact } from '../services/factualMemoryTypes';
import { reportRecoverableError } from '../services/diagnostics';

export function useDetailedFacts(characterId?: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    characterId: string;
    revision: number;
    items: RecalledFact[];
    error: string;
  }>();
  useEffect(() => {
    if (!characterId) return;
    let current = true;
    void listDetailedFacts(characterId).then((facts) => {
      if (current) setResult({ characterId, revision, items: facts.sort((a, b) => b.timestamp - a.timestamp), error: '' });
    }).catch((cause: unknown) => {
      if (current) setResult({ characterId, revision, items: [], error: '详细事实读取失败，请重试。' });
      reportRecoverableError({ location: 'character.fact-archive', error: cause, userMessage: '详细事实读取失败，请重试。' });
    });
    return () => { current = false; };
  }, [characterId, revision]);
  const ready = result?.characterId === characterId && result?.revision === revision;
  return {
    items: ready ? result.items : [],
    loading: Boolean(characterId) && !ready,
    error: ready ? result.error : '',
    refresh: () => setRevision((value) => value + 1),
  };
}
