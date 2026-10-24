import type { RoomStateSnapshotV2 } from './runtimeEvent';

export type ConversationItemKind = 'issue' | 'commitment' | 'decision' | 'condition';
export type ConversationItemStatus = 'open' | 'established' | 'resolved' | 'retracted';

export interface ConversationItemUpdate {
  key: string;
  kind: ConversationItemKind;
  status: ConversationItemStatus;
  summary: string;
  participantIds: string[];
  evidenceText: string;
}

export interface ConversationItem extends ConversationItemUpdate {
  sourceMessageIds: string[];
  updatedAt: number;
}

export interface ConversationUpdate {
  items: ConversationItemUpdate[];
  room?: {
    addAlliances?: Array<[string, string]>;
    removeAlliances?: Array<[string, string]>;
    addConflictPairs?: Array<[string, string]>;
    removeConflictPairs?: Array<[string, string]>;
    pileOnTarget?: RoomStateSnapshotV2['pileOnTarget'];
    silencedActors?: string[];
    evidenceText: string;
  };
  settled?: { evidenceText: string; scope?: 'room' };
}

export interface ConversationContinuityState {
  items: ConversationItem[];
  settledAt?: number;
  settledScope?: 'room';
  settledEvidenceText?: string;
  settledSourceMessageId?: string;
}
