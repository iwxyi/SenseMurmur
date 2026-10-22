export interface DetailedFact {
  text: string;
  status: 'asserted' | 'agreed' | 'proposed' | 'disputed';
  sourceIds: string[];
  mergedFrom?: FactReference[];
  retracted?: boolean;
}

export interface FactReference {
  messageId: string;
  factIndex: number;
}

export interface FactMergeCandidate extends FactReference {
  fact: DetailedFact;
}

export interface FactEvidence {
  id: string;
  serverId?: string;
  nodeId: string;
  parentNodeId?: string | null;
  content: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  audience: string[];
  invalid?: boolean;
}

export interface FactArchiveEntry {
  messageId: string;
  facts: DetailedFact[];
  sources: FactEvidence[];
  synced?: boolean;
}

export interface RecalledFact {
  id: string;
  text: string;
  status: DetailedFact['status'];
  timestamp: number;
  chatId: string;
  mergedFrom?: FactReference[];
  retracted?: boolean;
  knownByIds?: string[];
}

export function collapseMergedFacts<T extends { id: string; chatId: string; mergedFrom?: FactReference[]; retracted?: boolean }>(items: T[]): T[] {
  const replaced = new Set(items.flatMap((item) => (item.mergedFrom || [])
    .map((ref) => JSON.stringify([item.chatId, `${ref.messageId}:${ref.factIndex}`]))));
  return items.filter((item) => !replaced.has(JSON.stringify([item.chatId, item.id])) && !item.retracted);
}

export class FactExtractionValidationError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`MEMORY_FACT_INVALID: ${field}: ${reason}`);
    this.name = 'FactExtractionValidationError';
    this.field = field;
    this.reason = reason;
  }
}

export function parseDetailedFacts(raw: string, allowedIds: Set<string>, anchorId: string,
  onContextOnlyFact?: (error: FactExtractionValidationError) => void,
  mergeCandidates: Map<string, FactMergeCandidate> = new Map()): DetailedFact[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FactExtractionValidationError('response', 'expected one valid JSON object');
  }
  if (!value || typeof value !== 'object' || !('facts' in value) || !Array.isArray(value.facts) || value.facts.length > 6) {
    throw new FactExtractionValidationError('facts', 'expected an array containing at most 6 facts');
  }
  return value.facts.flatMap((item: unknown, index: number): DetailedFact[] => {
    const path = `facts[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FactExtractionValidationError(path, 'expected a fact object');
    const fact = item as Record<string, unknown>;
    if (fact.retracted !== undefined && typeof fact.retracted !== 'boolean') {
      throw new FactExtractionValidationError(`${path}.retracted`, 'expected a boolean');
    }
    if (typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 1200) {
      throw new FactExtractionValidationError(`${path}.text`, 'expected non-empty text of at most 1200 characters');
    }
    if (typeof fact.status !== 'string' || !['asserted', 'agreed', 'proposed', 'disputed'].includes(fact.status)) {
      throw new FactExtractionValidationError(`${path}.status`, 'expected asserted|agreed|proposed|disputed');
    }
    if (!Array.isArray(fact.sourceIds) || !fact.sourceIds.length || fact.sourceIds.length > 12) {
      throw new FactExtractionValidationError(`${path}.sourceIds`, 'expected 1 to 12 source message ids');
    }
    fact.sourceIds.forEach((id: unknown, sourceIndex: number) => {
      if (typeof id !== 'string' || !allowedIds.has(id)) throw new FactExtractionValidationError(
        `${path}.sourceIds[${sourceIndex}]`, 'expected an exact id from the supplied messages; names and invented ids are not allowed');
    });
    if (!fact.sourceIds.includes(anchorId)) {
      const error = new FactExtractionValidationError(`${path}.sourceIds`, 'must include newMessageId; context-only fact excluded');
      if (!onContextOnlyFact) throw error;
      onContextOnlyFact(error);
      return [];
    }
    const mergedFrom: FactReference[] = [];
    if (fact.mergeWith !== undefined) {
      if (!Array.isArray(fact.mergeWith) || fact.mergeWith.length > 6) {
        throw new FactExtractionValidationError(`${path}.mergeWith`, 'expected at most 6 supplied fact references');
      }
      for (const key of new Set(fact.mergeWith)) {
        const candidate = typeof key === 'string' ? mergeCandidates.get(key) : undefined;
        if (!candidate || candidate.fact.retracted || candidate.fact.status !== fact.status
          || !candidate.fact.sourceIds.every((id) => (fact.sourceIds as unknown[]).includes(id))) {
          throw new FactExtractionValidationError(`${path}.mergeWith`, 'merge must reference a supplied fact with the same status and retain all its evidence');
        }
        mergedFrom.push({ messageId: candidate.messageId, factIndex: candidate.factIndex });
      }
    }
    if (fact.retracted === true && !mergedFrom.length) {
      throw new FactExtractionValidationError(`${path}.mergeWith`, 'retraction must reference an existing fact');
    }
    return [{ text: fact.text.trim(), status: fact.status as DetailedFact['status'], sourceIds: [...new Set(fact.sourceIds)] as string[],
      ...(mergedFrom.length ? { mergedFrom } : {}), ...(fact.retracted === true ? { retracted: true } : {}) }];
  });
}
