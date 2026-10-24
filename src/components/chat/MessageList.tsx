import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useVirtualizer, type Range } from '@tanstack/react-virtual';
import { Box, Chip, CircularProgress, Fab, Stack, Typography, keyframes } from '@mui/material';
import { memo, type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message, MessageAttachment, NarrativeBlock, NarrativeTurnMetadata } from '../../types/message';
import type { AICharacter } from '../../types/character';
import MessageBubble from './MessageBubble';
import EventMessageItem from './EventMessageItem';
import type { EventRenderFlags } from './eventMessagePresentation';
import type { NarrativeStoryChoiceOption } from './messageBubblePresentation';
import SystemMessageItem from './SystemMessageItem';
import { resolveCharacterOrDeleted } from '../../utils/deletedEntity';
import type { ChatRenderItem } from './chatRenderModel';
import { getContinuousAiMessageKeys, isNarrativeRevealAllowed } from './messageListPresentation';
import type { ExpressionFeedbackKind } from '../../services/characterExpressionFeedback';
import ImageLightbox, { type LightboxImageItem } from '../common/ImageLightbox';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { logDeveloperDiagnostic } from '../../services/developerDiagnostics';
import { buildStoryNodeProgress, type StoryNodeProgressChip } from '../../services/storyNodeProgress';
import type { MessageBranchVersionInfo } from '../../services/messageBranching';
import type { AssistantHtmlInteractionPayload, AssistantHtmlRuntimeError } from '../../features/assistantHtml/AssistantHtmlFrame';
import { buildBubblePreview, resolveCharacterBubbleStyle } from '../../utils/bubbleStyle';
import { motion, prefersReducedMotion, transition } from '../../styles/motion';
import { buildMessageListRenderItems, type MessageListRenderItem } from './messageListRenderItems';
import { extractMessageSelectionRange } from './messageListSelection';
import { shouldMaintainTailAfterMutation } from './messageListTailOwnership';
import { SCROLL_INTENT_PRIORITY, shouldBlockScrollWrite, type ScrollIntentKind, type ScrollTransaction } from '../../services/scrollCoordinator';

const TOP_PREFETCH_THRESHOLD = 520;
// Keep following the tail when the user is only slightly above it. The input
// composer overlays the lower edge and a newly appended bubble can itself be
// taller than the old fixed threshold, so a 96px cutoff makes normal sends
// appear behind the composer unless the scrollbar is exactly at the end.
const BOTTOM_STICKY_THRESHOLD = 176;
const JUMP_TO_BOTTOM_PAGE_MULTIPLIER = 3;
const BOTTOM_RESTORE_ANCHOR_THRESHOLD = 700;
const SMOOTH_SCROLL_DISTANCE_LIMIT = 900;
const FOLLOW_SCROLL_DURATION_MS = 220;
const JUMP_SCROLL_DURATION_MS = 260;
const PROGRAMMATIC_SCROLL_SETTLE_MS = 120;
const USER_SCROLL_INERTIA_GRACE_MS = 480;
const MIN_BOTTOM_PREFETCH_PAGES = 1;
const MAX_BOTTOM_PREFETCH_PAGES = 3;
const SCROLL_INTENT_SETTLE_MS = 160;
const BRANCH_SCROLL_TRANSACTION_MAX_MS = 1200;
const INITIAL_REVEAL_MAX_FRAMES = 12;
const INITIAL_REVEAL_STABLE_FRAMES = 2;
const PREPEND_STABILIZE_MAX_FRAMES = 36;
const PREPEND_STABILIZE_STABLE_FRAMES = 6;
const PREPEND_STABILIZE_OVERSCAN = 18;
const INITIAL_TAIL_REVEAL_THRESHOLD = 4;
const storyNodeFadeIn = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
`;

type ResponsiveInset = number | string | Record<string, number | string>;
interface ScrollAnchorSnapshot {
  messageId: string;
  offsetTop: number;
  sourceTimestamp?: number;
}

interface TailFollowStartSnapshot {
  scrollTop: number;
}

type MessageScrollIntentKind = ScrollIntentKind;

export interface MessageListScrollPosition extends ScrollAnchorSnapshot {
  pinned: boolean;
}
export interface MessageListScrollRequest extends ScrollAnchorSnapshot {
  key: string;
  behavior?: ScrollBehavior;
  highlight?: boolean;
}

/**
 * Tail mutations belong to the viewport only when it was already following
 * the tail. User interaction history is deliberately not an input here:
 * "has interacted" and "is at the bottom" are different states.
 */
interface MessageListProps {
  messages: Message[];
  characters: AICharacter[];
  currentUser?: { nickname?: string; avatar?: string };
  onDeleteMessage?: (id: string) => void;
  onWithdrawMessage?: (id: string) => void | Promise<void>;
  onAnalyzeMessage?: (message: Message) => void;
  onExpressionFeedback?: (message: Message, kind: ExpressionFeedbackKind) => void;
  onRetryMedia?: (message: Message, attachmentId: string) => void | Promise<void>;
  onAddImagesToReference?: (message: Message, attachments: MessageAttachment[]) => void;
  onCharacterAvatarClick?: (character: import('../../services/markdownCharacterMentions').MentionCharacter, anchorEl: HTMLElement) => void;
  onMentionCharacter?: (character: AICharacter) => void;
  onCreateRevision?: (message: Message, content: string) => void | Promise<void>;
  onRegenerate?: (message: Message) => void | Promise<void>;
  onSwitchRevision?: (message: Message, direction: -1 | 1) => void | Promise<void>;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenHtmlFullscreen?: (artifactId: string) => void;
  onHtmlAutosave?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlSubmit?: (input: AssistantHtmlInteractionPayload) => void | Promise<void>;
  onHtmlRepair?: (error: AssistantHtmlRuntimeError) => void | Promise<void>;
  onConfirmWorkspaceMutationPlan?: (message: Message) => void | Promise<void>;
  readOnly?: boolean;
  branchVersionInfoByMessageId?: Record<string, MessageBranchVersionInfo | null | undefined>;
  onReachTop?: () => void | Promise<void>;
  onReachBottom?: () => void | Promise<void>;
  onJumpToConversationBottom?: () => void | Promise<void>;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  hasMore?: boolean;
  hasMoreNewer?: boolean;
  topHint?: string;
  loadingText?: string;
  topInset?: ResponsiveInset;
  bottomInset?: ResponsiveInset;
  selfMemberId?: string | null;
  privateConversation?: boolean;
  emptyContent?: ReactNode;
  tailContent?: ReactNode;
  storyChoiceMessageId?: string | null;
  storyChoiceOptions?: NarrativeStoryChoiceOption[];
  storyChoiceSubmittingValue?: string | null;
  onChooseStoryChoice?: (value: string) => void;
  onBottomPinnedChange?: (pinned: boolean) => void;
  onNearBottomChange?: (nearBottom: boolean) => void;
  initialScrollPosition?: MessageListScrollPosition | null;
  scrollRequest?: MessageListScrollRequest | null;
  onScrollRequestResolved?: (request: MessageListScrollRequest, resolved: boolean) => void;
  onScrollPositionChange?: (position: MessageListScrollPosition) => void;
  narrativeRevealMessageKeys?: ReadonlySet<string>;
  onNarrativeRevealComplete?: (message: Message) => void;
  autoStickToBottom?: boolean;
}

function buildChatImageTimeline(messages: Message[]) {
  return messages
    .filter((message) => !message.isDeleted)
    .sort((left, right) => left.timestamp - right.timestamp)
    .flatMap((message) => (message.metadata?.attachments || [])
      .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
      .map((attachment) => ({
        key: `${message.id}-${attachment.id}`,
        messageId: message.id,
        attachmentId: attachment.id,
        src: attachment.url as string,
        fullSrc: attachment.url as string,
        alt: attachment.altText || message.senderName,
      })));
}

function ChoiceMeta({ label, value }: { label: string; value: string }) {
  return (
    <Box
      component="span"
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        maxWidth: '100%',
        px: 0.75,
        py: 0.25,
        borderRadius: 1,
        bgcolor: theme.palette.mode === 'light' ? 'rgba(15,23,42,0.06)' : 'rgba(226,232,240,0.08)',
        color: 'text.secondary',
        fontSize: 12,
        lineHeight: 1.5,
      })}
    >
      <Box component="span" sx={{ flex: '0 0 auto', fontWeight: 700, mr: 0.5 }}>{label}</Box>
      <Box component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{value}</Box>
    </Box>
  );
}

function StoryChoicePanel({ options, onChoose, showDeveloperDetails = false, submittingValue = null }: { options: NarrativeStoryChoiceOption[]; onChoose?: (value: string) => void; showDeveloperDetails?: boolean; submittingValue?: string | null }) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const maxContentWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  if (!options.length) return null;
  const isSubmitting = Boolean(submittingValue);
  return (
    <Box data-message-id="story-choice-panel" data-message-type="story-choice" sx={{ px: { xs: 2, sm: 3 }, py: 0.75, width: '100%' }}>
      <Stack spacing={0.75} sx={{ width: '100%', maxWidth: maxContentWidth, mx: 'auto', px: { xs: 0.5, sm: 1 }, transition: 'gap 220ms ease' }}>
        <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, fontWeight: 700, transition: 'opacity 180ms ease, max-height 220ms ease, margin 220ms ease', opacity: isSubmitting ? 0 : 1, maxHeight: isSubmitting ? 0 : 24, overflow: 'hidden' }}>
          {isSubmitting ? '已选择剧情走向' : '选择接下来的剧情走向'}
        </Typography>
        {options.map((option) => (
          <Box
            key={option.value}
            component="button"
            type="button"
            disabled={isSubmitting}
            onClick={() => {
              if (!isSubmitting) onChoose?.(option.value);
            }}
            sx={(theme) => ({
              '--choice-option-max-height': submittingValue && option.value !== submittingValue ? '0px' : '260px',
              '--choice-option-opacity': submittingValue && option.value !== submittingValue ? 0 : 1,
              '--choice-option-scale': submittingValue && option.value !== submittingValue ? 0.985 : 1,
              width: '100%',
              border: `1px solid ${theme.palette.mode === 'light' ? 'rgba(148,163,184,0.32)' : 'rgba(226,232,240,0.16)'}`,
              borderRadius: 2,
              px: { xs: 1.5, sm: 1.75 },
              py: submittingValue && option.value !== submittingValue ? 0 : { xs: 1, sm: 1.1 },
              mt: submittingValue && option.value !== submittingValue ? '0 !important' : undefined,
              maxHeight: 'var(--choice-option-max-height)',
              opacity: 'var(--choice-option-opacity)',
              transform: 'scale(var(--choice-option-scale))',
              overflow: 'hidden',
              bgcolor: submittingValue === option.value
                ? theme.palette.mode === 'light' ? 'rgba(238,242,255,0.92)' : 'rgba(49,46,129,0.42)'
                : theme.palette.mode === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.82)',
              color: 'text.primary',
              textAlign: 'left',
              font: 'inherit',
              cursor: isSubmitting ? 'default' : 'pointer',
              boxShadow: theme.palette.mode === 'light' ? '0 10px 28px rgba(15,23,42,0.10)' : '0 14px 34px rgba(0,0,0,0.28)',
              transition: 'max-height 260ms ease, opacity 180ms ease, transform 220ms ease, box-shadow 160ms ease, border-color 160ms ease, background-color 160ms ease, padding 220ms ease, margin 220ms ease',
              '&:hover': {
                transform: isSubmitting ? 'scale(var(--choice-option-scale))' : 'translateY(-1px)',
                borderColor: submittingValue === option.value
                  ? theme.palette.mode === 'light' ? 'rgba(99,102,241,0.42)' : 'rgba(129,140,248,0.5)'
                  : theme.palette.mode === 'light' ? 'rgba(99,102,241,0.38)' : 'rgba(129,140,248,0.44)',
                bgcolor: isSubmitting
                  ? undefined
                  : theme.palette.mode === 'light' ? 'rgba(255,255,255,0.98)' : 'rgba(30,41,59,0.9)',
              },
              '&:active': { transform: 'translateY(0) scale(0.992)' },
              '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
              '&:disabled': {
                color: 'text.primary',
              },
            })}
          >
            <Typography variant="body2" sx={{ fontSize: { xs: 14, sm: 14.5 }, fontWeight: 400, lineHeight: 1.7 }}>{option.label}</Typography>
            {showDeveloperDetails && (option.intent || option.risk || option.reward) ? (
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 0.75, flexWrap: 'wrap' }}>
                {option.intent ? <ChoiceMeta label="意图" value={option.intent} /> : null}
                {option.risk ? <ChoiceMeta label="风险" value={option.risk} /> : null}
                {option.reward ? <ChoiceMeta label="收益" value={option.reward} /> : null}
              </Stack>
            ) : null}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function getStoryNodeProgressChipSx(tone: StoryNodeProgressChip['tone']) {
  if (tone === 'recap') return { borderColor: 'rgba(245,158,11,0.34)', bgcolor: 'rgba(245,158,11,0.08)' };
  return { borderColor: 'rgba(14,165,233,0.32)', bgcolor: 'rgba(14,165,233,0.07)' };
}

function StoryNodeProgressBar({ message }: { message: Message }) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const progress = buildStoryNodeProgress(message);
  if (!progress) return null;
  const maxContentWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  return (
    <Box sx={{ px: { xs: 2, sm: 3 }, pt: 0.15, pb: 0.55, width: '100%' }}>
      <Stack direction="row" spacing={0.55} useFlexGap sx={{ flexWrap: 'wrap', maxWidth: maxContentWidth, mx: 'auto', px: { xs: 0.5, sm: 1 } }}>
        {progress.chips.map((chip) => (
          <Chip
            key={`${chip.tone}:${chip.label}`}
            size="small"
            label={chip.label}
            variant="outlined"
            sx={{
              height: 22,
              maxWidth: '100%',
              ...getStoryNodeProgressChipSx(chip.tone),
              '& .MuiChip-label': { px: 0.8, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
            }}
          />
        ))}
      </Stack>
    </Box>
  );
}

function resolveNarrativeBlockCharacter(block: NarrativeBlock, characters: AICharacter[]) {
  if (block.characterId) {
    const byId = characters.find((character) => character.id === block.characterId);
    if (byId) return byId;
  }
  const actorName = (block.actorName || '').trim();
  return actorName ? characters.find((character) => character.name === actorName) || null : null;
}

function buildNarrativeBlockScrollAnchor(message: Message, block: NarrativeBlock, index: number) {
  return `${message.id}:story-block:${block.id || index}`;
}

function getElementScrollAnchorId(element: HTMLElement) {
  return element.dataset.scrollAnchor || element.dataset.messageId || '';
}

function getElementScrollTimestamp(element: HTMLElement) {
  const raw = element.dataset.scrollTimestamp || element.closest<HTMLElement>('[data-scroll-timestamp]')?.dataset.scrollTimestamp;
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function getSourceMessageIdFromScrollAnchor(messageId: string) {
  const storyAnchorIndex = messageId.indexOf(':story-');
  return storyAnchorIndex >= 0 ? messageId.slice(0, storyAnchorIndex) : messageId;
}

function getRenderItemScrollAnchorId(item: MessageListRenderItem) {
  if (item.renderKind === 'narrative-block' && item.block) {
    return buildNarrativeBlockScrollAnchor(item.message, item.block, item.blockIndex ?? 0);
  }
  return item.message.id;
}

function buildNarrativeBlockMessage(parent: Message, block: NarrativeBlock, turn: NarrativeTurnMetadata | undefined, index: number, character?: AICharacter | null): Message {
  const blockKey = `${parent.id}:narrative-block:${block.id || index}`;
  if (block.displayMode === 'bubble') {
    const senderId = character?.id || block.characterId || block.actorId || parent.senderId;
    const senderName = character?.name || block.actorName || parent.senderName || '角色';
    return {
      id: blockKey,
      clientKey: blockKey,
      chatId: parent.chatId,
      type: 'ai',
      senderId,
      senderName,
      content: block.text,
      emotion: parent.emotion,
      timestamp: parent.timestamp,
      isDeleted: false,
    };
  }
  return {
    id: blockKey,
    clientKey: blockKey,
    chatId: parent.chatId,
    type: parent.type,
    senderId: parent.senderId,
    senderName: parent.senderName,
    content: block.text,
    emotion: parent.emotion,
    timestamp: parent.timestamp,
    isDeleted: false,
    metadata: {
      narrativeTurn: {
        turnId: `${turn?.turnId || parent.id}:${block.id || index}`,
        turnKind: turn?.turnKind || 'narrative_beat',
        sceneId: turn?.sceneId,
        phase: turn?.phase,
        povActorId: turn?.povActorId || parent.senderId,
        blocks: [block],
      },
      storyChoiceSelection: block.displayMode === 'choice_card' ? parent.metadata?.storyChoiceSelection : undefined,
    },
  };
}

function getStoryReaderFontFamily(fontFamily: string | undefined) {
  if (fontFamily === 'serif') return 'Georgia, "Times New Roman", "Noto Serif SC", "Songti SC", serif';
  if (fontFamily === 'sans') return 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  return undefined;
}

function getHistoricalBubbleShadow(shadow: string | undefined) {
  if (!shadow || shadow === 'none') return '0 1px 3px rgba(0,0,0,0.10)';
  return '0 1px 3px rgba(0,0,0,0.10)';
}

const LightweightNarrativeBlock = memo(function LightweightNarrativeBlock({
  block,
  character,
  maxContentWidth,
  storyReaderFontFamily,
  storyReaderFontSize,
  storyReaderLineHeight,
  customBubbleStyles,
  onCharacterAvatarClick,
}: {
  block: NarrativeBlock;
  character?: AICharacter | null;
  maxContentWidth: string | number;
  storyReaderFontFamily?: string;
  storyReaderFontSize: number;
  storyReaderLineHeight: number;
  customBubbleStyles: ReturnType<typeof useSettingsStore.getState>['customBubbleStyles'];
  onCharacterAvatarClick?: (character: import('../../services/markdownCharacterMentions').MentionCharacter, anchorEl: HTMLElement) => void;
}) {
  if (block.displayMode === 'bubble') {
    const resolvedStyle = character
      ? resolveCharacterBubbleStyle({ bubbleStyle: character.bubbleStyle, bubbleStyleId: character.bubbleStyleId, customStyles: customBubbleStyles })
      : null;
    const bubblePreview = resolvedStyle ? buildBubblePreview(resolvedStyle, false) : null;
    const senderName = character?.name || block.actorName || '角色';
    const avatarText = senderName.slice(0, 1);
    const wrapperStyle: CSSProperties = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '6px 16px',
      width: '100%',
      boxSizing: 'border-box',
    };
    const contentStyle: CSSProperties = {
      maxWidth: typeof maxContentWidth === 'number' ? maxContentWidth : maxContentWidth,
      minWidth: 0,
      display: 'grid',
      gap: 3,
      justifyItems: 'start',
    };
    const avatarStyle: CSSProperties = {
      width: 34,
      height: 34,
      borderRadius: '50%',
      flex: '0 0 auto',
      display: 'grid',
      placeItems: 'center',
      background: resolvedStyle?.backgroundColor || '#6366f1',
      color: resolvedStyle?.textColor || '#fff',
      fontSize: 14,
      fontWeight: 700,
      cursor: character && onCharacterAvatarClick ? 'pointer' : 'default',
      userSelect: 'none',
    };
    const nameStyle: CSSProperties = {
      color: 'rgba(100, 116, 139, 0.92)',
      fontSize: 12,
      lineHeight: '18px',
      fontWeight: 500,
      padding: '0 4px',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };
    const bubbleStyle: CSSProperties = {
      padding: '8px 12px',
      borderRadius: bubblePreview?.borderRadius || '18px',
      background: bubblePreview?.background || '#fff',
      color: bubblePreview?.color || '#1f2937',
      border: bubblePreview?.border || '1px solid rgba(15, 23, 42, 0.08)',
      boxShadow: getHistoricalBubbleShadow(bubblePreview?.boxShadow),
      fontSize: 14,
      lineHeight: 1.85,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      userSelect: 'text',
    };
    return (
      <div style={wrapperStyle}>
        <div
          style={avatarStyle}
          onClick={(event) => {
            if (character && onCharacterAvatarClick) onCharacterAvatarClick(character, event.currentTarget);
          }}
        >
          {avatarText}
        </div>
        <div style={contentStyle}>
          <div style={nameStyle}>{senderName}</div>
          <div style={bubbleStyle}>{block.text}</div>
        </div>
      </div>
    );
  }

  if (block.displayMode === 'system_panel') {
    const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean);
    const title = lines[0] || '章节回顾';
    const body = lines.slice(1).join('\n');
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 24px', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ width: '100%', maxWidth: maxContentWidth, border: '1px solid rgba(14,165,233,0.24)', borderRadius: 8, background: 'rgba(240,249,255,0.72)', padding: '10px 13px', boxSizing: 'border-box' }}>
          <div style={{ color: 'rgba(100, 116, 139, 0.96)', fontSize: 12, fontWeight: 700, lineHeight: 1.5, marginBottom: body ? 5 : 0 }}>{title}</div>
          {body ? <div style={{ color: '#1f2937', fontSize: 14, lineHeight: 1.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</div> : null}
        </div>
      </div>
    );
  }

  if (block.displayMode === 'choice_card') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 24px', width: '100%', boxSizing: 'border-box' }}>
        <div style={{ width: '100%', maxWidth: maxContentWidth, border: '1px solid rgba(99,102,241,0.22)', borderRadius: 8, background: 'rgba(238,242,255,0.62)', padding: '10px 13px', boxSizing: 'border-box' }}>
          <div style={{ color: 'rgba(100, 116, 139, 0.96)', fontSize: 12, fontWeight: 700, lineHeight: 1.5, marginBottom: 4 }}>你选择了</div>
          <div style={{ color: '#1f2937', fontSize: 14, lineHeight: 1.75, fontWeight: 700, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{block.text}</div>
        </div>
      </div>
    );
  }

  const paragraphStyle: CSSProperties = {
    width: '100%',
    maxWidth: maxContentWidth,
    padding: '4px 4px',
    boxSizing: 'border-box',
    fontFamily: storyReaderFontFamily,
    fontSize: storyReaderFontSize,
    lineHeight: storyReaderLineHeight,
    color: '#1f2937',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  };
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 24px', width: '100%', boxSizing: 'border-box' }}>
      <div style={paragraphStyle}>{block.text}</div>
    </div>
  );
});

export default function MessageList({
  messages,
  characters,
  currentUser,
  onDeleteMessage,
  onWithdrawMessage,
  onAnalyzeMessage,
  onExpressionFeedback,
  onRetryMedia,
  onAddImagesToReference,
  onCharacterAvatarClick,
  onMentionCharacter,
  onCreateRevision,
  onRegenerate,
  onSwitchRevision,
  onOpenArtifact,
  onOpenHtmlFullscreen,
  onHtmlAutosave,
  onHtmlSubmit,
  onHtmlRepair,
  onConfirmWorkspaceMutationPlan,
  readOnly = false,
  branchVersionInfoByMessageId,
  onReachTop,
  onReachBottom,
  onJumpToConversationBottom,
  isLoadingOlder = false,
  isLoadingNewer = false,
  hasMore = false,
  hasMoreNewer = false,
  topHint,
  loadingText,
  topInset,
  bottomInset,
  selfMemberId = null,
  privateConversation = false,
  emptyContent,
  tailContent,
  storyChoiceMessageId = null,
  storyChoiceOptions = [],
  storyChoiceSubmittingValue = null,
  onChooseStoryChoice,
  onBottomPinnedChange,
  onNearBottomChange,
  initialScrollPosition = null,
  scrollRequest = null,
  onScrollRequestResolved,
  onScrollPositionChange,
  narrativeRevealMessageKeys,
  onNarrativeRevealComplete,
  autoStickToBottom = true,
}: MessageListProps) {
  const developerMode = useSettingsStore((state) => state.developerMode);
  const developerUI = useSettingsStore((state) => state.developerUI);
  const eventRenderFlags = useMemo<EventRenderFlags>(() => ({
    developerMode,
    showRelationshipEvents: developerUI.showRelationshipEvents,
    showAffectEvents: developerUI.showAffectEvents,
    showConflictEvents: developerUI.showConflictEvents,
    showStateEvents: developerUI.showStateEvents,
    showMemoryDistillationEvents: developerUI.showMemoryDistillationEvents,
    showDetailedFactHints: developerUI.showDetailedFactHints,
    showCalendarEvents: developerUI.showCalendarEvents,
    showMemoryDebug: developerUI.showMemoryDebug,
    showLocalInterceptionHints: developerUI.showLocalInterceptionHints,
  }), [
    developerMode,
    developerUI.showAffectEvents,
    developerUI.showCalendarEvents,
    developerUI.showConflictEvents,
    developerUI.showLocalInterceptionHints,
    developerUI.showMemoryDebug,
    developerUI.showMemoryDistillationEvents,
    developerUI.showDetailedFactHints,
    developerUI.showRelationshipEvents,
    developerUI.showStateEvents,
  ]);
  const renderItems = useMemo(() => buildMessageListRenderItems({
    messages,
    eventRenderFlags,
    showDeveloperDetails: developerMode,
    storyChoiceMessageId,
    storyChoiceOptions,
  }), [developerMode, eventRenderFlags, messages, storyChoiceMessageId, storyChoiceOptions]);
  const continuousAiMessageKeys = useMemo(() => getContinuousAiMessageKeys(renderItems), [renderItems]);
  useEffect(() => {
    if (!messages.length && !renderItems.length) return;
    logDeveloperDiagnostic('message-pagination:render-state', {
      messageCount: messages.length,
      renderItemCount: renderItems.length,
      firstTimestamp: messages[0]?.timestamp || null,
      lastTimestamp: messages.at(-1)?.timestamp || null,
      firstRenderKey: renderItems[0]?.key || null,
      lastRenderKey: renderItems.at(-1)?.key || null,
      isLoadingOlder,
      isLoadingNewer,
      hasMoreOlder: hasMore,
      hasMoreNewer,
    }, messages.length <= 2 && renderItems.length <= 2 ? 'warn' : 'info', 'message-window');
  }, [hasMore, hasMoreNewer, isLoadingNewer, isLoadingOlder, messages, renderItems]);
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const customBubbleStyles = useSettingsStore((state) => state.customBubbleStyles);
  const storyRevealMode = chatAppearance.storyReader.revealMode;
  const storyReaderFontFamily = useMemo(() => getStoryReaderFontFamily(chatAppearance.storyReader.fontFamily), [chatAppearance.storyReader.fontFamily]);
  const contentMaxWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const showJumpToBottomRef = useRef(false);
  const topLoadTriggeredRef = useRef(false);
  const bottomLoadTriggeredRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const lastReportedBottomPinnedRef = useRef<boolean | null>(null);
  const lastReportedNearBottomRef = useRef<boolean | null>(null);
  const hasJumpedToBottomRef = useRef(false);
  const initialScrollPositionRef = useRef(initialScrollPosition);
  const pendingInitialRestoreRef = useRef<MessageListScrollPosition | null>(initialScrollPosition?.pinned ? null : initialScrollPosition);
  const appliedInitialRestoreKeyRef = useRef<string | null>(null);
  const prependRestoreRef = useRef<ScrollAnchorSnapshot | null>(null);
  const prependRestoreBoundaryRef = useRef<{
    firstKey: string | null;
    itemCount: number;
    scrollHeight: number;
  } | null>(null);
  const bottomRestoreDistanceRef = useRef<number | null>(null);
  const latestScrollAnchorRef = useRef<ScrollAnchorSnapshot | null>(null);
  const lastScrollTopRef = useRef(0);
  const hasUserScrollIntentRef = useRef(false);
  const isUserPointerHeldRef = useRef(false);
  const userScrollMomentumRef = useRef<{ direction: 'up' | 'down'; at: number; velocity: number } | null>(null);
  const adaptiveBottomPagesRef = useRef(MIN_BOTTOM_PREFETCH_PAGES);
  const lastScrollSampleRef = useRef<{ top: number; at: number } | null>(null);
  const scrollAnchorFrameRef = useRef<number | null>(null);
  const followScrollAnimationRef = useRef<number | null>(null);
  const tailFollowStartSnapshotRef = useRef<TailFollowStartSnapshot | null>(null);
  const programmaticScrollRef = useRef<{ mode: 'follow' | 'jump'; startedAt: number; targetTop: number } | null>(null);
  const scrollWriteIntentRef = useRef<{ kind: MessageScrollIntentKind; priority: number; startedAt: number } | null>(null);
  const scrollTransactionRef = useRef<ScrollTransaction | null>(null);
  const scrollTransactionStableFramesRef = useRef(0);
  const scrollTransactionTimeoutRef = useRef<number | null>(null);
  const initialTailRevealFramesRef = useRef<number[]>([]);
  const initialAnchorRevealFramesRef = useRef<number[]>([]);
  const previousStoryChoiceSubmittingValueRef = useRef<string | null>(storyChoiceSubmittingValue);
  const appliedScrollRequestKeyRef = useRef<string | null>(null);
  const hasInitialRestorePosition = Boolean(initialScrollPosition && !initialScrollPosition.pinned);
  const [initialViewportReady, setInitialViewportReady] = useState(() => !autoStickToBottom && !hasInitialRestorePosition);
  const [prependStabilizing, setPrependStabilizing] = useState(false);
  const [diagramViewerItem, setDiagramViewerItem] = useState<LightboxImageItem | null>(null);
  const [selectedMessageKeys, setSelectedMessageKeys] = useState<ReadonlySet<string>>(() => new Set());
  const textSelectionActive = selectedMessageKeys.size > 0;
  const renderItemKeys = useMemo(() => renderItems.map((item) => item.key), [renderItems]);
  const selectionRangeExtractor = useCallback((range: Range) => (
    extractMessageSelectionRange(range, renderItemKeys, selectedMessageKeys)
  ), [renderItemKeys, selectedMessageKeys]);
  const previousRenderMetricsRef = useRef({
    itemCount: renderItems.length,
    lastItemKey: renderItems.at(-1)?.key ?? null,
    lastItemContentLength: renderItems.at(-1)?.message.content.length ?? 0,
    lastItemIsStreaming: Boolean(renderItems.at(-1)?.message.isStreaming),
    hasTailContent: Boolean(tailContent),
    storyChoiceKey: `${storyChoiceMessageId || ''}:${storyChoiceSubmittingValue || ''}:${storyChoiceOptions.map((option) => option.value).join('|')}`,
  });

  const chatImageTimeline = useMemo(() => buildChatImageTimeline(messages), [messages]);
  const messageVirtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => containerRef.current,
    getItemKey: (index) => renderItems[index]?.key || index,
    estimateSize: () => 108,
    overscan: prependStabilizing ? PREPEND_STABILIZE_OVERSCAN : 2,
    rangeExtractor: selectionRangeExtractor,
  });
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => (
    autoStickToBottom
    && shouldStickToBottomRef.current
    && !isUserPointerHeldRef.current
    && !textSelectionActive
    && !tailFollowStartSnapshotRef.current
    && followScrollAnimationRef.current == null
  );
  const virtualMessageItems = messageVirtualizer.getVirtualItems();
  const renderedMessageItems = virtualMessageItems;

  useEffect(() => {
    const updateTextSelectionState = () => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode;
      const hasMessageSelection = Boolean(
        selection
        && !selection.isCollapsed
        && anchor
        && containerRef.current?.contains(anchor),
      );
      const selectedKeys = new Set<string>();
      const container = containerRef.current;
      if (hasMessageSelection && selection && container) {
        const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
        container.querySelectorAll<HTMLElement>('[data-selection-key]').forEach((element) => {
          if (ranges.some((range) => range.intersectsNode(element))) {
            const key = element.dataset.selectionKey;
            if (key) selectedKeys.add(key);
          }
        });
      }
      setSelectedMessageKeys((current) => (
        current.size === selectedKeys.size && [...current].every((key) => selectedKeys.has(key))
          ? current : selectedKeys
      ));
    };
    document.addEventListener('selectionchange', updateTextSelectionState);
    return () => document.removeEventListener('selectionchange', updateTextSelectionState);
  }, []);

  const viewerIndex = viewerKey ? chatImageTimeline.findIndex((item) => item.key === viewerKey) : -1;
  const viewerImages = diagramViewerItem ? [diagramViewerItem] : chatImageTimeline;
  const viewerOpen = Boolean(diagramViewerItem) || viewerIndex >= 0;
  const activeViewerIndex = diagramViewerItem ? 0 : Math.max(0, viewerIndex);

  const openChatImage = useCallback((message: Message, attachment: MessageAttachment) => {
    setDiagramViewerItem(null);
    const key = `${message.id}-${attachment.id}`;
    if (!chatImageTimeline.some((item) => item.key === key)) return;
    setViewerKey(key);
  }, [chatImageTimeline]);

  const openChatDiagram = useCallback((message: Message, diagram: { source: string; svg: string; dataUrl: string }) => {
    setViewerKey(null);
    setDiagramViewerItem({
      key: `${message.id}-diagram-${diagram.source.length}-${diagram.svg.length}`,
      src: diagram.dataUrl,
      fullSrc: diagram.dataUrl,
      alt: '流程图',
    });
  }, []);

  const loadOlderFromViewer = useCallback(() => {
    if (!onReachTop || isLoadingOlder || !hasMore) return;
    void onReachTop();
  }, [hasMore, isLoadingOlder, onReachTop]);

  const renderBubble = useCallback((item: ChatRenderItem, options?: { key?: string; message?: Message; character?: AICharacter }) => (
    <MessageBubble
      key={options?.key || item.key}
      message={options?.message || item.message}
      continuesPreviousSender={!options?.message && continuousAiMessageKeys.has(item.key)}
      characters={characters}
      character={options?.character || (item.message.type === 'ai' ? resolveCharacterOrDeleted(characters, item.message.senderId, item.message.senderName) : undefined)}
      currentUser={currentUser}
      onDelete={item.pending || item.message.type === 'system' || (options?.message && options.message.id !== item.message.id) ? undefined : onDeleteMessage}
      onWithdraw={item.pending || readOnly || item.message.type === 'system' ? undefined : onWithdrawMessage}
      onAnalyze={item.pending || readOnly || item.message.type === 'system' ? undefined : onAnalyzeMessage}
      onExpressionFeedback={item.pending || readOnly || (options?.message || item.message).type !== 'ai' ? undefined : onExpressionFeedback}
      onRetryMedia={item.pending || readOnly ? undefined : onRetryMedia}
      onOpenImage={item.pending ? undefined : openChatImage}
      onAddImagesToReference={item.pending || readOnly ? undefined : onAddImagesToReference}
      onOpenDiagram={item.pending ? undefined : openChatDiagram}
      onCharacterAvatarClick={item.pending ? undefined : onCharacterAvatarClick}
      onMentionCharacter={item.pending || readOnly ? undefined : onMentionCharacter}
      onCreateRevision={item.pending || readOnly ? undefined : onCreateRevision}
      onRegenerate={item.pending || readOnly ? undefined : onRegenerate}
      onSwitchRevision={item.pending ? undefined : onSwitchRevision}
      onOpenArtifact={item.pending ? undefined : onOpenArtifact}
      onOpenHtmlFullscreen={item.pending ? undefined : onOpenHtmlFullscreen}
      onHtmlAutosave={item.pending || readOnly ? undefined : onHtmlAutosave}
      onHtmlSubmit={item.pending || readOnly ? undefined : onHtmlSubmit}
      onHtmlRepair={item.pending || readOnly ? undefined : onHtmlRepair}
      onConfirmWorkspaceMutationPlan={item.pending || readOnly ? undefined : onConfirmWorkspaceMutationPlan}
      branchVersionInfo={branchVersionInfoByMessageId?.[options?.message?.id || item.message.id] || null}
      pending={item.pending}
      selfMemberId={selfMemberId}
      privateConversation={privateConversation}
    />
  ), [branchVersionInfoByMessageId, characters, continuousAiMessageKeys, currentUser, onAddImagesToReference, onAnalyzeMessage, onCharacterAvatarClick, onMentionCharacter, onConfirmWorkspaceMutationPlan, onCreateRevision, onDeleteMessage, onExpressionFeedback, onHtmlAutosave, onHtmlRepair, onHtmlSubmit, onOpenArtifact, onOpenHtmlFullscreen, onRegenerate, onRetryMedia, onSwitchRevision, onWithdrawMessage, openChatDiagram, openChatImage, privateConversation, readOnly, selfMemberId]);

  const renderMessageItem = useCallback((item: MessageListRenderItem) => {
    const anchorProps = {
      'data-message-id': item.message.id,
      'data-message-client-key': item.message.clientKey || undefined,
      'data-message-server-id': item.message.serverId || undefined,
      'data-scroll-timestamp': String(item.message.timestamp),
    };
    if (item.renderKind === 'system') {
      return <Box key={item.key} {...anchorProps}><SystemMessageItem message={item.message} /></Box>;
    }
    if (item.renderKind === 'event') {
      return <Box key={item.key} {...anchorProps}><EventMessageItem message={item.message} members={characters} /></Box>;
    }
    if (item.renderKind === 'story-choice') {
      return (
        <Box key={item.key} {...anchorProps} sx={{ display: 'grid' }}>
          <Box data-scroll-anchor={`${item.message.id}:story-choice`} data-scroll-timestamp={item.message.timestamp}>
            <StoryChoicePanel options={storyChoiceOptions} onChoose={onChooseStoryChoice} showDeveloperDetails={developerMode} submittingValue={storyChoiceSubmittingValue} />
          </Box>
        </Box>
      );
    }
    if (item.renderKind === 'narrative-progress') {
      return <Box key={item.key} {...anchorProps}><StoryNodeProgressBar message={item.message} /></Box>;
    }
    if (item.renderKind === 'narrative-block') {
      const block = item.block;
      const index = item.blockIndex ?? 0;
      if (!block) return null;
      const recentNarrative = !item.pending && isNarrativeRevealAllowed({ item: item.sourceItem, revealMessageKeys: narrativeRevealMessageKeys });
      const shouldFadeNode = recentNarrative && storyRevealMode === 'fade' && !prefersReducedMotion();
      const character = block.displayMode === 'bubble' ? resolveNarrativeBlockCharacter(block, characters) : undefined;
      if (!item.pending) {
        return (
          <div
            key={item.key}
            {...anchorProps}
            data-scroll-anchor={buildNarrativeBlockScrollAnchor(item.message, block, index)}
            onAnimationEnd={shouldFadeNode && item.completeNarrativeReveal ? () => onNarrativeRevealComplete?.(item.message) : undefined}
            style={{
              display: 'grid',
              ...(shouldFadeNode ? {
                animation: `${storyNodeFadeIn} 220ms ease-out both`,
              } : {}),
            }}
          >
            <LightweightNarrativeBlock
              block={block}
              character={character}
              maxContentWidth={contentMaxWidth}
              storyReaderFontFamily={storyReaderFontFamily}
              storyReaderFontSize={chatAppearance.storyReader.fontSize}
              storyReaderLineHeight={chatAppearance.storyReader.lineHeight}
              customBubbleStyles={customBubbleStyles}
              onCharacterAvatarClick={onCharacterAvatarClick}
            />
          </div>
        );
      }
      const blockMessage = buildNarrativeBlockMessage(item.message, block, item.message.metadata?.narrativeTurn, index, character);
      return (
        <Box
          key={item.key}
          {...anchorProps}
          data-scroll-anchor={buildNarrativeBlockScrollAnchor(item.message, block, index)}
          onAnimationEnd={shouldFadeNode && item.completeNarrativeReveal ? () => onNarrativeRevealComplete?.(item.message) : undefined}
          sx={{
            display: 'grid',
            ...(shouldFadeNode ? {
              animation: `${storyNodeFadeIn} 220ms ease-out both`,
            } : {}),
          }}
        >
          {renderBubble(item.sourceItem, {
            key: `${item.key}:bubble`,
            message: blockMessage,
            character: character || (blockMessage.type === 'ai' ? resolveCharacterOrDeleted(characters, blockMessage.senderId, blockMessage.senderName) : undefined),
          })}
        </Box>
      );
    }
    return <Box key={item.key} {...anchorProps}>{renderBubble(item.sourceItem)}</Box>;
  }, [characters, chatAppearance.storyReader.fontSize, chatAppearance.storyReader.lineHeight, contentMaxWidth, customBubbleStyles, developerMode, narrativeRevealMessageKeys, onCharacterAvatarClick, onChooseStoryChoice, onNarrativeRevealComplete, renderBubble, storyChoiceOptions, storyChoiceSubmittingValue, storyReaderFontFamily, storyRevealMode]);

  const topStatusText = useMemo(() => {
    if (messages.length === 0) return null;
    if (hasMore) return isLoadingOlder ? (loadingText || null) : '';
    return topHint || '没有更早的消息';
  }, [hasMore, isLoadingOlder, loadingText, messages.length, topHint]);

  const getDistanceFromBottom = useCallback((element: HTMLDivElement) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ), []);

  const shouldShowJumpToBottomButton = useCallback((element: HTMLDivElement) => (
    getDistanceFromBottom(element) > element.clientHeight * JUMP_TO_BOTTOM_PAGE_MULTIPLIER
  ), [getDistanceFromBottom]);

  const updateJumpToBottomVisibility = useCallback((visible: boolean) => {
    if (showJumpToBottomRef.current === visible) return;
    showJumpToBottomRef.current = visible;
    setShowJumpToBottom(visible);
  }, []);

  const getAdaptiveBottomThreshold = useCallback((element: HTMLDivElement) => (
    Math.max(BOTTOM_STICKY_THRESHOLD, element.clientHeight * adaptiveBottomPagesRef.current)
  ), []);

  const reportNearBottomState = useCallback((element: HTMLDivElement) => {
    const nearBottom = getDistanceFromBottom(element) <= getAdaptiveBottomThreshold(element) && !hasMoreNewer;
    if (lastReportedNearBottomRef.current !== nearBottom) {
      lastReportedNearBottomRef.current = nearBottom;
      onNearBottomChange?.(nearBottom);
    }
    return nearBottom;
  }, [getAdaptiveBottomThreshold, getDistanceFromBottom, hasMoreNewer, onNearBottomChange]);

  const cancelProgrammaticScroll = useCallback(() => {
    if (followScrollAnimationRef.current != null) {
      window.cancelAnimationFrame(followScrollAnimationRef.current);
      followScrollAnimationRef.current = null;
    }
    programmaticScrollRef.current = null;
  }, []);

  const markUserScrollIntent = useCallback(() => {
    hasUserScrollIntentRef.current = true;
    scrollWriteIntentRef.current = {
      kind: 'userScroll',
      priority: SCROLL_INTENT_PRIORITY.userScroll,
      startedAt: performance.now(),
    };
    cancelProgrammaticScroll();
  }, [cancelProgrammaticScroll]);

  const beginUserScrollGesture = useCallback(() => {
    isUserPointerHeldRef.current = true;
    markUserScrollIntent();
  }, [markUserScrollIntent]);

  const endUserScrollGesture = useCallback(() => {
    isUserPointerHeldRef.current = false;
  }, []);

  useEffect(() => {
    // Keep the user's press state accurate even when the pointer is released
    // outside the list. Capturing the pointer on the list retargets click and
    // double-click events away from message bubbles and their controls.
    window.addEventListener('pointerup', endUserScrollGesture);
    window.addEventListener('pointercancel', endUserScrollGesture);
    window.addEventListener('blur', endUserScrollGesture);
    return () => {
      window.removeEventListener('pointerup', endUserScrollGesture);
      window.removeEventListener('pointercancel', endUserScrollGesture);
      window.removeEventListener('blur', endUserScrollGesture);
    };
  }, [endUserScrollGesture]);

  const recordUserScrollMomentum = useCallback((direction: 'up' | 'down' | null, velocity: number) => {
    if (!direction || velocity <= 0) return;
    userScrollMomentumRef.current = {
      direction,
      velocity,
      at: performance.now(),
    };
  }, []);

  const isUserScrollMomentumActive = useCallback((direction?: 'up' | 'down') => {
    const current = userScrollMomentumRef.current;
    if (!current) return false;
    if (direction && current.direction !== direction) return false;
    return performance.now() - current.at <= USER_SCROLL_INERTIA_GRACE_MS;
  }, []);

  const isRecentScrollWriteIntent = useCallback((intent: MessageScrollIntentKind) => {
    const active = scrollWriteIntentRef.current;
    return Boolean(active && active.kind === intent && performance.now() - active.startedAt <= SCROLL_INTENT_SETTLE_MS);
  }, []);

  const runScrollWrite = useCallback((
    intent: MessageScrollIntentKind,
    write: (container: HTMLDivElement) => void,
    options?: { allowDuringUserScroll?: boolean },
  ) => {
    const container = containerRef.current;
    if (!container) return false;
    if (isUserPointerHeldRef.current && intent !== 'explicitJump') {
      return false;
    }
    const now = performance.now();
    const priority = SCROLL_INTENT_PRIORITY[intent];
    const active = scrollWriteIntentRef.current;
    const userScrollActive = isUserScrollMomentumActive();
    const blockedReason = shouldBlockScrollWrite({
      intent,
      now,
      active: active ? { intent: active.kind, priority: active.priority, startedAt: active.startedAt } : null,
      userMomentum: userScrollActive,
      allowDuringUserScroll: options?.allowDuringUserScroll,
      settleMs: SCROLL_INTENT_SETTLE_MS,
      transaction: scrollTransactionRef.current,
    });
    if (blockedReason) {
      logDeveloperDiagnostic('chat-scroll:intent-blocked', {
        intent,
        reason: blockedReason,
        activeIntent: active?.kind,
        scrollTop: Math.round(container.scrollTop),
      }, 'debug', 'chat-scroll');
      return false;
    }
    scrollWriteIntentRef.current = { kind: intent, priority, startedAt: now };
    const beforeTop = container.scrollTop;
    write(container);
    lastScrollTopRef.current = container.scrollTop;
    logDeveloperDiagnostic('chat-scroll:write', {
      intent,
      beforeTop: Math.round(beforeTop),
      afterTop: Math.round(container.scrollTop),
      delta: Math.round(container.scrollTop - beforeTop),
      distanceFromBottom: Math.round(getDistanceFromBottom(container)),
      scrollHeight: Math.round(container.scrollHeight),
      clientHeight: Math.round(container.clientHeight),
      activeIntent: active?.kind || null,
    }, 'debug', 'chat-scroll');
    return true;
  }, [getDistanceFromBottom, isUserScrollMomentumActive]);

  const updateAdaptiveBottomPrefetch = useCallback((element: HTMLDivElement, isScrollingDown: boolean) => {
    if (!hasUserScrollIntentRef.current || !isScrollingDown) return;
    const now = performance.now();
    const previous = lastScrollSampleRef.current;
    lastScrollSampleRef.current = { top: element.scrollTop, at: now };
    if (!previous) return;
    const deltaTop = element.scrollTop - previous.top;
    const deltaTime = Math.max(16, now - previous.at);
    const velocity = deltaTop / deltaTime;
    if (velocity >= 1.2) {
      adaptiveBottomPagesRef.current = MAX_BOTTOM_PREFETCH_PAGES;
    } else if (velocity >= 0.45) {
      adaptiveBottomPagesRef.current = 2;
    } else {
      adaptiveBottomPagesRef.current = MIN_BOTTOM_PREFETCH_PAGES;
    }
  }, []);

  const captureScrollAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const distanceFromBottom = getDistanceFromBottom(container);
    const scrollAnchorNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor]'));
    const messageAnchorNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
    const nodes = scrollAnchorNodes.length ? scrollAnchorNodes : messageAnchorNodes;
    const visibleNodes = nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1;
    });
    const candidates = visibleNodes.length ? visibleNodes : nodes;
    const targetLine = distanceFromBottom <= BOTTOM_RESTORE_ANCHOR_THRESHOLD
      ? containerRect.bottom - Math.min(120, containerRect.height * 0.25)
      : containerRect.top + containerRect.height * 0.42;
    const anchorNode = candidates
      .map((node) => ({ node, distance: Math.abs(node.getBoundingClientRect().top - targetLine) }))
      .sort((left, right) => left.distance - right.distance)[0]?.node;
    const messageId = anchorNode ? getElementScrollAnchorId(anchorNode) : '';
    if (!anchorNode || !messageId) return null;
    return {
      messageId,
      offsetTop: anchorNode.getBoundingClientRect().top - containerRect.top,
      sourceTimestamp: getElementScrollTimestamp(anchorNode),
    };
  }, [getDistanceFromBottom]);

  const captureTopVisibleScrollAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const messageNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
    const scrollAnchorNodes = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor]'));
    const nodes = messageNodes.length ? messageNodes : scrollAnchorNodes;
    const anchorNode = nodes
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1)
      .sort((left, right) => {
        const leftDistance = Math.abs(left.rect.top - containerRect.top);
        const rightDistance = Math.abs(right.rect.top - containerRect.top);
        return leftDistance - rightDistance;
      })[0]?.node;
    const messageId = anchorNode ? getElementScrollAnchorId(anchorNode) : '';
    if (!anchorNode || !messageId) return null;
    return {
      messageId,
      offsetTop: anchorNode.getBoundingClientRect().top - containerRect.top,
      sourceTimestamp: getElementScrollTimestamp(anchorNode),
    };
  }, []);

  const rememberPrependRestoreAnchor = useCallback((snapshot: ScrollAnchorSnapshot | null) => {
    if (!snapshot) return;
    const container = containerRef.current;
    setPrependStabilizing(true);
    prependRestoreRef.current = snapshot;
    prependRestoreBoundaryRef.current = {
      firstKey: renderItems[0]?.key ?? null,
      itemCount: renderItems.length,
      scrollHeight: Math.round(container?.scrollHeight ?? 0),
    };
  }, [renderItems]);

  const restoreScrollAnchor = useCallback((
    snapshot: ScrollAnchorSnapshot & { behavior?: ScrollBehavior },
    options?: { intent?: MessageScrollIntentKind; allowDuringUserScroll?: boolean },
  ) => {
    const container = containerRef.current;
    if (!container) return false;
    const containerRect = container.getBoundingClientRect();
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor], [data-message-id]'));
    const target = nodes
      .find((node) => getElementScrollAnchorId(node) === snapshot.messageId);
    const sourceMessageId = getSourceMessageIdFromScrollAnchor(snapshot.messageId);
    const sourceTarget = target ? null : nodes
      .find((node) => node.dataset.messageId === sourceMessageId);
    const fallbackTarget = target || sourceTarget || (snapshot.sourceTimestamp !== undefined
      ? nodes
        .map((node) => ({ node, timestamp: getElementScrollTimestamp(node) }))
        .filter((item): item is { node: HTMLElement; timestamp: number } => item.timestamp !== undefined)
        .sort((left, right) => Math.abs(left.timestamp - snapshot.sourceTimestamp!) - Math.abs(right.timestamp - snapshot.sourceTimestamp!))[0]?.node
      : null);
    if (!fallbackTarget) {
      logDeveloperDiagnostic('chat-scroll:anchor-restore-miss', {
        请求锚点: snapshot,
        scrollTop: Math.round(container.scrollTop),
        scrollHeight: Math.round(container.scrollHeight),
        clientHeight: Math.round(container.clientHeight),
        renderItemCount: renderItems.length,
        firstMessageId: renderItems[0]?.message.id,
        firstTimestamp: renderItems[0]?.message.timestamp,
        lastMessageId: renderItems.at(-1)?.message.id,
        lastTimestamp: renderItems.at(-1)?.message.timestamp,
      }, options?.intent === 'initialRestore' ? 'debug' : 'warn', 'chat-scroll');
      return false;
    }
    const currentOffset = fallbackTarget.getBoundingClientRect().top - containerRect.top;
    const delta = currentOffset - snapshot.offsetTop;
    const beforeTop = container.scrollTop;
    if (Math.abs(delta) >= 1) {
      const didWrite = runScrollWrite(options?.intent || 'explicitJump', (scrollContainer) => {
        if ('behavior' in snapshot && snapshot.behavior && snapshot.behavior !== 'auto') {
          scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: snapshot.behavior });
        } else {
          scrollContainer.scrollTop += delta;
        }
      }, { allowDuringUserScroll: options?.allowDuringUserScroll });
      if (!didWrite) return false;
    }
    lastScrollTopRef.current = container.scrollTop;
    logDeveloperDiagnostic('chat-scroll:anchor-restored', {
      请求锚点: snapshot,
      匹配方式: target ? '精确匹配' : sourceTarget ? '源消息兜底' : '按时间兜底',
      实际锚点: {
        id: getElementScrollAnchorId(fallbackTarget),
        timestamp: getElementScrollTimestamp(fallbackTarget),
      },
      当前offsetTop: Math.round(currentOffset),
      目标offsetTop: Math.round(snapshot.offsetTop),
      delta: Math.round(delta),
      beforeScrollTop: Math.round(beforeTop),
      afterScrollTop: Math.round(container.scrollTop),
      renderItemCount: renderItems.length,
      hasMore,
      hasMoreNewer,
      isLoadingOlder,
      isLoadingNewer,
    }, 'debug', 'chat-scroll');
    return true;
  }, [hasMore, hasMoreNewer, isLoadingNewer, isLoadingOlder, renderItems, runScrollWrite]);

  const resolveVirtualScrollAnchorIndex = useCallback((snapshot: ScrollAnchorSnapshot) => {
    const exactIndex = renderItems.findIndex((item) => getRenderItemScrollAnchorId(item) === snapshot.messageId);
    if (exactIndex >= 0) {
      return { index: exactIndex, reason: 'exact-anchor' };
    }

    const sourceMessageId = getSourceMessageIdFromScrollAnchor(snapshot.messageId);
    const sourceIndex = renderItems.findIndex((item) => item.message.id === sourceMessageId);
    if (sourceIndex >= 0) {
      return { index: sourceIndex, reason: 'source-message' };
    }

    if (snapshot.sourceTimestamp === undefined) return null;
    let nearest: { index: number; distance: number } | null = null;
    for (let index = 0; index < renderItems.length; index += 1) {
      const item = renderItems[index];
      if (!item) continue;
      const distance = Math.abs(item.message.timestamp - snapshot.sourceTimestamp!);
      if (!nearest || distance < nearest.distance) nearest = { index, distance };
    }
    return nearest ? { index: nearest.index, reason: 'source-timestamp' } : null;
  }, [renderItems]);

  const scrollVirtualizerToAnchor = useCallback((snapshot: ScrollAnchorSnapshot, options?: { intent?: MessageScrollIntentKind; allowDuringUserScroll?: boolean }) => {
    const match = resolveVirtualScrollAnchorIndex(snapshot);
    if (!match) return false;
    const didWrite = runScrollWrite(options?.intent || 'explicitJump', () => {
      messageVirtualizer.scrollToIndex(match.index, { align: 'start', behavior: 'auto' });
    }, { allowDuringUserScroll: options?.allowDuringUserScroll });
    if (!didWrite) return false;
    logDeveloperDiagnostic('chat-scroll:virtual-restore-prep', {
      messageId: snapshot.messageId,
      offsetTop: Math.round(snapshot.offsetTop),
      sourceTimestamp: snapshot.sourceTimestamp,
      index: match.index,
      reason: match.reason,
      renderItemCount: renderItems.length,
      targetMessageId: renderItems[match.index]?.message.id,
    }, 'info', 'chat-scroll');
    return true;
  }, [messageVirtualizer, renderItems, resolveVirtualScrollAnchorIndex, runScrollWrite]);

  const highlightScrollTarget = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const target = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor], [data-message-id]'))
      .find((node) => getElementScrollAnchorId(node) === messageId);
    if (!target) return;
    const previousOutline = target.style.outline;
    const previousOutlineOffset = target.style.outlineOffset;
    target.style.outline = '2px solid rgba(59,130,246,0.88)';
    target.style.outlineOffset = '3px';
    window.setTimeout(() => {
      target.style.outline = previousOutline;
      target.style.outlineOffset = previousOutlineOffset;
    }, 1300);
  }, []);

  const getInitialRestoreKey = useCallback((position: MessageListScrollPosition | null) => (
    position && !position.pinned
      ? `${position.messageId}:${Math.round(position.offsetTop)}:${position.sourceTimestamp ?? ''}`
      : null
  ), []);

  useLayoutEffect(() => {
    if (hasJumpedToBottomRef.current) return;
    initialScrollPositionRef.current = initialScrollPosition;
    const restoreKey = getInitialRestoreKey(initialScrollPosition);
    if (!restoreKey || appliedInitialRestoreKeyRef.current === restoreKey) return;
    pendingInitialRestoreRef.current = initialScrollPosition;
    setInitialViewportReady(false);
    logDeveloperDiagnostic('chat-scroll:restore-pending', {
      messageId: initialScrollPosition?.messageId,
      offsetTop: initialScrollPosition?.offsetTop,
      sourceTimestamp: initialScrollPosition?.sourceTimestamp,
      renderItemCount: renderItems.length,
    }, 'info');
  }, [getInitialRestoreKey, initialScrollPosition, renderItems.length]);

  const rememberScrollAnchor = useCallback((options?: { persist?: boolean; reason?: string }) => {
    const snapshot = captureScrollAnchor();
    latestScrollAnchorRef.current = snapshot;
    if (snapshot && options?.persist !== false) {
      if (onScrollPositionChange) {
        // This reports a shared viewport position. The caller decides whether
        // to keep it in memory (chat navigation) or persist it (story reading).
        logDeveloperDiagnostic('chat-scroll:position-reported', {
          reason: options?.reason || 'unknown',
          messageId: snapshot.messageId,
          offsetTop: Math.round(snapshot.offsetTop),
          pinned: shouldStickToBottomRef.current,
          sourceTimestamp: snapshot.sourceTimestamp,
          userScrollIntent: hasUserScrollIntentRef.current,
          scrollTop: Math.round(containerRef.current?.scrollTop ?? 0),
        }, 'debug', 'chat-scroll');
        onScrollPositionChange({
          ...snapshot,
          pinned: shouldStickToBottomRef.current,
        });
      }
    } else if (snapshot && onScrollPositionChange) {
      logDeveloperDiagnostic('chat-scroll:position-report-skipped', {
        reason: options?.reason || 'unknown',
        messageId: snapshot.messageId,
        offsetTop: Math.round(snapshot.offsetTop),
        pinned: shouldStickToBottomRef.current,
        sourceTimestamp: snapshot.sourceTimestamp,
        userScrollIntent: hasUserScrollIntentRef.current,
        scrollTop: Math.round(containerRef.current?.scrollTop ?? 0),
      }, 'debug', 'chat-scroll');
    }
    if (isLoadingOlder && snapshot) {
      rememberPrependRestoreAnchor(captureTopVisibleScrollAnchor() || snapshot);
    }
    return snapshot;
  }, [captureScrollAnchor, captureTopVisibleScrollAnchor, isLoadingOlder, onScrollPositionChange, rememberPrependRestoreAnchor]);

  const scheduleRememberScrollAnchor = useCallback((options?: { persist?: boolean; reason?: string }) => {
    if (scrollAnchorFrameRef.current != null) return;
    scrollAnchorFrameRef.current = window.requestAnimationFrame(() => {
      scrollAnchorFrameRef.current = null;
      rememberScrollAnchor(options);
    });
  }, [rememberScrollAnchor]);
  const rememberScrollAnchorRef = useRef(rememberScrollAnchor);
  useEffect(() => {
    rememberScrollAnchorRef.current = rememberScrollAnchor;
  }, [rememberScrollAnchor]);

  useEffect(() => () => {
    if (scrollAnchorFrameRef.current != null) {
      window.cancelAnimationFrame(scrollAnchorFrameRef.current);
      scrollAnchorFrameRef.current = null;
    }
    rememberScrollAnchorRef.current({
      persist: hasUserScrollIntentRef.current || shouldStickToBottomRef.current,
      reason: 'unmount',
    });
  }, []);

  const triggerReachBottom = useCallback(() => {
    if (!onReachBottom || isLoadingNewer || !hasMoreNewer || bottomLoadTriggeredRef.current) return;
    const container = containerRef.current;
    bottomRestoreDistanceRef.current = container ? getDistanceFromBottom(container) : null;
    bottomLoadTriggeredRef.current = true;
    void onReachBottom();
  }, [getDistanceFromBottom, hasMoreNewer, isLoadingNewer, onReachBottom]);

  useEffect(() => {
    if (storyRevealMode !== 'instant' || !onNarrativeRevealComplete) return;
    if (!narrativeRevealMessageKeys?.size) return;
    renderItems.forEach((item) => {
      if (item.renderKind === 'narrative-block' && item.completeNarrativeReveal && isNarrativeRevealAllowed({ item: item.sourceItem, revealMessageKeys: narrativeRevealMessageKeys })) {
        onNarrativeRevealComplete(item.message);
      }
    });
  }, [narrativeRevealMessageKeys, onNarrativeRevealComplete, renderItems, storyRevealMode]);

  const updatePinnedState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    const distance = getDistanceFromBottom(container);
    const pinned = distance <= BOTTOM_STICKY_THRESHOLD && !hasMoreNewer;
    updateJumpToBottomVisibility(shouldShowJumpToBottomButton(container));
    shouldStickToBottomRef.current = pinned;
    if (lastReportedBottomPinnedRef.current !== pinned) {
      lastReportedBottomPinnedRef.current = pinned;
      onBottomPinnedChange?.(pinned);
    }
    return pinned;
  }, [getDistanceFromBottom, hasMoreNewer, onBottomPinnedChange, shouldShowJumpToBottomButton, updateJumpToBottomVisibility]);

  const isProgrammaticTailScrollActive = useCallback(() => {
    const current = programmaticScrollRef.current;
    if (!current) return false;
    if (followScrollAnimationRef.current != null) return true;
    return performance.now() - current.startedAt <= PROGRAMMATIC_SCROLL_SETTLE_MS;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto', intent: MessageScrollIntentKind = 'tailFollow') => {
    const container = containerRef.current;
    if (!container) return;
    cancelProgrammaticScroll();
    const top = Math.max(0, container.scrollHeight - container.clientHeight);
    const distance = Math.abs(top - container.scrollTop);
    const effectiveBehavior = prefersReducedMotion() || distance > SMOOTH_SCROLL_DISTANCE_LIMIT ? 'auto' : behavior;
    const didWrite = runScrollWrite(intent, (scrollContainer) => {
      programmaticScrollRef.current = { mode: 'jump', startedAt: performance.now(), targetTop: top };
      scrollContainer.scrollTo({ top, behavior: effectiveBehavior });
    }, { allowDuringUserScroll: intent === 'explicitJump' });
    if (!didWrite) return;
    shouldStickToBottomRef.current = !hasMoreNewer;
    updateJumpToBottomVisibility(false);
    if (!hasMoreNewer && lastReportedBottomPinnedRef.current !== true) {
      lastReportedBottomPinnedRef.current = true;
      onBottomPinnedChange?.(true);
    }
    if (effectiveBehavior === 'auto') {
      lastScrollTopRef.current = top;
    }
  }, [cancelProgrammaticScroll, hasMoreNewer, onBottomPinnedChange, runScrollWrite, updateJumpToBottomVisibility]);

  const followScrollToBottom = useCallback((options?: { animate?: boolean; mode?: 'follow' | 'jump'; intent?: MessageScrollIntentKind; startTop?: number }) => {
    const container = containerRef.current;
    if (!container) return;
    cancelProgrammaticScroll();
    const capturedStartTop = options?.startTop;
    if (capturedStartTop != null && Math.abs(container.scrollTop - capturedStartTop) >= 1) {
      const restored = runScrollWrite(options?.intent || 'tailFollow', (scrollContainer) => {
        scrollContainer.scrollTop = capturedStartTop;
      });
      if (!restored) return;
    }
    const startTop = capturedStartTop ?? container.scrollTop;
    const initialTargetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const distance = initialTargetTop - startTop;
    const intent = options?.intent || (options?.mode === 'jump' ? 'explicitJump' : 'tailFollow');
    if (options?.animate === false || prefersReducedMotion() || Math.abs(distance) > SMOOTH_SCROLL_DISTANCE_LIMIT) {
      const didWrite = runScrollWrite(intent, (scrollContainer) => {
        scrollContainer.scrollTop = initialTargetTop;
      }, { allowDuringUserScroll: intent === 'explicitJump' });
      if (!didWrite) return;
      programmaticScrollRef.current = { mode: options?.mode || 'follow', startedAt: performance.now(), targetTop: initialTargetTop };
      shouldStickToBottomRef.current = !hasMoreNewer;
      return;
    }
    if (Math.abs(distance) < 1) return;
    let startTime: number | null = null;
    const mode = options?.mode || 'follow';
    programmaticScrollRef.current = { mode, startedAt: performance.now(), targetTop: initialTargetTop };
    const step = (time: number) => {
      if (!shouldStickToBottomRef.current) {
        followScrollAnimationRef.current = null;
        programmaticScrollRef.current = null;
        return;
      }
      if (startTime == null) startTime = time;
      const duration = mode === 'jump' ? JUMP_SCROLL_DURATION_MS : FOLLOW_SCROLL_DURATION_MS;
      const progress = Math.min(1, (time - startTime) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      // The first streaming glyph can arrive while the new-bubble animation
      // is in flight. Re-read the tail so the animation finishes at the
      // current bottom rather than at the bubble's initial placeholder size.
      const currentTargetTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextTop = startTop + (currentTargetTop - startTop) * eased;
      const didWrite = runScrollWrite(intent, (scrollContainer) => {
        scrollContainer.scrollTop = nextTop;
      }, { allowDuringUserScroll: intent === 'explicitJump' });
      if (!didWrite) {
        followScrollAnimationRef.current = null;
        return;
      }
      if (progress < 1) {
        followScrollAnimationRef.current = window.requestAnimationFrame(step);
      } else {
        followScrollAnimationRef.current = null;
        programmaticScrollRef.current = { mode, startedAt: performance.now(), targetTop: currentTargetTop };
      }
    };
    followScrollAnimationRef.current = window.requestAnimationFrame(step);
  }, [cancelProgrammaticScroll, hasMoreNewer, runScrollWrite]);

  const forceTailScrollPosition = useCallback((intent: MessageScrollIntentKind = 'tailFollow') => {
    const container = containerRef.current;
    if (!container || renderItems.length === 0) return;
    runScrollWrite(intent, (scrollContainer) => {
      programmaticScrollRef.current = {
        mode: 'jump',
        startedAt: performance.now(),
        targetTop: Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight),
      };
      messageVirtualizer.scrollToIndex(renderItems.length - 1, { align: 'end', behavior: 'auto' });
    }, { allowDuringUserScroll: intent === 'initialRestore' || intent === 'explicitJump' });
  }, [messageVirtualizer, renderItems.length, runScrollWrite]);

  const cancelInitialTailRevealFrames = useCallback(() => {
    initialTailRevealFramesRef.current.forEach((frame) => window.cancelAnimationFrame(frame));
    initialTailRevealFramesRef.current = [];
  }, []);

  const cancelInitialAnchorRevealFrames = useCallback(() => {
    initialAnchorRevealFramesRef.current.forEach((frame) => window.cancelAnimationFrame(frame));
    initialAnchorRevealFramesRef.current = [];
  }, []);

  const scheduleInitialTailReveal = useCallback(() => {
    cancelInitialTailRevealFrames();
    setInitialViewportReady(false);
    const runFrame = (frameCount: number, stableCount: number) => {
      forceTailScrollPosition('initialRestore');
      const container = containerRef.current;
      const distanceFromBottom = container ? getDistanceFromBottom(container) : Number.POSITIVE_INFINITY;
      const nextStableCount = distanceFromBottom <= INITIAL_TAIL_REVEAL_THRESHOLD ? stableCount + 1 : 0;
      if (nextStableCount >= INITIAL_REVEAL_STABLE_FRAMES || frameCount >= INITIAL_REVEAL_MAX_FRAMES) {
        logDeveloperDiagnostic('chat-scroll:initial-tail-reveal', {
          frameCount,
          stableCount: nextStableCount,
          distanceFromBottom: Number.isFinite(distanceFromBottom) ? Math.round(distanceFromBottom) : null,
          scrollTop: Math.round(container?.scrollTop ?? 0),
          scrollHeight: Math.round(container?.scrollHeight ?? 0),
          clientHeight: Math.round(container?.clientHeight ?? 0),
          renderItemCount: renderItems.length,
        }, 'debug', 'chat-scroll');
        initialTailRevealFramesRef.current = [];
        setInitialViewportReady(true);
        return;
      }
      const handle = window.requestAnimationFrame(() => runFrame(frameCount + 1, nextStableCount));
      initialTailRevealFramesRef.current = [handle];
    };
    const firstFrame = window.requestAnimationFrame(() => runFrame(1, 0));
    initialTailRevealFramesRef.current = [firstFrame];
  }, [cancelInitialTailRevealFrames, forceTailScrollPosition, getDistanceFromBottom, renderItems.length]);

  const scheduleInitialAnchorReveal = useCallback((position: MessageListScrollPosition) => {
    cancelInitialAnchorRevealFrames();
    setInitialViewportReady(false);
    const runFrame = (frameCount: number, stableCount: number) => {
      scrollVirtualizerToAnchor(position, { intent: 'initialRestore', allowDuringUserScroll: true });
      const restored = restoreScrollAnchor(position, { intent: 'initialRestore', allowDuringUserScroll: true });
      const nextStableCount = restored ? stableCount + 1 : 0;
      if (nextStableCount >= INITIAL_REVEAL_STABLE_FRAMES || frameCount >= INITIAL_REVEAL_MAX_FRAMES) {
        const container = containerRef.current;
        logDeveloperDiagnostic('chat-scroll:initial-anchor-reveal', {
          messageId: position.messageId,
          offsetTop: Math.round(position.offsetTop),
          sourceTimestamp: position.sourceTimestamp,
          frameCount,
          restored,
          stableCount: nextStableCount,
          scrollTop: Math.round(container?.scrollTop ?? 0),
          scrollHeight: Math.round(container?.scrollHeight ?? 0),
          clientHeight: Math.round(container?.clientHeight ?? 0),
          renderItemCount: renderItems.length,
        }, restored ? 'debug' : 'warn', 'chat-scroll');
        initialAnchorRevealFramesRef.current = [];
        setInitialViewportReady(true);
        return;
      }
      const handle = window.requestAnimationFrame(() => runFrame(frameCount + 1, nextStableCount));
      initialAnchorRevealFramesRef.current = [handle];
    };
    const firstFrame = window.requestAnimationFrame(() => runFrame(1, 0));
    initialAnchorRevealFramesRef.current = [firstFrame];
  }, [cancelInitialAnchorRevealFrames, renderItems.length, restoreScrollAnchor, scrollVirtualizerToAnchor]);

  useEffect(() => cancelProgrammaticScroll, [cancelProgrammaticScroll]);

  // Save the viewport before React inserts a new tail row. TanStack Virtual
  // may temporarily render that row at an estimate, so the later follow must
  // start from this real position, not from an already-adjusted scrollTop.
  useLayoutEffect(() => () => {
    const container = containerRef.current;
    if (!container || !hasJumpedToBottomRef.current) return;
    if (!shouldMaintainTailAfterMutation({
      autoStickToBottom,
      wasPinnedBeforeMutation: shouldStickToBottomRef.current,
      isUserPointerHeld: isUserPointerHeldRef.current,
    })) {
      tailFollowStartSnapshotRef.current = null;
      return;
    }
    tailFollowStartSnapshotRef.current = { scrollTop: container.scrollTop };
  }, [autoStickToBottom, renderItems, storyChoiceMessageId, storyChoiceOptions, storyChoiceSubmittingValue, tailContent]);

  useEffect(() => cancelInitialTailRevealFrames, [cancelInitialTailRevealFrames]);
  useEffect(() => cancelInitialAnchorRevealFrames, [cancelInitialAnchorRevealFrames]);

  useEffect(() => {
    if (autoStickToBottom) return;
    cancelProgrammaticScroll();
    const snapshot = latestScrollAnchorRef.current || captureScrollAnchor();
    latestScrollAnchorRef.current = snapshot;
    shouldStickToBottomRef.current = false;
    const container = containerRef.current;
    if (container) updateJumpToBottomVisibility(shouldShowJumpToBottomButton(container));
    if (lastReportedBottomPinnedRef.current !== false) {
      lastReportedBottomPinnedRef.current = false;
      onBottomPinnedChange?.(false);
    }
  }, [autoStickToBottom, cancelProgrammaticScroll, captureScrollAnchor, onBottomPinnedChange, shouldShowJumpToBottomButton, updateJumpToBottomVisibility]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return undefined;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!hasJumpedToBottomRef.current) return;
      if (frame != null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (scrollTransactionRef.current) return;
        if (isUserScrollMomentumActive()) return;
        // New bubbles use a short tail-follow animation. Let that animation
        // own scrollTop until it finishes instead of replacing it with an
        // immediate ResizeObserver correction.
        if (followScrollAnimationRef.current != null || tailFollowStartSnapshotRef.current) return;
        // A line wrap is measured after React commits. Preserve the exact
        // bottom only for a viewport that was already following it. When a
        // user is reading history, deliberately leave scrollTop untouched:
        // tail-only growth cannot move their visible anchor, while replaying
        // a stale snapshot can.
        if (!shouldMaintainTailAfterMutation({
          autoStickToBottom,
          wasPinnedBeforeMutation: shouldStickToBottomRef.current,
          isUserPointerHeld: isUserPointerHeldRef.current,
        })) return;
        scrollToBottom('auto', 'tailFollow');
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [autoStickToBottom, isUserScrollMomentumActive, scrollToBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || renderItems.length === 0 || hasJumpedToBottomRef.current) return;
    const initialPosition = initialScrollPositionRef.current;
    if (initialPosition && !initialPosition.pinned) {
      const restored = restoreScrollAnchor(initialPosition, { intent: 'initialRestore', allowDuringUserScroll: true });
      if (!restored) {
        pendingInitialRestoreRef.current = initialPosition;
        shouldStickToBottomRef.current = false;
        lastReportedBottomPinnedRef.current = false;
        onBottomPinnedChange?.(false);
        logDeveloperDiagnostic('chat-scroll:initial-restore-miss', {
          messageId: initialPosition.messageId,
          offsetTop: initialPosition.offsetTop,
          sourceTimestamp: initialPosition.sourceTimestamp,
          renderItemCount: renderItems.length,
          firstMessageId: renderItems[0]?.message.id,
          firstTimestamp: renderItems[0]?.message.timestamp,
          lastMessageId: renderItems.at(-1)?.message.id,
          lastTimestamp: renderItems.at(-1)?.message.timestamp,
        }, 'debug', 'chat-scroll');
        if (scrollVirtualizerToAnchor(initialPosition, { intent: 'initialRestore', allowDuringUserScroll: true })) {
          hasJumpedToBottomRef.current = true;
          scheduleInitialAnchorReveal(initialPosition);
          appliedInitialRestoreKeyRef.current = getInitialRestoreKey(initialPosition);
          pendingInitialRestoreRef.current = null;
          latestScrollAnchorRef.current = initialPosition;
          logDeveloperDiagnostic('chat-scroll:initial-restore-virtualized', {
            messageId: initialPosition.messageId,
            offsetTop: initialPosition.offsetTop,
            sourceTimestamp: initialPosition.sourceTimestamp,
            renderItemCount: renderItems.length,
          }, 'info', 'chat-scroll');
          return;
        }
        if (!hasMore && !hasMoreNewer) {
          logDeveloperDiagnostic('chat-scroll:initial-restore-failed', {
            reason: 'no-dom-or-virtual-anchor',
            messageId: initialPosition.messageId,
            sourceTimestamp: initialPosition.sourceTimestamp,
            renderItemCount: renderItems.length,
          }, 'warn', 'chat-scroll');
          hasJumpedToBottomRef.current = true;
          pendingInitialRestoreRef.current = null;
          setInitialViewportReady(true);
        }
        return;
      }
      hasJumpedToBottomRef.current = true;
      scheduleInitialAnchorReveal(initialPosition);
      shouldStickToBottomRef.current = false;
      lastReportedBottomPinnedRef.current = false;
      appliedInitialRestoreKeyRef.current = getInitialRestoreKey(initialPosition);
      pendingInitialRestoreRef.current = null;
      latestScrollAnchorRef.current = initialPosition;
      onBottomPinnedChange?.(false);
      logDeveloperDiagnostic('chat-scroll:initial-restore-hit', {
        messageId: initialPosition.messageId,
        offsetTop: initialPosition.offsetTop,
        sourceTimestamp: initialPosition.sourceTimestamp,
        scrollTop: container.scrollTop,
        renderItemCount: renderItems.length,
      }, 'info');
      return;
    }
    pendingInitialRestoreRef.current = null;
    scheduleInitialTailReveal();
    hasJumpedToBottomRef.current = true;
    shouldStickToBottomRef.current = true;
    if (lastReportedBottomPinnedRef.current !== true) {
      lastReportedBottomPinnedRef.current = true;
      onBottomPinnedChange?.(true);
    }
  }, [getInitialRestoreKey, hasMore, hasMoreNewer, onBottomPinnedChange, renderItems, restoreScrollAnchor, scheduleInitialAnchorReveal, scheduleInitialTailReveal, scrollVirtualizerToAnchor]);

  useLayoutEffect(() => {
    if (!scrollRequest || appliedScrollRequestKeyRef.current === scrollRequest.key) return;
    if (scrollRequest.key.startsWith('branch-switch:')) {
      // A branch switch supersedes any tail-follow animation started for the
      // previous branch. If it is left alive, its next rAF can write the old
      // tail position after the new anchor has already been restored.
      cancelProgrammaticScroll();
      const transaction: ScrollTransaction = {
        id: scrollRequest.key,
        intent: 'explicitJump',
        startedAt: performance.now(),
      };
      scrollTransactionRef.current = transaction;
      scrollTransactionStableFramesRef.current = 0;
      if (scrollTransactionTimeoutRef.current != null) window.clearTimeout(scrollTransactionTimeoutRef.current);
      scrollTransactionTimeoutRef.current = window.setTimeout(() => {
        if (scrollTransactionRef.current?.id === transaction.id) {
          scrollTransactionRef.current = null;
          scrollTransactionStableFramesRef.current = 0;
        }
        scrollTransactionTimeoutRef.current = null;
      }, BRANCH_SCROLL_TRANSACTION_MAX_MS);
      let cancelled = false;
      let firstFrame = 0;
      let secondFrame = 0;
      const settle = () => {
        if (cancelled) return;
        restoreScrollAnchor(scrollRequest, { intent: 'explicitJump', allowDuringUserScroll: true });
        secondFrame = requestAnimationFrame(() => {
          if (cancelled) return;
          const restored = restoreScrollAnchor(scrollRequest, { intent: 'explicitJump', allowDuringUserScroll: true });
          appliedScrollRequestKeyRef.current = scrollRequest.key;
          shouldStickToBottomRef.current = false;
          lastReportedBottomPinnedRef.current = false;
          onBottomPinnedChange?.(false);
          updatePinnedState();
          if (restored && scrollRequest.highlight) highlightScrollTarget(scrollRequest.messageId);
          onScrollRequestResolved?.(scrollRequest, restored);
        });
      };
      firstFrame = requestAnimationFrame(settle);
      return () => {
        cancelled = true;
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
        // Effect cleanup is also invoked when virtualized render metrics
        // change. Do not end the transaction here: those delayed renders are
        // precisely what the transaction must protect against. It is ended
        // by stable render metrics or the timeout fallback instead.
      };
    }
    const restored = restoreScrollAnchor(scrollRequest, { intent: 'explicitJump', allowDuringUserScroll: true });
    appliedScrollRequestKeyRef.current = scrollRequest.key;
    if (!restored) {
      onScrollRequestResolved?.(scrollRequest, false);
      return;
    }
    shouldStickToBottomRef.current = false;
    lastReportedBottomPinnedRef.current = false;
    onBottomPinnedChange?.(false);
    updatePinnedState();
    if (scrollRequest.highlight) highlightScrollTarget(scrollRequest.messageId);
    onScrollRequestResolved?.(scrollRequest, true);
    logDeveloperDiagnostic('chat-scroll:request-hit', {
      messageId: scrollRequest.messageId,
      offsetTop: scrollRequest.offsetTop,
      key: scrollRequest.key,
      renderItemCount: renderItems.length,
    }, 'info');
  }, [cancelProgrammaticScroll, highlightScrollTarget, onBottomPinnedChange, onScrollRequestResolved, renderItems.length, restoreScrollAnchor, scrollRequest, updatePinnedState]);

  useLayoutEffect(() => {
    const pending = pendingInitialRestoreRef.current;
    const container = containerRef.current;
    if (!pending || !container || pending.pinned || renderItems.length === 0) return;
    const restoreKey = getInitialRestoreKey(pending);
    if (restoreKey && appliedInitialRestoreKeyRef.current === restoreKey) {
      pendingInitialRestoreRef.current = null;
      return;
    }
    if (!restoreScrollAnchor(pending, { intent: 'initialRestore', allowDuringUserScroll: true })) {
      if (scrollVirtualizerToAnchor(pending, { intent: 'initialRestore', allowDuringUserScroll: true })) {
        hasJumpedToBottomRef.current = true;
        scheduleInitialAnchorReveal(pending);
        shouldStickToBottomRef.current = false;
        lastReportedBottomPinnedRef.current = false;
        appliedInitialRestoreKeyRef.current = restoreKey;
        pendingInitialRestoreRef.current = null;
        latestScrollAnchorRef.current = pending;
        onBottomPinnedChange?.(false);
        logDeveloperDiagnostic('chat-scroll:deferred-restore-virtualized', {
          messageId: pending.messageId,
          offsetTop: pending.offsetTop,
          sourceTimestamp: pending.sourceTimestamp,
          renderItemCount: renderItems.length,
        }, 'info', 'chat-scroll');
        return;
      }
      if (!hasMore && !hasMoreNewer) {
        hasJumpedToBottomRef.current = true;
        pendingInitialRestoreRef.current = null;
        setInitialViewportReady(true);
      }
      return;
    }
    hasJumpedToBottomRef.current = true;
    scheduleInitialAnchorReveal(pending);
    shouldStickToBottomRef.current = false;
    lastReportedBottomPinnedRef.current = false;
    appliedInitialRestoreKeyRef.current = restoreKey;
    pendingInitialRestoreRef.current = null;
    latestScrollAnchorRef.current = pending;
    onBottomPinnedChange?.(false);
    updatePinnedState();
    logDeveloperDiagnostic('chat-scroll:deferred-restore-hit', {
      messageId: pending.messageId,
      offsetTop: pending.offsetTop,
      sourceTimestamp: pending.sourceTimestamp,
      scrollTop: container.scrollTop,
      renderItemCount: renderItems.length,
    }, 'info');
  }, [getInitialRestoreKey, hasMore, hasMoreNewer, onBottomPinnedChange, renderItems, restoreScrollAnchor, scheduleInitialAnchorReveal, scrollVirtualizerToAnchor, updatePinnedState]);

  const schedulePrependAnchorRestore = useCallback((
    snapshot: ScrollAnchorSnapshot,
    boundary: typeof prependRestoreBoundaryRef.current,
  ) => {
    cancelProgrammaticScroll();
    setPrependStabilizing(true);
    let lastMeasuredScrollHeight = boundary?.scrollHeight ?? containerRef.current?.scrollHeight ?? 0;
    const runFrame = (frameCount: number, stableCount: number) => {
      const containerBefore = containerRef.current;
      const heightDelta = containerBefore ? containerBefore.scrollHeight - lastMeasuredScrollHeight : 0;
      if (containerBefore && Math.abs(heightDelta) >= 1) {
        runScrollWrite('prependPreserve', (scrollContainer) => {
          scrollContainer.scrollTop += heightDelta;
        }, { allowDuringUserScroll: true });
      }
      if (frameCount === 1) {
        restoreScrollAnchor(snapshot, { intent: 'prependPreserve', allowDuringUserScroll: true });
      }
      lastMeasuredScrollHeight = containerRef.current?.scrollHeight ?? lastMeasuredScrollHeight;
      const heightStable = Math.abs(heightDelta) < 1;
      const nextStableCount = heightStable ? stableCount + 1 : 0;
      if (nextStableCount >= PREPEND_STABILIZE_STABLE_FRAMES || frameCount >= PREPEND_STABILIZE_MAX_FRAMES) {
        setPrependStabilizing(false);
        if (!isUserScrollMomentumActive('up')) updatePinnedState();
        return;
      }
      window.requestAnimationFrame(() => runFrame(frameCount + 1, nextStableCount));
    };
    runFrame(1, 0);
  }, [cancelProgrammaticScroll, isUserScrollMomentumActive, restoreScrollAnchor, runScrollWrite, updatePinnedState]);

  useLayoutEffect(() => {
    const snapshot = prependRestoreRef.current;
    if (!snapshot) return;
    const boundary = prependRestoreBoundaryRef.current;
    const currentFirstKey = renderItems[0]?.key ?? null;
    if (boundary && boundary.firstKey === currentFirstKey && boundary.itemCount === renderItems.length) {
      return;
    }
    prependRestoreRef.current = null;
    prependRestoreBoundaryRef.current = null;
    schedulePrependAnchorRestore(snapshot, boundary);
  }, [renderItems, schedulePrependAnchorRestore]);

  useLayoutEffect(() => {
    const distance = bottomRestoreDistanceRef.current;
    const container = containerRef.current;
    if (distance == null || !container) return;
    bottomRestoreDistanceRef.current = null;
    cancelProgrammaticScroll();
    const restoreBottomDistance = () => {
      if (distance <= BOTTOM_STICKY_THRESHOLD) {
        scrollToBottom('auto', 'appendPreserve');
        return;
      }
      runScrollWrite('appendPreserve', (scrollContainer) => {
        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight - distance);
      }, { allowDuringUserScroll: true });
      if (!isUserScrollMomentumActive('down')) updatePinnedState();
    };
    restoreBottomDistance();
    const handle = window.requestAnimationFrame(restoreBottomDistance);
    return () => window.cancelAnimationFrame(handle);
  }, [cancelProgrammaticScroll, isLoadingNewer, isUserScrollMomentumActive, renderItems, runScrollWrite, scrollToBottom, updatePinnedState]);

  useLayoutEffect(() => {
    const currentMetrics = {
      itemCount: renderItems.length,
      lastItemKey: renderItems.at(-1)?.key ?? null,
      lastItemContentLength: renderItems.at(-1)?.message.content.length ?? 0,
      lastItemIsStreaming: Boolean(renderItems.at(-1)?.message.isStreaming),
      hasTailContent: Boolean(tailContent),
      storyChoiceKey: `${storyChoiceMessageId || ''}:${storyChoiceSubmittingValue || ''}:${storyChoiceOptions.map((option) => option.value).join('|')}`,
    };
    const previousMetrics = previousRenderMetricsRef.current;
    previousRenderMetricsRef.current = currentMetrics;
    const metricsChanged = !(
      currentMetrics.itemCount === previousMetrics.itemCount
      && currentMetrics.lastItemContentLength === previousMetrics.lastItemContentLength
      && currentMetrics.lastItemIsStreaming === previousMetrics.lastItemIsStreaming
      && currentMetrics.lastItemKey === previousMetrics.lastItemKey
      && currentMetrics.hasTailContent === previousMetrics.hasTailContent
      && currentMetrics.storyChoiceKey === previousMetrics.storyChoiceKey
    );

    // A branch switch may receive delayed virtual-list batches well after an
    // apparently stable render (18 items can become 30 a second later). The
    // transaction therefore remains authoritative for its full timeout
    // window; render stability is diagnostic only and must not release it.
    if (scrollTransactionRef.current) {
      tailFollowStartSnapshotRef.current = null;
      return;
    }

    if (!hasJumpedToBottomRef.current) {
      tailFollowStartSnapshotRef.current = null;
      return;
    }
    if (!autoStickToBottom) {
      tailFollowStartSnapshotRef.current = null;
      // These metrics describe tail mutations only. A reader whose room has
      // disabled tail following must keep the browser's current viewport;
      // restoring a stale anchor here can move unrelated visible content.
      return;
    }
    // An explicit branch switch owns the scroll position; do not let the
    // tail-follow effect pull the viewport to the new (possibly longer) tail
    // before the anchor restoration runs.
    if (!metricsChanged) {
      tailFollowStartSnapshotRef.current = null;
      return;
    }

    const tailChanged = currentMetrics.lastItemKey !== previousMetrics.lastItemKey
      || currentMetrics.itemCount !== previousMetrics.itemCount
      || currentMetrics.hasTailContent !== previousMetrics.hasTailContent
      || currentMetrics.storyChoiceKey !== previousMetrics.storyChoiceKey;
    const tailGrew = currentMetrics.lastItemKey === previousMetrics.lastItemKey
      && currentMetrics.lastItemContentLength > previousMetrics.lastItemContentLength;
    const isStreamingTailHandoff = currentMetrics.lastItemIsStreaming || previousMetrics.lastItemIsStreaming;
    if (tailGrew && isStreamingTailHandoff) {
      // Streaming rows can grow after the virtualizer has measured them. Keep
      // the initial viewport pinned even when the content-length mutation
      // itself is intentionally not animated.
      if (shouldStickToBottomRef.current && !isUserPointerHeldRef.current) {
        scrollToBottom('auto', 'tailFollow');
      }
      tailFollowStartSnapshotRef.current = null;
      return;
    }
    // `shouldStickToBottomRef` is updated by actual viewport movement before
    // this mutation. Never infer tail ownership from a missing scroll event:
    // someone reading history may simply be still.
    if (!shouldMaintainTailAfterMutation({
      autoStickToBottom,
      wasPinnedBeforeMutation: shouldStickToBottomRef.current,
      isUserPointerHeld: isUserPointerHeldRef.current,
    })) {
      tailFollowStartSnapshotRef.current = null;
      return;
    }

    const startSnapshot = tailChanged ? tailFollowStartSnapshotRef.current : null;
    tailFollowStartSnapshotRef.current = null;

    shouldStickToBottomRef.current = true;
    if (!hasMoreNewer && lastReportedBottomPinnedRef.current !== true) {
      lastReportedBottomPinnedRef.current = true;
      onBottomPinnedChange?.(true);
    }

    followScrollToBottom({
      animate: true,
      mode: 'follow',
      intent: 'tailFollow',
      startTop: startSnapshot?.scrollTop,
    });
  }, [autoStickToBottom, followScrollToBottom, hasMoreNewer, onBottomPinnedChange, renderItems, restoreScrollAnchor, scrollRequest, scrollToBottom, storyChoiceMessageId, storyChoiceOptions, storyChoiceSubmittingValue, tailContent]);

  useLayoutEffect(() => {
    const previousValue = previousStoryChoiceSubmittingValueRef.current;
    previousStoryChoiceSubmittingValueRef.current = storyChoiceSubmittingValue;
    if (!storyChoiceSubmittingValue || previousValue === storyChoiceSubmittingValue) return;
    if (!autoStickToBottom) return;
    if (!hasJumpedToBottomRef.current) return;
    if (isUserPointerHeldRef.current) return;
    shouldStickToBottomRef.current = true;
    followScrollToBottom({ animate: true, mode: 'follow', intent: 'tailFollow' });
  }, [autoStickToBottom, followScrollToBottom, storyChoiceSubmittingValue]);

  useEffect(() => {
    if (!isLoadingOlder) {
      topLoadTriggeredRef.current = false;
      const boundary = prependRestoreBoundaryRef.current;
      if (boundary && boundary.firstKey === (renderItems[0]?.key ?? null) && boundary.itemCount === renderItems.length) {
        prependRestoreRef.current = null;
        prependRestoreBoundaryRef.current = null;
        setPrependStabilizing(false);
      }
    }
  }, [isLoadingOlder, renderItems]);

  useEffect(() => {
    if (!isLoadingNewer) {
      bottomLoadTriggeredRef.current = false;
    }
  }, [isLoadingNewer]);

  useEffect(() => {
    if (!autoStickToBottom && !hasInitialRestorePosition) setInitialViewportReady(true);
  }, [autoStickToBottom, hasInitialRestorePosition]);

  useEffect(() => {
    const container = containerRef.current;
    if (!autoStickToBottom || !container || !hasMoreNewer || isLoadingNewer) return;
    if (container.scrollHeight > container.clientHeight + 1) return;
    triggerReachBottom();
  }, [autoStickToBottom, hasMoreNewer, isLoadingNewer, renderItems.length, triggerReachBottom]);

  const hideUntilInitialViewportPositioned = renderItems.length > 0 && !initialViewportReady;

  return (
    <Box
      ref={containerRef}
      data-chat-message-list
      onWheel={markUserScrollIntent}
      onTouchStart={beginUserScrollGesture}
      onTouchEnd={endUserScrollGesture}
      onTouchCancel={endUserScrollGesture}
      onPointerDown={() => {
        beginUserScrollGesture();
      }}
      onPointerUp={endUserScrollGesture}
      onPointerCancel={endUserScrollGesture}
      onKeyDown={markUserScrollIntent}
      tabIndex={0}
      aria-label="聊天消息列表"
      onScroll={() => {
        const container = containerRef.current;
        if (!container) return;

        if (isProgrammaticTailScrollActive()) {
          lastScrollTopRef.current = container.scrollTop;
          shouldStickToBottomRef.current = !hasMoreNewer;
          updateJumpToBottomVisibility(false);
          if (!hasMoreNewer && lastReportedBottomPinnedRef.current !== true) {
            lastReportedBottomPinnedRef.current = true;
            onBottomPinnedChange?.(true);
          }
          scheduleRememberScrollAnchor({ reason: 'programmatic-tail-scroll' });
          return;
        }

        const previousScrollTop = lastScrollTopRef.current;
        const isScrollingUp = container.scrollTop < previousScrollTop - 2;
        const isScrollingDown = container.scrollTop > previousScrollTop + 2;
        const previousSample = lastScrollSampleRef.current;
        const now = performance.now();
        const velocity = previousSample
          ? Math.abs(container.scrollTop - previousSample.top) / Math.max(16, now - previousSample.at)
          : Math.abs(container.scrollTop - previousScrollTop) / 16;
        recordUserScrollMomentum(isScrollingUp ? 'up' : isScrollingDown ? 'down' : null, velocity);
        updateAdaptiveBottomPrefetch(container, isScrollingDown);
        lastScrollTopRef.current = container.scrollTop;
        if (!autoStickToBottom && !hasUserScrollIntentRef.current) {
          shouldStickToBottomRef.current = false;
          updateJumpToBottomVisibility(shouldShowJumpToBottomButton(container));
          if (lastReportedBottomPinnedRef.current !== false) {
            lastReportedBottomPinnedRef.current = false;
            onBottomPinnedChange?.(false);
          }
          scheduleRememberScrollAnchor({ persist: false, reason: 'programmatic-scroll-before-user-intent' });
          return;
        }
        if (isScrollingUp) {
          shouldStickToBottomRef.current = false;
          updateJumpToBottomVisibility(shouldShowJumpToBottomButton(container));
          if (hasUserScrollIntentRef.current) reportNearBottomState(container);
          if (lastReportedBottomPinnedRef.current !== false) {
            lastReportedBottomPinnedRef.current = false;
            onBottomPinnedChange?.(false);
          }
        } else {
          updatePinnedState();
          if (hasUserScrollIntentRef.current) reportNearBottomState(container);
        }
        scheduleRememberScrollAnchor({ reason: 'scroll' });
        if (isLoadingOlder && hasUserScrollIntentRef.current && !isRecentScrollWriteIntent('prependPreserve')) {
          rememberPrependRestoreAnchor(captureTopVisibleScrollAnchor() || captureScrollAnchor() || latestScrollAnchorRef.current);
        }

        const distanceFromBottom = getDistanceFromBottom(container);
        if (autoStickToBottom && distanceFromBottom < getAdaptiveBottomThreshold(container)) {
          triggerReachBottom();
        } else {
          bottomLoadTriggeredRef.current = false;
        }

        if (container.scrollTop > TOP_PREFETCH_THRESHOLD) {
          topLoadTriggeredRef.current = false;
          return;
        }

        if (!hasUserScrollIntentRef.current || !isScrollingUp) return;
        if (!onReachTop || topLoadTriggeredRef.current || isLoadingOlder || !hasMore) return;

        rememberPrependRestoreAnchor(captureTopVisibleScrollAnchor() || captureScrollAnchor() || latestScrollAnchorRef.current);
        topLoadTriggeredRef.current = true;
        logDeveloperDiagnostic('chat-scroll:reach-top', {
          reason: 'user-scroll',
          scrollTop: Math.round(container.scrollTop),
          messageId: prependRestoreRef.current?.messageId,
          offsetTop: Math.round(prependRestoreRef.current?.offsetTop ?? 0),
          renderItemCount: renderItems.length,
        }, 'debug', 'chat-scroll');
        void onReachTop();
      }}
      sx={{
        position: 'relative',
        flex: 1,
        width: '100%',
        maxWidth: contentMaxWidth,
        mx: 'auto',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        pt: topInset || 2,
        pb: bottomInset || 2,
        bgcolor: 'transparent',
        scrollPaddingTop: topInset || 16,
        scrollPaddingBottom: bottomInset || 16,
        transition: transition(['padding-bottom', 'scroll-padding-bottom'], motion.durations.slow, motion.emphasized),
        overflowAnchor: 'none',
        scrollbarGutter: 'stable',
        visibility: hideUntilInitialViewportPositioned ? 'hidden' : 'visible',
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
      }}
    >
      {messages.length > 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', px: 2, pb: 1, minHeight: 25 }}>
          {isLoadingOlder ? (
            <CircularProgress size={16} thickness={4} sx={{ color: 'text.secondary' }} />
          ) : (
            <Typography
              variant="caption"
              sx={{
                color: topStatusText ? 'text.secondary' : 'transparent',
                userSelect: 'none',
              }}
            >
              {topStatusText || '没有更早的消息'}
            </Typography>
          )}
        </Box>
      ) : null}

      <Box ref={contentRef}>
        {messages.length === 0 && emptyContent ? emptyContent : null}
        {renderItems.length > 0 ? (
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: `${messageVirtualizer.getTotalSize()}px`,
            }}
          >
            {renderedMessageItems.map((renderedItem) => {
              const item = renderItems[renderedItem.index];
              if (!item) return null;
              return (
                <div
                  key={item.key}
                  data-index={renderedItem.index}
                  data-selection-key={item.key}
                  ref={messageVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: `${renderedItem.start}px`,
                    left: 0,
                    width: '100%',
                    minWidth: 0,
                    maxWidth: '100%',
                    // Paint containment clips the bubble's shadow at each
                    // virtual row boundary. Keep layout/style isolation for
                    // virtualized rows without changing their visual output.
                    contain: 'layout style',
                  }}
                >
                  {renderMessageItem(item)}
                </div>
              );
            })}
          </div>
        ) : null}
        {isLoadingNewer ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', px: 2, py: 1, minHeight: 34 }}>
            <CircularProgress size={16} thickness={4} sx={{ color: 'text.secondary' }} />
          </Box>
        ) : null}
        {tailContent}
      </Box>
      {showJumpToBottom ? (
        <Fab
          size="small"
          color="primary"
          aria-label="滚动到底部"
          onClick={() => {
            markUserScrollIntent();
            if (onJumpToConversationBottom) {
              void Promise.resolve(onJumpToConversationBottom()).finally(() => {
                hasUserScrollIntentRef.current = false;
                shouldStickToBottomRef.current = true;
                followScrollToBottom({ animate: true, mode: 'jump', intent: 'explicitJump' });
              });
              return;
            }
            hasUserScrollIntentRef.current = false;
            shouldStickToBottomRef.current = true;
            followScrollToBottom({ animate: true, mode: 'jump', intent: 'explicitJump' });
          }}
          sx={{
            position: 'fixed',
            right: { xs: 16, sm: 24 },
            bottom: { xs: 'calc(126px + env(safe-area-inset-bottom, 0px))', sm: 122 },
            zIndex: 6,
            boxShadow: 4,
          }}
        >
          <KeyboardArrowDownIcon />
        </Fab>
      ) : null}
      <ImageLightbox
        open={viewerOpen}
        images={viewerImages}
        index={activeViewerIndex}
        onIndexChange={(index) => {
          if (diagramViewerItem) return;
          setViewerKey(chatImageTimeline[index]?.key || null);
        }}
        onReachStart={!diagramViewerItem && hasMore && !isLoadingOlder ? loadOlderFromViewer : undefined}
        reachStartVersion={messages.length}
        onClose={() => {
          setViewerKey(null);
          setDiagramViewerItem(null);
        }}
      />
    </Box>
  );
}
