import { api } from './api';

export type MarketItemKind = 'character_template' | 'chat_template' | 'bundle_template';
export type MarketItemStatus = 'pending' | 'approved' | 'rejected' | 'archived';

export interface MarketItem {
  id: string;
  kind: MarketItemKind;
  ownerUserId: string;
  sourceEntityId?: string | null;
  title: string;
  summary: string;
  coverImage?: string | null;
  status: MarketItemStatus;
  payloadVersion: number;
  previousPayloadVersion?: number | null;
  reviewNote?: string;
  importedCount: number;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number | null;
  payload?: Record<string, unknown>;
  previousPayload?: Record<string, unknown> | null;
  previewPayload?: Record<string, unknown> | null;
}

export interface MarketUploadPayload {
  kind: MarketItemKind;
  title: string;
  summary?: string;
  coverImage?: string | null;
  payload: Record<string, unknown>;
  sourceEntityId?: string | null;
  marketItemId?: string | null;
}

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export const marketApi = {
  list(params: { kind?: MarketItemKind; limit?: number } = {}) {
    return api.request<{ items: MarketItem[] }>('GET', `/market${buildQuery(params)}`);
  },
  mine(params: { kind?: MarketItemKind; sourceEntityId?: string | null } = {}) {
    return api.request<{ items: MarketItem[] }>('GET', `/market/mine${buildQuery(params)}`);
  },
  detail(id: string) {
    return api.request<{ item: MarketItem }>('GET', `/market/${encodeURIComponent(id)}`);
  },
  upload(payload: MarketUploadPayload) {
    return api.request<{ item: MarketItem; updated: boolean }>('POST', '/market/items', payload);
  },
  recordImported(id: string) {
    return api.request<{ ok: boolean }>('POST', `/market/${encodeURIComponent(id)}/imported`);
  },
};
