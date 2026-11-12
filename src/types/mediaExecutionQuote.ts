export interface MediaExecutionQuote {
  schemaVersion: 1;
  id: string;
  model: string;
  modality: string;
  requestSha256: string;
  costQuoteId: string;
  amount: string;
  unit: string;
  kind: 'request_tariff' | 'usage_estimate';
  capturedAt: number;
  expiresAt: number;
  token: string;
}

export function parseMediaExecutionQuote(value: unknown): MediaExecutionQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('媒体报价格式无效');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1
    || !['id', 'requestSha256', 'costQuoteId', 'token'].every((key) => typeof item[key] === 'string' && /^[a-f0-9]{64}$/.test(item[key]))
    || !['model', 'modality', 'unit'].every((key) => typeof item[key] === 'string' && item[key].trim())
    || typeof item.amount !== 'string' || !/^\d+\.\d{6}$/.test(item.amount)
    || !['request_tariff', 'usage_estimate'].includes(String(item.kind))
    || !Number.isSafeInteger(item.capturedAt) || Number(item.capturedAt) < 0
    || !Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) !== Number(item.capturedAt) + 300_000) {
    throw new Error('媒体报价格式无效');
  }
  return { schemaVersion: 1, id: String(item.id), model: String(item.model), modality: String(item.modality),
    requestSha256: String(item.requestSha256), costQuoteId: String(item.costQuoteId),
    amount: item.amount, unit: String(item.unit), kind: item.kind as MediaExecutionQuote['kind'],
    capturedAt: Number(item.capturedAt), expiresAt: Number(item.expiresAt), token: String(item.token) };
}
