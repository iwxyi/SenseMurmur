import { api } from './api';
import type { APIConfig, AIModelProfile } from '../types/settings';
import { readAuthSnapshot } from './authSnapshot';
import { getBackendOrigin } from './backendUrl';

function realtimeEnvironment() {
  const target = new URL(getBackendOrigin() || window.location.origin);
  return {
    protocol: target.protocol,
    host: target.host,
    token: readAuthSnapshot().token || '',
  };
}

export function usesManagedSpeechProfile(profile: Pick<APIConfig, 'provider' | 'baseUrl'> & Partial<Pick<AIModelProfile, 'type'>>) {
  const provider = String(profile.provider || '');
  const baseUrl = String(profile.baseUrl || '').replace(/\/+$/, '');
  const model = String((profile as Partial<APIConfig>).model || '').trim().toLowerCase();
  const legacyManagedModel = new Set(['tts-volcengine', 'stt-volcengine', 'speech-tts', 'speech-stt']);
  return provider === 'official'
    || provider.startsWith('managed:')
    || provider.startsWith('official-')
    || legacyManagedModel.has(model)
    || ((profile.type === 'tts' || profile.type === 'stt' || profile.type === 'audio') && (baseUrl === '/api' || baseUrl.endsWith('/api')));
}

/**
 * Keep audio data URLs compatible with managed STT adapters.
 * MediaRecorder commonly reports MIME parameters such as `codecs=opus`,
 * while the server-side adapters expect the canonical `data:<mime>;base64` form.
 */
export function normalizeAudioDataUrl(value: string) {
  const match = String(value || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i);
  if (!match) return value;
  return `data:${match[1]};base64,${match[2]}`;
}

export function realtimeSpeechUrl(
  profile: Pick<APIConfig, 'provider' | 'model'>,
  environment = realtimeEnvironment(),
) {
  const providerCode = profile.provider.startsWith('managed:')
    ? profile.provider.slice('managed:'.length)
    : profile.provider.startsWith('official-')
      ? profile.provider.slice('official-'.length)
      : '';
  const params = new URLSearchParams();
  if (environment.token) params.set('token', environment.token);
  if (providerCode && providerCode !== 'official') params.set('providerCode', providerCode);
  if (profile.model.trim()) params.set('modelId', profile.model.trim());
  const scheme = environment.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${environment.host}/api/speech/stt/stream?${params.toString()}`;
}

export function speechTextFromMessage(content: string) {
  return String(content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type SpeechSynthesisRequest = Parameters<typeof api.synthesizeSpeech>[0];
export type SpeechTranscriptionRequest = Parameters<typeof api.transcribeSpeech>[0];

export async function synthesizeSpeech(request: SpeechSynthesisRequest) {
  return api.synthesizeSpeech(request);
}

export async function transcribeSpeech(request: SpeechTranscriptionRequest) {
  return api.transcribeSpeech(request);
}
