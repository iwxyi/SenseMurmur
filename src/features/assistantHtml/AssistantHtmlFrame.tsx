import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import type { AssistantArtifactVersion, AssistantHtmlRuntimeManifest } from '../../types/assistantArtifact';
import { buildAssistantHtmlDocument } from './assistantHtmlDocument';
import { parseAssistantHtmlBridgeEvent } from './assistantHtmlBridge';
import { validateAssistantHtmlPayload } from './assistantHtmlValidation';
import { useTheme } from '@mui/material/styles';
import { logDeveloperDiagnostic } from '../../services/developerDiagnostics';
import { getAssistantHtmlRuntimeError, rememberAssistantHtmlRuntimeError } from './assistantHtmlRuntimeErrorCache';
import { copyTextToClipboard } from '../../utils/clipboard';
import { CopyTextDialog } from '../../components/common/CopyTextDialog';

export interface AssistantHtmlInteractionPayload {
  artifactId: string;
  baseVersionId: string;
  interactionId: string;
  resultType: 'form' | 'quiz' | 'selection' | 'custom';
  payload: Record<string, unknown>;
  closeOnSubmit?: boolean;
}

export interface AssistantHtmlRuntimeError {
  artifactId: string;
  versionId: string;
  message: string;
  kind: 'runtime' | 'unhandledrejection' | 'console' | 'resource' | 'page_state';
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
}

function createHtmlChannelToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `html-${crypto.randomUUID()}`;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint32Array(4));
    return `html-${Array.from(bytes, (value) => value.toString(36)).join('')}`;
  }
  return `html-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export default function AssistantHtmlFrame({
  artifactId,
  version,
  manifest,
  inline = false,
  fillContainer = false,
  interactive = true,
  readOnly = false,
  onAutosave,
  onSubmit,
  onOpenFullscreen,
  onRuntimeError,
  onRequestRepair,
}: {
  artifactId: string;
  version: AssistantArtifactVersion;
  manifest: AssistantHtmlRuntimeManifest;
  inline?: boolean;
  fillContainer?: boolean;
  interactive?: boolean;
  readOnly?: boolean;
  onAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onOpenFullscreen?: () => void;
  onRuntimeError?: (error: AssistantHtmlRuntimeError) => void;
  onRequestRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
}) {
  const theme = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const channelToken = useMemo(() => `${artifactId}:${version.id}:${createHtmlChannelToken()}`, [artifactId, version.id]);
  const [height, setHeight] = useState(manifest.viewport?.preferredHeight || (inline ? 280 : 720));
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);
  const bridgeReadyRef = useRef(false);
  const loaded = loadedVersionId === version.id;
  const cachedRuntimeError = getAssistantHtmlRuntimeError(artifactId, version.id);
  const [error, setError] = useState(() => cachedRuntimeError?.message || '');
  const [lastRuntimeError, setLastRuntimeError] = useState<AssistantHtmlRuntimeError | null>(() => cachedRuntimeError);
  const [repairing, setRepairing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const interactionId = manifest.submission?.interactionId || '';
  const baseVersionId = version.stage === 'autosave' && version.baseVersionId ? version.baseVersionId : version.id;
  const srcDoc = useMemo(() => buildAssistantHtmlDocument({
    html: version.content,
    manifest,
    channelToken,
    artifactId,
    versionId: version.id,
    interactionState: version.interactionState,
    readOnly,
    displayMode: theme.palette.mode,
    applicationOrigin: window.location.origin,
  }), [artifactId, channelToken, manifest, readOnly, theme.palette.mode, version]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = parseAssistantHtmlBridgeEvent({
        event,
        frameWindow: frameRef.current?.contentWindow || null,
        channelToken,
        artifactId,
        versionId: version.id,
        interactionId,
      });
      if (!message) return;
      if (message.type === 'ready' || message.type === 'resize') {
        bridgeReadyRef.current = true;
        const nextHeight = Number(message.height || 0);
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
          const maxHeight = inline ? manifest.viewport?.maxInlineHeight || 480 : 1600;
          setHeight(Math.min(Math.max(nextHeight, 160), maxHeight));
        }
        return;
      }
      if (message.type === 'error') {
        const info = message.errorInfo;
        const runtimeError: AssistantHtmlRuntimeError = {
          artifactId,
          versionId: version.id,
          message: String(info?.message || message.error || 'HTML 交互脚本执行失败'),
          kind: info?.kind || 'runtime',
          stack: info?.stack || undefined,
          source: info?.source || undefined,
          line: info?.line || undefined,
          column: info?.column || undefined,
        };
        if (runtimeError.kind === 'page_state') return;
        const previousError = getAssistantHtmlRuntimeError(artifactId, version.id);
        const isRepeatedError = previousError?.kind === runtimeError.kind
          && previousError.message === runtimeError.message
          && previousError.source === runtimeError.source
          && previousError.line === runtimeError.line
          && previousError.column === runtimeError.column;
        if (!readOnly && !isRepeatedError) {
          logDeveloperDiagnostic('html-artifact:iframe-error', { ...runtimeError }, 'error', 'chat-window');
        }
        const effectiveError = rememberAssistantHtmlRuntimeError(runtimeError) || runtimeError;
        setError(effectiveError.message);
        setLastRuntimeError(effectiveError);
        if (effectiveError === runtimeError) onRuntimeError?.(runtimeError);
        return;
      }
      if (message.type === 'open_fullscreen') {
        onOpenFullscreen?.();
        return;
      }
      if (readOnly || !message.payload || !manifest.submission) return;
      try {
        const payload = validateAssistantHtmlPayload(manifest, message.payload);
        const input: AssistantHtmlInteractionPayload = {
          artifactId,
          baseVersionId,
          interactionId,
          resultType: manifest.submission.resultType,
          payload,
        };
        if (message.type === 'autosave') void onAutosave?.(input);
        if (message.type === 'submit') {
          input.closeOnSubmit = message.closeOnSubmit !== false;
          setSubmitting(true);
          void Promise.resolve(onSubmit?.(input)).catch((reason) => {
            if (!getAssistantHtmlRuntimeError(artifactId, version.id)) setError(reason instanceof Error ? reason.message : '提交失败');
          }).finally(() => setSubmitting(false));
        }
      } catch (reason) {
        if (!getAssistantHtmlRuntimeError(artifactId, version.id)) setError(reason instanceof Error ? reason.message : '提交内容无效');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [artifactId, baseVersionId, channelToken, inline, interactionId, manifest, onAutosave, onOpenFullscreen, onRuntimeError, onSubmit, readOnly, version.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const cached = getAssistantHtmlRuntimeError(artifactId, version.id);
      setError(cached?.message || '');
      setLastRuntimeError(cached);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [artifactId, version.id]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: fillContainer ? '100%' : 'auto', minHeight: fillContainer ? 0 : inline ? 160 : 'calc(100dvh - 110px)', flex: fillContainer ? 1 : undefined, display: fillContainer ? 'flex' : undefined, flexDirection: fillContainer ? 'column' : undefined }}>
      {!loaded ? <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}><CircularProgress size={20} /></Box> : null}
      {submitting ? (
        <Box sx={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center', bgcolor: 'rgba(15,18,24,0.42)', backdropFilter: 'blur(2px)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderRadius: 1, bgcolor: 'background.paper', color: 'text.primary', boxShadow: 3 }}>
            <CircularProgress size={18} />
            <Typography variant="body2">正在提交</Typography>
          </Box>
        </Box>
      ) : null}
      <Box
        ref={frameRef}
        component="iframe"
        title="HTML 交互内容"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms"
        onLoad={() => {
          logDeveloperDiagnostic('html-artifact:iframe-load', { artifactId, versionId: version.id }, 'info', 'chat-window');
          bridgeReadyRef.current = false;
          setLoadedVersionId(version.id);
          frameRef.current?.contentWindow?.postMessage({ type: 'host_ready', channelToken, artifactId, versionId: version.id }, '*');
          // A load event without a bridge-ready event means the document
          // rendered but its runtime script did not execute.
          window.setTimeout(() => {
            if (!frameRef.current?.contentWindow) return;
            if (!bridgeReadyRef.current) {
              if (!readOnly) logDeveloperDiagnostic('html-artifact:iframe-runtime-missing', { artifactId, versionId: version.id }, 'error', 'chat-window');
              setError('HTML 页面已加载，但交互脚本未执行');
            }
          }, 1200);
        }}
        sx={{ width: '100%', height: fillContainer ? 'auto' : inline ? height : 'calc(100dvh - 110px)', minHeight: fillContainer ? 0 : inline ? 160 : 420, flex: fillContainer ? 1 : undefined, border: 0, display: 'block', pointerEvents: interactive ? 'auto' : 'none', bgcolor: theme.palette.mode === 'dark' ? '#181a20' : '#fff' }}
      />
      {!loaded ? <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>正在加载交互内容…</Typography> : null}
      {error ? (
        <Box
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mt: fillContainer ? 0 : 0.5, px: fillContainer ? 1.5 : 0, py: fillContainer ? 1 : 0, borderTop: fillContainer ? '1px solid' : undefined, borderColor: fillContainer ? 'divider' : undefined, bgcolor: fillContainer ? 'background.paper' : undefined, flexShrink: 0 }}
        >
          <Typography variant="caption" color="error" sx={{ flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</Typography>
          <Button
            size="small"
            variant="text"
            startIcon={<ContentCopyOutlinedIcon fontSize="inherit" />}
            onClick={async () => {
              const detail = [
                `artifactId: ${artifactId}`,
                `versionId: ${version.id}`,
                `错误类型: ${lastRuntimeError?.kind || 'runtime'}`,
                `错误信息: ${lastRuntimeError?.message || error}`,
                lastRuntimeError?.source ? `来源: ${lastRuntimeError.source}${lastRuntimeError.line ? `:${lastRuntimeError.line}:${lastRuntimeError.column || 0}` : ''}` : '',
                lastRuntimeError?.stack ? `堆栈:\n${lastRuntimeError.stack}` : '',
              ].filter(Boolean).join('\n');
              if (!(await copyTextToClipboard(detail))) setCopyFallback(detail);
            }}
            sx={{ minWidth: 'auto', flexShrink: 0, textTransform: 'none' }}
          >复制</Button>
          {onRequestRepair && lastRuntimeError ? <Button
            size="small"
            variant="contained"
            disabled={repairing}
            onClick={() => {
              setRepairing(true);
              void Promise.resolve(onRequestRepair(lastRuntimeError)).finally(() => setRepairing(false));
            }}
            sx={{ flexShrink: 0, textTransform: 'none' }}
          >{repairing ? '正在修复' : '修复'}</Button> : null}
        </Box>
      ) : null}
      <CopyTextDialog
        open={Boolean(copyFallback)}
        label="HTML 错误详情"
        value={copyFallback || ''}
        onClose={() => setCopyFallback(null)}
      />
    </Box>
  );
}
