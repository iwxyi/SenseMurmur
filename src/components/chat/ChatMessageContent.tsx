import { useEffect, useState, type MouseEvent } from 'react';
import { Box, Button, CircularProgress, LinearProgress, Typography, keyframes } from '@mui/material';
import type { Message, MessageAttachment, NarrativeBlock } from '../../types/message';
import type { AICharacter } from '../../types/character';
import { getAttachmentStatusDetail, getAttachmentStatusLabel } from '../../services/messageAttachmentDisplay';
import { backendUrl } from '../../services/backendUrl';
import MarkdownText from '../common/MarkdownText';
import { formatNarrativeLineText } from '../../services/narrativeLinePresentation';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { downloadChatFile } from '../../services/chatFileTransfer';
import { reducedMotionSx } from '../../styles/motion';
import { VoicePlaybackBar } from './VoicePlaybackBar';
import { getAttachmentDisplayWidth, parseInlineAttachmentPlaceholders, shouldHideGeneratedMediaPlaceholderText } from './chatMessageContentUtils';

const typingBounce = keyframes`
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
`;

export function PendingTypingDots() {
  return (
    <Box sx={{ display: 'flex', gap: 0.5, py: 0.25 }}>
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: 'text.disabled',
            animation: `${typingBounce} 1.4s ease-in-out infinite`,
            animationDelay: `${i * 0.18}s`,
            ...reducedMotionSx,
          }}
        />
      ))}
    </Box>
  );
}

function parseAttachmentRatio(attachment: Pick<MessageAttachment, 'kind' | 'width' | 'height' | 'aspectRatio'>) {
  const width = Number(attachment.width || 0);
  const height = Number(attachment.height || 0);
  if (width > 0 && height > 0) return width / height;
  const ratioMatch = attachment.aspectRatio?.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratioMatch) {
    const left = Number(ratioMatch[1]);
    const right = Number(ratioMatch[2]);
    if (left > 0 && right > 0) return left / right;
  }
  return 4 / 3;
}

function getAttachmentMaxWidth(ratio: number, kind: MessageAttachment['kind'] = 'image') {
  if (kind === 'sticker') return 240;
  if (ratio < 0.82) return 300;
  if (ratio < 1.2) return 360;
  if (ratio < 1.7) return 440;
  return 520;
}

function getAttachmentKnownSize(attachment: Pick<MessageAttachment, 'width' | 'height'>) {
  const width = Number(attachment.width || 0);
  const height = Number(attachment.height || 0);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function estimateAudioDurationMs(attachment: MessageAttachment) {
  if (attachment.durationMs && attachment.durationMs > 0) return attachment.durationMs;
  const textLength = (attachment.promptText || attachment.altText || '').replace(/\s/g, '').length;
  return Math.max(1_500, Math.min(60_000, Math.round((textLength / 4.5) * 1_000)));
}

function MessageAudioAttachment({ attachment, showTranscript }: { attachment: MessageAttachment; showTranscript: boolean }) {
  const audioSource = attachment.url?.startsWith('/') ? backendUrl(attachment.url) : attachment.url;
  if (!audioSource) return null;
  return (
    <VoicePlaybackBar
      src={audioSource}
      initialDurationMs={attachment.durationMs}
      estimatedDurationMs={estimateAudioDurationMs(attachment)}
      transcript={attachment.transcriptVisibility === 'hidden'
        ? undefined
        : attachment.transcriptVisibility === 'visible' || showTranscript ? attachment.promptText : undefined}
    />
  );
}

function MessageImageAttachment({
  message,
  attachment,
  onOpenImage,
  onOpenPrompt,
  caption,
}: {
  message: Message;
  attachment: MessageAttachment;
  onOpenImage?: (message: Message, attachment: MessageAttachment) => void;
  onOpenPrompt?: (attachment: MessageAttachment, event: MouseEvent<HTMLElement>) => void;
  caption?: string;
}) {
  const knownSize = getAttachmentKnownSize(attachment);
  const imageSource = attachment.url?.startsWith('/') ? backendUrl(attachment.url) : attachment.url;
  const [loadedImage, setLoadedImage] = useState<{
    source?: string;
    size: { width: number; height: number } | null;
    status: 'loading' | 'ready' | 'failed';
  }>(() => ({ source: imageSource, size: knownSize, status: 'loading' }));
  const activeImage = loadedImage.source === imageSource
    ? loadedImage
    : { source: imageSource, size: knownSize, status: 'loading' as const };
  const [viewportHeight, setViewportHeight] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  const isSticker = attachment.kind === 'sticker';
  const displaySize = activeImage.size || knownSize;
  const imageStatus = activeImage.status;
  const hasDeclaredRatio = Boolean(displaySize || attachment.aspectRatio);
  const ratioValue = displaySize ? displaySize.width / displaySize.height : parseAttachmentRatio(attachment);
  const maxWidth = getAttachmentMaxWidth(ratioValue, attachment.kind);
  const maxHeight = Math.min(viewportHeight * 0.56, isSticker ? 240 : 520);
  const width = getAttachmentDisplayWidth({ displaySize, ratioValue, maxWidth, maxHeight });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const updateViewportHeight = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', updateViewportHeight);
    return () => window.removeEventListener('resize', updateViewportHeight);
  }, []);

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 0.45,
        width: isSticker && !hasDeclaredRatio ? 'fit-content' : width,
        minWidth: 0,
        maxWidth: '100%',
        justifySelf: 'start',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          minWidth: isSticker && !hasDeclaredRatio && imageStatus !== 'failed' ? 44 : 0,
          maxWidth: '100%',
          aspectRatio: isSticker && !hasDeclaredRatio ? undefined : `${ratioValue} / 1`,
          minHeight: isSticker && !hasDeclaredRatio && imageStatus !== 'failed' ? 44 : 0,
          width: isSticker && !hasDeclaredRatio ? 'fit-content' : undefined,
          borderRadius: 1.5,
          overflow: 'hidden',
          bgcolor: 'action.hover',
        }}
      >
          <Box
            component="img"
            src={imageSource}
            alt={attachment.altText}
            loading="lazy"
            decoding="async"
            onLoad={async (event) => {
              const image = event.currentTarget;
              const size = image.naturalWidth > 0 && image.naturalHeight > 0
                ? { width: image.naturalWidth, height: image.naturalHeight }
                : knownSize;
              setLoadedImage({ source: imageSource, size, status: 'loading' });
              const source = image.currentSrc || image.src;
              try {
                await image.decode?.();
                if ((image.currentSrc || image.src) === source) {
                  setLoadedImage((current) => current.source === imageSource ? { ...current, status: 'ready' } : current);
                }
              } catch {
                if ((image.currentSrc || image.src) === source) {
                  setLoadedImage((current) => current.source === imageSource ? { ...current, status: 'failed' } : current);
                }
              }
            }}
            onError={() => setLoadedImage((current) => current.source === imageSource
              ? { ...current, status: 'failed' }
              : { source: imageSource, size: knownSize, status: 'failed' })}
            onClick={() => onOpenImage?.(message, attachment)}
            onContextMenu={(event) => {
              if (!attachment.promptText || !onOpenPrompt) return;
              event.preventDefault();
              event.stopPropagation();
              onOpenPrompt(attachment, event);
            }}
            sx={{
              width: isSticker && !hasDeclaredRatio ? 'auto' : '100%',
              boxSizing: 'border-box',
              height: isSticker && !hasDeclaredRatio ? 'auto' : '100%',
              opacity: imageStatus === 'ready' ? 1 : 0,
              transition: 'opacity 120ms ease-out',
              maxWidth: isSticker ? 'min(100%, 240px)' : '100%',
              maxHeight: isSticker ? 'min(56vh, 240px)' : 'min(56vh, 520px)',
              objectFit: 'contain',
              display: 'block',
              cursor: onOpenImage ? 'zoom-in' : 'default',
              borderRadius: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'action.hover',
            }}
          />
          {imageStatus === 'loading' ? (
            <Box role="status" aria-label={isSticker ? '正在加载表情包' : '正在加载图片'} sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
              <CircularProgress size={22} thickness={4} sx={{ color: 'text.secondary' }} />
            </Box>
          ) : null}
          {imageStatus === 'failed' ? (
            <Box role="status" sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 1 }}>
              <Typography variant="caption" color="text.secondary">{isSticker ? '表情包加载失败' : '图片加载失败'}</Typography>
            </Box>
          ) : null}
      </Box>
      {caption ? (
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {caption}
        </Typography>
      ) : null}
    </Box>
  );
}

function NarrativeChoiceCard({ block, showDeveloperDetails = false }: { block: NarrativeBlock; showDeveloperDetails?: boolean }) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const maxContentWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  const choice = block.choices?.[0];
  const meta = showDeveloperDetails ? [
    choice?.intent ? `意图：${choice.intent}` : '',
    choice?.risk ? `风险：${choice.risk}` : '',
    choice?.reward ? `收益：${choice.reward}` : '',
  ].filter(Boolean) : [];
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <Box
        sx={(theme) => ({
          width: '100%',
          maxWidth: maxContentWidth,
          borderRadius: 2,
          px: { xs: 1.35, sm: 1.6 },
          py: { xs: 1, sm: 1.15 },
          border: '1px solid',
          borderColor: theme.palette.mode === 'light' ? 'rgba(99,102,241,0.22)' : 'rgba(129,140,248,0.32)',
          bgcolor: theme.palette.mode === 'light' ? 'rgba(238,242,255,0.62)' : 'rgba(49,46,129,0.20)',
        })}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 700, mb: 0.35 }}>
          你选择了
        </Typography>
        <Typography variant="body2" sx={{ lineHeight: 1.75, fontWeight: 700, wordBreak: 'break-word' }}>
          {block.text}
        </Typography>
        {meta.length ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.55, lineHeight: 1.6, wordBreak: 'break-word' }}>
            {meta.join(' · ')}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

function NarrativeSystemPanel({ block, characters }: { block: NarrativeBlock; characters: AICharacter[] }) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const maxContentWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = lines[0] || '章节回顾';
  const bodyLines = lines.slice(1);
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <Box
        sx={(theme) => ({
          width: '100%',
          maxWidth: maxContentWidth,
          borderRadius: 2,
          px: { xs: 1.35, sm: 1.6 },
          py: { xs: 1, sm: 1.15 },
          border: '1px solid',
          borderColor: theme.palette.mode === 'light' ? 'rgba(14,165,233,0.24)' : 'rgba(125,211,252,0.26)',
          bgcolor: theme.palette.mode === 'light' ? 'rgba(240,249,255,0.72)' : 'rgba(8,47,73,0.26)',
          boxShadow: theme.palette.mode === 'light' ? '0 10px 28px rgba(15,23,42,0.06)' : '0 12px 30px rgba(0,0,0,0.22)',
        })}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 700, mb: 0.45 }}>
          {formatNarrativeLineText(title, characters)}
        </Typography>
        {bodyLines.map((line) => (
          <Typography key={line} component="div" variant="body2" sx={{ lineHeight: 1.75, wordBreak: 'break-word', mt: 0.35 }}>
            <MarkdownText text={formatNarrativeLineText(line, characters)} />
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

export function NarrativeParagraphContent({ blocks, characters = [], showDeveloperDetails = false }: { blocks: NarrativeBlock[]; characters?: AICharacter[]; showDeveloperDetails?: boolean }) {
  return (
    <Box sx={{ display: 'grid', gap: 1.75 }}>
      {blocks.filter((block) => block.displayMode !== 'bubble').map((block) => {
        return block.displayMode === 'choice_card' ? (
        <NarrativeChoiceCard key={block.id} block={block} showDeveloperDetails={showDeveloperDetails} />
      ) : block.displayMode === 'system_panel' ? (
        showDeveloperDetails ? <NarrativeSystemPanel key={block.id} block={block} characters={characters} /> : null
      ) : (
        <Box key={block.id} sx={{ fontSize: 'inherit', lineHeight: 'inherit', color: 'text.primary', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}>
          <MarkdownText text={block.text} />
        </Box>
      );
      })}
    </Box>
  );
}

export function MessageContent({ message, onRetryMedia, onOpenImage, onOpenPrompt, onOpenDiagram, compactMediaLayout = false }: {
  message: Message;
  onRetryMedia?: (message: Message, attachmentId: string) => void | Promise<void>;
  onOpenImage?: (message: Message, attachment: MessageAttachment) => void;
  onOpenPrompt?: (attachment: MessageAttachment, event: MouseEvent<HTMLElement>) => void;
  onOpenDiagram?: (message: Message, diagram: { source: string; svg: string; dataUrl: string }) => void;
  compactMediaLayout?: boolean;
}) {
  const showVoiceTranscript = useSettingsStore((state) => state.showVoiceTranscript);
  const attachments = message.metadata?.attachments || [];
  const shouldHideMediaPlaceholderText = shouldHideGeneratedMediaPlaceholderText(message);
  const isAttachmentProcessing = (status: string | undefined) => status === 'queued' || status === 'generating' || status === 'placeholder';
  const getMediaFrameStyle = (attachment: Pick<MessageAttachment, 'kind' | 'width' | 'height' | 'aspectRatio'>) => {
    const knownSize = getAttachmentKnownSize(attachment);
    const ratioValue = parseAttachmentRatio(attachment);
    const ratio = `${ratioValue} / 1`;
    const isSticker = attachment.kind === 'sticker';
    const maxWidth = getAttachmentMaxWidth(ratioValue, attachment.kind);
    const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
    const maxHeight = Math.min(viewportHeight * 0.56, isSticker ? 240 : 520);
    const width = getAttachmentDisplayWidth({ displaySize: knownSize, ratioValue, maxWidth, maxHeight });
    return {
      width,
      minWidth: 0,
      maxWidth: '100%',
      boxSizing: 'border-box' as const,
      maxHeight: isSticker ? 'min(56vh, 240px)' : 'min(56vh, 520px)',
      justifySelf: 'start',
      aspectRatio: ratio,
      borderRadius: 1.5,
      border: '1px solid',
      borderColor: 'divider',
      overflow: 'hidden',
      bgcolor: 'action.hover',
      position: 'relative' as const,
    };
  };
  const findAttachmentBySlotId = (slotId: string) => attachments.find((attachment) => attachment.slotId === slotId || attachment.id === slotId);
  const visibleContentParts = shouldHideMediaPlaceholderText ? [] : parseInlineAttachmentPlaceholders(message.content);
  const hasInlineAttachments = visibleContentParts.some((part) => part.kind === 'attachment');
  const usedAttachmentIds = new Set<string>();
  const renderAttachment = (attachment: MessageAttachment, captionOverride?: string) => {
    if (attachment.kind === 'image' || attachment.kind === 'sticker') {
      const canRetryAttachment = attachment.status === 'failed' || attachment.status === 'queued' || attachment.status === 'generating' || (attachment.status === 'ready' && !attachment.url);
      if (attachment.status === 'ready' && attachment.url) {
        return (
          <MessageImageAttachment
            key={attachment.id}
            message={message}
            attachment={attachment}
            caption={captionOverride || attachment.caption}
            onOpenImage={onOpenImage}
            onOpenPrompt={onOpenPrompt}
          />
        );
      }
      return (
        <Box key={attachment.id} sx={getMediaFrameStyle(attachment)}>
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 1.5, textAlign: 'center' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0.75, minWidth: 0, maxWidth: '85%' }}>
              <Typography variant="caption" color={attachment.status === 'failed' ? 'error' : 'text.secondary'}>
                {getAttachmentStatusLabel(attachment)}
              </Typography>
              {isAttachmentProcessing(attachment.status) ? <LinearProgress /> : null}
              {attachment.status === 'failed' ? (
                <Typography variant="caption" sx={{ color: 'error.main', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {getAttachmentStatusDetail(attachment)}
                </Typography>
              ) : null}
              {canRetryAttachment && onRetryMedia ? (
                <Button size="small" variant="outlined" color={attachment.status === 'failed' ? 'error' : 'primary'} sx={{ minWidth: 0 }} onClick={() => void onRetryMedia?.(message, attachment.id)}>
                  重试
                </Button>
              ) : null}
              <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {captionOverride || attachment.caption || attachment.altText}
              </Typography>
            </Box>
          </Box>
        </Box>
      );
    }
    if (attachment.kind === 'audio') {
      if (attachment.status === 'ready' && attachment.url) {
        return <MessageAudioAttachment key={attachment.id} attachment={attachment} showTranscript={showVoiceTranscript} />;
      }
      const estimatedDurationMs = estimateAudioDurationMs(attachment);
      const loadingWidth = Math.round(Math.min(300, Math.max(142, 118 + (estimatedDurationMs / 1000) * 9)));
      return (
        <Box key={attachment.id} sx={{ width: loadingWidth, minWidth: 0, maxWidth: '100%', overflow: 'hidden', borderRadius: 999, border: '1px solid', borderColor: 'divider', px: 1.25, py: 0.75, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color={attachment.status === 'failed' ? 'error.main' : 'text.secondary'} sx={{ overflowWrap: 'anywhere' }}>
            {attachment.status === 'failed' ? getAttachmentStatusDetail(attachment) : getAttachmentStatusLabel(attachment)}
          </Typography>
          {attachment.status !== 'failed' ? <LinearProgress sx={{ mt: 0.5 }} /> : null}
          {attachment.status === 'failed' && onRetryMedia ? (
            <Button size="small" variant="outlined" color="error" sx={{ mt: 0.6 }} onClick={() => void onRetryMedia?.(message, attachment.id)}>
              重试
            </Button>
          ) : null}
        </Box>
      );
    }
    if (attachment.kind === 'file') {
      return (
        <Box key={attachment.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1.5, minWidth: 0, maxWidth: 'min(360px, 100%)', width: 'fit-content' }}>
          <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.fileName || attachment.altText}</Typography>
          <Button size="small" onClick={() => downloadChatFile({ name: attachment.fileName || attachment.altText, mimeType: attachment.mimeType, url: attachment.url, textContent: attachment.textContent })}>下载</Button>
        </Box>
      );
    }
    return null;
  };
  // An auto grid track keeps media's intrinsic width even after the bubble
  // shrinks. Allow the track itself to shrink so maxWidth on attachments applies.
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0.9, width: compactMediaLayout ? 'fit-content' : 'auto', minWidth: 0, maxWidth: '100%' }}>
      {visibleContentParts.map((part, index) => {
        if (part.kind === 'text') {
          if (!part.text.trim()) return null;
          return (
            <Box key={`text-${index}`} sx={{ typography: 'body2', minWidth: 0, maxWidth: '100%', overflow: 'hidden', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text', '& table': { width: '100%', borderCollapse: 'collapse' }, '& th, & td': { border: '1px solid', borderColor: 'divider', px: 0.75, py: 0.4 } }}>
              <MarkdownText
                text={part.text}
                forceRich={message.metadata?.format === 'markdown'}
                deferDiagrams={Boolean(message.isStreaming)}
                onOpenDiagram={onOpenDiagram ? (diagram) => onOpenDiagram(message, diagram) : undefined}
              />
            </Box>
          );
        }
        const attachment = findAttachmentBySlotId(part.slotId);
        if (!attachment) {
          return (
            <Box key={`missing-attachment-${part.slotId}-${index}`} sx={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', borderRadius: 1.5, border: '1px dashed', borderColor: 'divider', px: 1.25, py: 1, color: 'text.secondary' }}>
              <Typography variant="caption">{part.altText || '图片'}的生成任务数据缺失</Typography>
            </Box>
          );
        }
        usedAttachmentIds.add(attachment.id);
        return renderAttachment(attachment, part.altText || attachment.caption);
      })}
      {attachments
        .filter((attachment) => !hasInlineAttachments || !usedAttachmentIds.has(attachment.id))
        .map((attachment) => renderAttachment(attachment))}
    </Box>
  );
}
