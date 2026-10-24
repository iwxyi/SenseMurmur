export interface DetailedFact {
  title?: string;
  userDeleted?: boolean;
  lifecycle?: 'ongoing' | 'temporary';
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
  title?: string;
  userDeleted?: boolean;
  lifecycle?: 'ongoing' | 'temporary';
  archived?: boolean;
  id: string;
  text: string;
  status: DetailedFact['status'];
  timestamp: number;
  archivedAt?: number;
  chatId: string;
  mergedFrom?: FactReference[];
  retracted?: boolean;
  knownByIds?: string[];
}

export function collapseMergedFacts<T extends { id: string; chatId: string; mergedFrom?: FactReference[]; retracted?: boolean; userDeleted?: boolean }>(items: T[]): T[] {
  const replaced = new Set(items.flatMap((item) => (item.mergedFrom || [])
    .map((ref) => JSON.stringify([item.chatId, `${ref.messageId}:${ref.factIndex}`]))));
  const deleted = new Set(items.filter((item) => item.userDeleted).map((item) => JSON.stringify([item.chatId, item.id])));
  return items.filter((item) => !replaced.has(JSON.stringify([item.chatId, item.id])) && !item.retracted
    && !deleted.has(JSON.stringify([item.chatId, item.id])));
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
    if (fact.title !== undefined && (typeof fact.title !== 'string' || !fact.title.trim() || fact.title.length > 80)) {
      throw new FactExtractionValidationError(`${path}.title`, 'expected non-empty title of at most 80 characters');
    }
    if (fact.retracted !== undefined && typeof fact.retracted !== 'boolean') {
      throw new FactExtractionValidationError(`${path}.retracted`, 'expected a boolean');
    }
    if (fact.lifecycle !== undefined && !['ongoing', 'temporary'].includes(String(fact.lifecycle))) {
      throw new FactExtractionValidationError(`${path}.lifecycle`, 'expected ongoing|temporary');
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
    let inheritedLifecycle: DetailedFact['lifecycle'];
    const sourceIds = new Set(fact.sourceIds as string[]);
    if (fact.mergeWith !== undefined) {
      if (!Array.isArray(fact.mergeWith) || fact.mergeWith.length > 6) {
        throw new FactExtractionValidationError(`${path}.mergeWith`, 'expected at most 6 supplied fact references');
      }
      for (const [mergeIndex, key] of [...new Set(fact.mergeWith)].entries()) {
        const mergePath = `${path}.mergeWith[${mergeIndex}]`;
        const candidate = typeof key === 'string' ? mergeCandidates.get(key) : undefined;
        if (!candidate) {
          throw new FactExtractionValidationError(mergePath,
            `expected an exact existingFacts ref; available refs: ${[...mergeCandidates.keys()].join(', ') || '(none)'}`);
        }
        if (candidate.fact.retracted) {
          throw new FactExtractionValidationError(mergePath, `referenced fact ${key} is retracted and cannot be merged`);
        }
        if (candidate.fact.status !== fact.status) {
          throw new FactExtractionValidationError(mergePath,
            `referenced fact ${key} has status ${candidate.fact.status}, received ${fact.status}; merge only matching statuses, otherwise record the change separately`);
        }
        inheritedLifecycle ||= candidate.fact.lifecycle;
        // A valid reference already identifies its evidence. Inherit it rather
        // than making the model recopy provenance, but never invent new evidence.
        for (const id of candidate.fact.sourceIds) {
          if (!allowedIds.has(id)) {
            throw new FactExtractionValidationError(mergePath, `referenced fact ${key} has evidence outside the supplied messages`);
          }
          sourceIds.add(id);
        }
        mergedFrom.push({ messageId: candidate.messageId, factIndex: candidate.factIndex });
      }
    }
    if (sourceIds.size > 12) {
      throw new FactExtractionValidationError(`${path}.sourceIds`,
        `merged evidence contains ${sourceIds.size} messages, exceeding the limit of 12; do not merge these records or discard their evidence, record the new information separately`);
    }
    if (fact.retracted === true && !mergedFrom.length) {
      throw new FactExtractionValidationError(`${path}.mergeWith`, 'retraction must reference an existing fact');
    }
    return [{ ...(typeof fact.title === 'string' ? { title: fact.title.trim() } : {}),
      text: fact.text.trim(), status: fact.status as DetailedFact['status'], sourceIds: [...sourceIds],
      ...(inheritedLifecycle ? { lifecycle: inheritedLifecycle } : fact.lifecycle ? { lifecycle: fact.lifecycle as DetailedFact['lifecycle'] } : {}),
      ...(mergedFrom.length ? { mergedFrom } : {}), ...(fact.retracted === true ? { retracted: true } : {}) }];
  });
}
