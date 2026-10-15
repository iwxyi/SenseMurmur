import type { AssistantHtmlRuntimeManifest, AssistantHtmlSubmissionField } from '../../types/assistantArtifact';

const MAX_FIELDS = 100;
const MAX_PAYLOAD_CHARS = 32_000;
const MAX_FIELD_CHARS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeField(value: unknown): AssistantHtmlSubmissionField | null {
  if (!isRecord(value)) return null;
  const name = cleanText(value.name, 120);
  const type = String(value.type || 'text');
  if (!name || !['text', 'textarea', 'number', 'boolean', 'single_choice', 'multi_choice'].includes(type)) return null;
  const options = Array.isArray(value.options)
    ? Array.from(new Set(value.options.map((item) => cleanText(item, 240)).filter(Boolean))).slice(0, 100)
    : undefined;
  return {
    name,
    type: type as AssistantHtmlSubmissionField['type'],
    label: cleanText(value.label, 240) || undefined,
    required: Boolean(value.required),
    maxLength: Number.isFinite(Number(value.maxLength)) ? Math.min(Math.max(Math.floor(Number(value.maxLength)), 1), MAX_FIELD_CHARS) : undefined,
    options: options?.length ? options : undefined,
  };
}

export function resolveAssistantHtmlPresentation(html: string, fieldCount: number, preferredMode?: 'inline_interaction' | 'artifact_page'): AssistantHtmlRuntimeManifest['presentation'] {
  const source = html.trim().replace(/^```(?:html)?\s*/i, '');
  const fullDocument = /^(?:<!doctype\s+html\b|<html\b)/i.test(source);
  if (fieldCount > 12 || source.length > 12_000) return 'fullscreen';
  if (preferredMode === 'inline_interaction') return 'inline';
  if (preferredMode === 'artifact_page') return 'fullscreen';
  return fullDocument ? 'fullscreen' : 'inline';
}

export function normalizeAssistantHtmlRuntime(value: unknown, html = '', preferredMode?: 'inline_interaction' | 'artifact_page'): AssistantHtmlRuntimeManifest | undefined {
  if (!isRecord(value)) return undefined;
  const autosave = isRecord(value.autosave) && value.autosave.enabled === true ? {
    enabled: true as const,
    debounceMs: Number.isFinite(Number(value.autosave.debounceMs)) ? Math.min(Math.max(Math.floor(Number(value.autosave.debounceMs)), 400), 5000) : undefined,
  } : undefined;
  const rawSubmission = isRecord(value.submission) ? value.submission : null;
  const fields = rawSubmission && Array.isArray(rawSubmission.fields)
    ? rawSubmission.fields.map(normalizeField).filter((field): field is AssistantHtmlSubmissionField => Boolean(field)).slice(0, MAX_FIELDS)
    : [];
  const interactionId = rawSubmission ? cleanText(rawSubmission.interactionId, 160) : '';
  const presentation = resolveAssistantHtmlPresentation(html, fields.length, preferredMode);
  const submission = rawSubmission && interactionId && fields.length ? {
    interactionId,
    label: cleanText(rawSubmission.label, 120) || '提交',
    resultType: ['form', 'quiz', 'selection', 'custom'].includes(String(rawSubmission.resultType))
      ? rawSubmission.resultType as NonNullable<AssistantHtmlRuntimeManifest['submission']>['resultType']
      : 'form' as const,
    fields,
    sendToAssistant: true as const,
    createArtifactVersion: true as const,
  } : undefined;
  return {
    schemaVersion: 1,
    presentation,
    executionMode: value.executionMode === 'sandboxed_web' ? 'sandboxed_web' : 'declarative',
    viewport: presentation === 'inline' ? { preferredHeight: 280, maxInlineHeight: 480 } : { preferredHeight: 720 },
    autosave,
    submission,
  };
}

function normalizeFieldValue(field: AssistantHtmlSubmissionField, value: unknown) {
  if (field.type === 'boolean') return Boolean(value);
  if (field.type === 'number') {
    if (value === '' || value == null) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${field.label || field.name} 必须是数字`);
    return parsed;
  }
  if (field.type === 'multi_choice') {
    const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
    const normalized = values.map((item) => cleanText(item, field.maxLength || MAX_FIELD_CHARS)).filter(Boolean);
    if (field.options?.length && normalized.some((item) => !field.options!.includes(item))) throw new Error(`${field.label || field.name} 包含无效选项`);
    return normalized;
  }
  const normalized = cleanText(value, field.maxLength || MAX_FIELD_CHARS);
  if (field.options?.length && normalized && !field.options.includes(normalized)) throw new Error(`${field.label || field.name} 包含无效选项`);
  return normalized;
}

export function validateAssistantHtmlPayload(manifest: AssistantHtmlRuntimeManifest, payload: unknown) {
  if (!manifest.submission) throw new Error('当前 HTML 没有可提交的交互协议');
  if (!isRecord(payload)) throw new Error('提交内容格式无效');
  const fieldNames = new Set(manifest.submission.fields.map((field) => field.name));
  const unknownFields = Object.keys(payload).filter((key) => !fieldNames.has(key));
  if (unknownFields.length) throw new Error(`提交包含未知字段：${unknownFields.slice(0, 3).join('、')}`);
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  manifest.submission.fields.forEach((field) => {
    const value = normalizeFieldValue(field, payload[field.name]);
    const missing = value == null || value === '' || (Array.isArray(value) && !value.length);
    if (field.required && missing) throw new Error(`${field.label || field.name} 不能为空`);
    normalized[field.name] = value;
  });
  if (JSON.stringify(normalized).length > MAX_PAYLOAD_CHARS) throw new Error('提交内容超过大小限制');
  return normalized;
}
