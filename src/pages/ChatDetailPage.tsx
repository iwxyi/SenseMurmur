import { lazy, Suspense, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Box, IconButton, Button, Typography, Switch, Stack, TextField, Chip, Alert, Dialog, DialogTitle, DialogContent, DialogActions, Slider, FormControl, InputLabel, Select, MenuItem, Divider, FormControlLabel, Checkbox, CircularProgress, Tooltip, Collapse } from '@mui/material';
import PageSection from '../components/common/PageSection';
import AppSnackbar from '../components/common/AppSnackbar';
import LoadingState from '../components/common/LoadingState';
import PeopleIcon from '@mui/icons-material/People';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import InfoIcon from '@mui/icons-material/Info';
import PlayIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SettingsIcon from '@mui/icons-material/Settings';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSchedulerStore } from '../stores/useSchedulerStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUIStore } from '../stores/useUIStore';
import { useLocalWorkspaceStore } from '../stores/useLocalWorkspaceStore';
import { type DriverMessageCommitResult, type GroupChat, type MessageBranchState, type RoomRelationshipSharedFact, type StoryChapterState } from '../types/chat';
import MessageList, { type MessageListScrollPosition, type MessageListScrollRequest } from '../components/chat/MessageList';
import type { NarrativeStoryChoiceOption } from '../components/chat/messageBubblePresentation';
import SessionComposerHost from '../components/session/SessionComposerHost';
import type { ChatInputHandle } from '../components/chat/ChatInput';
import RightPanel from '../components/layout/RightPanel';
import GlassHeader from '../components/layout/GlassHeader';
import { buildRuntimeEventMessageContent, normalizeRuntimeEvent } from '../services/runtimeEventFactory';
import { persistLocalFirstMessage, persistLocalFirstMessages } from '../services/chatCommitMessage';
import { buildPrivateSessionEvent } from '../services/directSessionHelpers';
import { resolveCharacterOrDeleted } from '../utils/deletedEntity';
import type { CharacterMention, Message, MessageAttachment } from '../types/message';
import { trimMentionDraft } from '../services/characterMentions';
import type { AICharacter } from '../types/character';
import { readChatNavigationPosition, saveChatNavigationPosition } from '../services/chatNavigationPosition';
import { getLocalDataUserId } from '../services/authStorageScope';
import { buildExpressionFeedbackPatch, getExpressionFeedbackLabel, type ExpressionFeedbackKind } from '../services/characterExpressionFeedback';
import { useAuthStore } from '../stores/useAuthStore';
import { runInterruptedManualInput, useManualInputQueue } from '../hooks/useManualInputQueue';
import { useStreamingMessageState } from '../hooks/useStreamingMessageState';
import { getConversationLoopStartBlockReason, useChatRunLoop } from '../hooks/useChatRunLoop';
import { useChatSidebarProjection } from '../hooks/useChatSidebarProjection';
import { useMessageAnalysis } from '../hooks/useMessageAnalysis';
import { useChatSurfaceActions } from '../hooks/useChatSurfaceActions';
import { useReplyOperation } from '../hooks/useReplyOperation';
import ChatBackground from '../components/chat/ChatBackground';
import { getSyncableCharacterMemberIds } from '../services/pageSyncScopeContract';
import SessionInfoCards from '../components/chat/SessionInfoCards';
import { projectSessionInfoCards } from '../services/sessionInfoProjection';
import { useResponsive } from '../hooks/useResponsive';
import type { UserDraftActivity } from '../services/userInputBuffer';
import { usePaneLayout } from '../components/layout/PaneLayoutContext';
import type { LocalInterceptionEvent } from '../services/chatEngine';
import { api, type ChatShareState } from '../services/api';
import { copyTextToClipboard } from '../utils/clipboard';
import { getInputCapabilityWarning, getUsablePreferredAIProfile, resolveAIModelInputCapabilities } from '../types/settings';
import { logDeveloperDiagnostic } from '../services/developerDiagnostics';
import { isGenerationCancelledError } from '../services/generationCancellation';
import { isCloudSyncEnabled } from '../services/cloudSyncPreference';
import { getStoryChoiceGateState, resolveStoryReaderRole, sanitizeStoryChoicePrompt } from '../services/storyChoices';
import { resolveSessionScrollCapabilities } from '../services/sessionScrollCapabilities';
import { buildStoryRoomOpeningPreview, type StoryRoomOpeningPreview } from '../services/storyRoomOpeningPreview';
import { motion, prefersReducedMotion, transition } from '../styles/motion';
import { attachMessageToActiveBranch, buildBranchStateWithHead, buildMessageBranchVersionInfoByMessageId, createMessageRevisionDraft, forkBranchState, getBranchRevisionGroup, getMessageBranchVersionInfo, isMessageBranchingEnabled, projectActiveBranchMessages, resolveMessageBranchNodes } from '../services/messageBranching';
import { getLatestChatPreviewMessage } from '../services/chatLatestMessage';
import { projectCurrentChatMessages, projectMergedChatMessages } from '../services/currentChatMessages';
import { overlayTransientMessages, releaseConfirmedTransientMessages, removeTransientMessage, upsertTransientMessage } from '../services/transientMessageOverlay';
import { resolveSessionFamilyKey } from '../services/sessionEngineKeys';
import { isAssistantArtifactCloudSyncEnabled, setAssistantArtifactCloudSyncEnabled } from '../services/assistantArtifactCloudSyncPreference';
import { hasRoomCapability } from '../services/capabilityRuntime';
import { useAssistantArtifactStore } from '../stores/useAssistantArtifactStore';
import type { AssistantHtmlInteractionPayload, AssistantHtmlRuntimeError } from '../features/assistantHtml/AssistantHtmlFrame';
import { formatAssistantHtmlSubmission } from '../features/assistantHtml/assistantHtmlSubmission';
import { readAssistantAgentDefaultEnabled, writeAssistantAgentDefaultEnabled } from '../services/assistantAgentPreference';
import { isChatBlockedByMissingRequiredCharacters } from '../services/chatAvailability';
import { createConversationInitializationState, getConversationInitializationRequirement, getInitializationMembers } from '../services/conversationInitialization';
import { initializeDefaultRelationshipsForCreatedCharacters } from '../services/defaultRelationshipInitializer';
import { refreshRelationshipLedgerBaselines } from '../services/relationshipLedger';
import { buildOpeningTopicGuideMessage } from '../services/createChatOpening';
import { getPendingAppCommand, subscribePendingAppCommand, type PendingAppCommand } from '../features/appCommand/pendingCommandStore';
import {
  buildStoryChoicePendingKey,
  buildStoryReaderTextInputCapabilities,
  buildVisibleStoryBranchOptions,
  findVisibleStoryChoiceSourceMessage,
  getNarrativeRevealIdentityKeys,
  getStoryReaderComposerPlaceholder,
  getStoryTailStatus,
  isStoryChoicePending,
  resolveEffectiveStoryReaderAtTail,
  shouldAutoStartStoryRoom,
  shouldRegisterLiveNarrativeReveal,
  shouldRouteTextAsStoryCustomDirection,
} from './chatDetailStoryHelpers';

const ChatSidebarPanel = lazy(() => import('../components/chat/ChatSidebarPanel'));
const AssistantAgentPanel = lazy(() => import('../components/chat/AssistantAgentPanel'));
const AssistantHtmlFullscreenDialog = lazy(() => import('../features/assistantHtml/AssistantHtmlFullscreenDialog'));
const SessionActionPanel = lazy(() => import('../components/session/SessionActionPanel'));
const MessageAnalysisDialog = lazy(() => import('../components/chat/MessageAnalysisDialog').then((module) => ({ default: module.MessageAnalysisDialog })));
const ProfilePreviewOverlay = lazy(() => import('../components/chat/ProfilePreviewOverlay'));
const WorldCalendarPanel = lazy(() => import('../components/calendar/WorldCalendarPanel'));
const CHAT_MESSAGE_WINDOW_SIZE = 40;
const STORY_CHOICE_COLLAPSE_MS = 420;
const STORY_READING_POSITION_SAVE_MS = 700;

function isRecoverableRichMediaAttachment(attachment: Pick<MessageAttachment, 'kind' | 'status'>) {
  return (
    (attachment.kind === 'image' || attachment.kind === 'audio')
    && (attachment.status === 'queued' || attachment.status === 'generating')
  );
}

type ProfilePreviewState =
  | { kind: 'character'; anchorRect: DOMRect; anchorElement: HTMLElement; character: AICharacter }
  | { kind: 'chat'; anchorRect: DOMRect; anchorElement: HTMLElement };
type PendingStoryChoiceVisual = {
  key: string;
  sourceMessageId: string;
  selectedValue: string;
  options: NarrativeStoryChoiceOption[];
};
type HtmlRepairRetryState = {
  chatId: string;
  artifactId: string;
  runtimeError: AssistantHtmlRuntimeError;
  userMessage: Message;
  message: string;
};
type HomeCommandChatLocationState = {
  homeCommandInitialMessage?: string;
  homeCommandStartAgent?: boolean;
  homeCommandPreferredMode?: 'chat' | 'image' | 'research' | 'tool';
};

function getMessageListElementScrollTimestamp(element: HTMLElement) {
  const raw = element.dataset.scrollTimestamp || element.closest<HTMLElement>('[data-scroll-timestamp]')?.dataset.scrollTimestamp;
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function getMessageListElementScrollAnchor(element: HTMLElement) {
  return element.dataset.scrollAnchor || element.dataset.messageId || '';
}

function getSourceMessageIdFromScrollAnchor(messageId: string) {
  const storyAnchorIndex = messageId.indexOf(':story-');
  return storyAnchorIndex >= 0 ? messageId.slice(0, storyAnchorIndex) : messageId;
}

function captureMessageListScrollRequest(keyPrefix: string, preferredMessageId?: string): MessageListScrollRequest | null {
  const container = document.querySelector<HTMLElement>('[data-chat-message-list]');
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor], [data-message-id]'));
  if (!nodes.length) return null;
  const preferredNode = preferredMessageId
    ? nodes.find((node) => getMessageListElementScrollAnchor(node) === preferredMessageId)
    : null;
  const visibleNodes = preferredNode ? [] : nodes.filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1;
  });
  const candidates = visibleNodes.length ? visibleNodes : nodes;
  const targetLine = preferredNode
    ? preferredNode.getBoundingClientRect().top
    : containerRect.top + containerRect.height * 0.42;
  const anchorNode = preferredNode || candidates
    .map((node) => ({ node, distance: Math.abs(node.getBoundingClientRect().top - targetLine) }))
    .sort((left, right) => left.distance - right.distance)[0]?.node;
  const messageId = anchorNode ? getMessageListElementScrollAnchor(anchorNode) : '';
  if (!anchorNode || !messageId) return null;
  return {
    key: `${keyPrefix}:${messageId}:${Date.now()}`,
    messageId,
    offsetTop: anchorNode.getBoundingClientRect().top - containerRect.top,
    sourceTimestamp: getMessageListElementScrollTimestamp(anchorNode),
    behavior: 'auto',
  };
}

function PanelFallback() {
  return null;
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function LazyPanel({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PanelFallback />}>{children}</Suspense>;
}

function ChatPageSettingsDialog({
  open,
  onClose,
  isStoryRoom,
  chat,
  updateChat,
  isAssistantChat,
  onCloseAssistantPanel,
}: {
  open: boolean;
  onClose: () => void;
  isStoryRoom: boolean;
  chat: GroupChat | null;
  updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
  isAssistantChat: boolean;
  onCloseAssistantPanel?: () => void;
}) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const setChatAppearance = useSettingsStore((state) => state.setChatAppearance);
  const authMode = useAuthStore((state) => state.authMode);
  const currentUser = useAuthStore((state) => state.user);
  const [artifactCloudSyncEnabled, setArtifactCloudSyncState] = useState(() => isAssistantArtifactCloudSyncEnabled());
  const capabilities = chat?.modeState.assistantCapabilities || {};
  const agentEnabled = Boolean(capabilities.agent);
  const agentAvailable = authMode === 'cloud' && currentUser?.agentEntitled === true;
  const aiSearchAvailable = authMode === 'cloud' && currentUser?.aiSearchEntitled === true;
  const aiSearchEnabled = Boolean(capabilities.webSearch);
  const aiSearchSwitchDisabled = !aiSearchAvailable || (isAssistantChat && !agentEnabled);
  const artifactCloudSyncEntitled = Boolean(currentUser?.assistantArtifactCloudSyncEntitled);
  const artifactCloudSyncAvailable = authMode === 'cloud' && currentUser?.cloudSyncEntitled !== false && artifactCloudSyncEntitled;
  useEffect(() => {
    if (!artifactCloudSyncAvailable && artifactCloudSyncEnabled) {
      setAssistantArtifactCloudSyncEnabled(false);
      setArtifactCloudSyncState(false);
    }
  }, [artifactCloudSyncAvailable, artifactCloudSyncEnabled]);
  useEffect(() => {
    const handler = () => setArtifactCloudSyncState(isAssistantArtifactCloudSyncEnabled());
    window.addEventListener('pneumata-assistant-artifact-cloud-sync-preference-changed', handler);
    return () => window.removeEventListener('pneumata-assistant-artifact-cloud-sync-preference-changed', handler);
  }, []);
  const handleAgentToggle = (enabled: boolean) => {
    if (!chat) return;
    if (enabled && !agentAvailable) return;
    writeAssistantAgentDefaultEnabled(enabled);
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        agentCapabilities: {
          ...(chat.modeState.agentCapabilities || {}),
          enabled,
          chatArtifactRead: enabled,
          chatArtifactWrite: enabled,
          fileUpload: enabled,
          fileDownload: enabled,
          workspaceRead: enabled,
          webSearch: enabled && aiSearchAvailable,
          updatedAt: Date.now(),
        },
        assistantCapabilities: {
          ...capabilities,
          agent: enabled,
          artifacts: enabled,
          webSearch: enabled && aiSearchAvailable ? true : false,
          webSearchUserDisabled: false,
          updatedAt: Date.now(),
        },
      },
    });
  };
  const handleArtifactCloudSyncToggle = (enabled: boolean) => {
    setAssistantArtifactCloudSyncEnabled(enabled);
    setArtifactCloudSyncState(enabled);
    if (enabled && chat?.id) {
      void import('../stores/useAssistantArtifactStore')
        .then((module) => module.useAssistantArtifactStore.getState().pushArtifactsToCloud(chat.id))
        .catch(() => undefined);
    }
  };
  const handleAiSearchToggle = (enabled: boolean) => {
    if (!chat) return;
    if (enabled && aiSearchSwitchDisabled) return;
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        assistantCapabilities: {
          ...capabilities,
          webSearch: enabled,
          webSearchUserDisabled: !enabled,
          updatedAt: Date.now(),
        },
      },
    });
  };
  const artifactSyncHelp = '仅同步文档、代码、图表源码、表格、JSON、纯文本和图片引用；Office、PDF、压缩包和工程文件仍走 WebDAV / 本地存储。';
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>聊天页设置</DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ pt: 0.5 }}>
          {isAssistantChat ? (
            <>
              <Box>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>Agent 能力</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.55 }}>
                      开启后显示产物面板并支持文件、图表、网页等可沉淀结果；关闭后助手只保留普通聊天。
                    </Typography>
                  </Box>
                  <Switch
                    checked={agentEnabled}
                    disabled={!agentAvailable}
                    onChange={(event) => handleAgentToggle(event.target.checked)}
                    slotProps={{ input: { 'aria-label': '开启 Agent 能力' } }}
                  />
                </Stack>
                {!agentAvailable ? (
                  <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                    Agent 能力仅会员可用。
                  </Typography>
                ) : null}
                {onCloseAssistantPanel ? (
                  <Button size="small" variant="outlined" onClick={() => { onCloseAssistantPanel(); onClose(); }} sx={{ mt: 1 }}>
                    关闭右侧面板
                  </Button>
                ) : null}
              </Box>
              <Box>
                <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>同步 AI 文本产物</Typography>
                      <Tooltip title={artifactSyncHelp} arrow>
                        <IconButton size="small" aria-label="同步 AI 文本产物说明" sx={{ width: 24, height: 24 }}>
                          <HelpOutlineIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                    {!artifactCloudSyncAvailable ? (
                      <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                        当前账号未获得 AI 产物云同步权限，或未处于云端同步模式。
                      </Typography>
                    ) : null}
                  </Box>
                  <Switch
                    checked={artifactCloudSyncEnabled && artifactCloudSyncAvailable}
                    disabled={!artifactCloudSyncAvailable}
                    onChange={(event) => handleArtifactCloudSyncToggle(event.target.checked)}
                    slotProps={{ input: { 'aria-label': '同步 AI 文本产物' } }}
                  />
                </Stack>
              </Box>
              <Divider />
            </>
          ) : null}

          <Box>
            <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>AI 搜索</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.55 }}>
                  开启后聊天会在用户明显需要最新资料时检索网页；每次实际搜索按后台配置扣点。
                </Typography>
                {!aiSearchAvailable ? (
                  <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                    AI 搜索仅会员可用。
                  </Typography>
                ) : isAssistantChat && !agentEnabled ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    普通助手不会启用搜索；开启 Agent 后可打开。
                  </Typography>
                ) : null}
              </Box>
              <Switch
                checked={aiSearchEnabled && !aiSearchSwitchDisabled}
                disabled={aiSearchSwitchDisabled}
                onChange={(event) => handleAiSearchToggle(event.target.checked)}
                slotProps={{ input: { 'aria-label': '开启 AI 搜索' } }}
              />
            </Stack>
          </Box>

          <Box>
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.75 }}>页面最大宽度</Typography>
            <Slider
              value={chatAppearance.maxContentWidth}
              min={560}
              max={1080}
              step={20}
              valueLabelDisplay="auto"
              disabled={chatAppearance.maxContentWidthUnlimited}
              onChange={(_, value) => setChatAppearance({ maxContentWidth: Array.isArray(value) ? value[0] : value })}
            />
            <FormControlLabel
              control={(
                <Checkbox
                  checked={chatAppearance.maxContentWidthUnlimited}
                  onChange={(event) => setChatAppearance({ maxContentWidthUnlimited: event.target.checked })}
                />
              )}
              label="不限宽"
              sx={{ mt: 0.25 }}
            />
            <Typography variant="caption" color="text.secondary">
              控制聊天气泡、发送者提示、旁白和选项卡片的最大内容宽度。
            </Typography>
          </Box>

          {isStoryRoom ? (
            <>
              <Divider />
              <Typography variant="body2" sx={{ fontWeight: 800 }}>故事房正文</Typography>
              <FormControl size="small" fullWidth>
                <InputLabel id="story-reader-font-family-label">正文字体</InputLabel>
                <Select
                  labelId="story-reader-font-family-label"
                  label="正文字体"
                  value={chatAppearance.storyReader.fontFamily}
                  onChange={(event) => setChatAppearance({ storyReader: { ...chatAppearance.storyReader, fontFamily: event.target.value as typeof chatAppearance.storyReader.fontFamily } })}
                >
                  <MenuItem value="default">跟随系统</MenuItem>
                  <MenuItem value="serif">故事衬线</MenuItem>
                  <MenuItem value="sans">清爽无衬线</MenuItem>
                </Select>
              </FormControl>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.75 }}>文字大小</Typography>
                <Slider
                  value={chatAppearance.storyReader.fontSize}
                  min={14}
                  max={22}
                  step={1}
                  valueLabelDisplay="auto"
                  onChange={(_, value) => setChatAppearance({ storyReader: { ...chatAppearance.storyReader, fontSize: Array.isArray(value) ? value[0] : value } })}
                />
              </Box>
              <Box>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.75 }}>行间距</Typography>
                <Slider
                  value={chatAppearance.storyReader.lineHeight}
                  min={1.55}
                  max={2.45}
                  step={0.05}
                  valueLabelDisplay="auto"
                  onChange={(_, value) => setChatAppearance({ storyReader: { ...chatAppearance.storyReader, lineHeight: Array.isArray(value) ? value[0] : value } })}
                />
              </Box>
              <FormControl size="small" fullWidth>
                <InputLabel id="story-reader-reveal-mode-label">节点出现方式</InputLabel>
                <Select
                  labelId="story-reader-reveal-mode-label"
                  label="节点出现方式"
                  value={chatAppearance.storyReader.revealMode}
                  onChange={(event) => setChatAppearance({ storyReader: { ...chatAppearance.storyReader, revealMode: event.target.value as typeof chatAppearance.storyReader.revealMode } })}
                >
                  <MenuItem value="fade">整节淡入</MenuItem>
                  <MenuItem value="instant">立即显示</MenuItem>
                </Select>
              </FormControl>
            </>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}

function StoryRoomOpeningEmptyState({ preview }: { preview: StoryRoomOpeningPreview }) {
  const chatAppearance = useSettingsStore((state) => state.chatAppearance);
  const maxContentWidth = chatAppearance.maxContentWidthUnlimited ? '100%' : chatAppearance.maxContentWidth;
  return (
    <Box data-testid="story-room-opening-empty-state" sx={{ width: '100%', px: { xs: 2, sm: 3 }, py: { xs: 3, sm: 4 } }}>
      <Box
        sx={(theme) => ({
          width: '100%',
          maxWidth: maxContentWidth,
          mx: 'auto',
          borderRadius: 3,
          border: '1px solid',
          borderColor: theme.palette.mode === 'light' ? 'rgba(148,163,184,0.26)' : 'rgba(226,232,240,0.14)',
          bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.78)' : 'rgba(15,23,42,0.58)',
          boxShadow: theme.palette.mode === 'light' ? '0 16px 44px rgba(15,23,42,0.08)' : '0 18px 48px rgba(0,0,0,0.22)',
          backdropFilter: 'blur(18px)',
          p: { xs: 2, sm: 2.4 },
        })}
      >
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 700, mb: 0.5 }}>
              故事即将开始
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 900, lineHeight: 1.35 }}>
              {preview.title}
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 800, mb: 0.4 }}>
              当前目标
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
              {preview.goal}
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 800, mb: 0.4 }}>
              开场处境
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
              {preview.scene}
            </Typography>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 1.2 }}>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 800, mb: 0.4 }}>
                第一章目标
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
                {preview.firstChapterGoal}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 800, mb: 0.4 }}>
                参与感
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
                {preview.readerPromise}
              </Typography>
            </Box>
          </Box>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.25 }}>
            {preview.items.map((item) => (
              <Chip
                key={`${item.label}:${item.text}`}
                size="small"
                label={`${item.label}：${item.text}`}
                variant="outlined"
                sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
              />
            ))}
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}

function ChatSharePanel({ chat }: { chat: GroupChat }) {
  const [state, setState] = useState<ChatShareState>(() => ({
    enabled: Boolean(chat.shareEnabled),
    token: chat.shareToken || null,
    viewerCount: chat.shareViewerCount || 0,
  }));
  const [loading, setLoading] = useState(false);
  const [copyText, setCopyText] = useState('');
  const [error, setError] = useState('');
  const shareUrl = state.token && typeof window !== 'undefined'
    ? `${window.location.origin}/shared/${state.token}`
    : '';

  useEffect(() => {
    let cancelled = false;
    setError('');
    void api.getChatShareState(chat.id)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chat.id]);

  const toggle = async (enabled: boolean) => {
    setLoading(true);
    setError('');
    setCopyText('');
    try {
      setState(await api.updateChatShareState(chat.id, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    const copied = await copyTextToClipboard(shareUrl);
    setCopyText(copied ? '已复制' : '复制失败，请手动复制');
  };

  if (chat.type !== 'group') return null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.25, display: 'grid', gap: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>分享聊天记录</Typography>
          <Typography variant="caption" color="text.secondary">匿名只读访问，只显示群聊名称和聊天内容</Typography>
        </Box>
        <Switch checked={state.enabled} disabled={loading} onChange={(event) => void toggle(event.target.checked)} />
      </Stack>
      {error ? <Alert severity="error" sx={{ py: 0 }}>{error}</Alert> : null}
      {state.enabled && shareUrl ? (
        <Stack spacing={1}>
          <TextField
            size="small"
            value={shareUrl}
            fullWidth
            slotProps={{ input: { readOnly: true } }}
          />
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={copy}>复制链接</Button>
            <Chip size="small" variant="outlined" label={`访问人数 ${state.viewerCount}`} />
            {copyText ? <Typography variant="caption" color="text.secondary">{copyText}</Typography> : null}
          </Stack>
        </Stack>
      ) : null}
    </Box>
  );
}

function localizeLocalInterceptionReason(reason: string) {
  const normalized = reason.trim();
  const exact: Record<string, string> = {
    empty_content: '生成内容为空或不可见',
    missing_requested_image: '没有完成图片请求',
    missing_requested_subject: '图片对象没有对准',
    missing_topic_focus: '偏离了当前话题',
    missing_question_answer: '没有回答当前问题',
    missing_direct_reply_focus: '没有先回应点名要求',
    no_media_capability: '当前模型能力不足',
    message_withdrawn: '角色内在冲动触发撤回',
    model_omitted_deliberation_artifacts_for_deliberative_move: '模型这次回复做了审议动作，但没有返回结构化审议产物',
    visible_away_without_presence_update: '可见回复表示离开或忙碌，但没有返回下线状态标记',
    surface_contract_invalid: '可见消息形态不符合当前房间规则',
    duplicate_content: '内容与近期发言重复或过近',
  };
  if (exact[normalized]) return exact[normalized];
  if (/model_omitted_deliberation_artifacts/i.test(normalized)) return '模型这次回复做了审议动作，但没有返回结构化审议产物';
  if (/visible_away_without_presence_update/i.test(normalized)) return '可见回复表示离开或忙碌，但没有返回下线状态标记';
  if (/stage directions|parenthesized scene beats/i.test(normalized)) return '包含括号舞台动作或场景旁白，不符合当前房间表面规则';
  if (/another speaker line/i.test(normalized)) return '同一条回复里写入了其他角色的台词';
  if (/exactly repeats/i.test(normalized)) return '完全复用了近期发言';
  if (/substring/i.test(normalized)) return '截取了近期发言的一部分';
  if (/copies a recent line/i.test(normalized)) return '复制了近期发言';
  if (/too close/i.test(normalized) || /surface overlap/i.test(normalized)) return '与近期措辞过于接近';
  if (/opening pattern/i.test(normalized)) return '复用了房间里的高频开头';
  if (/emoji|sticker/i.test(normalized)) return '复用了近期高频表情或贴纸标记';
  return normalized || '本地规则判定不应直接发出';
}

function localizeLocalInterceptionKind(kind: LocalInterceptionEvent['kind']) {
  const labels: Record<LocalInterceptionEvent['kind'], string> = {
    guidance_retry: '指令重试',
    analysis_artifacts_present: '审议产物已返回',
    analysis_artifacts_missing: '审议产物缺失',
    presence_metadata_missing: '状态标记缺失',
    surface_echo_warning: '重复内容提示',
    surface_contract_warning: '表面规则提示',
    surface_echo_retry: '重复内容重试',
    surface_echo_skip: '重复内容拦截',
    surface_contract_retry: '表面规则重试',
    surface_contract_skip: '表面规则拦截',
    empty_generation_skip: '空回复跳过',
    streamed_draft_committed: '流式草稿已提交',
    auto_withdraw: '自动撤回',
  };
  return labels[kind] || '本地拦截';
}

function isRetryInterception(kind: LocalInterceptionEvent['kind']) {
  return kind.endsWith('_retry');
}

function isDiagnosticHint(kind: LocalInterceptionEvent['kind']) {
  return kind === 'analysis_artifacts_present'
    || kind === 'analysis_artifacts_missing'
    || kind === 'presence_metadata_missing'
    || kind === 'surface_echo_warning'
    || kind === 'surface_contract_warning'
    || kind === 'streamed_draft_committed';
}

function compactInterceptedDraft(draft: string | undefined) {
  const normalized = (draft || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '（无可展示草稿）';
  return normalized.length > 160 ? `${normalized.slice(0, 160)}...` : normalized;
}

function buildLocalInterceptionSummary(event: LocalInterceptionEvent) {
  const actor = event.speakerName || '角色';
  const reason = localizeLocalInterceptionReason(event.reason);
  const kind = localizeLocalInterceptionKind(event.kind);
  const attempt = isRetryInterception(event.kind) && event.attempt ? `第 ${event.attempt} 次` : '';
  const draft = compactInterceptedDraft(event.draft);
  if (isDiagnosticHint(event.kind)) {
    return `${kind}${attempt ? `（${attempt}）` : ''}：${actor} 的消息已保留。草稿：${draft}（说明：${reason}）`;
  }
  if (isRetryInterception(event.kind)) {
    return `${kind}${attempt ? `（${attempt}）` : ''}：${actor} 的草稿暂不提交，正在要求模型修正。草稿：${draft}（原因：${reason}）`;
  }
  return `${kind}：拦截了${actor}的发言：${draft}（原因：${reason}）`;
}

type SidebarTabValue = 'session' | 'members' | 'narrative' | 'chapters' | 'clues' | 'roles' | 'world' | 'developer' | 'activities';
const EMPTY_MESSAGES: never[] = [];

function buildBranchTopologySignature(messages: Message[]) {
  return messages.map((message) => {
    const branching = message.metadata?.branching;
    return [
      message.id,
      message.clientKey || '',
      message.serverId || '',
      message.isDeleted ? 1 : 0,
      branching?.nodeId || '',
      branching?.parentNodeId ?? '',
      branching?.revisionRootId || '',
      branching?.revisionOfMessageId || '',
    ].join(':');
  }).join('|');
}

function buildVisibleMessageIdSignature(messages: Message[]) {
  return messages.map((message) => message.id).join('|');
}

function getPendingAppCommandActionLabel(pending: PendingAppCommand) {
  const primaryChoice = pending.choices?.find((choice) => choice.kind === 'confirm' || choice.kind === 'execute');
  if (primaryChoice) return primaryChoice.label;
  if (pending.route.mode !== 'local_action') return '继续处理';
  const plan = pending.route.plan;
  if (plan.action === 'create_group_chat') return plan.groupName ? `创建「${plan.groupName}」` : '创建群聊';
  if (plan.action === 'create_direct_chat') return plan.characterName ? `和${plan.characterName}聊天` : '创建单聊';
  if (plan.action === 'create_character' || plan.action === 'create_characters') {
    const count = plan.characters?.length || (plan.characterName ? 1 : 0);
    return count > 1 ? `创建 ${count} 个角色` : '创建角色';
  }
  if (plan.action === 'set_ai_model_key') return '写入模型秘钥';
  if (plan.action === 'update_theme') return plan.theme === 'dark' ? '切换夜间模式' : '切换主题';
  if (plan.action === 'open_existing_chat') return '打开最佳匹配';
  return plan.title || '执行操作';
}

function buildPendingAppCommandChoices(pending: PendingAppCommand) {
  const routeChoices = pending.choices?.length ? pending.choices : [];
  const hasCancel = routeChoices.some((choice) => choice.kind === 'cancel');
  const choices = routeChoices.length
    ? routeChoices
    : [{ id: 'confirm', label: getPendingAppCommandActionLabel(pending), kind: 'confirm' as const }];
  return hasCancel ? choices : [...choices, { id: 'cancel', label: '取消本次操作', kind: 'cancel' as const }];
}

function resolvePendingChoicePresentation(pending: PendingAppCommand) {
  if (pending.route.mode === 'local_action' && pending.route.choicePresentation) return pending.route.choicePresentation;
  const choices = buildPendingAppCommandChoices(pending);
  const longest = Math.max(...choices.map((choice) => choice.label.length + (choice.description?.length || 0)), 0);
  if (choices.length > 5) return 'select';
  if (longest > 18 || choices.length > 3) return 'list';
  return 'chips';
}

function cloneMessageImagesForComposer(message: Message, attachments: MessageAttachment[]) {
  const now = Date.now();
  return attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.status === 'ready' && Boolean(attachment.url))
    .slice(0, 9)
    .map((attachment, index): MessageAttachment => ({
      ...attachment,
      id: `ref_${message.id}_${attachment.id}_${now}_${index}`,
      status: 'ready',
      altText: attachment.altText || attachment.caption || '参考图',
      caption: attachment.caption || attachment.altText || '参考图',
      createdAt: now + index,
      updatedAt: now + index,
    }));
}

export default function ChatDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const { isMobile, isDesktop } = useResponsive();
  const pane = usePaneLayout();
  const isSplitDetailPane = pane.role === 'detail';
  const { setHideMobileBottomNav } = useLayoutHeaderActions();

  const chats = useChatStore((state) => state.chats);
  const updateChat = useChatStore((state) => state.updateChat);
  const deleteChat = useChatStore((state) => state.deleteChat);
  const applyChatRuntimeDelta = useChatStore((state) => state.applyChatRuntimeDelta);
  const loadChat = useChatStore((state) => state.loadChat);
  const restoreLocalChats = useChatStore((state) => state.restoreLocalChats);
  const markChatsWarm = useChatStore((state) => state.markChatsWarm);
  const chatsLoading = useChatStore((state) => state.isLoading);
  const remoteDeletedChatIds = useChatStore((state) => state.remoteDeletedChatIds);
  const remoteDeletedChats = useChatStore((state) => state.remoteDeletedChats);
  const characters = useCharacterStore((state) => state.characters);
  const updateCharacter = useCharacterStore((state) => state.updateCharacter);
  const updateCharacters = useCharacterStore((state) => state.updateCharacters);
  const loadCharacter = useCharacterStore((state) => state.loadCharacter);
  const markCharactersWarm = useCharacterStore((state) => state.markCharactersWarm);
  const messages = useMessageStore(useShallow((state) => (
    id ? state.messages.filter((message) => message.chatId === id) : EMPTY_MESSAGES
  )));
  const rawCurrentMessageWindow = useMessageStore((state) => (id ? state.messageWindowsByChatId[id] : undefined));
  const hydrateMessagesFromCache = useMessageStore((state) => state.hydrateMessagesFromCache);
  const openChatWindow = useMessageStore((state) => state.openChatWindow);
  const closeChatWindow = useMessageStore((state) => state.closeChatWindow);
  const loadMessages = useMessageStore((state) => state.loadMessages);
  const addMessage = useMessageStore((state) => state.addMessage);
  const upsertMessage = useMessageStore((state) => state.upsertMessage);
  const upsertMessages = useMessageStore((state) => state.upsertMessages);
  const deleteMessage = useMessageStore((state) => state.deleteMessage);
  const withdrawMessage = useMessageStore((state) => state.withdrawMessage);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' | 'info' }>({ open: false, message: '', severity: 'error' });
  const confirmWorkspaceMutationPlan = useCallback(async (message: Message) => {
    const plan = message.metadata?.workspaceMutationPlan;
    if (!plan || plan.status !== 'pending') return;
    const workspace = useLocalWorkspaceStore.getState();
    const directory = workspace.directories.find((item) => item.id === plan.directoryId);
    if (!directory) {
      setSnackbar({ open: true, message: '找不到对应的授权工作区，请重新授权。', severity: 'error' });
      return;
    }
    const { confirmAndApplyLocalWorkspaceMutationPlan } = await import('../services/localWorkspaceService');
    try {
      const result = await confirmAndApplyLocalWorkspaceMutationPlan({ plan, directory });
      upsertMessage({ ...message, metadata: { ...(message.metadata || {}), workspaceMutationPlan: { ...plan, status: 'confirmed', result: { applied: result.applied, failed: Math.max(0, result.planned - result.applied) } } } });
      setSnackbar({ open: true, message: `工作区变更已执行：${result.applied}/${result.planned} 项。`, severity: result.applied === result.planned ? 'success' : 'info' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const expired = /过期/.test(reason);
      upsertMessage({ ...message, metadata: { ...(message.metadata || {}), workspaceMutationPlan: { ...plan, status: expired ? 'expired' : 'rejected', result: { applied: 0, failed: plan.mutations.length, error: reason } } } });
      setSnackbar({ open: true, message: expired ? '工作区变更计划已过期，请重新发起操作。' : `工作区变更未执行：${reason}`, severity: 'error' });
    }
  }, [setSnackbar, upsertMessage]);
  const hasMore = useMessageStore((state) => state.hasMore);
  const hasMoreNewer = useMessageStore((state) => state.hasMoreNewer);
  const isLoading = useMessageStore((state) => state.isLoading);
  const isLoadingOlder = useMessageStore((state) => state.isLoadingOlder);
  const isLoadingNewer = useMessageStore((state) => state.isLoadingNewer);
  const { isRunning, isPaused, start, stop, pause, resume, setCurrentSpeaker, recordSpeak, resetAllCooldowns, loopToken } = useSchedulerStore();
  const api = useSettingsStore((s) => s.api);
  const aiProfiles = useSettingsStore((s) => s.aiProfiles);
  const textProfile = getUsablePreferredAIProfile(aiProfiles, 'text');
  const textInputCapabilities = resolveAIModelInputCapabilities(textProfile);
  const textInputCapabilityWarning = getInputCapabilityWarning(textProfile, isZh ? 'zh' : 'en');
  const { speakAsCharacterId, setSpeakAsCharacter, rightPanelOpen, toggleRightPanel, setRightPanelOpen, rightPanelTab, setRightPanelTab, chatReadingPositions, setChatReadingPosition } = useUIStore();
  const dramaBoost = useSettingsStore((s) => s.developerUI.dramaBoost);
  const showLocalInterceptionHints = useSettingsStore((s) => s.developerMode && s.developerUI.showLocalInterceptionHints);
  const currentUser = useAuthStore((s) => s.user);
  const authMode = useAuthStore((s) => s.authMode);
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const chatShareAvailable = authMode === 'cloud' && currentUser?.chatShareEntitled === true;
  const isRemoteDeletedChat = Boolean(id && remoteDeletedChatIds.includes(id));

  const [detailBootstrapComplete, setDetailBootstrapComplete] = useState(false);
  const [sidebarMessagesReady, setSidebarMessagesReady] = useState(false);
  const [profilePreview, setProfilePreview] = useState<ProfilePreviewState | null>(null);
  const composerInputRef = useRef<ChatInputHandle | null>(null);
  const handleMentionCharacter = useCallback((character: AICharacter) => {
    if (composerInputRef.current?.insertMention(character)) navigator.vibrate?.(15);
    else setSnackbar({ open: true, message: '当前输入框不可用，暂时无法艾特', severity: 'info' });
  }, []);
  const [aiDirectPerspectiveMemberId, setAiDirectPerspectiveMemberId] = useState<string | null>(null);
  const [guideTargetMemberId, setGuideTargetMemberId] = useState<string | null>(null);
  const [pendingStoryChoiceKey, setPendingStoryChoiceKey] = useState<string | null>(null);
  const [messageScrollRequest, setMessageScrollRequest] = useState<MessageListScrollRequest | null>(null);
  const [pendingStoryChoiceVisual, setPendingStoryChoiceVisual] = useState<PendingStoryChoiceVisual | null>(null);
  const [isStoryReaderAtTail, setIsStoryReaderAtTail] = useState(true);
  const [hasStoryReaderReachedTailIntent, setHasStoryReaderReachedTailIntent] = useState(false);
  const [hasStoryUserDraft, setHasStoryUserDraft] = useState(false);
  const [isStoryGenerationCancelled, setIsStoryGenerationCancelled] = useState(false);
  const [isExplicitContinuationScrollFollowSuspended, setIsExplicitContinuationScrollFollowSuspended] = useState(false);
  const [narrativeRevealMessageKeys, setNarrativeRevealMessageKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [chatPageSettingsOpen, setChatPageSettingsOpen] = useState(false);
  const [uiHydrated, setUiHydrated] = useState(() => useUIStore.persist.hasHydrated());
  const [selectedAssistantArtifactId, setSelectedAssistantArtifactId] = useState<string | null>(null);
  const [fullscreenAssistantArtifactId, setFullscreenAssistantArtifactId] = useState<string | null>(null);
  const [pendingAppCommand, setPendingAppCommand] = useState<PendingAppCommand | null>(null);
  const [visiblePendingAppCommand, setVisiblePendingAppCommand] = useState<PendingAppCommand | null>(null);
  const [pendingAppCommandChoiceId, setPendingAppCommandChoiceId] = useState<string | null>(null);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [composerInjectedAttachments, setComposerInjectedAttachments] = useState<MessageAttachment[]>([]);
  const {
    pending: isDirectReplyPending,
    epochRef: directReplyEpochRef,
    begin: beginReplyOperation,
    finish: finishReplyOperation,
    cancel: cancelReplyOperation,
  } = useReplyOperation();
  const [htmlRepairRetry, setHtmlRepairRetry] = useState<HtmlRepairRetryState | null>(null);
  const [readOnlyEmphasis, setReadOnlyEmphasis] = useState(true);

  const loopTokenRef = useRef<string | null>(null);
  const isRunningRef = useRef(false);
  const isPausedRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const pendingStoryChoiceRef = useRef<string | null>(null);
  const pendingStoryChoiceVisualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isStoryReaderAtTailRef = useRef(true);
  const consumedHomeCommandRef = useRef<string | null>(null);
  const lastReadingPositionPersistRef = useRef<{ chatId: string; key: string; at: number } | null>(null);
  const pendingReadingPositionPersistRef = useRef<{
    chatId: string;
    key: string;
    position: MessageListScrollPosition;
  } | null>(null);
  const readingPositionPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedChatWindowRef = useRef<{ chatId: string; requestKey: string; openedAt: number; restored: boolean; cloudMode: boolean } | null>(null);
  const storyEntryReadingPositionRef = useRef<{ chatId: string; key: string; position: MessageListScrollPosition } | null>(null);
  const navigationAccountScope = getLocalDataUserId();
  const initialChatNavigationPosition = useMemo(() => id ? readChatNavigationPosition(id, navigationAccountScope) : null, [id, navigationAccountScope]);
  const handleChatNavigationPositionChange = useCallback((position: MessageListScrollPosition) => {
    if (id) saveChatNavigationPosition(id, position);
  }, [id]);
  const activeChatIdRef = useRef<string | null>(id ?? null);
  const isManualInputPendingRef = useRef<() => boolean>(() => false);
  const userDraftActivityRef = useRef<UserDraftActivity | null>(null);
  const pendingHtmlSubmissionKeysRef = useRef(new Set<string>());
  const regenerationResumeRef = useRef<{ epoch: number; shouldResume: boolean } | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const pendingAppCommandChoiceRef = useRef(false);
  const assistantTitleRetryKeyRef = useRef<string | null>(null);
  const openingLoopRef = useRef(false);
  const openingSuppressedRef = useRef(false);
  const openingMessageCountRef = useRef(0);

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return undefined;
    const visualViewport = window.visualViewport;
    if (!visualViewport) return undefined;
    const updateKeyboardInset = () => {
      const active = document.activeElement;
      const isTextEditing = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active?.getAttribute('contenteditable') === 'true';
      const coveredHeight = Math.max(0, Math.round(window.innerHeight - visualViewport.height - visualViewport.offsetTop));
      const nextInset = isTextEditing && coveredHeight > 80 ? coveredHeight : 0;
      setKeyboardInset((current) => current === nextInset ? current : nextInset);
    };
    updateKeyboardInset();
    visualViewport.addEventListener('resize', updateKeyboardInset);
    visualViewport.addEventListener('scroll', updateKeyboardInset);
    window.addEventListener('resize', updateKeyboardInset);
    document.addEventListener('focusin', updateKeyboardInset);
    document.addEventListener('focusout', updateKeyboardInset);
    return () => {
      visualViewport.removeEventListener('resize', updateKeyboardInset);
      visualViewport.removeEventListener('scroll', updateKeyboardInset);
      window.removeEventListener('resize', updateKeyboardInset);
      document.removeEventListener('focusin', updateKeyboardInset);
      document.removeEventListener('focusout', updateKeyboardInset);
    };
  }, [isMobile]);
  useEffect(() => {
    if (useUIStore.persist.hasHydrated()) {
      setUiHydrated(true);
      return undefined;
    }
    const unsubscribe = useUIStore.persist.onFinishHydration(() => setUiHydrated(true));
    void useUIStore.persist.rehydrate();
    return unsubscribe;
  }, []);

  useEffect(() => {
    // Keep the rendered choices in lockstep with the pending command store.
    // Clearing a command must also clear the visible copy so stale choices
    // cannot remain clickable while the exit animation is running.
    setVisiblePendingAppCommand(pendingAppCommand);
  }, [pendingAppCommand]);
  const [transientMessages, setTransientMessages] = useState<Message[]>([]);
  useEffect(() => {
    setTransientMessages([]);
  }, [id]);
  const upsertMessageWithLiveReveal = useCallback((message: Message) => {
    if (message.isStreaming) {
      setTransientMessages((current) => (message.isDeleted
        ? removeTransientMessage(current, message)
        : upsertTransientMessage(current, message)));
      return;
    }
    const revealKeys = getNarrativeRevealIdentityKeys(message);
    if (revealKeys.length && shouldRegisterLiveNarrativeReveal(message)) {
      setNarrativeRevealMessageKeys((current) => {
        const next = new Set(current);
        let changed = false;
        revealKeys.forEach((key) => {
          if (!next.has(key)) {
            next.add(key);
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }
    // Complete the same rendered bubble in place. The committed message is
    // written in parallel and later confirms this presentation entry.
    setTransientMessages((current) => {
      const exists = current.some((item) => item.clientKey === message.clientKey || item.id === message.id);
      return exists ? upsertTransientMessage(current, { ...message, isStreaming: false }) : current;
    });
    upsertMessage(message);
  }, [upsertMessage]);
  const clearNarrativeRevealMessage = useCallback((message: Message) => {
    const revealKeys = getNarrativeRevealIdentityKeys(message);
    if (!revealKeys.length) return;
    setNarrativeRevealMessageKeys((current) => {
      let changed = false;
      const next = new Set(current);
      revealKeys.forEach((key) => {
        if (next.delete(key)) changed = true;
      });
      return changed ? next : current;
    });
  }, []);
  const {
    streamingMessageRef,
    updateStreamingMessage,
    discardStreamingMessage,
    clearStreamingMessageRef,
    freezeStreamingDisplay,
    getDisplayedStreamingMessage,
  } = useStreamingMessageState(upsertMessageWithLiveReveal);

  useLayoutEffect(() => {
    if (!id) return;
    if (!useChatStore.persist.hasHydrated()) void useChatStore.persist.rehydrate();
    if (!useCharacterStore.persist.hasHydrated()) void useCharacterStore.persist.rehydrate();
    void hydrateMessagesFromCache(id, { limit: CHAT_MESSAGE_WINDOW_SIZE });
  }, [hydrateMessagesFromCache, id]);

  useEffect(() => {
    let cancelled = false;
    setDetailBootstrapComplete(false);
    markChatsWarm();
    markCharactersWarm();
    logDeveloperDiagnostic('chat-detail:bootstrap:start', {
      chatId: id,
      authMode,
      isLoggedIn,
      currentChats: useChatStore.getState().chats.length,
      currentCharacters: useCharacterStore.getState().characters.length,
    }, 'debug', 'chat-page');
    void (async () => {
      await restoreLocalChats();
      const localChat = id ? useChatStore.getState().chats.find((item) => item.id === id) || null : null;
      logDeveloperDiagnostic('chat-detail:bootstrap:local-chat', {
        chatId: id,
        found: Boolean(localChat),
        runtimeDetailLoaded: localChat?.runtimeDetailLoaded,
        memberCount: localChat?.memberIds?.length,
      }, localChat ? 'debug' : 'info', 'chat-page');
      if (localChat && !cancelled) setDetailBootstrapComplete(true);
      const loadedChat = id ? await loadChat(id) : null;
      logDeveloperDiagnostic('chat-detail:bootstrap:loaded-chat', {
        chatId: id,
        found: Boolean(loadedChat),
        runtimeDetailLoaded: loadedChat?.runtimeDetailLoaded,
        memberCount: loadedChat?.memberIds?.length,
      }, loadedChat ? 'debug' : 'warn', 'chat-page');
      if (!localChat && !cancelled) setDetailBootstrapComplete(true);
      const memberIds = loadedChat?.memberIds || localChat?.memberIds || useChatStore.getState().chats.find((item) => item.id === id)?.memberIds || [];
      logDeveloperDiagnostic('chat-detail:bootstrap:load-members', {
        chatId: id,
        memberIds,
        missingCharacterIds: getSyncableCharacterMemberIds(memberIds)
          .filter((memberId) => !useCharacterStore.getState().hasCharacterLoaded(memberId)),
      }, 'debug', 'chat-page');
      await Promise.all(
        getSyncableCharacterMemberIds(memberIds)
          .filter((memberId) => !useCharacterStore.getState().hasCharacterLoaded(memberId))
          .map((memberId) => loadCharacter(memberId)),
      );
    })().finally(() => {
      if (!cancelled) setDetailBootstrapComplete(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authMode, id, isLoggedIn, loadCharacter, loadChat, markCharactersWarm, markChatsWarm, restoreLocalChats]);

  const remoteDeletedChat = remoteDeletedChats.find((c) => c.id === id);
  const chat = chats.find((c) => c.id === id) || remoteDeletedChat;
  const groupBackgroundUrl = chat?.groupVisual?.backgroundUrl?.trim() || '';
  const groupBackgroundOpacity = Math.min(1, Math.max(0.05, Number(chat?.groupVisual?.backgroundOpacity ?? 0.16)));
  const sessionInfoCards = useMemo(() => {
    if (!chat) return [];
    return projectSessionInfoCards({ chat, chats, members: characters, isZh: true });
  }, [chat, chats, characters]);
  const aiDirectSourceInfoCards = useMemo(
    () => chat?.type === 'ai_direct' ? sessionInfoCards.filter((card) => card.key === 'ai-direct-source-chat') : [],
    [chat?.type, sessionInfoCards]
  );
  const globalSessionInfoCards = useMemo(
    () => sessionInfoCards.filter((card) => card.key !== 'ai-direct-source-chat'),
    [sessionInfoCards]
  );
  const currentChatAllMessages = useMemo(() => (id
    ? projectMergedChatMessages({
      chatId: id,
      activeMessages: messages,
      cachedWindow: rawCurrentMessageWindow ? { ...rawCurrentMessageWindow, preserveBranchContext: Boolean(chat && isMessageBranchingEnabled(chat)) } : rawCurrentMessageWindow,
    })
    : []), [chat, id, messages, rawCurrentMessageWindow]);
  const stableBranchProjectionRef = useRef<{ key: string; messages: Message[] } | null>(null);
  const currentChatMessages = useMemo(() => {
    if (!id) return [];
    const branchName = chat?.messageBranchState?.activeBranchName || 'main';
    const head = chat?.messageBranchState?.refs?.[branchName]?.headNodeId
      || chat?.messageBranchState?.activeLeafNodeId || '';
    const branchKey = `${id}:${branchName}:${head}`;
    const result = projectCurrentChatMessages({
      chatId: id, chat, activeMessages: messages, cachedWindow: rawCurrentMessageWindow,
      fallbackMessages: stableBranchProjectionRef.current?.key === branchKey
        ? stableBranchProjectionRef.current.messages : undefined,
    });
    if (chat && isMessageBranchingEnabled(chat) && result.length > 0) {
      stableBranchProjectionRef.current = { key: branchKey, messages: result };
    }
    return result;
  }, [chat, rawCurrentMessageWindow, id, messages]);
  const visibleChatMessages = useMemo(
    () => overlayTransientMessages(currentChatMessages, transientMessages),
    [currentChatMessages, transientMessages],
  );
  useEffect(() => {
    setTransientMessages((current) => releaseConfirmedTransientMessages(current, currentChatMessages));
  }, [currentChatMessages]);
  useEffect(() => {
    if (!chat || chat.type !== 'assistant' || !id || !currentChatMessages.length) return;
    if (chat.modeState.assistantTitle?.source === 'user') return;
    const latestTimestamp = currentChatMessages.at(-1)?.timestamp || 0;
    const retryKey = `${id}:${currentChatMessages.length}:${latestTimestamp}`;
    if (assistantTitleRetryKeyRef.current === retryKey) return;
    assistantTitleRetryKeyRef.current = retryKey;
    void import('../services/assistantChatFlow').then(({ maybeGenerateAssistantChatTitle }) => {
      void maybeGenerateAssistantChatTitle({
        api,
        chat,
        chatId: id,
        currentMessages: currentChatMessages,
        updateChat,
      });
    });
  }, [api, chat, currentChatMessages, id, updateChat]);
  const cloudRichMediaRequiresServerId = authMode === 'cloud' && isCloudSyncEnabled();
  const queuedRichMediaSignature = useMemo(() => currentChatMessages
    .flatMap((message) => (message.metadata?.attachments || [])
      .filter(isRecoverableRichMediaAttachment)
      .map((attachment) => `${message.id}:${message.serverId || 'pending'}:${attachment.id}:${attachment.updatedAt || attachment.createdAt || 0}`))
    .join('|'), [currentChatMessages]);
  useEffect(() => {
    if (!queuedRichMediaSignature || !aiProfiles.length) return undefined;
    const messagesWithQueuedMedia = currentChatMessages.filter((message) => (
      (!cloudRichMediaRequiresServerId || Boolean(message.serverId))
      && message.metadata?.attachments?.some(isRecoverableRichMediaAttachment)
    ));
    if (!messagesWithQueuedMedia.length) return undefined;
    let cancelled = false;
    void import('../services/richMessageMedia').then(({ processRichMessageMedia }) => {
      if (cancelled) return;
      messagesWithQueuedMedia.forEach((message) => {
        const speaker = characters.find((character) => character.id === message.senderId) || null;
        void processRichMessageMedia({
          message,
          character: speaker,
          characters,
          messages: currentChatMessages,
          aiProfiles,
          upsertMessage,
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [aiProfiles, characters, cloudRichMediaRequiresServerId, currentChatMessages, queuedRichMediaSignature, upsertMessage]);
  const messageWindowDebugSignatureRef = useRef('');
  const pageStateDebugSignatureRef = useRef('');
  useEffect(() => {
    if (!id || typeof console === 'undefined') return;
    const signature = [
      id,
      authMode,
      messages.length,
      rawCurrentMessageWindow?.messages?.length || 0,
      currentChatMessages.length,
      isLoading,
    ].join('|');
    if (messageWindowDebugSignatureRef.current === signature) return;
    messageWindowDebugSignatureRef.current = signature;
    logDeveloperDiagnostic('message-window:page-projection', {
      chatId: id,
      authMode,
      activeMessages: messages.length,
      cachedWindowMessages: rawCurrentMessageWindow?.messages?.length || 0,
      cachedWindowActiveLimit: rawCurrentMessageWindow?.activeLimit,
      projectedMessages: currentChatMessages.length,
      isLoading,
    }, 'debug', 'message-window');
  }, [authMode, currentChatMessages.length, id, isLoading, messages.length, rawCurrentMessageWindow?.activeLimit, rawCurrentMessageWindow?.messages?.length]);
  useEffect(() => {
    if (!id) return;
    const branchState = chat?.messageBranchState;
    const signature = [
      id,
      messages.filter((message) => message.chatId === id).length,
      rawCurrentMessageWindow?.messages?.length || 0,
      rawCurrentMessageWindow?.activeLimit || 0,
      currentChatAllMessages.length,
      currentChatMessages.length,
      currentChatMessages[0]?.timestamp || 0,
      currentChatMessages.at(-1)?.timestamp || 0,
      Object.keys(branchState?.selectedRevisionByRootId || {}).length,
      Object.keys(branchState?.activeChildByParentNodeId || {}).length,
      hasMore,
      hasMoreNewer,
      isLoading,
    ].join('|');
    if (pageStateDebugSignatureRef.current === signature) return;
    pageStateDebugSignatureRef.current = signature;
    logDeveloperDiagnostic('message-pagination:page-state', {
      chatId: id,
      activeStoreMessages: messages.filter((message) => message.chatId === id).length,
      cachedMessages: rawCurrentMessageWindow?.messages?.length || 0,
      cachedActiveLimit: rawCurrentMessageWindow?.activeLimit || null,
      mergedMessages: currentChatAllMessages.length,
      projectedMessages: currentChatMessages.length,
      projectedRange: currentChatMessages.length ? [currentChatMessages[0]?.timestamp, currentChatMessages.at(-1)?.timestamp] : null,
      selectedRevisionCount: Object.keys(branchState?.selectedRevisionByRootId || {}).length,
      activeChildCount: Object.keys(branchState?.activeChildByParentNodeId || {}).length,
      activeLeafNodeId: branchState?.activeLeafNodeId ? String(branchState.activeLeafNodeId).slice(-12) : null,
      hasMoreOlder: hasMore,
      hasMoreNewer,
      isLoading,
    }, currentChatMessages.length <= 2 && currentChatAllMessages.length > 2 ? 'warn' : 'info', 'message-window');
  }, [chat?.messageBranchState, currentChatAllMessages.length, currentChatMessages, hasMore, hasMoreNewer, id, isLoading, messages, rawCurrentMessageWindow?.activeLimit, rawCurrentMessageWindow?.messages?.length]);
  const branchTopologySignature = useMemo(
    () => buildBranchTopologySignature(currentChatAllMessages),
    [currentChatAllMessages],
  );
  const visibleMessageIdSignature = useMemo(
    () => buildVisibleMessageIdSignature(currentChatMessages),
    [currentChatMessages],
  );
  const branchVersionInfoByMessageId = useMemo(() => {
    if (!chat || !isMessageBranchingEnabled(chat)) return {} as Record<string, NonNullable<ReturnType<typeof getMessageBranchVersionInfo>>>;
    return buildMessageBranchVersionInfoByMessageId(
      chat,
      currentChatAllMessages,
      currentChatMessages.map((message) => message.id),
    ) as Record<string, NonNullable<ReturnType<typeof getMessageBranchVersionInfo>>>;
  }, [branchTopologySignature, chat?.messageBranchState, chat?.mode, chat?.sessionKind?.scenarioId, visibleMessageIdSignature]);
  const sidebarMessages = sidebarMessagesReady ? currentChatMessages : EMPTY_MESSAGES;
  const {
    analysisDialogOpen,
    analysisError,
    analysisLoading,
    analysisTarget,
    analysisText,
    analyzeMessage,
    closeAnalysisDialog,
  } = useMessageAnalysis({
    api,
    chat,
    messages: currentChatMessages,
    characters,
    fallbackError: t('common.error'),
  });
  const members = useMemo(
    () => chat ? chat.memberIds.map((memberId) => resolveCharacterOrDeleted(characters, memberId)) : [],
    [characters, chat]
  );
  const isMissingRequiredCharacterChat = useMemo(
    () => isChatBlockedByMissingRequiredCharacters(chat, characters),
    [characters, chat],
  );
  const relationshipInitialization = useMemo(
    () => chat ? getConversationInitializationRequirement(chat, characters) : { required: false, fingerprint: '', status: 'ready' as const },
    [characters, chat],
  );
  const relationshipInitializationBlocked = relationshipInitialization.required;
  const relationshipInitializationFailed = relationshipInitialization.status === 'failed';
  const chatReadOnlyReason = isRemoteDeletedChat
    ? '此会话已在其他设备删除'
    : isMissingRequiredCharacterChat
      ? '角色已删除，无法继续聊天'
      : relationshipInitializationBlocked
        ? relationshipInitializationFailed
          ? '初始化失败，请重试'
          : '正在初始化'
      : '';
  const chatInteractionDisabled = Boolean(chatReadOnlyReason);
  const handleRefreshGroupRelationships = useCallback(() => {
    if (!chat || chat.type !== 'group') return;
    const requirement = getConversationInitializationRequirement(chat, characters);
    if (!requirement.fingerprint) return;
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        initialization: createConversationInitializationState('running', requirement.fingerprint, Date.now(), true),
      },
    });
  }, [characters, chat, updateChat]);
  const handleUpdateSharedRelationshipFacts = useCallback(async (updates: Array<{ fact: RoomRelationshipSharedFact; statement: string }>) => {
    if (!chat || !updates.length) return;
    const latest = useChatStore.getState().chats.find((item) => item.id === chat.id);
    if (!latest) throw new Error('当前群聊不存在');
    const statements = new Map(updates.map(({ fact, statement }) => [fact.id, statement]));
    const updatedAt = Date.now();
    const sharedFacts = (latest.relationshipStructure?.sharedFacts || []).map((fact) => (
      statements.has(fact.id) ? { ...fact, statement: statements.get(fact.id)!, updatedAt } : fact
    ));
    await updateChat(latest.id, {
      relationshipStructure: {
        version: 1,
        edges: latest.relationshipStructure?.edges || [],
        sharedFacts,
        updatedAt,
      },
    });
  }, [chat, updateChat]);
  const activeMembers = useMemo(
    () => chat ? characters.filter((c) => chat.memberIds.includes(c.id)) : [],
    [characters, chat]
  );
  const aiDirectMemberIds = useMemo(
    () => chat?.type === 'ai_direct' ? getSyncableCharacterMemberIds(chat.memberIds) : [],
    [chat]
  );
  const speakAsChar = useMemo(
    () => speakAsCharacterId ? characters.find((c) => c.id === speakAsCharacterId) ?? null : null,
    [characters, speakAsCharacterId]
  );
  const isStoryRoom = chat?.sessionKind?.scenarioId === 'story-reader';
  const isStudyRoom = Boolean(chat && hasRoomCapability(chat, 'knowledge'));
  const isAssistantChat = chat?.type === 'assistant';
  const isLearningProgressRoom = Boolean(chat && hasRoomCapability(chat, 'html-interactive'));
  useEffect(() => {
    if (!id || !detailBootstrapComplete || isMissingRequiredCharacterChat || !relationshipInitialization.required || relationshipInitialization.status === 'failed') return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const fingerprint = relationshipInitialization.fingerprint;
    const persistState = async (status: 'running' | 'completed' | 'failed') => {
      const current = useChatStore.getState().chats.find((item) => item.id === id);
      if (cancelled || activeChatIdRef.current !== id || !current) return false;
      const currentRequirement = getConversationInitializationRequirement(current, useCharacterStore.getState().characters);
      if (currentRequirement.fingerprint !== fingerprint) return false;
      await updateChat(id, {
        modeState: {
          ...current.modeState,
          initialization: createConversationInitializationState(status, fingerprint),
        },
      });
      return !cancelled && activeChatIdRef.current === id;
    };
    const run = async () => {
      const settings = useSettingsStore.getState();
      const profile = getUsablePreferredAIProfile(settings.aiProfiles, 'text');
      if (!profile) {
        await persistState('failed');
        return;
      }
      try {
        const current = useChatStore.getState().chats.find((item) => item.id === id);
        if (!current || cancelled || activeChatIdRef.current !== id) return;
        const forceRelationshipRefresh = current.modeState.initialization?.forceRelationshipRefresh === true;
        const membersForInitialization = getInitializationMembers(current, useCharacterStore.getState().characters);
        await initializeDefaultRelationshipsForCreatedCharacters({
          config: profile,
          createdCharacters: membersForInitialization,
          allCharacters: membersForInitialization,
          language: isZh ? 'zh' : 'en',
          updateCharacters: useCharacterStore.getState().updateCharacters,
          force: forceRelationshipRefresh,
          replaceWithinCharacterIds: membersForInitialization.map((member) => member.id),
          updateRelationshipStructure: async ({ edges, sharedFacts }) => {
            const latest = useChatStore.getState().chats.find((item) => item.id === id);
            if (cancelled || controller.signal.aborted || activeChatIdRef.current !== id || !latest) return;
            const currentRequirement = getConversationInitializationRequirement(latest, useCharacterStore.getState().characters);
            if (currentRequirement.fingerprint !== fingerprint) return;
            const force = latest.modeState.initialization?.forceRelationshipRefresh === true;
            if (force) {
              await updateChat(id, {
                relationshipStructure: {
                  version: 1,
                  edges,
                  sharedFacts,
                  updatedAt: Date.now(),
                },
              });
              return;
            }
            const existing = latest.relationshipStructure?.edges || [];
            const existingKeys = new Set(existing.map((edge) => `${edge.fromId}->${edge.toId}:${edge.kind}`));
            const additions = edges.filter((edge) => !existingKeys.has(`${edge.fromId}->${edge.toId}:${edge.kind}`));
            const existingSharedFacts = latest.relationshipStructure?.sharedFacts || [];
            const existingSharedKeys = new Set(existingSharedFacts.map((fact) => `${[...fact.memberIds].sort().join('|')}:${fact.kind}`));
            const sharedAdditions = sharedFacts.filter((fact) => !existingSharedKeys.has(`${[...fact.memberIds].sort().join('|')}:${fact.kind}`));
            if (!additions.length && !sharedAdditions.length) return;
            await updateChat(id, {
              relationshipStructure: {
                version: 1,
                edges: [...existing, ...additions],
                sharedFacts: [...existingSharedFacts, ...sharedAdditions],
                updatedAt: Date.now(),
              },
            });
          },
          scope: 'selected_members',
          signal: controller.signal,
        });
        if (forceRelationshipRefresh) {
          const latestAfterRelationshipUpdate = useChatStore.getState().chats.find((item) => item.id === id);
          if (latestAfterRelationshipUpdate) {
            const refreshedLedger = refreshRelationshipLedgerBaselines(
              latestAfterRelationshipUpdate.relationshipLedger || [],
              useCharacterStore.getState().characters,
              membersForInitialization.map((member) => member.id),
              Date.now(),
            );
            await updateChat(id, { relationshipLedger: refreshedLedger });
          }
        }
        if (cancelled || controller.signal.aborted || activeChatIdRef.current !== id) return;
        const latestChat = useChatStore.getState().chats.find((item) => item.id === id);
        const latestRequirement = latestChat
          ? getConversationInitializationRequirement(latestChat, useCharacterStore.getState().characters)
          : null;
        if (!latestChat || latestRequirement?.fingerprint !== fingerprint) return;
        const hasExistingMessage = useMessageStore.getState().messages.some((message) => (
          message.chatId === id && !message.isDeleted && message.type !== 'system'
        ));
        if (!hasExistingMessage && latestChat.topic.trim()) {
          await addMessage(buildOpeningTopicGuideMessage(id, latestChat.topic));
        }
        await persistState('completed');
      } catch (error) {
        if (cancelled || controller.signal.aborted || activeChatIdRef.current !== id) return;
        console.error('[chat-detail:conversation-initialization:error]', error);
        await persistState('failed');
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [addMessage, detailBootstrapComplete, id, isMissingRequiredCharacterChat, isZh, relationshipInitialization.fingerprint, relationshipInitialization.required, relationshipInitialization.status, updateChat]);
  useEffect(() => {
    if (!id || !isAssistantChat) {
      setPendingAppCommand(null);
      return undefined;
    }
    const syncPending = () => setPendingAppCommand(getPendingAppCommand(`assistant:${id}`));
    syncPending();
    return subscribePendingAppCommand(syncPending);
  }, [id, isAssistantChat]);
  const agentEntitled = authMode === 'cloud' && currentUser?.agentEntitled === true;
  useEffect(() => {
    if (!chat || !isAssistantChat || agentEntitled) return;
    const capabilities = chat.modeState.assistantCapabilities || {};
    const genericCapabilities = chat.modeState.agentCapabilities || {};
    if (!capabilities.agent && !capabilities.artifacts && !genericCapabilities.enabled) return;
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        agentCapabilities: {
          ...genericCapabilities,
          enabled: false,
          chatArtifactRead: false,
          chatArtifactWrite: false,
          fileUpload: false,
          fileDownload: false,
          workspaceRead: false,
          workspaceWrite: false,
          webSearch: false,
          updatedAt: Date.now(),
        },
        assistantCapabilities: {
          ...capabilities,
          agent: false,
          artifacts: false,
          updatedAt: Date.now(),
        },
      },
    });
    setSnackbar({ open: true, message: 'Agent 能力仅会员可用，已关闭当前助手的 Agent 模式。', severity: 'error' });
  }, [agentEntitled, chat, isAssistantChat, updateChat]);
  useEffect(() => {
    if (!chat || !isAssistantChat || !agentEntitled || !readAssistantAgentDefaultEnabled(true)) return;
    const generic = chat.modeState.agentCapabilities;
    const legacy = chat.modeState.assistantCapabilities;
    if (generic?.enabled && legacy?.agent) return;
    const searchEnabled = currentUser?.aiSearchEntitled === true;
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        agentCapabilities: {
          ...(generic || {}),
          enabled: true,
          chatArtifactRead: true,
          chatArtifactWrite: true,
          fileUpload: true,
          fileDownload: true,
          workspaceRead: true,
          webSearch: searchEnabled,
          updatedAt: Date.now(),
        },
        assistantCapabilities: {
          ...(legacy || {}),
          agent: true,
          artifacts: true,
          webSearch: searchEnabled,
          webSearchUserDisabled: false,
          updatedAt: Date.now(),
        },
      },
    });
  }, [agentEntitled, chat, currentUser?.aiSearchEntitled, isAssistantChat, updateChat]);
  useEffect(() => {
    if (!chat || !isAssistantChat || authMode !== 'cloud' || currentUser?.aiSearchEntitled !== true) return;
    const capabilities = chat.modeState.assistantCapabilities || {};
    if (!capabilities.agent || capabilities.webSearch || capabilities.webSearchUserDisabled) return;
    void updateChat(chat.id, {
      modeState: {
        ...chat.modeState,
        assistantCapabilities: {
          ...capabilities,
          webSearch: true,
          webSearchUserDisabled: false,
          updatedAt: Date.now(),
        },
      },
    });
  }, [authMode, chat, currentUser?.aiSearchEntitled, isAssistantChat, updateChat]);
  const savedStoryReadingPositionForChat = isStoryRoom && id ? chatReadingPositions[id] : null;
  const savedStoryReadingRestoreKey = savedStoryReadingPositionForChat && !savedStoryReadingPositionForChat.pinned
    ? `${savedStoryReadingPositionForChat.messageId}:${savedStoryReadingPositionForChat.sourceTimestamp ?? ''}:${Math.round(savedStoryReadingPositionForChat.offsetTop)}`
    : '';
  if (!id || !isStoryRoom || storyEntryReadingPositionRef.current?.chatId !== id) {
    storyEntryReadingPositionRef.current = null;
  }
  if (id && isStoryRoom && savedStoryReadingPositionForChat && !storyEntryReadingPositionRef.current) {
    storyEntryReadingPositionRef.current = {
      chatId: id,
      key: savedStoryReadingRestoreKey || 'tail',
      position: {
        messageId: savedStoryReadingPositionForChat.messageId,
        offsetTop: savedStoryReadingPositionForChat.offsetTop,
        pinned: savedStoryReadingPositionForChat.pinned,
        sourceTimestamp: savedStoryReadingPositionForChat.sourceTimestamp,
      },
    };
  }
  const entryStoryReadingPositionRecord = storyEntryReadingPositionRef.current;
  let entryStoryReadingPosition: MessageListScrollPosition | null = null;
  if (entryStoryReadingPositionRecord && entryStoryReadingPositionRecord.chatId === id) {
    entryStoryReadingPosition = entryStoryReadingPositionRecord.position;
  }
  const storyReadingRestoreKey = entryStoryReadingPosition && !entryStoryReadingPosition.pinned
    ? `${entryStoryReadingPosition.messageId}:${entryStoryReadingPosition.sourceTimestamp ?? ''}:${Math.round(entryStoryReadingPosition.offsetTop)}`
    : '';
  const hasSavedNonTailStoryReadingPosition = Boolean(entryStoryReadingPosition && !entryStoryReadingPosition.pinned);
  useEffect(() => {
    if (!chat || chat.type !== 'ai_direct') {
      setAiDirectPerspectiveMemberId(null);
      return;
    }
    if (aiDirectPerspectiveMemberId && aiDirectMemberIds.includes(aiDirectPerspectiveMemberId)) return;
    setAiDirectPerspectiveMemberId(aiDirectMemberIds[0] || null);
  }, [aiDirectMemberIds, aiDirectPerspectiveMemberId, chat]);
  useEffect(() => {
    setGuideTargetMemberId(null);
    setNarrativeRevealMessageKeys(new Set());
    setPendingStoryChoiceVisual(null);
    setHasStoryReaderReachedTailIntent(false);
    const nextAtTail = chat?.sessionKind?.scenarioId === 'story-reader' && savedStoryReadingPositionForChat
      ? savedStoryReadingPositionForChat.pinned
      : true;
    setIsStoryReaderAtTail(nextAtTail);
    isStoryReaderAtTailRef.current = nextAtTail;
    if (pendingStoryChoiceVisualTimerRef.current) {
      clearTimeout(pendingStoryChoiceVisualTimerRef.current);
      pendingStoryChoiceVisualTimerRef.current = null;
    }
  }, [chat?.sessionKind?.scenarioId, id, savedStoryReadingPositionForChat?.pinned]);
  useEffect(() => () => {
    if (pendingStoryChoiceVisualTimerRef.current) clearTimeout(pendingStoryChoiceVisualTimerRef.current);
  }, []);
  const aiDirectPerspectiveChar = useMemo(
    () => {
      if (chat?.type !== 'ai_direct') return null;
      const perspectiveId = aiDirectPerspectiveMemberId && aiDirectMemberIds.includes(aiDirectPerspectiveMemberId)
        ? aiDirectPerspectiveMemberId
        : aiDirectMemberIds[0] || null;
      return perspectiveId ? characters.find((c) => c.id === perspectiveId) ?? members.find((member) => member.id === perspectiveId) ?? null : null;
    },
    [aiDirectMemberIds, aiDirectPerspectiveMemberId, characters, chat, members]
  );
  const effectiveAiDirectPerspectiveMemberId = chat?.type === 'ai_direct'
    ? (aiDirectPerspectiveMemberId && aiDirectMemberIds.includes(aiDirectPerspectiveMemberId) ? aiDirectPerspectiveMemberId : aiDirectMemberIds[0] || null)
    : null;
  const effectiveSpeakAsChar = chat?.type === 'ai_direct' ? aiDirectPerspectiveChar : speakAsChar;
  const guideTargetMember = useMemo(
    () => guideTargetMemberId ? characters.find((c) => c.id === guideTargetMemberId) ?? null : null,
    [characters, guideTargetMemberId]
  );

  const openCharacterPreview = useCallback((mention: { id: string; name: string }, anchorEl: HTMLElement) => {
    const character = characters.find((item) => item.id === mention.id && item.deletedAt == null);
    if (!character) {
      setSnackbar({ open: true, message: '这个角色已删除，仅可查看历史消息', severity: 'info' });
      return;
    }
    setProfilePreview({ kind: 'character', anchorRect: anchorEl.getBoundingClientRect(), anchorElement: anchorEl, character });
  }, [characters]);

  const openChatPreview = useCallback((anchorEl: HTMLElement) => {
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    setProfilePreview({ kind: 'chat', anchorRect: anchorEl.getBoundingClientRect(), anchorElement: anchorEl });
  }, [chatInteractionDisabled, chatReadOnlyReason]);
  const {
    actionSchema,
    actionPanelTitle,
    activeSidebarTab,
    composerSurfaces,
    directMemoryPanelContext,
    memberTabTitle,
    privatePayloads,
    projectedActionPanelActions,
    projectedDetailState,
    projectedRuntimeState,
    projectedSidebarChat,
    runtimePanelLoading,
    runtimeTabTitle,
    sessionActions,
    sessionTabTitle,
    showActionTab,
    showMemberTab,
    showRuntimeTab,
    showSessionTab,
    sidebarTitle,
  } = useChatSidebarProjection({
    chat,
    members,
    activeMembers,
    characters,
    currentChatMessages: sidebarMessages,
    rightPanelTab,
    speakAsChar: effectiveSpeakAsChar,
    language: i18n.language,
  });
  const sidebarTabValue = activeSidebarTab === 'actions' ? (showSessionTab ? 'session' : 'activities') : activeSidebarTab;
  const storyRoomOpeningPreview = useMemo(
    () => buildStoryRoomOpeningPreview(chat, members),
    [chat, members],
  );
  const sessionScrollCapabilities = useMemo(
    () => resolveSessionScrollCapabilities({
      sessionKind: chat?.sessionKind,
      explicitContinuationPending: isExplicitContinuationScrollFollowSuspended,
      restoringReaderPosition: hasSavedNonTailStoryReadingPosition && !hasStoryReaderReachedTailIntent,
    }),
    [chat?.sessionKind, hasSavedNonTailStoryReadingPosition, hasStoryReaderReachedTailIntent, isExplicitContinuationScrollFollowSuspended],
  );
  const initialStoryReadingPosition = useMemo<MessageListScrollPosition | null>(() => {
    if (!isStoryRoom || !id) return null;
    const position = entryStoryReadingPosition;
    if (!position) return null;
    return {
      messageId: position.messageId,
      offsetTop: position.offsetTop,
      pinned: position.pinned,
      sourceTimestamp: position.sourceTimestamp,
    };
  }, [entryStoryReadingPosition, id, isStoryRoom]);
  const storyRestoreWindowReady = useMemo(() => {
    if (!isStoryRoom || !initialStoryReadingPosition || initialStoryReadingPosition.pinned) return true;
    const sourceMessageId = getSourceMessageIdFromScrollAnchor(initialStoryReadingPosition.messageId);
    return currentChatMessages.some((message) => (
      message.id === sourceMessageId
      || (
        initialStoryReadingPosition.sourceTimestamp !== undefined
        && message.timestamp === initialStoryReadingPosition.sourceTimestamp
      )
    ));
  }, [currentChatMessages, initialStoryReadingPosition, isStoryRoom]);
  const shouldDelayStoryMessageListForRestore = Boolean(
    isStoryRoom
    && initialStoryReadingPosition
    && !initialStoryReadingPosition.pinned
    && !storyRestoreWindowReady
  );
  useEffect(() => {
    if (!shouldDelayStoryMessageListForRestore || !id || !initialStoryReadingPosition) return;
    logDeveloperDiagnostic('故事阅读恢复：等待恢复窗口', {
      chatId: id,
      messageId: initialStoryReadingPosition.messageId,
      sourceMessageId: getSourceMessageIdFromScrollAnchor(initialStoryReadingPosition.messageId),
      sourceTimestamp: initialStoryReadingPosition.sourceTimestamp,
      currentMessages: currentChatMessages.length,
      firstTimestamp: currentChatMessages[0]?.timestamp,
      lastTimestamp: currentChatMessages.at(-1)?.timestamp,
    }, 'info', 'chat-scroll');
  }, [currentChatMessages, id, initialStoryReadingPosition, shouldDelayStoryMessageListForRestore]);
  const effectiveTextInputCapabilities = useMemo(() => {
    return isStoryRoom && !effectiveSpeakAsChar
      ? buildStoryReaderTextInputCapabilities(textInputCapabilities)
      : textInputCapabilities;
  }, [effectiveSpeakAsChar, isStoryRoom, textInputCapabilities]);
  const effectiveTextInputCapabilityWarning = isStoryRoom && !effectiveSpeakAsChar
    ? undefined
    : textInputCapabilityWarning;
  const storyReaderRole = isStoryRoom ? resolveStoryReaderRole(chat || undefined) : 'director';
  const effectiveComposerSurfaces = useMemo(() => {
    const primaryTextSurface = composerSurfaces.find((surface) => surface.type === 'text') || { key: 'member-guide-text', type: 'text' as const };
    if (guideTargetMember && !effectiveSpeakAsChar) {
      const nextSurface = {
        ...primaryTextSurface,
        key: 'member-guide-text',
        type: 'text' as const,
        mode: 'guide' as const,
        actorId: guideTargetMember.id,
        capability: 'guide' as const,
        placeholder: `安排${guideTargetMember.name}回应、说话或行动`,
      };
      return [nextSurface];
    }
    if (!effectiveSpeakAsChar && isStoryRoom) {
      return [{
        ...primaryTextSurface,
        key: 'story-reader-direction-text',
        type: 'text' as const,
        mode: 'memberSpeak' as const,
        actorId: 'user',
        capability: 'speak' as const,
        placeholder: getStoryReaderComposerPlaceholder(storyReaderRole),
      }];
    }
    if (!effectiveSpeakAsChar && chat?.type === 'group' && chat.memberIds.includes('user')) {
      return [{
        ...primaryTextSurface,
        key: 'member-user-text',
        type: 'text' as const,
        mode: 'memberSpeak' as const,
        actorId: 'user',
        capability: 'speak' as const,
        placeholder: isStoryRoom ? getStoryReaderComposerPlaceholder(storyReaderRole) : '输入消息',
      }];
    }
    if (!effectiveSpeakAsChar && chat?.type === 'direct') {
      return [{
        ...primaryTextSurface,
        key: 'direct-user-text',
        type: 'text' as const,
        mode: 'memberSpeak' as const,
        actorId: 'user',
        capability: 'speak' as const,
        placeholder: '输入消息',
      }];
    }
    if (!effectiveSpeakAsChar && chat?.type === 'assistant') {
      return [{
        ...primaryTextSurface,
        key: 'assistant-user-text',
        type: 'text' as const,
        mode: 'memberSpeak' as const,
        actorId: 'user',
        capability: 'speak' as const,
        placeholder: '向助手提问',
      }];
    }
    if (!effectiveSpeakAsChar && chat?.type === 'ai_direct') {
      return [{
        ...primaryTextSurface,
        key: 'ai-direct-text',
        type: 'text' as const,
        mode: 'memberSpeak' as const,
        actorId: 'user',
        capability: 'speak' as const,
        placeholder: '输入消息',
      }];
    }
    return [primaryTextSurface];
  }, [chat, composerSurfaces, effectiveSpeakAsChar, guideTargetMember, isStoryRoom, storyReaderRole]);
  const handleSidebarTabChange = useCallback((value: SidebarTabValue) => {
    setRightPanelTab(value === 'developer' ? 'developer' : value);
  }, [setRightPanelTab]);
  void dramaBoost;
  void rightPanelOpen;

  useEffect(() => {
    setSidebarMessagesReady(false);
    const scheduler = (window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    }).requestIdleCallback;
    if (typeof scheduler === 'function') {
      const handle = scheduler(() => setSidebarMessagesReady(true), { timeout: 700 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(() => setSidebarMessagesReady(true), 160);
    return () => window.clearTimeout(handle);
  }, [id]);

  useEffect(() => {
    // 窄窗口也使用右侧面板；旧的移动端自动关闭逻辑暂时停用，保留以便后续恢复：
    // if (!isDesktop) setRightPanelOpen(false);
  }, [id, isDesktop, setRightPanelOpen]);

  const showErrorToast = useCallback((message: string) => {
    const normalized = message.trim();
    const imageInputCompatibilityHint = isZh
      ? '当前服务商不兼容图片输入格式。可关闭该模型的图片输入能力，或改用官方支持多模态的模型。'
      : 'Current provider is not compatible with the image input format. Disable image input for this model or switch to an officially supported multimodal model.';
    const corsHint = isZh
      ? '浏览器直连被目标服务的跨域策略拦截。可继续保存配置，正式使用建议走服务端代理。'
      : 'The target service blocked browser-direct requests via CORS. You can still save the config, but production use should go through your server proxy.';
    if (/unknown variant `image_url`|expected `text`/i.test(normalized)) {
      setSnackbar({ open: true, message: imageInputCompatibilityHint, severity: 'error' });
      return;
    }
    if (/failed to fetch|cors/i.test(normalized)) {
      setSnackbar({ open: true, message: corsHint, severity: 'error' });
      return;
    }
    setSnackbar({ open: true, message, severity: 'error' });
  }, [isZh]);

  const handleAddImagesToReference = useCallback((message: Message, attachments: MessageAttachment[]) => {
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    if (!effectiveTextInputCapabilities.imageInput) {
      setSnackbar({ open: true, message: '当前模型未开启图片输入能力', severity: 'error' });
      return;
    }
    const nextAttachments = cloneMessageImagesForComposer(message, attachments);
    if (!nextAttachments.length) return;
    setComposerInjectedAttachments(nextAttachments);
    setSnackbar({
      open: true,
      message: nextAttachments.length > 1 ? `已放入 ${nextAttachments.length} 张参考图` : '已放入参考图',
      severity: 'success',
    });
  }, [chatInteractionDisabled, chatReadOnlyReason, effectiveTextInputCapabilities.imageInput]);

  const closeSnackbar = useCallback(() => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  }, []);

  useEffect(() => {
    isRunningRef.current = isRunning;
    isPausedRef.current = isPaused;
  }, [isPaused, isRunning]);

  useEffect(() => {
    isStoryReaderAtTailRef.current = isStoryReaderAtTail;
  }, [isStoryReaderAtTail]);

  useEffect(() => {
    if (!isRemoteDeletedChat) return;
    pause();
    stop();
  }, [isRemoteDeletedChat, pause, stop]);

  useEffect(() => {
    activeChatIdRef.current = id ?? null;
    loopTokenRef.current = loopToken;
  }, [id, loopToken]);

  const appendEventMessage = useCallback(async (chatId: string, payload: { eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown; visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public'; visibleToIds?: string[]; visibleToRoles?: string[]; createdAt?: number; sourceMessageId?: string }, sourceMessageId?: string) => {
    const targetChat = useChatStore.getState().chats.find((item) => item.id === chatId) || null;
    const eventPayload = normalizeRuntimeEvent(targetChat ? buildPrivateSessionEvent(targetChat, payload) : payload);
    const eventMessage = {
      chatId,
      type: 'event' as const,
      senderId: 'system',
      senderName: 'System',
      content: buildRuntimeEventMessageContent({
        ...eventPayload,
        sourceMessageId: eventPayload.sourceMessageId || sourceMessageId,
      }),
      emotion: 0,
      timestamp: eventPayload.createdAt,
    };
    const { timestamp: eventTimestamp, ...persistedEventMessage } = eventMessage;
    await persistLocalFirstMessage({
      upsertMessage,
      timestamp: eventTimestamp,
      message: persistedEventMessage,
    });
  }, [chat, chats, currentChatMessages, upsertMessage]);

  const appendEventMessages = useCallback(async (chatId: string, payloads: Array<{ eventType: string; title: string; summary: string; pair?: [string, string]; metrics?: unknown; visibilityScope?: 'public' | 'role_private' | 'moderator_only' | 'pair_private' | 'derived_public'; visibleToIds?: string[]; visibleToRoles?: string[]; createdAt?: number; sourceMessageId?: string }>, sourceMessageId?: string) => {
    if (!payloads.length) return;
    const targetChat = useChatStore.getState().chats.find((item) => item.id === chatId) || null;
    await persistLocalFirstMessages({
      upsertMessages,
      deferLocalUpsert: true,
      messages: payloads.map((payload, index) => {
        const eventPayload = normalizeRuntimeEvent(targetChat ? buildPrivateSessionEvent(targetChat, payload) : payload);
        const createdAt = eventPayload.createdAt ?? Date.now() + index;
        const message = {
          timestamp: createdAt,
          chatId,
          type: 'event' as const,
          senderId: 'system',
          senderName: 'System',
          content: buildRuntimeEventMessageContent({
            ...eventPayload,
            createdAt,
            sourceMessageId: eventPayload.sourceMessageId || sourceMessageId,
          }),
          emotion: 0,
        };
        const { timestamp, ...persistedMessage } = message;
        return {
          timestamp,
          message: persistedMessage,
        };
      }),
    });
  }, [chat, chats, currentChatMessages, upsertMessages]);

  const addAnchoredMessage = useCallback(async (message: Omit<Message, 'id' | 'timestamp' | 'isDeleted'> & { timestamp?: number }) => {
    const liveChat = useChatStore.getState().chats.find((item) => item.id === message.chatId);
    const messageState = useMessageStore.getState();
    const liveMessages = projectMergedChatMessages({
      chatId: message.chatId,
      activeMessages: messageState.messages.filter((item) => item.chatId === message.chatId),
      cachedWindow: messageState.messageWindowsByChatId[message.chatId]
        ? { ...messageState.messageWindowsByChatId[message.chatId], preserveBranchContext: Boolean(liveChat && isMessageBranchingEnabled(liveChat)) }
        : undefined,
    });
    const anchoredMessage = liveChat
      ? attachMessageToActiveBranch(liveChat, liveMessages, message)
      : message;
    const created = await addMessage(anchoredMessage as Parameters<typeof addMessage>[0]);
    if (liveChat && created && isMessageBranchingEnabled(liveChat)) {
      const nodeId = created.metadata?.branching?.nodeId || created.clientKey || created.id;
      const latestChat = useChatStore.getState().chats.find((item) => item.id === message.chatId) || liveChat;
      await updateChat(liveChat.id, { messageBranchState: buildBranchStateWithHead(latestChat.messageBranchState, nodeId) });
    }
    return created;
  }, [addMessage, updateChat]);

  const upsertMessageStable = useCallback((message: Message) => {
    upsertMessageWithLiveReveal(message);
  }, [upsertMessageWithLiveReveal]);

  const appendEventMessageStable = appendEventMessage;
  const appendEventMessagesStable = appendEventMessages;

  const appendMembershipNotice = useCallback(async (content: string) => {
    if (!chat || !id) return;
    await useMessageStore.getState().addMessage({
      chatId: id,
      type: 'system',
      senderId: 'system',
      senderName: 'System',
      content,
      emotion: 0,
      timestamp: Date.now(),
    });
  }, [chat, id]);
  const addMessageStable = addAnchoredMessage;
  const getNextMessageTimestamp = useCallback(() => {
    const latestTimestamp = currentChatMessages.reduce((latest, message) => Math.max(latest, Number(message.timestamp || 0)), 0);
    return Math.max(Date.now(), latestTimestamp + 1);
  }, [currentChatMessages]);

  const appendLocalInterceptionHint = useCallback(async (event: LocalInterceptionEvent) => {
    if (!chat?.id || !showLocalInterceptionHints) return;
    await appendEventMessageStable(chat.id, {
      eventType: 'local_interception',
      title: '提示：本地拦截',
      summary: buildLocalInterceptionSummary(event),
      visibilityScope: 'moderator_only',
      metrics: {
        kind: event.kind,
        speakerId: event.speakerId,
        speakerName: event.speakerName,
        reason: event.reason,
        attempt: event.attempt,
      },
    });
  }, [appendEventMessageStable, chat?.id, showLocalInterceptionHints]);

  const handleStartDirectChat = useCallback(async (characterId: string) => {
    const character = characters.find((item) => item.id === characterId);
    if (!character) {
      setSnackbar({ open: true, message: '角色已不存在，无法发消息', severity: 'error' });
      return false;
    }
    try {
      const { ensureCharacterDirectChat } = await import('../services/directChatCreation');
      const directChatId = await ensureCharacterDirectChat(character.id);
      navigate(`/chats/${directChatId}?fromTab=1`);
      return true;
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : t('common.error'), severity: 'error' });
      return false;
    }
  }, [characters, navigate, t]);

  const {
    thinkingId,
    chatError,
    runLoopError,
    isWaitingForInput,
    hasPendingTurnWork,
    startConversationLoopIfNeeded,
    cancelActiveConversationLoop,
    resetRunLoopUiState,
  } = useChatRunLoop({
    chat,
    chatId: id,
    activeMembers,
    api,
    aiProfiles,
    isRunningRef,
    isPausedRef,
    loopTokenRef,
    activeChatIdRef,
    streamingMessageRef,
    getDisplayedStreamingMessage,
    freezeStreamingDisplay,
    updateStreamingMessage,
    onLocalInterception: appendLocalInterceptionHint,
    discardStreamingMessage,
    clearStreamingMessageRef,
    isManualInputPending: () => isManualInputPendingRef.current(),
    isStoryReaderAtTail: () => isStoryReaderAtTailRef.current,
    setCurrentSpeaker,
    resetAllCooldowns,
    start,
    stop,
    pause,
    updateChat,
    showErrorToast,
    t,
    upsertMessage: upsertMessageStable,
    updateCharacter,
    updateCharacters,
    appendEventMessage: appendEventMessageStable,
    appendEventMessages: appendEventMessagesStable,
    applyChatRuntimeDelta,
    recordSpeak,
    getUserDraftActivity: () => userDraftActivityRef.current,
  });
  const { enqueueManualInput, isManualInputPending } = useManualInputQueue({
    isRunningRef,
    isPausedRef,
    hasPendingTurnWork,
    pause,
  });
  isManualInputPendingRef.current = isManualInputPending;

  const startInitialConversationOpening = useCallback(() => {
    // Do not infer an empty/new conversation while the detail bootstrap or
    // message window is still being restored. Existing rooms otherwise race
    // the remote load and can incorrectly start a fresh opening turn.
    if (!chat || !id || chatInteractionDisabled || isStoryRoom || !detailBootstrapComplete || isLoading) return;
    const conversationTurnCount = currentChatMessages.filter((message) => message.type === 'user' || message.type === 'ai').length;
    if (conversationTurnCount > 0) {
      const hasStreamingTurn = currentChatMessages.some((message) => message.isStreaming);
      openingMessageCountRef.current = conversationTurnCount;
      // Keep the single-flight opening guard while the first AI node is still
      // streaming. The placeholder already counts as an AI turn, and clearing
      // the guard at that point lets a transient isRunning=false render start
      // a second loop, producing an empty sibling (1/2).
      if (!hasStreamingTurn) openingSuppressedRef.current = false;
      return;
    }
    if (openingMessageCountRef.current > 0) {
      openingMessageCountRef.current = 0;
      openingSuppressedRef.current = false;
    }
    if (openingSuppressedRef.current) return;
    if (isRunning || isDirectReplyPending) return;
    // React effects can re-run while the opening turn is being scheduled
    // (notably after clearing history and seeding the topic guide). Keep the
    // single-flight guard local to this page so two opening loops cannot create
    // sibling AI nodes from the same empty conversation.
    if (openingLoopRef.current) return;
    // Direct chats are request/response conversations. During auth and
    // message-window hydration they can temporarily project as empty; never
    // treat that transient state as a brand-new conversation opening.
    if (chat.type === 'assistant' || chat.type === 'direct') return;
    openingLoopRef.current = true;
    resume();
    startConversationLoopIfNeeded(chat, { immediate: true });
  }, [chat, chatInteractionDisabled, currentChatMessages, detailBootstrapComplete, id, isDirectReplyPending, isLoading, isRunning, isStoryRoom, resume, startConversationLoopIfNeeded]);

  // Creation, initial loading, and clearing history all converge here: when
  // the projected conversation becomes empty, this single entry starts the
  // optional AI opening turn.
  useEffect(() => {
    startInitialConversationOpening();
  }, [startInitialConversationOpening]);

  const commitPersistedManualRuntime = useCallback(async (message: Message, recentMessages: Message[]) => {
    if (!chat || !id) return;
    const runtimeChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
    const [{ runPersistedSessionCommitRuntime }, { resolveSessionEngine }] = await Promise.all([
      import('../services/sessionCommitPipeline'),
      import('../services/sessionEngineRegistry'),
    ]);
    const sessionEngine = resolveSessionEngine(runtimeChat);
    await runPersistedSessionCommitRuntime({
      api,
      chatId: id,
      chat: runtimeChat,
      characters,
      message,
      currentMessages: recentMessages,
      onCommit: async (args) => await (sessionEngine.onMessageCommitted as (commitArgs: {
        conversation: GroupChat;
        characters: typeof characters;
        message: Pick<Message, 'content' | 'type' | 'senderId'>;
        previousAiMessage: Pick<Message, 'senderId'> | null;
        recentMessages?: Message[];
        apiConfig?: typeof api;
      }) => DriverMessageCommitResult | Promise<DriverMessageCommitResult>)(args),
      updateCharacter,
      updateCharacters: async (patches) => updateCharacters(patches.map((patch) => ({ id: patch.id, updates: patch.patch }))),
      appendEventMessage: appendEventMessageStable,
      appendEventMessages: appendEventMessagesStable,
      updateChat,
      applyChatRuntimeDelta,
      recordSpeak,
      getCurrentChat: (chatId) => useChatStore.getState().chats.find((item) => item.id === chatId),
      getCurrentCharacters: () => useCharacterStore.getState().characters,
    });
  }, [api, appendEventMessageStable, appendEventMessagesStable, applyChatRuntimeDelta, characters, chat, id, recordSpeak, updateCharacter, updateCharacters, updateChat]);

  const handleCreateMessageRevision = useCallback(async (sourceMessage: Message, nextContent: string) => {
    if (!chat || !id || !isMessageBranchingEnabled(chat)) return;
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    const trimmedContent = nextContent.trim();
    if (!trimmedContent) return;
    cancelReplyOperation();

    await enqueueManualInput(async () => {
      const cancelledRunningLoop = isRunningRef.current;
      if (cancelledRunningLoop) cancelActiveConversationLoop('message_revision_created');
      const scrollRestoreRequest = captureMessageListScrollRequest('branch-create', sourceMessage.id);
      const sourceNode = resolveMessageBranchNodes(currentChatAllMessages)
        .find((node) => node.message.id === sourceMessage.id || node.nodeId === sourceMessage.id);
      if (!sourceNode) return;

      const revisionDraft = createMessageRevisionDraft({
        sourceMessage,
        parentNodeId: sourceNode.parentNodeId,
        content: trimmedContent,
        timestamp: getNextMessageTimestamp(),
      });
      const createdRevision = await addAnchoredMessage(revisionDraft);
      const revisionNodeId = createdRevision.metadata?.branching?.nodeId || createdRevision.id;
      const activeBranchName = chat.messageBranchState?.activeBranchName || 'main';
      const currentHeadNodeId = chat.messageBranchState?.refs?.[activeBranchName]?.headNodeId
        || currentChatMessages.at(-1)?.metadata?.branching?.nodeId
        || currentChatMessages.at(-1)?.id
        || null;
      const preservedState = currentHeadNodeId && currentHeadNodeId !== sourceNode.parentNodeId
        ? forkBranchState(chat.messageBranchState, currentHeadNodeId, `${activeBranchName}-before-edit-${Date.now()}`)
        : chat.messageBranchState;
      const nextBranchState: MessageBranchState = buildBranchStateWithHead(preservedState, revisionNodeId, activeBranchName);
      const nextChat: GroupChat = {
        ...chat,
        messageBranchState: nextBranchState,
        lastMessageAt: createdRevision.timestamp,
        latestMessage: createdRevision,
      };
      const nextAllMessages = [
        ...currentChatAllMessages.filter((message) => message.id !== createdRevision.id),
        createdRevision,
      ];
      const activeMessagesAfterRevision = projectActiveBranchMessages(nextChat, nextAllMessages);

      await updateChat(id, {
        messageBranchState: nextBranchState,
        lastMessageAt: createdRevision.timestamp,
        latestMessage: createdRevision,
      });
      if (scrollRestoreRequest) {
        setMessageScrollRequest({
          ...scrollRestoreRequest,
          key: `branch-create:${createdRevision.id}:${Date.now()}`,
          messageId: createdRevision.id,
          sourceTimestamp: createdRevision.timestamp,
        });
      }
      if (chat.type === 'direct' && createdRevision.type === 'user') {
        const { controller: directReplyAbortController, epoch: directReplyEpoch } = beginReplyOperation();
        const shouldContinueDirectRevision = () => {
          if (directReplyAbortController.signal.aborted) return false;
          if (directReplyEpochRef.current !== directReplyEpoch) return false;
          const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || nextChat;
          if (latestChat.messageBranchState?.activeLeafNodeId !== revisionNodeId) return false;
          const messageState = useMessageStore.getState();
          const latestMessages = projectMergedChatMessages({
            chatId: id,
            activeMessages: messageState.messages,
            cachedWindow: messageState.messageWindowsByChatId[id],
          });
          return projectActiveBranchMessages(latestChat, latestMessages).some((message) => message.id === createdRevision.id);
        };
        void (async () => {
          try {
            const { runDirectUserReplyFlow } = await import('../services/directUserReplyFlow');
            await runDirectUserReplyFlow({
              api,
              aiProfiles,
              chatId: id,
              chat: nextChat,
              userMessage: createdRevision,
              content: trimmedContent,
              characters,
              updateCharacter,
              updateCharacters,
              upsertMessage: upsertMessageStable,
              appendEventMessage: appendEventMessageStable,
              appendEventMessages: appendEventMessagesStable,
              updateChat,
              applyChatRuntimeDelta,
              recordSpeak,
              onLocalInterception: appendLocalInterceptionHint,
              signal: directReplyAbortController.signal,
              shouldContinue: shouldContinueDirectRevision,
              deferRuntimePersistenceUntilCommit: true,
            });
          } catch (error) {
            if (!isGenerationCancelledError(error)) {
              console.error('[direct-reply:revision-error]', error);
              showErrorToast(error instanceof Error ? error.message : String(error));
            }
          } finally {
            finishReplyOperation(directReplyAbortController);
          }
        })();
      } else if (chat.type === 'assistant' && createdRevision.type === 'user') {
        const { controller: assistantReplyAbortController, epoch: directReplyEpoch } = beginReplyOperation();
        const shouldContinueAssistantRevision = () => {
          if (assistantReplyAbortController.signal.aborted) return false;
          if (directReplyEpochRef.current !== directReplyEpoch) return false;
          const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || nextChat;
          if (latestChat.messageBranchState?.activeLeafNodeId !== revisionNodeId) return false;
          const messageState = useMessageStore.getState();
          const latestMessages = projectMergedChatMessages({
            chatId: id,
            activeMessages: messageState.messages,
            cachedWindow: messageState.messageWindowsByChatId[id],
          });
          return projectActiveBranchMessages(latestChat, latestMessages).some((message) => message.id === createdRevision.id);
        };
        void (async () => {
          try {
            const { runAssistantChatReplyFlow } = await import('../services/assistantChatFlow');
            await runAssistantChatReplyFlow({
              api,
              aiProfiles,
              chatId: id,
              chat: nextChat,
              currentMessages: activeMessagesAfterRevision,
              selectedArtifactId: selectedAssistantArtifactId,
              timestamp: createdRevision.timestamp + 1,
              upsertMessage: upsertMessageStable,
              updateChat,
              signal: assistantReplyAbortController.signal,
              shouldContinue: shouldContinueAssistantRevision,
            });
          } catch (error) {
            if (!isGenerationCancelledError(error)) {
              console.error('[assistant-reply:revision-error]', error);
              showErrorToast(error instanceof Error ? error.message : String(error));
            }
          } finally {
            finishReplyOperation(assistantReplyAbortController);
          }
        })();
      } else if (createdRevision.type === 'user' || createdRevision.type === 'god') {
        try {
          await commitPersistedManualRuntime(createdRevision, activeMessagesAfterRevision);
        } catch (error) {
          // Runtime persistence (especially cloud sync) must not prevent the
          // local branch from continuing to the next AI turn.
          logDeveloperDiagnostic('chat-branch:runtime-commit-failed', {
            chatId: id,
            error: error instanceof Error ? error.message : String(error),
          }, 'warn', 'chat-run');
        }
      }
      if (cancelledRunningLoop) {
        setSnackbar({ open: true, message: '已切换到新分支，当前生成已重启', severity: 'success' });
      }
      const learningHtmlRevisionRequest = (chat.mode === 'classroom'
        || chat.sessionKind?.family === 'study'
        || chat.sessionKind?.scenarioId === 'learning-progress'
        || chat.sessionKind?.scenarioId === 'ielts-coach')
        && /html|网页|交互页面|可作答.*页面/i.test(trimmedContent)
        && createdRevision.type === 'user'
        && chat.type !== 'assistant' && chat.type !== 'direct';
      if (learningHtmlRevisionRequest) {
        const { controller, epoch } = beginReplyOperation();
        const teacher = characters.find((character) => chat.memberIds.includes(character.id));
        void import('../services/assistantChatFlow').then(({ runAssistantChatReplyFlow }) => runAssistantChatReplyFlow({
          api,
          aiProfiles,
          chat: nextChat,
          chatId: id,
          currentMessages: activeMessagesAfterRevision,
          selectedArtifactId: selectedAssistantArtifactId,
          timestamp: createdRevision.timestamp + 1,
          upsertMessage: upsertMessageStable,
          updateChat,
          replySender: teacher ? { id: teacher.id, name: teacher.name } : undefined,
          forceArtifact: true,
          signal: controller.signal,
          shouldContinue: () => !controller.signal.aborted && directReplyEpochRef.current === epoch,
        })).catch((error) => {
          if (!isGenerationCancelledError(error)) {
            console.error('[learning-reply:revision-error]', error);
            showErrorToast(error instanceof Error ? error.message : String(error));
          }
        })
          .finally(() => finishReplyOperation(controller));
      }
      if (!learningHtmlRevisionRequest && chat.type !== 'direct' && chat.type !== 'assistant') {
        const startStateMessages = projectActiveBranchMessages(nextChat, useMessageStore.getState().messages.filter((message) => message.chatId === id));
        logDeveloperDiagnostic('chat-branch:ai-start-state', {
          chatId: id,
          createdRevisionId: createdRevision.id,
          createdRevisionType: createdRevision.type,
          projectedCount: startStateMessages.length,
          projectedTailType: startStateMessages.at(-1)?.type || null,
          projectedTailId: startStateMessages.at(-1)?.id || null,
        }, 'info', 'chat-run');
        const startBlockReason = startConversationLoopIfNeeded(nextChat, { immediate: true });
        if (startBlockReason) {
          logDeveloperDiagnostic('chat-branch:ai-start-blocked', {
            chatId: id,
            reason: startBlockReason,
          }, 'warn', 'chat-run');
        }
      }
    });
  }, [beginReplyOperation, cancelReplyOperation, directReplyEpochRef, finishReplyOperation, currentChatMessages, addAnchoredMessage, aiProfiles, api, appendEventMessage, appendEventMessageStable, appendEventMessagesStable, appendLocalInterceptionHint, applyChatRuntimeDelta, cancelActiveConversationLoop, characters, chat, chatInteractionDisabled, chatReadOnlyReason, chats, commitPersistedManualRuntime, currentChatAllMessages, enqueueManualInput, getNextMessageTimestamp, id, recordSpeak, selectedAssistantArtifactId, setSnackbar, showErrorToast, startConversationLoopIfNeeded, updateCharacter, updateCharacters, updateChat, upsertMessageStable]);

  const handleRegenerateAssistant = useCallback(async (sourceMessage: Message) => {
    if (!chat || !id || !isMessageBranchingEnabled(chat) || sourceMessage.type !== 'ai') return;
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    const { controller, epoch } = beginReplyOperation();
    const shouldResume = (regenerationResumeRef.current?.epoch === epoch - 1 && regenerationResumeRef.current.shouldResume)
      || (isRunningRef.current && !isPausedRef.current);
    regenerationResumeRef.current = { epoch, shouldResume };
    // Rewinding to an empty branch must not trigger a new-room opening on failure.
    openingLoopRef.current = true;
    const shouldContinue = () => !controller.signal.aborted && directReplyEpochRef.current === epoch;
    try {
      await runInterruptedManualInput({
        enqueueManualInput,
        interrupt: () => {
          if (isRunningRef.current) cancelActiveConversationLoop('message_regenerate');
        },
        shouldContinue,
        resumeOnCompleted: shouldResume,
        task: async () => {
          const sourceNode = resolveMessageBranchNodes(currentChatAllMessages)
            .find((node) => node.message.id === sourceMessage.id || node.nodeId === sourceMessage.id);
          if (!sourceNode) return;
          const activeMessages = projectActiveBranchMessages(chat, currentChatAllMessages);
          const sourceIndex = activeMessages.findIndex((message) => message.id === sourceMessage.id);
          const contextMessages = sourceIndex >= 0 ? activeMessages.slice(0, sourceIndex) : activeMessages;
          const state = chat.messageBranchState;
          const activeName = state?.activeBranchName || 'main';
          const activeRefHead = state?.refs?.[activeName]?.headNodeId || activeMessages.at(-1)?.metadata?.branching?.nodeId || activeMessages.at(-1)?.id || null;
          let nextState = state;
          if (activeRefHead && activeRefHead !== sourceNode.parentNodeId) {
            nextState = forkBranchState(nextState, activeRefHead, `${activeName}-before-regenerate-${Date.now()}`);
          }
          nextState = buildBranchStateWithHead(nextState, sourceNode.parentNodeId, activeName);
          const nextChat: GroupChat = { ...chat, messageBranchState: nextState };
          await updateChat(id, { messageBranchState: nextState });
          if (!shouldContinue()) return;
          const { runAssistantChatReplyFlow } = await import('../services/assistantChatFlow');
          const regenerated = await runAssistantChatReplyFlow({
            api,
            aiProfiles,
            chatId: id,
            chat: nextChat,
            currentMessages: contextMessages,
            selectedArtifactId: selectedAssistantArtifactId,
            timestamp: getNextMessageTimestamp(),
            upsertMessage: upsertMessageStable,
            updateChat,
            signal: controller.signal,
            replySender: { id: sourceMessage.senderId, name: sourceMessage.senderName },
            revisionOfNodeId: sourceNode.nodeId,
            shouldContinue,
          });
          if (!shouldContinue()) return;
          const regeneratedNodeId = regenerated.metadata?.branching?.nodeId || regenerated.clientKey || regenerated.id;
          const branchUpdates: Partial<GroupChat> = {
            messageBranchState: buildBranchStateWithHead(nextState, regeneratedNodeId, activeName),
            lastMessageAt: regenerated.timestamp,
            latestMessage: regenerated,
          };
          await updateChat(id, branchUpdates);
          if (!shouldContinue()) return;
          setSnackbar({ open: true, message: '已重新回答', severity: 'success' });
          return { ...nextChat, ...branchUpdates };
        },
        onCompleted: (nextChat) => {
          const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || nextChat;
          const blockReason = startConversationLoopIfNeeded(latestChat, { immediate: true });
          if (blockReason === 'waiting_story_choice') {
            setSnackbar({ open: true, message: '已重新回答，请先选择一个剧情走向', severity: 'info' });
          }
        },
      });
    } catch (error) {
      if (shouldContinue() && !isGenerationCancelledError(error)) showErrorToast(error instanceof Error ? error.message : String(error));
    } finally {
      if (directReplyEpochRef.current === epoch) {
        regenerationResumeRef.current = null;
      }
      finishReplyOperation(controller);
    }
  }, [beginReplyOperation, directReplyEpochRef, finishReplyOperation, aiProfiles, api, chat, chatInteractionDisabled, chatReadOnlyReason, currentChatAllMessages, enqueueManualInput, getNextMessageTimestamp, id, selectedAssistantArtifactId, setSnackbar, showErrorToast, cancelActiveConversationLoop, startConversationLoopIfNeeded, updateChat, upsertMessageStable]);

  const handleSwitchMessageRevision = useCallback(async (sourceMessage: Message, direction: -1 | 1) => {
    // A streaming placeholder is not a revision yet. It must be finalized
    // before branch navigation is exposed; otherwise cancelling it can leave
    // a second sibling ref and make the next generated answer look like a
    // third branch.
    if (!chat || !id || !isMessageBranchingEnabled(chat) || sourceMessage.isStreaming) return;
    cancelReplyOperation();
    const cancelledRunningLoop = isRunningRef.current;
    if (cancelledRunningLoop) cancelActiveConversationLoop('message_revision_switched');
    const scrollRestoreRequest = captureMessageListScrollRequest('branch-switch', sourceMessage.id);
    const group = getBranchRevisionGroup(currentChatAllMessages, sourceMessage.id);
    const sourceKeys = new Set([sourceMessage.id, sourceMessage.clientKey, sourceMessage.serverId].filter(Boolean));
    const currentIndex = group.findIndex((message) => [message.id, message.clientKey, message.serverId].some((key) => key && sourceKeys.has(key)));
    const target = group[currentIndex + direction];
    if (!target) {
      logDeveloperDiagnostic('chat-branch:switch-missing-target', {
        chatId: id,
        direction,
        sourceId: sourceMessage.id,
        sourceClientKey: sourceMessage.clientKey || null,
        groupSize: group.length,
        currentIndex,
      }, 'warn', 'message-window');
      return;
    }
    const targetNode = resolveMessageBranchNodes(currentChatAllMessages)
      .find((node) => node.message.id === target.id || node.nodeId === target.id);
    if (!targetNode) return;

    const targetNodeId = targetNode.nodeId || target.id;
    const allNodes = resolveMessageBranchNodes(currentChatAllMessages);
    const nodeById = new Map(allNodes.map((node) => [node.nodeId, node]));
    const isDescendantOfTarget = (node: typeof targetNode) => {
      let cursor = node.parentNodeId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === targetNodeId) return true;
        seen.add(cursor);
        cursor = nodeById.get(cursor)?.parentNodeId || null;
      }
      return false;
    };
    const branchTail = allNodes
      .filter((node) => node.nodeId === targetNodeId || isDescendantOfTarget(node))
      .sort((left, right) => (right.sequence - left.sequence) || (right.message.timestamp - left.message.timestamp))[0];
    const activeHeadId = branchTail?.nodeId || targetNodeId;
    const nextBranchState: MessageBranchState = buildBranchStateWithHead(chat.messageBranchState, activeHeadId);
    const nextChat: GroupChat = {
      ...chat,
      messageBranchState: nextBranchState,
    };
    const activeBranchMessages = projectActiveBranchMessages(nextChat, currentChatAllMessages);
    const activeTail = activeBranchMessages.at(-1);
    const activePreviewTail = getLatestChatPreviewMessage(activeBranchMessages);
    // Branch switching is a local projection change first. Do not block the
    // message list/scroll feedback on cloud persistence or workspace hooks.
    // Branch projection must update the local store synchronously. `updateChat`
    // waits for cloud-sync preparation before applying the local chat patch,
    // which leaves MessageList rendering the old branch for ~1s and then
    // causes a late 18 -> 30 item jump. queuePatch applies locally first and
    // flushes to the cloud asynchronously.
    void useChatStore.getState().syncPatch(id, {
      messageBranchState: {
        ...nextBranchState,
        activeLeafNodeId: activeTail?.metadata?.branching?.nodeId || activeTail?.id || targetNodeId,
      },
      ...(activePreviewTail ? {
        lastMessageAt: activePreviewTail.timestamp,
        latestMessage: activePreviewTail,
      } : {}),
    }).catch((error) => {
      showErrorToast(error instanceof Error ? error.message : '分支状态保存失败');
    });
    if (scrollRestoreRequest) {
      setMessageScrollRequest({
        ...scrollRestoreRequest,
        key: `branch-switch:${target.id}:${Date.now()}`,
        messageId: target.id,
        sourceTimestamp: target.timestamp,
      });
    }
    if (cancelledRunningLoop) {
      setSnackbar({ open: true, message: '已切换分支，当前生成已停止', severity: 'success' });
    }
  }, [cancelReplyOperation, cancelActiveConversationLoop, chat, currentChatAllMessages, id, setSnackbar, showErrorToast]);

  useEffect(() => {
    if (!chatInteractionDisabled) return;
    cancelReplyOperation();
    if (isRunningRef.current) cancelActiveConversationLoop('chat_read_only');
  }, [cancelReplyOperation, cancelActiveConversationLoop, chatInteractionDisabled]);

  useEffect(() => {
    if (id) {
      // Message history is independently addressable by chat id. Do not block
      // loading it while the chat summary/detail is still restoring or the
      // cloud detail request is temporarily unavailable.
      if (isStoryRoom && !chat) {
        logDeveloperDiagnostic('chat-detail:open-window:blocked', {
          chatId: id,
          reason: 'story-chat-not-loaded',
          chatsInStore: chats.length,
          chatsLoading,
          detailBootstrapComplete,
        }, 'warn', 'chat-page');
        return;
      }
      if (isStoryRoom && !uiHydrated) {
        logDeveloperDiagnostic('chat-detail:open-window:blocked', {
          chatId: id,
          reason: 'story-ui-not-hydrated',
        }, 'debug', 'chat-page');
        return;
      }
      const restorePosition = isStoryRoom ? entryStoryReadingPosition : initialChatNavigationPosition;
      const aroundTimestamp = restorePosition && !restorePosition.pinned
        ? restorePosition.sourceTimestamp
        : undefined;
      const requestKey = aroundTimestamp !== undefined
        ? `restore:${isStoryRoom ? storyReadingRestoreKey : restorePosition?.messageId}`
        : 'tail';
      const cloudMode = authMode === 'cloud' && isLoggedIn;
      const previousOpen = openedChatWindowRef.current;
      if (previousOpen?.chatId === id && previousOpen.requestKey === requestKey && previousOpen.cloudMode === cloudMode) {
        logDeveloperDiagnostic('chat-detail:open-window:skip-duplicate', {
          chatId: id,
          requestKey,
          cloudMode,
        }, 'debug', 'chat-page');
        if (isStoryRoom) {
          logDeveloperDiagnostic('故事阅读恢复：跳过重复打开窗口', {
            chatId: id,
            existingRequestKey: previousOpen.requestKey,
            nextRequestKey: requestKey,
            savedPosition: entryStoryReadingPosition ? {
              messageId: entryStoryReadingPosition.messageId,
              offsetTop: entryStoryReadingPosition.offsetTop,
              pinned: entryStoryReadingPosition.pinned,
              sourceTimestamp: entryStoryReadingPosition.sourceTimestamp,
            } : null,
          }, 'debug', 'chat-scroll');
        }
        return;
      }
      openedChatWindowRef.current = {
        chatId: id,
        requestKey,
        openedAt: Date.now(),
        restored: requestKey !== 'tail',
        cloudMode,
      };
      if (isStoryRoom) {
        logDeveloperDiagnostic('故事阅读恢复：打开消息窗口', {
          chatId: id,
          requestKey,
          savedPosition: entryStoryReadingPosition ? {
            messageId: entryStoryReadingPosition.messageId,
            offsetTop: entryStoryReadingPosition.offsetTop,
            pinned: entryStoryReadingPosition.pinned,
            sourceTimestamp: entryStoryReadingPosition.sourceTimestamp,
          } : null,
          aroundTimestamp,
        }, 'info', 'chat-scroll');
      }
      logDeveloperDiagnostic('chat-window:open', {
        chatId: id,
        isStoryRoom: chat?.sessionKind?.scenarioId === 'story-reader',
        requestKey,
        savedPosition: entryStoryReadingPosition ? {
          messageId: entryStoryReadingPosition.messageId,
          offsetTop: entryStoryReadingPosition.offsetTop,
          pinned: entryStoryReadingPosition.pinned,
          sourceTimestamp: entryStoryReadingPosition.sourceTimestamp,
        } : null,
        aroundTimestamp,
      }, 'info');
      void openChatWindow(id, {
        limit: CHAT_MESSAGE_WINDOW_SIZE,
        revalidate: true,
        aroundTimestamp,
      });
    }
  }, [authMode, chat, chats.length, chatsLoading, detailBootstrapComplete, entryStoryReadingPosition, id, initialChatNavigationPosition, isLoggedIn, isStoryRoom, openChatWindow, storyReadingRestoreKey, uiHydrated]);

  useEffect(() => {
    userDraftActivityRef.current = null;
    setHasStoryUserDraft(false);
    setIsStoryGenerationCancelled(false);
    setIsExplicitContinuationScrollFollowSuspended(false);
  }, [id, isStoryRoom]);

  useEffect(() => {
    if (!chatInteractionDisabled) {
      setReadOnlyEmphasis(false);
      return undefined;
    }
    setReadOnlyEmphasis(true);
    const timer = window.setTimeout(() => setReadOnlyEmphasis(false), 3000);
    return () => window.clearTimeout(timer);
  }, [chatInteractionDisabled, id, chatReadOnlyReason]);

  const handleOpenAssistantArtifact = useCallback((artifactId: string) => {
    setSelectedAssistantArtifactId(artifactId);
    setRightPanelOpen(true);
  }, [setRightPanelOpen]);

  const handleOpenAssistantHtmlFullscreen = useCallback((artifactId: string) => {
    logDeveloperDiagnostic('html-artifact:open-request', { chatId: id, artifactId, capability: chat ? hasRoomCapability(chat, 'html-interactive') : false }, 'info', 'chat-window');
    setFullscreenAssistantArtifactId(artifactId);
  }, [chat, id]);

  const handleCloseAssistantHtmlFullscreen = useCallback(() => {
    setFullscreenAssistantArtifactId(null);
  }, []);

  const handleHtmlAutosave = useCallback((input: AssistantHtmlInteractionPayload) => {
    useAssistantArtifactStore.getState().saveHtmlInteractionState({
      artifactId: input.artifactId,
      baseVersionId: input.baseVersionId,
      interactionState: input.payload,
    });
  }, []);

  const runHtmlRepairReply = useCallback(async (request: Omit<HtmlRepairRetryState, 'message'>, messageContext: Message[]) => {
    if (!chat || !id || request.chatId !== id || chat.type !== 'assistant' || chatInteractionDisabled) return;
    const artifact = useAssistantArtifactStore.getState().items.find((item) => item.id === request.artifactId && item.kind === 'html' && item.deletedAt == null);
    if (!artifact) {
      setHtmlRepairRetry({ ...request, message: '需要修复的页面已不存在。' });
      return;
    }
    setSelectedAssistantArtifactId(artifact.id);
    const { controller, epoch } = beginReplyOperation();
    try {
      const { runAssistantChatReplyFlow } = await import('../services/assistantChatFlow');
      const currentMessages = messageContext.some((message) => message.id === request.userMessage.id)
        ? messageContext
        : [...messageContext, request.userMessage];
      await runAssistantChatReplyFlow({
        api, aiProfiles, chatId: id, chat, currentMessages,
        selectedArtifactId: artifact.id, timestamp: request.userMessage.timestamp + 1,
        upsertMessage: upsertMessageStable, updateChat,
        signal: controller.signal,
        shouldContinue: () => !controller.signal.aborted && directReplyEpochRef.current === epoch,
      });
      setHtmlRepairRetry(null);
    } catch (error) {
      if (!isGenerationCancelledError(error)) {
        const isFormatError = error instanceof Error && error.name === 'AssistantAgentFormatError';
        if (!isFormatError) {
          logDeveloperDiagnostic('html-artifact:repair-failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }, 'error', 'chat-window');
        }
        const message = isFormatError
          ? 'Agent 返回的页面更新格式不正确，原页面未修改。'
          : '页面修复未完成，原页面未修改。';
        setHtmlRepairRetry({ ...request, message });
      }
    } finally {
      finishReplyOperation(controller);
    }
  }, [beginReplyOperation, directReplyEpochRef, finishReplyOperation, aiProfiles, api, chat, chatInteractionDisabled, id, updateChat, upsertMessageStable]);

  const handleHtmlRepair = useCallback(async (runtimeError: AssistantHtmlRuntimeError) => {
    if (!chat || !id || chat.type !== 'assistant' || chatInteractionDisabled) return;
    if (runtimeError.kind === 'page_state') {
      showErrorToast('页面只显示了失败状态，但没有上报具体异常，暂时无法自动修复。请让页面代码调用 window.pneumataReportError(error, "具体阶段")。');
      return;
    }
    setHtmlRepairRetry(null);
    await enqueueManualInput(async () => {
      const artifact = useAssistantArtifactStore.getState().items.find((item) => item.id === runtimeError.artifactId && item.kind === 'html' && item.deletedAt == null);
      if (!artifact) {
        showErrorToast('需要修复的页面已不存在。');
        return;
      }
      const detail = [
        `错误类型：${runtimeError.kind}`,
        `错误信息：${runtimeError.message}`,
        runtimeError.source ? `来源：${runtimeError.source}${runtimeError.line ? `:${runtimeError.line}:${runtimeError.column || 0}` : ''}` : '',
        runtimeError.stack ? `堆栈：${runtimeError.stack.slice(0, 3000)}` : '',
      ].filter(Boolean).join('\n');
      const userMessage = await addMessageStable({
        chatId: id,
        type: 'user',
        senderId: 'user',
        senderName: currentUser?.nickname?.trim() || '我',
        content: `请修复页面「${artifact.title}」。运行诊断如下：\n${detail}\n\n请仅更新这个页面产物，保留已有功能，并说明修复结果。`,
        emotion: 0,
        timestamp: getNextMessageTimestamp(),
        metadata: { assistantHtmlRuntimeError: { ...runtimeError, reportedAt: Date.now() } },
      });
      void updateChat(id, { lastMessageAt: userMessage.timestamp, latestMessage: userMessage });
      await runHtmlRepairReply({ chatId: id, artifactId: artifact.id, runtimeError, userMessage }, [...currentChatMessages, userMessage]);
    });
  }, [addMessageStable, chat, chatInteractionDisabled, currentChatMessages, currentUser?.nickname, enqueueManualInput, getNextMessageTimestamp, id, runHtmlRepairReply, showErrorToast, updateChat]);

  const handleRetryHtmlRepair = useCallback(() => {
    if (!htmlRepairRetry || htmlRepairRetry.chatId !== id) return;
    const request = htmlRepairRetry;
    setHtmlRepairRetry(null);
    void enqueueManualInput(() => runHtmlRepairReply(request, currentChatMessages));
  }, [currentChatMessages, enqueueManualInput, htmlRepairRetry, id, runHtmlRepairReply]);

  useEffect(() => {
    setHtmlRepairRetry(null);
  }, [id]);

  const handleHtmlSubmit = useCallback(async (input: AssistantHtmlInteractionPayload) => {
    // Assistant HTML submissions are also the structured answer surface for
    // learning-progress rooms. Keep the same artifact/version protocol, but
    // allow the study room to route the submitted attempt through the shared
    // Agent flow instead of silently ignoring the form.
    if (!chat || !id || (chat.type !== 'assistant' && !isLearningProgressRoom) || chatInteractionDisabled) return;
    const pendingKey = `${input.artifactId}:${input.interactionId}:${input.baseVersionId}`;
    if (pendingHtmlSubmissionKeysRef.current.has(pendingKey)) return;
    pendingHtmlSubmissionKeysRef.current.add(pendingKey);
    try {
      await enqueueManualInput(async () => {
        const submittedAt = Date.now();
        const submissionId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `html-submission-${submittedAt}-${Math.random().toString(36).slice(2, 10)}`;
        const artifact = useAssistantArtifactStore.getState().submitHtmlInteraction({
          artifactId: input.artifactId,
          baseVersionId: input.baseVersionId,
          interactionState: input.payload,
          submissionId,
          timestamp: submittedAt,
        });
        if (!artifact) return;
        const submittedVersion = artifact.versions.find((version) => version.id === artifact.currentVersionId);
        if (!submittedVersion || submittedVersion.stage !== 'submitted' || submittedVersion.submissionId !== submissionId || !submittedVersion.htmlRuntime) return;
        if (isLearningProgressRoom) {
          const { recordLearningAttempt } = await import('../services/learningProgressRuntime');
          const attemptPatch = recordLearningAttempt(chat, {
            id: submissionId,
            artifactId: artifact.id,
            interactionId: input.interactionId,
            submissionId,
            status: 'submitted',
            createdAt: submittedAt,
          });
          if (Object.keys(attemptPatch).length) await updateChat(id, attemptPatch);
        }

        const recentMessages = currentChatMessages;
        const userMessage = await addMessageStable({
          chatId: id,
          type: 'user',
          senderId: 'user',
          senderName: currentUser?.nickname?.trim() || '我',
          content: formatAssistantHtmlSubmission(artifact.title, submittedVersion.htmlRuntime, input.payload),
          emotion: 0,
          timestamp: getNextMessageTimestamp(),
          metadata: {
            assistantHtmlSubmission: {
              artifactId: artifact.id,
              baseVersionId: submittedVersion.id,
              interactionId: input.interactionId,
              submissionId,
              resultType: input.resultType,
              payload: input.payload,
              submittedAt,
            },
          },
        });
        if (input.closeOnSubmit !== false) {
          setFullscreenAssistantArtifactId((current) => current === artifact.id ? null : current);
        }
        void updateChat(id, { lastMessageAt: userMessage.timestamp, latestMessage: userMessage });
        const recentMessagesWithUser = [...recentMessages.filter((message) => message.id !== userMessage.id), userMessage];

        const { controller: assistantReplyAbortController, epoch: assistantReplyEpoch } = beginReplyOperation();
        try {
          const { runAssistantChatReplyFlow } = await import('../services/assistantChatFlow');
          await runAssistantChatReplyFlow({
            api,
            aiProfiles,
            chatId: id,
            chat,
            currentMessages: recentMessagesWithUser,
            selectedArtifactId: artifact.id,
            timestamp: userMessage.timestamp + 1,
            upsertMessage: upsertMessageStable,
            updateChat,
            signal: assistantReplyAbortController.signal,
            shouldContinue: () => !assistantReplyAbortController.signal.aborted && directReplyEpochRef.current === assistantReplyEpoch,
          });
          if (isLearningProgressRoom) {
            const [{ mergeLearningKnowledgeFromArtifacts }, artifactStore] = await Promise.all([
              import('../services/learningProgressRuntime'),
              import('../stores/useAssistantArtifactStore'),
            ]);
            const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
            const learningPatch = mergeLearningKnowledgeFromArtifacts(latestChat, artifactStore.useAssistantArtifactStore.getState().getArtifactsForChat(id));
            if (Object.keys(learningPatch).length) await updateChat(id, learningPatch);
          }
        } catch (error) {
          if (!isGenerationCancelledError(error)) {
            console.error('[assistant-html:submit-error]', error);
            showErrorToast(error instanceof Error ? error.message : String(error));
          }
        } finally {
          finishReplyOperation(assistantReplyAbortController);
        }
      });
    } finally {
      pendingHtmlSubmissionKeysRef.current.delete(pendingKey);
    }
  }, [beginReplyOperation, directReplyEpochRef, finishReplyOperation, isLearningProgressRoom, addMessageStable, aiProfiles, api, chat, chatInteractionDisabled, currentChatMessages, currentUser?.nickname, enqueueManualInput, getNextMessageTimestamp, id, showErrorToast, updateChat, upsertMessageStable]);

  useEffect(() => {
    if (!id) return undefined;
    return () => {
      if (openedChatWindowRef.current?.chatId === id) openedChatWindowRef.current = null;
      activeChatIdRef.current = null;
      loopTokenRef.current = null;
      resetRunLoopUiState();
      discardStreamingMessage();
      closeChatWindow(id, { clearActiveOnly: true });
      cancelReplyOperation();
      stop();
    };
  }, [cancelReplyOperation, closeChatWindow, discardStreamingMessage, id, resetRunLoopUiState, stop]);

  const handleStopDirectReply = useCallback(() => {
    cancelReplyOperation();
    regenerationResumeRef.current = null;
  }, [cancelReplyOperation]);

  const handleMemberSpeakSend = useCallback(async (content: string, attachments: MessageAttachment[] = [], mentions: CharacterMention[] = []) => {
    if (!chat || !id) return;
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    await enqueueManualInput(async () => {
      const userMessage = await addMessageStable({
        chatId: id,
        type: 'user',
        senderId: 'user',
        senderName: currentUser?.nickname?.trim() || '我',
        content,
        emotion: 0,
        timestamp: getNextMessageTimestamp(),
        metadata: attachments.length || mentions.length ? { attachments, mentions } : undefined,
      });
      void updateChat(id, { lastMessageAt: userMessage.timestamp, latestMessage: userMessage });
      // Read both values after the optimistic user commit. The render
      // closure can still hold the pre-clear branch head, which would attach
      // the first AI reply to a deleted parent node.
      const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
      const recentMessages = useMessageStore.getState().messages.filter((message) => message.chatId === id);
      const recentMessagesWithUser = [...recentMessages.filter((message) => message.id !== userMessage.id), userMessage];
      if (chat.type === 'direct') {
        const { controller: directReplyAbortController, epoch: directReplyEpoch } = beginReplyOperation();
        void (async () => {
          try {
            const { runDirectUserReplyFlow } = await import('../services/directUserReplyFlow');
            await runDirectUserReplyFlow({
              api,
              aiProfiles,
              chatId: id,
              chat: latestChat,
              userMessage,
              content,
              characters,
              updateCharacter,
              updateCharacters,
              upsertMessage: upsertMessageStable,
              appendEventMessage: appendEventMessageStable,
              appendEventMessages: appendEventMessagesStable,
              updateChat,
              applyChatRuntimeDelta,
              recordSpeak,
              onLocalInterception: appendLocalInterceptionHint,
              signal: directReplyAbortController.signal,
              shouldContinue: () => !directReplyAbortController.signal.aborted && directReplyEpochRef.current === directReplyEpoch,
            });
          } catch (error) {
            if (!isGenerationCancelledError(error)) {
              console.error('[direct-reply:send-error]', error);
              showErrorToast(error instanceof Error ? error.message : String(error));
            }
          } finally {
            finishReplyOperation(directReplyAbortController);
          }
        })();
        return;
      }
      if (chat.type === 'assistant') {
        const { controller: assistantReplyAbortController, epoch: assistantReplyEpoch } = beginReplyOperation();
        void (async () => {
          try {
            const { runAssistantChatReplyFlow } = await import('../services/assistantChatFlow');
            await runAssistantChatReplyFlow({
              api,
              aiProfiles,
              chatId: id,
            chat: latestChat,
              currentMessages: recentMessagesWithUser,
              selectedArtifactId: selectedAssistantArtifactId,
              timestamp: userMessage.timestamp + 1,
              upsertMessage: upsertMessageStable,
              updateChat,
              signal: assistantReplyAbortController.signal,
              shouldContinue: () => !assistantReplyAbortController.signal.aborted && directReplyEpochRef.current === assistantReplyEpoch,
            });
          } catch (error) {
            if (!isGenerationCancelledError(error)) {
              console.error('[assistant-reply:send-error]', error);
              const message = error instanceof Error ? error.message : String(error);
              showErrorToast(message);
              void addMessageStable({
                chatId: id,
                type: 'system',
                senderId: 'system',
                senderName: 'System',
                content: `助手处理失败：${message}`,
                emotion: 0,
                timestamp: Date.now(),
              });
            }
          } finally {
            finishReplyOperation(assistantReplyAbortController);
          }
        })();
        return;
      }
      await commitPersistedManualRuntime(userMessage, recentMessagesWithUser);
      const isLearningProgressRoom = hasRoomCapability(latestChat, 'html-interactive');
      // Learning rooms use the semantic assistant planner for every turn.
      // The planner decides from the requested outcome whether this is a
      // normal answer, a knowledge/data update, a worksheet, or an interactive
      // HTML artifact. The UI must not guess that intent from keywords.
      if (isLearningProgressRoom) {
        const { controller, epoch } = beginReplyOperation();
        void Promise.all([import('../services/assistantChatFlow'), import('../stores/useAssistantArtifactStore'), import('../services/learningProgressRuntime')]).then(async ([{ runAssistantChatReplyFlow }, artifactStore, { mergeLearningKnowledgeFromArtifacts }]) => {
          const teacher = characters.find((character) => chat.memberIds.includes(character.id));
          await runAssistantChatReplyFlow({
          api,
          aiProfiles,
          chatId: id,
          chat,
          currentMessages: recentMessagesWithUser,
          selectedArtifactId: selectedAssistantArtifactId,
          timestamp: userMessage.timestamp + 1,
          upsertMessage: upsertMessageStable,
          updateChat,
          replySender: teacher ? { id: teacher.id, name: teacher.name } : undefined,
          signal: controller.signal,
          shouldContinue: () => !controller.signal.aborted && directReplyEpochRef.current === epoch,
          });
          const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
          const learningPatch = mergeLearningKnowledgeFromArtifacts(latestChat, artifactStore.useAssistantArtifactStore.getState().getArtifactsForChat(id));
          if (Object.keys(learningPatch).length) await updateChat(id, learningPatch);
        }).catch((error) => {
          if (!isGenerationCancelledError(error)) {
            console.error('[learning-reply:send-error]', error);
            showErrorToast(error instanceof Error ? error.message : String(error));
          }
        }).finally(() => finishReplyOperation(controller));
        return;
      }
      if (latestChat.type === 'ai_direct') {
        startConversationLoopIfNeeded(latestChat, { allowDirect: true, immediate: true });
        return;
      }
      startConversationLoopIfNeeded(latestChat);
    });
  }, [beginReplyOperation, directReplyEpochRef, finishReplyOperation, addMessageStable, aiProfiles, api, appendEventMessageStable, appendEventMessagesStable, appendLocalInterceptionHint, applyChatRuntimeDelta, characters, chat, chatInteractionDisabled, chatReadOnlyReason, commitPersistedManualRuntime, currentChatMessages, currentUser?.nickname, enqueueManualInput, getNextMessageTimestamp, id, recordSpeak, selectedAssistantArtifactId, setSnackbar, showErrorToast, startConversationLoopIfNeeded, updateCharacter, updateCharacters, updateChat, upsertMessageStable]);

  const handlePendingAppCommandChoice = useCallback(async (choiceId: string) => {
    if (!chat || !id || chat.type !== 'assistant') return;
    if (pendingAppCommandChoiceRef.current) return;
    pendingAppCommandChoiceRef.current = true;
    setPendingAppCommandChoiceId(choiceId);
    // Hide all choices immediately while the selected action is executing.
    setVisiblePendingAppCommand(null);
    setPendingAppCommand(null);
    cancelReplyOperation();
    try {
      await enqueueManualInput(async () => {
        try {
          const selectedChoice = visiblePendingAppCommand
            ? buildPendingAppCommandChoices(visiblePendingAppCommand).find((choice) => choice.id === choiceId)
            : null;
          if (selectedChoice) {
            const userMessage = await addMessageStable({
              chatId: id,
              type: 'user',
              senderId: 'user',
              senderName: currentUser?.nickname?.trim() || '我',
              content: `我选择：${selectedChoice.label}`,
              emotion: 0,
              timestamp: getNextMessageTimestamp(),
            });
            void updateChat(id, { lastMessageAt: userMessage.timestamp, latestMessage: userMessage });
          }
          const { runPendingAssistantAppCommandChoice } = await import('../features/assistantAppTools/assistantAppToolBridge');
          const result = await runPendingAssistantAppCommandChoice({
            chatId: id,
            choiceId,
            apiConfig: api,
            aiProfiles,
          });
          const assistantMessage = await addMessageStable({
            chatId: id,
            type: 'ai',
            senderId: 'assistant',
            senderName: '助手',
            content: result.content,
            emotion: 0,
            timestamp: getNextMessageTimestamp(),
            metadata: {
              format: 'markdown',
              assistant: { mode: 'general' },
            },
          });
          void updateChat(id, { lastMessageAt: assistantMessage.timestamp, latestMessage: assistantMessage });
        } catch (error) {
          console.error('[assistant-app-command:choice-error]', error);
          showErrorToast(error instanceof Error ? error.message : String(error));
        }
      });
    } finally {
      pendingAppCommandChoiceRef.current = false;
      setPendingAppCommandChoiceId(null);
    }
  }, [cancelReplyOperation, addMessageStable, aiProfiles, api, chat, currentUser?.nickname, enqueueManualInput, getNextMessageTimestamp, id, showErrorToast, updateChat, visiblePendingAppCommand]);

  useEffect(() => {
    if (!chat || !id) return;
    const state = location.state as HomeCommandChatLocationState | null;
    const initialMessage = state?.homeCommandInitialMessage?.trim();
    if (!initialMessage) return;
    const consumeKey = `${id}:${initialMessage}`;
    if (consumedHomeCommandRef.current === consumeKey) return;
    consumedHomeCommandRef.current = consumeKey;
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
    void handleMemberSpeakSend(initialMessage);
  }, [agentEntitled, chat, handleMemberSpeakSend, id, location.hash, location.pathname, location.search, location.state, navigate, updateChat]);

  const handleGuideSend = useCallback(async (content: string, attachments: MessageAttachment[] = [], mentions: CharacterMention[] = []) => {
    if (!chat || !id) return;
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    await enqueueManualInput(async () => {
      const recentMessages = currentChatMessages;
      const guidedMessage = await addMessageStable({
        chatId: id,
        type: 'god',
        senderId: 'user',
        senderName: '话题引导',
        content,
        emotion: 0,
        timestamp: getNextMessageTimestamp(),
        metadata: attachments.length || mentions.length ? { attachments, mentions } : undefined,
      });
      void updateChat(id, { lastMessageAt: guidedMessage.timestamp, latestMessage: guidedMessage });
      const recentMessagesWithGuide = [...recentMessages.filter((message) => message.id !== guidedMessage.id), guidedMessage];
      await commitPersistedManualRuntime(guidedMessage, recentMessagesWithGuide);
      startConversationLoopIfNeeded(chat);
    });
  }, [addMessageStable, chat, chatInteractionDisabled, chatReadOnlyReason, commitPersistedManualRuntime, currentChatMessages, enqueueManualInput, getNextMessageTimestamp, id, setSnackbar, startConversationLoopIfNeeded, updateChat]);

  const handleSpeakAs = useCallback(async (content: string, attachments: MessageAttachment[] = [], mentions: CharacterMention[] = []) => {
    if (!chat || !id || !effectiveSpeakAsChar) return;
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    const char = effectiveSpeakAsChar;
    if (!char) return;
    await enqueueManualInput(async () => {
      const recentMessages = currentChatMessages;
      const spokeMessage = await addMessageStable({
        chatId: id,
        type: 'user',
        senderId: char.id,
        senderName: char.name,
        content,
        emotion: 0,
        timestamp: getNextMessageTimestamp(),
        metadata: {
          manualSpeaker: {
            actorId: char.id,
            actorName: char.name,
            avatar: char.avatar,
          },
          ...(mentions.length ? { mentions } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      });
      void updateChat(id, { lastMessageAt: spokeMessage.timestamp, latestMessage: spokeMessage });
      const recentMessagesWithSpeaker = [...recentMessages.filter((message) => message.id !== spokeMessage.id), spokeMessage];
      await commitPersistedManualRuntime(spokeMessage, recentMessagesWithSpeaker);
      startConversationLoopIfNeeded(chat);
    });
  }, [addMessageStable, chat, chatInteractionDisabled, chatReadOnlyReason, commitPersistedManualRuntime, currentChatMessages, effectiveSpeakAsChar, enqueueManualInput, getNextMessageTimestamp, id, setSnackbar, startConversationLoopIfNeeded, updateChat]);

  const { runSessionAction, normalizeAndRunSurfaceIntent } = useChatSurfaceActions({
    chat,
    chats,
    characters,
    updateChat,
    addMessage: addMessageStable,
    appendEventMessage: appendEventMessageStable,
    actionSchema,
    aiProfiles,
    speakAsChar: effectiveSpeakAsChar,
    handleGuideSend,
    handleMemberSpeakSend,
    handleSpeakAs,
    setSnackbar,
  });

  const storyChoiceSourceMessage = useMemo(
    () => findVisibleStoryChoiceSourceMessage({
      isStoryRoom,
      phase: chat?.scenarioState?.phase,
      messages: currentChatMessages,
    }),
    [chat?.scenarioState?.phase, currentChatMessages, isStoryRoom],
  );
  const storyBranchOptions = useMemo(
    () => buildVisibleStoryBranchOptions({
      isStoryRoom,
      chat,
      sourceMessage: storyChoiceSourceMessage,
    }),
    [chat, isStoryRoom, storyChoiceSourceMessage],
  );
  useEffect(() => {
    if (!isStoryRoom || chat?.scenarioState?.phase !== 'choice') {
      pendingStoryChoiceRef.current = null;
      setPendingStoryChoiceKey(null);
    }
  }, [chat?.scenarioState?.phase, isStoryRoom]);
  const isCurrentStoryChoiceSubmitting = isStoryChoicePending({
    pendingKey: pendingStoryChoiceKey,
    chatId: id,
    choiceEpoch: chat?.scenarioState?.choiceEpoch,
    sourceMessageId: storyChoiceSourceMessage?.id,
  });
  const visibleStoryBranchOptions = isCurrentStoryChoiceSubmitting ? [] : storyBranchOptions;
  const storyChoiceGate = useMemo(
    () => getStoryChoiceGateState(chat, currentChatMessages),
    [chat, currentChatMessages],
  );
  const visibleSessionPanelActions = useMemo(
    () => sessionActions.filter((action) => action.type !== 'choose_story_branch'),
    [sessionActions],
  );
  const sessionActionPanelTitle = chat && resolveSessionFamilyKey(chat) === 'analysis'
    ? '审议操作'
    : (projectedDetailState?.actionPanel.title || actionPanelTitle || `${sessionTabTitle}操作`);
  const visibleActivityPanelActions = useMemo(
    () => projectedActionPanelActions.filter((action) => action.type !== 'choose_story_branch'),
    [projectedActionPanelActions],
  );
  const isStoryWaitingForChoice = chat?.sessionKind?.scenarioId === 'story-reader'
    && !isCurrentStoryChoiceSubmitting
    && storyChoiceGate.waiting;
  const displayedStoryChoiceVisual = pendingStoryChoiceVisual;
  const displayedStoryChoiceMessageId = isStoryWaitingForChoice
    ? storyChoiceSourceMessage?.id
    : displayedStoryChoiceVisual?.sourceMessageId || null;
  const displayedStoryChoiceOptions = isStoryWaitingForChoice
    ? visibleStoryBranchOptions
    : displayedStoryChoiceVisual?.options || [];
  const displayedStoryChoiceSubmittingValue = isStoryWaitingForChoice
    ? null
    : displayedStoryChoiceVisual?.selectedValue || null;
  const isSingleSpeakableMemberStop = Boolean(runLoopError?.startsWith('群里已无多人在线'));
  const runLoopStatusContent = (chatError || runLoopError) ? (
    <Alert
      severity={chatError || !isSingleSpeakableMemberStop ? 'error' : 'warning'}
      variant="outlined"
      role="status"
      sx={{ mx: { xs: 1.25, sm: 2 }, mt: 1, borderRadius: 2 }}
    >
      {chatError || runLoopError}
    </Alert>
  ) : null;
  const handleChooseStoryBranch = useCallback(async (optionValue: string) => {
    if (!chat || !id) return;
    const option = storyBranchOptions.find((item) => item.value === optionValue);
    const branches = chat.scenarioState?.branches || [];
    const currentEpoch = Number(chat.scenarioState?.choiceEpoch || 0);
    const currentBranches = branches.filter((branch) => Number(branch.choiceEpoch || 0) === currentEpoch);
    const selectedBranch = currentBranches.find((branch) => branch.branchId === optionValue)
      || currentBranches.find((branch) => branch.label === option?.label && branch.prompt === option?.prompt)
      || currentBranches.find((branch) => branch.label === option?.label);
    const branchId = selectedBranch?.branchId || optionValue;
    const storyDirection = sanitizeStoryChoicePrompt(selectedBranch?.prompt || selectedBranch?.description || option?.prompt || option?.label || chat.scenarioState?.storyDirection || '');
    const choiceLabel = option?.label || selectedBranch?.label || storyDirection || branchId;
    const choiceKey = buildStoryChoicePendingKey({
      chatId: id,
      choiceEpoch: chat.scenarioState?.choiceEpoch,
      sourceMessageId: storyChoiceSourceMessage?.id,
    });
    if (pendingStoryChoiceRef.current === choiceKey) return;
    pendingStoryChoiceRef.current = choiceKey;
    setPendingStoryChoiceKey(choiceKey);
    setIsExplicitContinuationScrollFollowSuspended(true);
    if (pendingStoryChoiceVisualTimerRef.current) clearTimeout(pendingStoryChoiceVisualTimerRef.current);
    if (storyChoiceSourceMessage?.id) {
      setPendingStoryChoiceVisual({
        key: choiceKey,
        sourceMessageId: storyChoiceSourceMessage.id,
        selectedValue: optionValue,
        options: storyBranchOptions,
      });
      pendingStoryChoiceVisualTimerRef.current = setTimeout(() => {
        pendingStoryChoiceVisualTimerRef.current = null;
        setPendingStoryChoiceVisual((current) => (current?.key === choiceKey ? null : current));
      }, STORY_CHOICE_COLLAPSE_MS);
    }
    logDeveloperDiagnostic('story-choice:select', {
      chatId: id,
      optionValue,
      branchId,
      choiceLabel,
      choiceEpoch: chat.scenarioState?.choiceEpoch || null,
      sourceMessageId: storyChoiceSourceMessage?.id || null,
      gateBeforeAction: storyChoiceGate,
    }, 'info');
    let actionSucceeded = false;
    try {
      const choiceMessage = await addMessageStable({
        chatId: id,
        type: 'user',
        senderId: 'user',
        senderName: currentUser?.nickname?.trim() || '我',
        content: `我选择：${choiceLabel}`,
        emotion: 0,
        timestamp: getNextMessageTimestamp(),
        metadata: {
          storyChoiceSelection: {
            branchId,
            sourceMessageId: storyChoiceSourceMessage?.id,
            label: choiceLabel,
            prompt: storyDirection || null,
            intent: option?.intent || selectedBranch?.intent || null,
            risk: option?.risk || selectedBranch?.risk || null,
            reward: option?.reward || selectedBranch?.reward || null,
            choiceEpoch: chat.scenarioState?.choiceEpoch,
          },
        },
      });
      void updateChat(id, { lastMessageAt: choiceMessage.timestamp, latestMessage: choiceMessage });
      const actionResult = await runSessionAction({ type: 'choose_story_branch', actorId: 'user' }, { branchId, prompt: storyDirection });
      actionSucceeded = true;
      logDeveloperDiagnostic('story-choice:action-result', {
        chatId: id,
        branchId,
        choiceEpoch: chat.scenarioState?.choiceEpoch || null,
        chatPatchPhase: actionResult?.chatPatch?.scenarioState?.phase || null,
        chatPatchChoiceEpoch: actionResult?.chatPatch?.scenarioState?.choiceEpoch || null,
        hasChatPatch: Boolean(actionResult?.chatPatch),
      }, actionResult?.chatPatch?.scenarioState?.phase === 'branch' ? 'info' : 'warn');
      const nextChat = actionResult?.chatPatch ? {
        ...chat,
        ...actionResult.chatPatch,
        scenarioState: {
          ...(chat.scenarioState || {}),
          ...(actionResult.chatPatch.scenarioState || {}),
        },
        worldState: {
          ...chat.worldState,
          ...(actionResult.chatPatch.worldState || {}),
        },
      } : chat;
      await updateChat(id, actionResult?.chatPatch || {});
      setIsStoryGenerationCancelled(false);
      const startBlockReason = startConversationLoopIfNeeded(nextChat, { ignoreReaderPositionOnce: true, immediate: true });
      if (startBlockReason) {
        logDeveloperDiagnostic('story-choice:start-blocked-after-select', {
          chatId: id,
          branchId,
          startBlockReason,
          nextPhase: nextChat.scenarioState?.phase || null,
        }, 'warn');
        setSnackbar({ open: true, message: startBlockReason === 'waiting_story_choice' ? '剧情选择已记录，但运行仍在等待选择，请查看开发者日志。' : '剧情选择已记录，但运行没有启动，请查看开发者日志。', severity: 'error' });
      }
    } finally {
      if (!actionSucceeded && pendingStoryChoiceRef.current === choiceKey) {
        pendingStoryChoiceRef.current = null;
        setPendingStoryChoiceKey(null);
        setPendingStoryChoiceVisual((current) => (current?.key === choiceKey ? null : current));
      }
    }
  }, [addMessageStable, chat, currentUser?.nickname, getNextMessageTimestamp, id, runSessionAction, setSnackbar, startConversationLoopIfNeeded, storyBranchOptions, storyChoiceGate, storyChoiceSourceMessage?.id, updateChat]);

  const handleStoryCustomDirectionSend = useCallback(async (content: string, attachments: MessageAttachment[] = [], mentions: CharacterMention[] = []) => {
    if (!chat || !id) return;
    const storyDirection = sanitizeStoryChoicePrompt(content);
    if (!storyDirection) return;
    const trimmedDraft = trimMentionDraft(content, mentions);
    const directionMentions = trimmedDraft.mentions.filter((mention) => mention.end <= storyDirection.length)
      .map((mention) => ({ ...mention, start: mention.start + 4, end: mention.end + 4 }));
    if (attachments.length) {
      setSnackbar({ open: true, message: '故事房自定义走向暂不支持附件，请用文字描述你想推动的剧情。', severity: 'error' });
      return;
    }
    await enqueueManualInput(async () => {
      const choiceKey = buildStoryChoicePendingKey({
        chatId: id,
        choiceEpoch: chat.scenarioState?.choiceEpoch,
        sourceMessageId: storyChoiceSourceMessage?.id,
      });
      if (pendingStoryChoiceRef.current === choiceKey) return;
      pendingStoryChoiceRef.current = choiceKey;
      setPendingStoryChoiceKey(choiceKey);
      setIsExplicitContinuationScrollFollowSuspended(true);
      let actionSucceeded = false;
      try {
        const choiceMessage = await addMessageStable({
          chatId: id,
          type: 'user',
          senderId: 'user',
          senderName: currentUser?.nickname?.trim() || '我',
          content: `我选择：${storyDirection}`,
          emotion: 0,
          timestamp: getNextMessageTimestamp(),
          metadata: {
            mentions: directionMentions,
            storyChoiceSelection: {
              branchId: '__custom_story_branch',
              sourceMessageId: storyChoiceSourceMessage?.id,
              label: storyDirection,
              prompt: storyDirection,
              intent: null,
              risk: null,
              reward: null,
              choiceEpoch: chat.scenarioState?.choiceEpoch,
            },
          },
        });
        void updateChat(id, { lastMessageAt: choiceMessage.timestamp, latestMessage: choiceMessage });
        const actionResult = await runSessionAction(
          { type: 'choose_story_branch', actorId: 'user' },
          { branchId: '__custom_story_branch', prompt: storyDirection },
        );
        actionSucceeded = true;
        logDeveloperDiagnostic('story-choice:custom-action-result', {
          chatId: id,
          choiceEpoch: chat.scenarioState?.choiceEpoch || null,
          chatPatchPhase: actionResult?.chatPatch?.scenarioState?.phase || null,
          chatPatchChoiceEpoch: actionResult?.chatPatch?.scenarioState?.choiceEpoch || null,
          hasChatPatch: Boolean(actionResult?.chatPatch),
        }, actionResult?.chatPatch?.scenarioState?.phase === 'branch' ? 'info' : 'warn');
        const nextChat = actionResult?.chatPatch ? {
          ...chat,
          ...actionResult.chatPatch,
          scenarioState: {
            ...(chat.scenarioState || {}),
            ...(actionResult.chatPatch.scenarioState || {}),
          },
          worldState: {
            ...chat.worldState,
            ...(actionResult.chatPatch.worldState || {}),
          },
        } : chat;
        await updateChat(id, actionResult?.chatPatch || {});
        setIsStoryGenerationCancelled(false);
        const startBlockReason = startConversationLoopIfNeeded(nextChat, { ignoreReaderPositionOnce: true, immediate: true });
        if (startBlockReason) {
          logDeveloperDiagnostic('story-choice:start-blocked-after-custom-direction', {
            chatId: id,
            startBlockReason,
            nextPhase: nextChat.scenarioState?.phase || null,
          }, 'warn');
          setSnackbar({ open: true, message: startBlockReason === 'waiting_story_choice' ? '剧情选择已记录，但运行仍在等待选择，请查看开发者日志。' : '剧情选择已记录，但运行没有启动，请查看开发者日志。', severity: 'error' });
        }
      } finally {
        if (!actionSucceeded && pendingStoryChoiceRef.current === choiceKey) {
          pendingStoryChoiceRef.current = null;
          setPendingStoryChoiceKey(null);
        }
      }
    });
  }, [addMessageStable, chat, currentUser?.nickname, enqueueManualInput, getNextMessageTimestamp, id, runSessionAction, setSnackbar, startConversationLoopIfNeeded, storyChoiceSourceMessage?.id, updateChat]);
  const storyTailStatus = getStoryTailStatus({
    hasRunLoopStatus: Boolean(runLoopStatusContent),
    isStoryChoiceSubmitting: isCurrentStoryChoiceSubmitting,
    isGeneratingStoryNode: Boolean(isStoryRoom && !isStoryWaitingForChoice && !isCurrentStoryChoiceSubmitting && isRunning && !isPaused && (thinkingId || hasPendingTurnWork())),
    isGenerationCancelled: Boolean(isStoryRoom && isStoryGenerationCancelled && !isStoryWaitingForChoice && !isCurrentStoryChoiceSubmitting),
    isWaitingForReaderTail: Boolean(isStoryRoom && !isStoryWaitingForChoice && !isCurrentStoryChoiceSubmitting && isRunning && !isPaused && !thinkingId && !hasPendingTurnWork() && !isStoryReaderAtTail),
  });
  const handleCancelStoryGeneration = useCallback(() => {
    setIsStoryGenerationCancelled(true);
    cancelActiveConversationLoop('story_generation_cancelled');
  }, [cancelActiveConversationLoop]);
  const handleContinueStoryGeneration = useCallback(() => {
    if (!chat || !id) return;
    setIsStoryGenerationCancelled(false);
    setIsExplicitContinuationScrollFollowSuspended(true);
    resume();
    const startBlockReason = startConversationLoopIfNeeded(chat, { ignoreReaderPositionOnce: true, immediate: true });
    if (startBlockReason) {
      logDeveloperDiagnostic('story-run:continue-blocked-after-cancel', {
        chatId: id,
        startBlockReason,
        phase: chat.scenarioState?.phase || null,
        storyChoiceGate,
      }, startBlockReason === 'waiting_story_choice' ? 'info' : 'warn');
    }
  }, [chat, id, resume, startConversationLoopIfNeeded, storyChoiceGate]);
  const hasStoryTailStatusContent = Boolean(runLoopStatusContent)
    || storyTailStatus === 'submitting_choice'
    || storyTailStatus === 'generating_node'
    || storyTailStatus === 'generation_cancelled';
  const storyBranchSuggestionContent = hasStoryTailStatusContent ? (
    <>
      {storyTailStatus === 'submitting_choice' ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', px: { xs: 2, sm: 3 }, pt: 0.75, pb: 1.5 }}>
          <Chip
            size="small"
            label="正在进入你选择的剧情"
            variant="outlined"
            sx={(theme) => ({
              borderRadius: 2,
              px: 0.8,
              py: 1.75,
              fontWeight: 700,
              bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(15,23,42,0.72)',
              boxShadow: '0 8px 22px rgba(15,23,42,0.10)',
            })}
          />
        </Box>
      ) : null}
    </>
  ) : null;
  const storyTailStatusBar = isStoryRoom && storyTailStatus ? (
    <Box sx={{ px: { xs: 2, sm: 3 }, pb: 1.25 }}>
      {storyTailStatus === 'generating_node' ? (
        <Box data-message-id="story-generating-next-node" data-message-type="story-loading" sx={{ display: 'flex', justifyContent: 'center' }}>
          <Box
            sx={(theme) => ({
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              maxWidth: '100%',
              px: 1.4,
              py: 0.9,
              borderRadius: 2,
              border: '1px solid',
              borderColor: theme.palette.mode === 'light' ? 'rgba(148,163,184,0.28)' : 'rgba(226,232,240,0.14)',
              bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(15,23,42,0.72)',
              boxShadow: '0 8px 22px rgba(15,23,42,0.10)',
            })}
          >
            <CircularProgress size={16} thickness={4} />
            <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
              正在生成下一节
            </Typography>
            <Button size="small" variant="text" onClick={handleCancelStoryGeneration} sx={{ minWidth: 0, px: 0.75 }}>
              停止
            </Button>
          </Box>
        </Box>
      ) : null}
      {storyTailStatus === 'generation_cancelled' ? (
        <Box data-message-id="story-generation-cancelled" data-message-type="story-loading" sx={{ display: 'flex', justifyContent: 'center' }}>
          <Box
            sx={(theme) => ({
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              maxWidth: '100%',
              px: 1.4,
              py: 0.9,
              borderRadius: 2,
              border: '1px solid',
              borderColor: theme.palette.mode === 'light' ? 'rgba(148,163,184,0.28)' : 'rgba(226,232,240,0.14)',
              bgcolor: theme.palette.mode === 'light' ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.78)',
              boxShadow: '0 8px 22px rgba(15,23,42,0.10)',
            })}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
              生成已停止
            </Typography>
            <Button size="small" variant="contained" onClick={handleContinueStoryGeneration} sx={{ minWidth: 0, px: 1 }}>
              继续
            </Button>
          </Box>
        </Box>
      ) : null}
    </Box>
  ) : null;
  const messageListBottomInset = chatInteractionDisabled
    ? { xs: '104px', sm: '92px' }
    : composerDockHeight > 0
      ? { xs: `${composerDockHeight + 12 + keyboardInset}px`, sm: `${composerDockHeight + 12}px` }
      : { xs: 'calc(112px + env(safe-area-inset-bottom, 0px))', sm: '104px' };

  useLayoutEffect(() => {
    if (isRemoteDeletedChat) {
      setComposerDockHeight(0);
      return undefined;
    }
    const node = composerDockRef.current;
    if (!node) return undefined;
    const measure = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      setComposerDockHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      const frame = window.requestAnimationFrame(measure);
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasStoryTailStatusContent, isRemoteDeletedChat, pendingAppCommand]);

  const htmlRepairErrorContent = htmlRepairRetry?.chatId === id ? (
    <Alert
      role="alert"
      severity="error"
      variant="outlined"
      action={(
        <Button color="inherit" size="small" onClick={handleRetryHtmlRepair} disabled={isDirectReplyPending}>
          重试
        </Button>
      )}
      sx={{ alignItems: 'center', '& .MuiAlert-message': { overflowWrap: 'anywhere' } }}
    >
      {htmlRepairRetry?.message}
    </Alert>
  ) : null;
  const composerTopContent = runLoopStatusContent || storyBranchSuggestionContent || visiblePendingAppCommand || isWaitingForInput ? (
    <Stack spacing={0.75}>
      {isWaitingForInput ? (
        <Alert severity="info" variant="outlined" role="status" sx={{ mx: { xs: 1.25, sm: 2 }, mt: 1, borderRadius: 2 }}>
          等待用户输入
        </Alert>
      ) : null}
      {runLoopStatusContent}
      <Collapse
        in={Boolean(storyBranchSuggestionContent)}
        timeout={prefersReducedMotion() ? 0 : motion.durations.slow}
        easing={{ enter: motion.emphasized, exit: motion.softInOut }}
        unmountOnExit
      >
        {storyBranchSuggestionContent ? <Box
          sx={{
            transformOrigin: '50% 100%',
            pb: 0.75,
            transition: transition(['opacity', 'transform'], motion.durations.slow, motion.emphasized),
            '.MuiCollapse-hidden &': {
              opacity: 0,
              transform: 'translateY(8px) scale(0.985)',
            },
          }}
        >
          {storyBranchSuggestionContent}
        </Box> : null}
      </Collapse>
      <Collapse
        in={Boolean(pendingAppCommand)}
        timeout={prefersReducedMotion() ? 0 : motion.durations.slow}
        easing={{ enter: motion.emphasized, exit: motion.softInOut }}
        unmountOnExit
        onExited={() => setVisiblePendingAppCommand(null)}
      >
        {visiblePendingAppCommand ? <Box
          sx={{
            display: 'grid',
            gap: 0.6,
            px: { xs: 0.2, sm: 0.35 },
            mb: 0.75,
            transformOrigin: '50% 100%',
            transition: transition(['opacity', 'transform'], motion.durations.slow, motion.emphasized),
            '.MuiCollapse-hidden &': {
              opacity: 0,
              transform: 'translateY(10px) scale(0.988)',
            },
            '@media (prefers-reduced-motion: reduce)': {
              transition: 'none',
              transform: 'none',
            },
          }}
        >
          {(() => {
            const choices = buildPendingAppCommandChoices(visiblePendingAppCommand);
            const presentation = resolvePendingChoicePresentation(visiblePendingAppCommand);
            const sendChoice = (choiceId: string) => handlePendingAppCommandChoice(choiceId);
            const choiceExecuting = Boolean(pendingAppCommandChoiceId);
            const label = (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  flexShrink: 0,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  opacity: 0.72,
                }}
              >
                等待选择
              </Typography>
            );
            if (presentation === 'select') {
              return (
                <Box sx={{ display: 'grid', gap: 0.45 }}>
                  {label}
                  <TextField
                    select
                    size="small"
                    value=""
                    disabled={choiceExecuting}
                    onChange={(event) => {
                      if (event.target.value) void sendChoice(event.target.value);
                    }}
                    label="选择操作"
                  >
                    {choices.map((choice) => (
                      <MenuItem key={choice.id} value={choice.id}>{choice.label}</MenuItem>
                    ))}
                  </TextField>
                </Box>
              );
            }
            if (presentation === 'list') {
              return (
                <Box sx={{ display: 'grid', gap: 0.6 }}>
                  {label}
                  {choices.map((choice) => (
                    <Button
                      key={choice.id}
                      size="small"
                      variant={choice.kind === 'cancel' ? 'text' : 'outlined'}
                      color={choice.kind === 'cancel' ? 'inherit' : 'primary'}
                      disabled={choiceExecuting}
                      onClick={() => void sendChoice(choice.id)}
                      sx={{ justifyContent: 'flex-start', textAlign: 'left', minHeight: 34 }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{choice.label}</Typography>
                        {choice.description ? <Typography variant="caption" color="text.secondary">{choice.description}</Typography> : null}
                      </Box>
                    </Button>
                  ))}
                </Box>
              );
            }
            return (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
                {label}
                {choices.map((choice) => (
                  <Chip
                    key={choice.id}
                    label={choice.label}
                    color={choice.kind === 'cancel' ? 'default' : 'primary'}
                    variant={choice.kind === 'cancel' ? 'outlined' : 'filled'}
                    disabled={choiceExecuting}
                    onClick={() => void sendChoice(choice.id)}
                    sx={{ maxWidth: '100%' }}
                  />
                ))}
              </Box>
            );
          })()}
        </Box> : null}
      </Collapse>
    </Stack>
  ) : null;

  const handleExpressionFeedback = useCallback(async (message: Message, kind: ExpressionFeedbackKind) => {
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    if (message.type !== 'ai') return;
    const character = characters.find((item) => item.id === message.senderId);
    if (!character) {
      setSnackbar({ open: true, message: '未找到这个角色，无法记录反馈', severity: 'error' });
      return;
    }
    const patch = buildExpressionFeedbackPatch({ character, message, kind });
    await updateCharacter(character.id, patch);
    setSnackbar({ open: true, message: `已记录反馈：${getExpressionFeedbackLabel(kind)}`, severity: 'success' });
  }, [characters, chatInteractionDisabled, chatReadOnlyReason, updateCharacter]);

  const handleRetryMedia = useCallback(async (message: Message, attachmentId: string) => {
    if (chatInteractionDisabled) {
      setSnackbar({ open: true, message: chatReadOnlyReason || '当前会话不可继续', severity: 'info' });
      return;
    }
    const character = message.type === 'ai' ? characters.find((item) => item.id === message.senderId) : null;
    const { retryRichMessageMedia } = await import('../services/richMessageMedia');
    await retryRichMessageMedia({
      message,
      attachmentId,
      character,
      characters,
      messages: currentChatMessages,
      aiProfiles,
      upsertMessage: upsertMessageStable,
    });
    setSnackbar({ open: true, message: '已重新加入生成队列', severity: 'info' });
  }, [aiProfiles, characters, chatInteractionDisabled, chatReadOnlyReason, currentChatMessages, upsertMessageStable]);


  const handleLoadOlderMessages = useCallback(async () => {
    if (!id || loadingMoreRef.current || !hasMore || currentChatMessages.length === 0) return;
    logDeveloperDiagnostic('message-pagination:request', {
      chatId: id,
      direction: 'older',
      cursor: currentChatMessages[0].timestamp,
      projectedMessages: currentChatMessages.length,
      mergedMessages: currentChatAllMessages.length,
      activeStoreMessages: messages.filter((message) => message.chatId === id).length,
      cachedMessages: rawCurrentMessageWindow?.messages?.length || 0,
      activeLimit: rawCurrentMessageWindow?.activeLimit || null,
      hasMoreOlder: hasMore,
      hasMoreNewer,
    }, 'info', 'message-window');
    loadingMoreRef.current = true;
    try {
      await loadMessages(id, { append: true, before: currentChatMessages[0].timestamp, limit: CHAT_MESSAGE_WINDOW_SIZE });
      const messageState = useMessageStore.getState();
      const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
      const activeMessages = messageState.messages.filter((message) => message.chatId === id);
      const cachedWindow = messageState.messageWindowsByChatId[id];
      const mergedMessages = projectMergedChatMessages({ chatId: id, activeMessages, cachedWindow });
      const projectedMessages = latestChat && isMessageBranchingEnabled(latestChat)
        ? projectActiveBranchMessages(latestChat, mergedMessages)
        : mergedMessages;
      logDeveloperDiagnostic('message-pagination:result', {
        chatId: id,
        direction: 'older',
        activeStoreMessages: activeMessages.length,
        cachedMessages: cachedWindow?.messages?.length || 0,
        activeLimit: cachedWindow?.activeLimit || null,
        mergedMessages: mergedMessages.length,
        projectedMessages: projectedMessages.length,
        projectedRange: projectedMessages.length ? [projectedMessages[0]?.timestamp, projectedMessages.at(-1)?.timestamp] : null,
        hasMoreOlder: messageState.hasMore,
        hasMoreNewer: messageState.hasMoreNewer,
      }, projectedMessages.length <= 2 && mergedMessages.length > 2 ? 'warn' : 'info', 'message-window');
    } finally {
      loadingMoreRef.current = false;
    }
  }, [chat, currentChatAllMessages.length, currentChatMessages, hasMore, hasMoreNewer, id, loadMessages, messages, rawCurrentMessageWindow]);

  const handleLoadNewerMessages = useCallback(async () => {
    if (!id || loadingMoreRef.current || !hasMoreNewer || currentChatMessages.length === 0) return;
    // After prepending an older page, the retained cache contains both the
    // visible older page and the newer page that was displaced from the
    // active window. The cursor must come from the visible active window;
    // using the cache maximum would ask for messages after the cache tail and
    // make the displaced newer messages impossible to restore.
    const latestTimestamp = currentChatMessages.reduce(
      (latest, message) => Math.max(latest, Number(message.timestamp || 0)),
      0,
    );
    if (!latestTimestamp) return;
    logDeveloperDiagnostic('message-pagination:request', {
      chatId: id,
      direction: 'newer',
      cursor: latestTimestamp,
      projectedMessages: currentChatMessages.length,
      mergedMessages: currentChatAllMessages.length,
      activeStoreMessages: messages.filter((message) => message.chatId === id).length,
      cachedMessages: rawCurrentMessageWindow?.messages?.length || 0,
      activeLimit: rawCurrentMessageWindow?.activeLimit || null,
      hasMoreOlder: hasMore,
      hasMoreNewer,
    }, 'info', 'message-window');
    loadingMoreRef.current = true;
    try {
      await loadMessages(id, { append: true, after: latestTimestamp, limit: CHAT_MESSAGE_WINDOW_SIZE });
      const messageState = useMessageStore.getState();
      const latestChat = useChatStore.getState().chats.find((item) => item.id === id) || chat;
      const activeMessages = messageState.messages.filter((message) => message.chatId === id);
      const cachedWindow = messageState.messageWindowsByChatId[id];
      const mergedMessages = projectMergedChatMessages({ chatId: id, activeMessages, cachedWindow });
      const projectedMessages = latestChat && isMessageBranchingEnabled(latestChat)
        ? projectActiveBranchMessages(latestChat, mergedMessages)
        : mergedMessages;
      logDeveloperDiagnostic('message-pagination:result', {
        chatId: id,
        direction: 'newer',
        activeStoreMessages: activeMessages.length,
        cachedMessages: cachedWindow?.messages?.length || 0,
        activeLimit: cachedWindow?.activeLimit || null,
        mergedMessages: mergedMessages.length,
        projectedMessages: projectedMessages.length,
        projectedRange: projectedMessages.length ? [projectedMessages[0]?.timestamp, projectedMessages.at(-1)?.timestamp] : null,
        hasMoreOlder: messageState.hasMore,
        hasMoreNewer: messageState.hasMoreNewer,
      }, projectedMessages.length <= 2 && mergedMessages.length > 2 ? 'warn' : 'info', 'message-window');
    } finally {
      loadingMoreRef.current = false;
    }
  }, [chat, currentChatAllMessages.length, currentChatMessages, hasMore, hasMoreNewer, id, loadMessages, messages, rawCurrentMessageWindow]);

  const handleNearTop = useCallback(() => {
    void handleLoadOlderMessages();
  }, [handleLoadOlderMessages]);

  const handleNearBottom = useCallback(() => {
    void handleLoadNewerMessages();
  }, [handleLoadNewerMessages]);

  const handleJumpToConversationBottom = useCallback(async () => {
    if (!id) return;
    if (hasMoreNewer) {
      await openChatWindow(id, { limit: CHAT_MESSAGE_WINDOW_SIZE, revalidate: true, resetWindow: true });
      await waitForNextFrame();
    }
  }, [hasMoreNewer, id, openChatWindow]);

  const fromTab = useMemo(() => new URLSearchParams(window.location.search).get('fromTab'), []);

  const handleHeaderBack = useCallback(() => {
    navigate(fromTab ? `/chats?tab=${fromTab}` : '/chats');
  }, [fromTab, navigate]);

  const handleDeleteAssistantChat = useCallback(async () => {
    if (!chat || chat.type !== 'assistant') return;
    const deletedChat = { id: chat.id, name: chat.name || '助手会话' };
    try {
      await deleteChat(chat.id);
      navigate(fromTab ? `/chats?tab=${fromTab}` : `/chats?tab=3`, {
        state: { deletedAssistantChat: deletedChat },
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error ? error.message : '删除助手失败',
        severity: 'error',
      });
    }
  }, [chat, deleteChat, fromTab, navigate]);

  const handleStoryChapterClick = useCallback(async (chapter: StoryChapterState) => {
    const messageId = chapter.startMessageId;
    if (!id || !messageId) return;
    if (chapter.openedAt) {
      await loadMessages(id, { aroundTimestamp: chapter.openedAt, limit: CHAT_MESSAGE_WINDOW_SIZE * 2 });
      await waitForNextFrame();
    }
    setMessageScrollRequest({
      key: `story-chapter:${chapter.id}:${messageId}:${chapter.openedAt || 0}:${Date.now()}`,
      messageId,
      offsetTop: isSplitDetailPane ? 84 : 96,
      sourceTimestamp: chapter.openedAt,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      highlight: true,
    });
    logDeveloperDiagnostic('story-chapter:jump-request', {
      chatId: id,
      chapterId: chapter.id,
      startMessageId: chapter.startMessageId,
      openedAt: chapter.openedAt,
    }, 'info');
  }, [id, isSplitDetailPane, loadMessages]);

  useEffect(() => {
    if (!id) return;
    const params = new URLSearchParams(location.search);
    const messageId = params.get('messageId') || '';
    const aroundTimestamp = params.get('aroundTimestamp');
    if (!messageId && !aroundTimestamp) return;
    const timestamp = aroundTimestamp !== null ? Number(aroundTimestamp) : undefined;
    if (aroundTimestamp !== null && !Number.isFinite(timestamp)) return;
    let cancelled = false;
    void (async () => {
      if (timestamp !== undefined) {
        await loadMessages(id, { aroundTimestamp: timestamp, limit: CHAT_MESSAGE_WINDOW_SIZE * 2 });
        await waitForNextFrame();
      }
      if (cancelled) return;
      setMessageScrollRequest({
        key: `chat-search:${id}:${messageId || timestamp || 0}:${Date.now()}`,
        messageId: messageId || '',
        offsetTop: isSplitDetailPane ? 84 : 96,
        sourceTimestamp: timestamp,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        highlight: true,
      });
      params.delete('messageId');
      params.delete('aroundTimestamp');
      const nextSearch = params.toString();
      navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ''}`, { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isSplitDetailPane, loadMessages, location.pathname, location.search, navigate]);

  const handleMessageScrollRequestResolved = useCallback((request: MessageListScrollRequest, resolved: boolean) => {
    if (resolved) {
      setMessageScrollRequest((current) => current?.key === request.key ? null : current);
      return;
    }
    if (request.key.startsWith('branch-switch:') || request.key.startsWith('branch-create:')) {
      logDeveloperDiagnostic('chat-scroll:branch-restore-miss', {
        chatId: id,
        requestKey: request.key,
        messageId: request.messageId,
        sourceTimestamp: request.sourceTimestamp,
      }, 'debug', 'message-window');
      return;
    }
    if (request.key.startsWith('chat-search:')) {
      setSnackbar({ open: true, message: '没有定位到这条搜索结果；当前消息窗口或云端分页里缺少对应消息。', severity: 'error' });
      logDeveloperDiagnostic('chat-scroll:search-request-miss', {
        chatId: id,
        requestKey: request.key,
        messageId: request.messageId,
        sourceTimestamp: request.sourceTimestamp,
      }, 'warn');
      return;
    }
    setSnackbar({ open: true, message: '没有定位到章节起点；当前消息窗口或云端分页里缺少对应消息。', severity: 'error' });
    logDeveloperDiagnostic('chat-scroll:request-miss', {
      chatId: id,
      requestKey: request.key,
      messageId: request.messageId,
      sourceTimestamp: request.sourceTimestamp,
    }, 'warn');
  }, [id, setSnackbar]);

  const canAutoRunConversation = chat?.type !== 'direct' && chat?.type !== 'ai_direct' && !chatInteractionDisabled;

  const handleMessageListBottomPinnedChange = useCallback((pinned: boolean) => {
    isStoryReaderAtTailRef.current = pinned;
    setIsStoryReaderAtTail(pinned);
  }, []);

  const handleMessageListNearBottomChange = useCallback((nearBottom: boolean) => {
    if (!nearBottom) return;
    isStoryReaderAtTailRef.current = true;
    setIsStoryReaderAtTail(true);
    setHasStoryReaderReachedTailIntent(true);
    setIsExplicitContinuationScrollFollowSuspended(false);
  }, []);

  const persistStoryReadingPosition = useCallback((chatId: string, position: MessageListScrollPosition, key: string) => {
    const roundedOffsetTop = Math.round(position.offsetTop);
    const previousStored = chatReadingPositions[chatId];
    lastReadingPositionPersistRef.current = { chatId, key, at: Date.now() };
    logDeveloperDiagnostic('故事阅读保存：写入UIStore', {
      chatId,
      next: {
        messageId: position.messageId,
        offsetTop: roundedOffsetTop,
        pinned: position.pinned,
        sourceTimestamp: position.sourceTimestamp,
      },
      previous: previousStored ? {
        messageId: previousStored.messageId,
        offsetTop: previousStored.offsetTop,
        pinned: previousStored.pinned,
        sourceTimestamp: previousStored.sourceTimestamp,
        updatedAt: previousStored.updatedAt,
      } : null,
    }, 'info', 'chat-scroll');
    logDeveloperDiagnostic('chat-scroll:save-position', {
      chatId,
      messageId: position.messageId,
      offsetTop: roundedOffsetTop,
      pinned: position.pinned,
      sourceTimestamp: position.sourceTimestamp,
    }, 'debug');
    setChatReadingPosition(chatId, {
      messageId: position.messageId,
      offsetTop: roundedOffsetTop,
      pinned: position.pinned,
      sourceTimestamp: position.sourceTimestamp,
    });
  }, [chatReadingPositions, setChatReadingPosition]);

  const handleStoryReadingPositionChange = useCallback((position: MessageListScrollPosition) => {
    if (!id || !isStoryRoom) return;
    const roundedOffsetTop = Math.round(position.offsetTop);
    const key = `${position.messageId}:${roundedOffsetTop}:${position.pinned ? '1' : '0'}`;
    const now = Date.now();
    const previous = lastReadingPositionPersistRef.current;
    if (previous?.chatId === id && previous.key === key) return;

    const persistPendingPosition = () => {
      readingPositionPersistTimerRef.current = null;
      const pending = pendingReadingPositionPersistRef.current;
      pendingReadingPositionPersistRef.current = null;
      if (!pending || pending.chatId !== id) return;
      persistStoryReadingPosition(pending.chatId, pending.position, pending.key);
    };
    const elapsed = previous?.chatId === id ? now - previous.at : STORY_READING_POSITION_SAVE_MS;
    if (elapsed >= STORY_READING_POSITION_SAVE_MS) {
      if (readingPositionPersistTimerRef.current) {
        clearTimeout(readingPositionPersistTimerRef.current);
        readingPositionPersistTimerRef.current = null;
      }
      pendingReadingPositionPersistRef.current = null;
      persistStoryReadingPosition(id, position, key);
      return;
    }

    pendingReadingPositionPersistRef.current = { chatId: id, key, position };
    if (readingPositionPersistTimerRef.current) return;
    readingPositionPersistTimerRef.current = setTimeout(persistPendingPosition, STORY_READING_POSITION_SAVE_MS - elapsed);
  }, [id, isStoryRoom, persistStoryReadingPosition]);

  useEffect(() => () => {
    if (readingPositionPersistTimerRef.current) clearTimeout(readingPositionPersistTimerRef.current);
  }, []);

  useEffect(() => {
    if (!readingPositionPersistTimerRef.current) return;
    clearTimeout(readingPositionPersistTimerRef.current);
    readingPositionPersistTimerRef.current = null;
    pendingReadingPositionPersistRef.current = null;
  }, [id]);

  useEffect(() => {
    const effectiveStoryReaderAtTail = resolveEffectiveStoryReaderAtTail({
      isStoryReaderAtTail,
      hasSavedNonTailStoryReadingPosition,
      hasStoryReaderReachedTailIntent,
    });
    if (!shouldAutoStartStoryRoom({
      hasChat: Boolean(chat),
      hasChatId: Boolean(id),
      canAutoRunConversation: Boolean(canAutoRunConversation),
      isStoryRoom,
      isStoryReaderAtTail: effectiveStoryReaderAtTail,
      isRunning,
      isPaused,
      isStoryWaitingForChoice,
      isStoryChoiceSubmitting: isCurrentStoryChoiceSubmitting,
      hasUserDraft: hasStoryUserDraft,
      hasRunLoopError: Boolean(chatError || runLoopError),
      canAutoContinueFromTail: sessionScrollCapabilities.autoContinueFromTail,
    })) return;
    if (!chat || !id) return;
    setIsStoryGenerationCancelled(false);
    logDeveloperDiagnostic('story-run:auto-tail-start', {
      chatId: id,
      phase: chat.scenarioState?.phase || null,
      isStoryReaderAtTail: effectiveStoryReaderAtTail,
      rawStoryReaderAtTail: isStoryReaderAtTail,
      hasSavedNonTailStoryReadingPosition,
      hasStoryReaderReachedTailIntent,
      hasUserDraft: hasStoryUserDraft,
      autoStickToBottom: sessionScrollCapabilities.autoStickToBottom,
      autoContinueFromTail: sessionScrollCapabilities.autoContinueFromTail,
      storyChoiceGate,
    }, 'info');
    resume();
    const startBlockReason = startConversationLoopIfNeeded(chat);
    if (startBlockReason) {
      logDeveloperDiagnostic('story-run:auto-tail-blocked', {
        chatId: id,
        blockReason: startBlockReason,
        phase: chat.scenarioState?.phase || null,
        storyChoiceGate,
      }, startBlockReason === 'waiting_story_choice' ? 'info' : 'warn');
    }
  }, [canAutoRunConversation, chat, chatError, hasSavedNonTailStoryReadingPosition, hasStoryReaderReachedTailIntent, hasStoryUserDraft, id, isCurrentStoryChoiceSubmitting, isPaused, isRunning, isStoryReaderAtTail, isStoryRoom, isStoryWaitingForChoice, resume, runLoopError, sessionScrollCapabilities.autoContinueFromTail, sessionScrollCapabilities.autoStickToBottom, startConversationLoopIfNeeded, storyChoiceGate]);

  const handleHeaderPrimaryAction = useCallback(() => {
    if (!chat || !id || !canAutoRunConversation) return;
    if (isDirectReplyPending) {
      handleStopDirectReply();
      return;
    }
    logDeveloperDiagnostic('chat-run:button', {
      chatId: id,
      phase: chat.scenarioState?.phase || null,
      isRunning,
      isPaused,
      isStoryWaitingForChoice,
      visibleChoiceCount: visibleStoryBranchOptions.length,
      storyChoiceGate,
    }, 'info');
    const blockReason = getConversationLoopStartBlockReason({
      conversationType: chat.type,
      isRunning,
      isPaused,
      isStoryChoiceBlocked: isStoryWaitingForChoice,
      hasActiveLoop: false,
    });
    if (blockReason === 'waiting_story_choice') {
      isRunningRef.current = false;
      isPausedRef.current = false;
      stop();
      void updateChat(id, { isActive: false });
      setSnackbar({
        open: true,
        message: storyChoiceGate.mismatch === 'runtime_without_visible_options'
          ? '剧情等待选择，但当前没有可见选项，请查看开发者日志。'
          : '请先选择一个剧情走向',
        severity: 'error',
      });
      return;
    }
    if (!isRunning || isPaused) {
      setIsStoryGenerationCancelled(false);
      resume();
      const startBlockReason = startConversationLoopIfNeeded(chat);
      if (startBlockReason) {
        setSnackbar({
          open: true,
          message: startBlockReason === 'waiting_story_choice'
            ? '请先选择一个剧情走向'
            : '当前会话暂时不能开始运行，请查看开发者日志。',
          severity: 'error',
        });
      }
    } else {
      if (isStoryRoom) setIsStoryGenerationCancelled(true);
      cancelActiveConversationLoop(isStoryRoom ? 'story_header_cancelled' : 'header_cancelled');
    }
  }, [canAutoRunConversation, cancelActiveConversationLoop, chat, handleStopDirectReply, id, isDirectReplyPending, isPaused, isRunning, isStoryRoom, isStoryWaitingForChoice, resume, setSnackbar, startConversationLoopIfNeeded, stop, storyChoiceGate, updateChat, visibleStoryBranchOptions.length]);

  const headerPrimaryActionButton = canAutoRunConversation && !isStoryRoom && !isStudyRoom ? (
    <IconButton onClick={handleHeaderPrimaryAction} color={isDirectReplyPending || (isRunning && !isPaused) ? 'primary' : 'default'}
      aria-label={isDirectReplyPending ? '停止回复' : isRunning && !isPaused ? '暂停群聊' : '继续群聊'}>
      {isDirectReplyPending || (isRunning && !isPaused) ? <PauseIcon /> : <PlayIcon />}
    </IconButton>
  ) : null;

  useEffect(() => {
    setHideMobileBottomNav(true);
    return () => setHideMobileBottomNav(false);
  }, [setHideMobileBottomNav]);

  if (!chat && currentChatMessages.length > 0) {
    return (
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, height: '100%', overflow: 'hidden', position: 'relative' }}>
        <GlassHeader
          title={detailBootstrapComplete
            ? (isZh ? '本地聊天记录' : 'Local messages')
            : (isZh ? '本地聊天记录 · 后台同步中' : 'Local messages · syncing')}
          leading={(
            <IconButton onClick={() => navigate('/chats')}>
              <ArrowBackIcon />
            </IconButton>
          )}
        />
        <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 1 }}>
          <MessageList
            key={id}
            messages={visibleChatMessages}
            characters={characters}
            selfMemberId={effectiveAiDirectPerspectiveMemberId}
            currentUser={currentUser ? { nickname: currentUser.nickname, avatar: currentUser.avatar } : undefined}
            onCreateRevision={undefined}
            onSwitchRevision={undefined}
            branchVersionInfoByMessageId={branchVersionInfoByMessageId}
            isLoadingOlder={isLoadingOlder}
            isLoadingNewer={isLoadingNewer}
            hasMore={hasMore}
            hasMoreNewer={hasMoreNewer}
            onReachTop={handleNearTop}
            onReachBottom={handleNearBottom}
            onJumpToConversationBottom={handleJumpToConversationBottom}
            loadingText={t('common.loading')}
            topHint="没有更早的消息"
            topInset={isSplitDetailPane ? { xs: '68px', sm: '68px' } : { xs: 'calc(80px + env(safe-area-inset-top, 0px))', sm: '72px' }}
            bottomInset={{ xs: '24px', sm: '24px' }}
            readOnly
          />
        </Box>
      </Box>
    );
  }

  if (!chat) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', flex: 1, width: '100%', height: '100%', minHeight: 0, p: 3 }}>
        {!isRemoteDeletedChat && (chatsLoading || !detailBootstrapComplete) ? (
          <LoadingState title="正在打开会话" compact />
        ) : (
          <Box sx={{ display: 'grid', gap: 1.5, justifyItems: 'center', textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              {isRemoteDeletedChat ? '这个会话已在其他设备删除' : '未找到这个会话'}
            </Typography>
            {isRemoteDeletedChat ? (
              <Button size="small" variant="outlined" onClick={() => navigate('/settings/recycle-bin')}>
                查看回收站
              </Button>
            ) : null}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <Box sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
        display: 'block',
        position: 'relative',
        bgcolor: 'background.default',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage: (theme) => theme.palette.mode === 'light'
            ? 'repeating-linear-gradient(0deg, rgba(15,23,42,0.030) 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, rgba(15,23,42,0.024) 0 1px, transparent 1px 28px)'
            : 'repeating-linear-gradient(0deg, rgba(226,232,240,0.030) 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, rgba(226,232,240,0.024) 0 1px, transparent 1px 28px)',
        },
      }}>
        <ChatBackground url={groupBackgroundUrl} opacity={groupBackgroundOpacity} />
        <GlassHeader
          title={(
            <Box
              component="button"
              type="button"
              onClick={(event) => openChatPreview(event.currentTarget)}
              sx={{
                minWidth: 0,
                maxWidth: '100%',
                p: 0,
                m: 0,
                border: 0,
                bgcolor: 'transparent',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                justifyContent: 'center',
                minHeight: 40,
              }}
            >
              <Typography variant="subtitle1" sx={{ maxWidth: '100%', fontWeight: 700, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {chat.name}
              </Typography>
            </Box>
          )}
          safeAreaTop={!isSplitDetailPane}
          zIndex={4}
          leading={!isSplitDetailPane ? (
            <IconButton onClick={handleHeaderBack} sx={{ flexShrink: 0 }}>
                <ArrowBackIcon />
            </IconButton>
          ) : null}
          actions={chatInteractionDisabled ? (
            relationshipInitializationBlocked && !isAssistantChat ? (
              <IconButton onClick={() => navigate(`/chats/${chat.id}/edit`)} aria-label="编辑群聊">
                <InfoIcon />
              </IconButton>
            ) : null
          ) : (
            <>
              {isAssistantChat ? null : headerPrimaryActionButton}
              {isAssistantChat ? (
                <IconButton onClick={toggleRightPanel} aria-label="打开助手能力面板">
                  <ExtensionOutlinedIcon />
                </IconButton>
              ) : null}
              {!isAssistantChat ? (
                <IconButton onClick={toggleRightPanel}>
                <PeopleIcon />
                </IconButton>
              ) : null}
              {!isAssistantChat ? <IconButton onClick={() => navigate(`/chats/${chat.id}/edit`)}>
                <InfoIcon />
              </IconButton> : null}
            </>
          )}
        />
        {storyTailStatusBar}
        <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 1 }}>
          {relationshipInitializationBlocked ? (
            <Box sx={{ position: 'absolute', top: { xs: 'calc(80px + env(safe-area-inset-top, 0px))', sm: 72 }, left: 0, right: 0, zIndex: 3, display: 'flex', justifyContent: 'center', px: 2, pointerEvents: 'none' }}>
              <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 0.8, px: 1.25, py: 0.65, borderRadius: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', boxShadow: 1 }}>
                {relationshipInitializationFailed ? null : <CircularProgress size={14} />}
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {relationshipInitializationFailed ? '初始化未完成' : '正在初始化'}
                </Typography>
              </Box>
            </Box>
          ) : null}
          {shouldDelayStoryMessageListForRestore ? null : <MessageList
            key={id}
            messages={visibleChatMessages}
            characters={characters}
            currentUser={currentUser ? { nickname: currentUser.nickname, avatar: currentUser.avatar } : undefined}
            onCreateRevision={isMessageBranchingEnabled(chat) && !chatInteractionDisabled ? handleCreateMessageRevision : undefined}
            onRegenerate={isMessageBranchingEnabled(chat) && !chatInteractionDisabled ? handleRegenerateAssistant : undefined}
            onSwitchRevision={isMessageBranchingEnabled(chat) ? handleSwitchMessageRevision : undefined}
            branchVersionInfoByMessageId={branchVersionInfoByMessageId}
            onDeleteMessage={deleteMessage}
            onWithdrawMessage={withdrawMessage}
            onAnalyzeMessage={analyzeMessage}
            onExpressionFeedback={handleExpressionFeedback}
            onRetryMedia={handleRetryMedia}
            onAddImagesToReference={handleAddImagesToReference}
            onCharacterAvatarClick={openCharacterPreview}
            onMentionCharacter={chatInteractionDisabled ? undefined : handleMentionCharacter}
            onOpenArtifact={isAssistantChat || isLearningProgressRoom ? handleOpenAssistantArtifact : undefined}
            onOpenHtmlFullscreen={chat && (isAssistantChat || hasRoomCapability(chat, 'html-interactive')) ? handleOpenAssistantHtmlFullscreen : undefined}
            onHtmlAutosave={(isAssistantChat || isLearningProgressRoom) && !chatInteractionDisabled ? handleHtmlAutosave : undefined}
            onHtmlSubmit={(isAssistantChat || isLearningProgressRoom) && !chatInteractionDisabled ? handleHtmlSubmit : undefined}
            onHtmlRepair={isAssistantChat && !chatInteractionDisabled ? handleHtmlRepair : undefined}
            onConfirmWorkspaceMutationPlan={!chatInteractionDisabled ? confirmWorkspaceMutationPlan : undefined}
            selfMemberId={effectiveAiDirectPerspectiveMemberId}
            onReachTop={handleNearTop}
            onReachBottom={handleNearBottom}
            onJumpToConversationBottom={handleJumpToConversationBottom}
            isLoadingOlder={isLoadingOlder}
            isLoadingNewer={isLoadingNewer}
            hasMore={hasMore}
            hasMoreNewer={hasMoreNewer}
            loadingText={t('common.loading')}
            topHint="没有更早的消息"
            topInset={isSplitDetailPane ? { xs: '68px', sm: '68px' } : { xs: 'calc(80px + env(safe-area-inset-top, 0px))', sm: '72px' }}
            bottomInset={messageListBottomInset}
            emptyContent={isStoryRoom && storyRoomOpeningPreview ? <StoryRoomOpeningEmptyState preview={storyRoomOpeningPreview} /> : undefined}
            privateConversation={chat.type !== 'group'}
            tailContent={undefined}
            storyChoiceMessageId={displayedStoryChoiceMessageId}
            storyChoiceOptions={displayedStoryChoiceOptions}
            storyChoiceSubmittingValue={displayedStoryChoiceSubmittingValue}
            onChooseStoryChoice={!chatInteractionDisabled && isStoryWaitingForChoice ? handleChooseStoryBranch : undefined}
            onBottomPinnedChange={isStoryRoom ? handleMessageListBottomPinnedChange : undefined}
            onNearBottomChange={isStoryRoom ? handleMessageListNearBottomChange : undefined}
            initialScrollPosition={isStoryRoom ? initialStoryReadingPosition : initialChatNavigationPosition}
            scrollRequest={messageScrollRequest}
            onScrollRequestResolved={handleMessageScrollRequestResolved}
            onScrollPositionChange={isStoryRoom ? handleStoryReadingPositionChange : handleChatNavigationPositionChange}
            narrativeRevealMessageKeys={narrativeRevealMessageKeys}
            onNarrativeRevealComplete={clearNarrativeRevealMessage}
            autoStickToBottom={sessionScrollCapabilities.autoStickToBottom}
            readOnly={chatInteractionDisabled}
          />}
        </Box>
        {chatInteractionDisabled ? (
          <Box sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 3,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            px: { xs: 1.5, sm: 2.5, md: 3 },
            pt: 1,
            pb: 'calc(env(safe-area-inset-bottom, 0px) + 14px)',
            pointerEvents: 'none',
            '& > *': { pointerEvents: 'auto' },
          }}>
            <Box role="status" sx={{
              width: '100%',
              maxWidth: 760,
              mx: 'auto',
              p: { xs: 0.85, sm: 1 },
              borderRadius: 3,
              border: '1px solid',
              borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.10)' : 'rgba(226,232,240,0.12)',
              bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.64)' : 'rgba(13,15,22,0.50)',
              backdropFilter: (theme) => theme.palette.mode === 'light' ? 'blur(24px) saturate(1.10)' : 'blur(22px) saturate(1.04)',
              WebkitBackdropFilter: (theme) => theme.palette.mode === 'light' ? 'blur(24px) saturate(1.10)' : 'blur(22px) saturate(1.04)',
              boxShadow: (theme) => theme.palette.mode === 'light'
                ? '0 18px 42px rgba(15,23,42,0.12), 0 1px 0 rgba(255,255,255,0.72) inset'
                : '0 18px 44px rgba(0,0,0,0.30), 0 1px 0 rgba(255,255,255,0.10) inset',
            }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.75, minHeight: 28, textAlign: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.4, overflowWrap: 'anywhere', opacity: readOnlyEmphasis ? 1 : 0.58, transition: 'opacity 900ms ease' }}>
                  {chatReadOnlyReason}
                </Typography>
                {relationshipInitializationFailed ? (
                  <Button size="small" variant="text" onClick={() => void updateChat(chat.id, {
                    modeState: {
                      ...chat.modeState,
                      initialization: createConversationInitializationState('running', relationshipInitialization.fingerprint),
                    },
                  })}>
                    重试
                  </Button>
                ) : null}
                <Tooltip
                  arrow
                  enterDelay={450}
                  describeChild
                  title={isRemoteDeletedChat
                    ? '当前仅保留本地只读历史；已停止自动生成和新消息提交。'
                    : relationshipInitializationBlocked
                      ? '初始化完成后会自动恢复聊天。'
                      : '当前仅可查看历史消息；修复或恢复角色后才能继续聊天。'}
                >
                  <HelpOutlineIcon aria-label="查看只读状态说明" sx={{ fontSize: 17, color: 'text.secondary', opacity: readOnlyEmphasis ? 0.85 : 0.48, transition: 'opacity 900ms ease', flexShrink: 0 }} />
                </Tooltip>
              </Box>
            </Box>
          </Box>
        ) : <Box
          ref={composerDockRef}
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: { xs: `${keyboardInset}px`, sm: 0 },
            zIndex: 2,
            display: 'grid',
            gap: 0.75,
            transition: transition(['transform', 'opacity'], motion.durations.slow, motion.emphasized),
            transformOrigin: '50% 100%',
            '@media (prefers-reduced-motion: reduce)': {
              transition: 'none',
            },
          }}
        >
          {htmlRepairErrorContent ? (
            <Box sx={{ width: '100%', maxWidth: 760, mx: 'auto', px: { xs: 1.5, sm: 2.5, md: 3 } }}>
              {htmlRepairErrorContent}
            </Box>
          ) : null}
          <SessionComposerHost
            key={chat.id}
            chatId={chat.id}
            isStoryRoom={isStoryRoom}
            draftActorId={effectiveSpeakAsChar?.id}
            mentionCharacters={activeMembers}
            inputHandleRef={composerInputRef}
            surfaces={effectiveComposerSurfaces}
            speakAsCharacterName={effectiveSpeakAsChar?.name}
            onCloseSpeakAs={effectiveSpeakAsChar && chat.type !== 'ai_direct' ? () => setSpeakAsCharacter(null) : undefined}
            sendingLabel="等待角色发言结束"
            composerState={isDirectReplyPending || (isRunning && !isPaused && (thinkingId || hasPendingTurnWork()))
              ? { phase: 'generating', label: 'AI 正在处理…', canSend: false, canDraft: true, canCancel: true }
              : { phase: 'idle', canSend: true, canDraft: true, canCancel: false }}
            hideSpeakAsChip={chat.type === 'ai_direct'}
            inputCapabilities={effectiveTextInputCapabilities}
            inputCapabilityWarning={effectiveTextInputCapabilityWarning}
            autoFocus={isAssistantChat && !isMobile}
            topContent={composerTopContent}
            injectedAttachments={composerInjectedAttachments}
            onInjectedAttachmentsConsumed={() => setComposerInjectedAttachments([])}
            onStopReply={isDirectReplyPending
              ? handleStopDirectReply
              : () => cancelActiveConversationLoop('composer_generation_cancelled')}
            // 右侧面板按钮固定在标题栏右上角；保留 composer 内部入口参数以兼容旧移动端布局。
            onOpenPanel={undefined}
            disabled={chatInteractionDisabled}
            disabledReason={chatReadOnlyReason}
            onDraftActivity={(activity) => {
              userDraftActivityRef.current = activity;
              if (isStoryRoom) setHasStoryUserDraft(Boolean(activity.hasDraft));
              if (activity.hasDraft && openingLoopRef.current) {
                openingLoopRef.current = false;
                openingSuppressedRef.current = true;
                if (isRunningRef.current) cancelActiveConversationLoop('user_started_before_opening');
              }
            }}
            onSubmitText={(submission, surface) => {
              if (shouldRouteTextAsStoryCustomDirection({
                isStoryRoom,
                hasSpeakAsCharacter: Boolean(effectiveSpeakAsChar),
                hasGuideTargetMember: Boolean(guideTargetMember),
                content: submission.content,
              })) {
                return handleStoryCustomDirectionSend(submission.content, submission.attachments || [], submission.mentions || []);
              }
              if (!effectiveSpeakAsChar && guideTargetMember && surface.mode === 'guide') {
                const guidedContent = `${guideTargetMember.name}，${submission.content}`;
                setGuideTargetMemberId(null);
                return normalizeAndRunSurfaceIntent(surface, { ...submission, content: guidedContent, actorId: guideTargetMember.id,
                  mentions: submission.mentions?.map((mention) => ({ ...mention, start: mention.start + guideTargetMember.name.length + 1, end: mention.end + guideTargetMember.name.length + 1 })) });
              }
              const effectiveSurface = effectiveSpeakAsChar ? { ...surface, mode: 'speakAs' as const, actorId: effectiveSpeakAsChar.id } : surface;
              const effectiveSubmission = effectiveSpeakAsChar ? { ...submission, actorId: effectiveSpeakAsChar.id } : submission;
              return normalizeAndRunSurfaceIntent(effectiveSurface, effectiveSubmission);
            }}
            onSendError={showErrorToast}
            onSubmitForm={(submission, surface) => {
              return normalizeAndRunSurfaceIntent(surface, submission);
            }}
            onSubmitBoard={(submission, surface) => {
              return normalizeAndRunSurfaceIntent(surface, submission);
            }}
          />
        </Box>}
      </Box>

      {(isAssistantChat || (chat && hasRoomCapability(chat, 'html-interactive'))) && fullscreenAssistantArtifactId ? (
        <Suspense fallback={null}>
          <AssistantHtmlFullscreenDialog
            artifactId={fullscreenAssistantArtifactId}
            onClose={handleCloseAssistantHtmlFullscreen}
            onAutosave={handleHtmlAutosave}
          onSubmit={handleHtmlSubmit}
          onRepair={handleHtmlRepair}
          />
        </Suspense>
      ) : null}

      {(chatInteractionDisabled && !relationshipInitializationBlocked) || ((isAssistantChat || isLearningProgressRoom || chat?.modeState.agentCapabilities?.enabled) && !rightPanelOpen) ? null : <RightPanel
        title={isAssistantChat ? '助手能力' : isLearningProgressRoom ? '学习资料' : sidebarTitle}
        hideMobileTitle
        desktopMaxWidth={isSplitDetailPane ? 340 : 420}
        desktopViewportRatio={isSplitDetailPane ? 0.28 : 0.34}
        titleActions={(
          <>
            <IconButton size="small" aria-label="聊天页设置" onClick={() => setChatPageSettingsOpen(true)}>
              <SettingsIcon fontSize="small" />
            </IconButton>
            {isAssistantChat ? (
              <IconButton size="small" aria-label="删除助手" color="error" onClick={() => void handleDeleteAssistantChat()}>
                <DeleteOutlineOutlinedIcon fontSize="small" />
              </IconButton>
            ) : null}
          </>
        )}
      >
        <PageSection spacing={2} fill animate={false}>
          {!isLearningProgressRoom ? <SessionInfoCards cards={globalSessionInfoCards} onOpenChat={(chatId) => navigate(`/chats/${chatId}`)} /> : null}
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <LazyPanel>
            {isAssistantChat || isLearningProgressRoom || chat?.modeState.agentCapabilities?.enabled ? (
                <Suspense fallback={<LoadingState title="正在加载" compact />}>
                  <AssistantAgentPanel
                    chat={chat}
                    selectedArtifactId={selectedAssistantArtifactId}
                    onSelectedArtifactChange={setSelectedAssistantArtifactId}
                    onHtmlAutosave={handleHtmlAutosave}
                    onHtmlSubmit={handleHtmlSubmit}
                    onHtmlRepair={handleHtmlRepair}
                    onAgentEnabledChange={agentEntitled ? (enabled) => {
                      writeAssistantAgentDefaultEnabled(enabled);
                      const aiSearchAvailable = authMode === 'cloud' && currentUser?.aiSearchEntitled === true;
                      void updateChat(chat.id, {
                        modeState: {
                          ...chat.modeState,
                          agentCapabilities: {
                            ...(chat.modeState.agentCapabilities || {}), enabled, chatArtifactRead: enabled, chatArtifactWrite: enabled, fileUpload: enabled, fileDownload: enabled, workspaceRead: enabled, webSearch: enabled && aiSearchAvailable, updatedAt: Date.now(),
                          },
                          assistantCapabilities: {
                            ...(chat.modeState.assistantCapabilities || {}),
                            agent: enabled,
                            artifacts: enabled,
                            webSearch: enabled && aiSearchAvailable ? true : false,
                            webSearchUserDisabled: false,
                            updatedAt: Date.now(),
                          },
                        },
                      });
                    } : undefined}
                  />
                </Suspense>
              ) : runtimePanelLoading ? <LoadingState title="正在加载" compact /> : <ChatSidebarPanel
                chat={projectedSidebarChat || { ...chat, primaryRecentEvent: projectedRuntimeState?.primaryRecentEvent }}
                members={members}
                messages={sidebarMessages}
                thinkingId={thinkingId}
                rightPanelTab={sidebarTabValue}
                setRightPanelTab={handleSidebarTabChange}
                showMemberTab={showMemberTab}
                showRuntimeTab={showRuntimeTab}
                memberPanelTitle={memberTabTitle}
                runtimePanelTitle={runtimeTabTitle}
                showSessionTab={showSessionTab}
                sessionPanel={showSessionTab && visibleSessionPanelActions.length ? (
                  <LazyPanel>
                    <SessionActionPanel title={sessionActionPanelTitle} actions={visibleSessionPanelActions} onRunAction={runSessionAction} frameless />
                  </LazyPanel>
                ) : null}
                sessionPanelTitle={sessionTabTitle}
                memberFooter={aiDirectSourceInfoCards.length ? (
                  <SessionInfoCards cards={aiDirectSourceInfoCards} onOpenChat={(chatId) => navigate(`/chats/${chatId}`)} />
                ) : null}
                privatePayloads={projectedDetailState?.sidebarChat.privatePayloads || privatePayloads}
                privatePayloadTitle={projectedDetailState?.privatePayloadTitle}
                directMemoryContext={directMemoryPanelContext}
                showActivityTab={showActionTab}
                activityPanel={showActionTab ? (
                  <LazyPanel>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'stretch' }}>
                      <WorldCalendarPanel
                        chats={chats}
                        characters={characters}
                        updateChat={updateChat}
                        isZh={isZh}
                        conversationId={chat.id}
                        compact
                        title="会话日历"
                        subtitle="世界事件驱动的会话活动时间线"
                        showHeader={false}
                      />
                      {chatShareAvailable ? <ChatSharePanel chat={chat} /> : null}
                      {visibleActivityPanelActions.length ? (
                        <SessionActionPanel title="派生动作" actions={visibleActivityPanelActions} onRunAction={runSessionAction} hideHeader frameless />
                      ) : null}
                    </Box>
                  </LazyPanel>
                ) : null}
                onSpeakAs={(charId) => {
                  setGuideTargetMemberId(null);
                  setSpeakAsCharacter(charId);
                }}
                onGuideMember={chat.type === 'group' ? (charId) => {
                  setSpeakAsCharacter(null);
                  setGuideTargetMemberId(charId);
                } : undefined}
                onSetPerspectiveMember={chat.type === 'ai_direct' ? (charId) => {
                  setAiDirectPerspectiveMemberId(charId);
                } : undefined}
                perspectiveMemberId={effectiveAiDirectPerspectiveMemberId}
                onStartDirectChat={chat.type === 'group' ? handleStartDirectChat : undefined}
                onRemoveMember={chat.type === 'group' ? async (charId) => {
                  const newMembers = chat.memberIds.filter((m) => m !== charId);
                  if (newMembers.length < 2) return;
                  const removedName = members.find((member) => member.id === charId)?.name || charId;
                  await updateChat(chat.id, { memberIds: newMembers });
                  await appendMembershipNotice(`${removedName} 离开群聊`);
                } : undefined}
                onUpdateSeats={chat.type === 'group' ? async (memberIds) => {
                  const previousMembers = new Set(chat.memberIds);
                  const nextMembers = new Set(memberIds);
                  const addedMembers = memberIds.filter((memberId) => !previousMembers.has(memberId));
                  const removedMembers = chat.memberIds.filter((memberId) => !nextMembers.has(memberId));
                  await updateChat(chat.id, {
                    memberIds,
                    scenarioState: {
                      ...chat.scenarioState,
                      seats: memberIds.map((memberId, index) => {
                        const existing = chat.scenarioState?.seats?.find((seat) => seat.actorId === memberId);
                        return {
                          seatId: existing?.seatId || `seat-${index + 1}`,
                          seatIndex: index,
                          actorId: memberId,
                          roleId: existing?.roleId || null,
                          teamId: existing?.teamId || null,
                          displayName: existing?.displayName,
                        };
                      }),
                      turnOrder: memberIds,
                    },
                    layoutState: {
                      slots: memberIds.map((memberId, index) => ({
                        slotId: `slot-${index + 1}`,
                        x: index,
                        y: 0,
                        actorId: memberId,
                      })),
                    },
                  });
                  if (addedMembers.length) {
                    const names = addedMembers.map((memberId) => members.find((member) => member.id === memberId)?.name || memberId);
                    await appendMembershipNotice(`${names.join('、')} 加入群聊`);
                  }
                  if (removedMembers.length) {
                    const names = removedMembers.map((memberId) => members.find((member) => member.id === memberId)?.name || memberId);
                    await appendMembershipNotice(`${names.join('、')} 离开群聊`);
                  }
                } : undefined}
                onRefreshRelationships={chat.type === 'group' ? handleRefreshGroupRelationships : undefined}
                onUpdateSharedRelationshipFacts={chat.type === 'group' ? handleUpdateSharedRelationshipFacts : undefined}
                onStoryChapterClick={handleStoryChapterClick}
              />}
            </LazyPanel>
          </Box>
        </PageSection>
      </RightPanel>}
      <ChatPageSettingsDialog
        open={chatPageSettingsOpen}
        onClose={() => setChatPageSettingsOpen(false)}
        isStoryRoom={isStoryRoom}
        chat={chat}
        updateChat={updateChat}
        isAssistantChat={isAssistantChat}
        onCloseAssistantPanel={isAssistantChat ? () => setRightPanelOpen(false) : undefined}
      />

      {analysisDialogOpen ? (
        <LazyPanel>
          <MessageAnalysisDialog
            open={analysisDialogOpen}
            target={analysisTarget}
            members={members}
            text={analysisText}
            loading={analysisLoading}
            error={analysisError}
            onClose={closeAnalysisDialog}
          />
        </LazyPanel>
      ) : null}

      {profilePreview ? (
        <LazyPanel>
          <ProfilePreviewOverlay
            open
            kind={profilePreview.kind}
            anchorRect={profilePreview.anchorRect}
            anchorElement={profilePreview.anchorElement}
            character={profilePreview.kind === 'character' ? profilePreview.character : null}
            chat={chat}
            members={members}
            chatStatusLabel={isRunning && !isPaused ? '运行中' : isWaitingForInput ? '已停止 · 等待用户输入' : chat.isActive ? '已暂停' : '未运行'}
            actionLabel={profilePreview.kind === 'character' ? '角色详情' : '群聊详情'}
            actionTiming="immediate"
            onSendMessage={profilePreview.kind === 'character' ? async () => {
              if (await handleStartDirectChat(profilePreview.character.id)) setProfilePreview(null);
            } : undefined}
            onAction={() => {
              if (profilePreview.kind === 'character') {
                navigate(`/characters/${profilePreview.character.id}/edit?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
                return;
              }
              navigate(`/chats/${chat.id}/edit`);
            }}
            onClose={() => setProfilePreview(null)}
          />
        </LazyPanel>
      ) : null}

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={closeSnackbar}
        severity={snackbar.severity}
        message={snackbar.message}
        offset="composer"
      />
    </Box>
  );
}
