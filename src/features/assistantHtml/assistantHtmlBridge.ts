export type AssistantHtmlBridgeEventType = 'ready' | 'resize' | 'autosave' | 'submit' | 'open_fullscreen' | 'close' | 'error';

export interface AssistantHtmlBridgeEvent {
  type: AssistantHtmlBridgeEventType;
  channelToken: string;
  artifactId: string;
  versionId: string;
  interactionId: string;
  height?: number;
  payload?: Record<string, unknown>;
  closeOnSubmit?: boolean;
  error?: string;
  errorInfo?: {
    kind?: 'runtime' | 'unhandledrejection' | 'console' | 'resource' | 'page_state';
    message?: string;
    stack?: string;
    source?: string;
    line?: number;
    column?: number;
  };
}

export function parseAssistantHtmlBridgeEvent(params: {
  event: MessageEvent;
  frameWindow: Window | null;
  channelToken: string;
  artifactId: string;
  versionId: string;
  interactionId: string;
}): AssistantHtmlBridgeEvent | null {
  if (!params.frameWindow || params.event.source !== params.frameWindow) return null;
  const data = params.event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (!['ready', 'resize', 'autosave', 'submit', 'open_fullscreen', 'close', 'error'].includes(String(record.type))) return null;
  if (record.channelToken !== params.channelToken || record.artifactId !== params.artifactId || record.versionId !== params.versionId || record.interactionId !== params.interactionId) return null;
  if (record.closeOnSubmit !== undefined && typeof record.closeOnSubmit !== 'boolean') return null;
  return record as unknown as AssistantHtmlBridgeEvent;
}
