import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import {
  Alert, Box, Typography, Button, Dialog, DialogTitle, DialogContent, DialogActions, IconButton, Menu, MenuItem, TextField, Collapse, Slider,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SaveIcon from '@mui/icons-material/Save';
import ForumIcon from '@mui/icons-material/Forum';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../stores/useChatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAuthStore } from '../stores/useAuthStore';
import type { AICharacter } from '../types/character';
import { getPreferredAIProfile, isAIProfileUsable } from '../types/settings';
import type { ChatStyle, GroupChat, RuntimeEvolutionIntensity } from '../types/chat';
import { ROOM_TEMPLATES, filterRoomTemplatesForAvailability, getRoomTemplate, getRoomTemplateKernel, getRoomTemplateKeyBySessionKind, type RoomTemplateKey } from '../services/roomTemplates';
import {
  DEFAULT_CONVERSATION_WORLD_STATE,
  defaultTopologySummaryForConversation,
  deriveSessionMemoryLayerSummary,
} from '../types/chat';
import {
  buildGroupChatDraft,
  composeGroupMemberIds,
  normalizeOperatorIdsInput,
  stripUserMemberId,
} from '../services/chatDraftBuilder';
import { api as apiClient, type BillingMembershipResponse, type VipEntitlementInfo } from '../services/api';
import { MIN_MEMBERS, MAX_MEMBERS, MAX_GROUP_MEMBERS_HARD_LIMIT } from '../constants/defaults';
import { getChatStyleOption } from '../constants/chatStyles';
import { storageKey } from '../constants/brand';
import DirectorControlsSection from '../components/createChat/DirectorControlsSection';
import ChatConfigSection from '../components/createChat/ChatConfigSection';
import GameplaySection from '../components/createChat/GameplaySection';
import ManagementSection from '../components/createChat/ManagementSection';
import MemberSelectionDialog from '../components/createChat/MemberSelectionDialog';
import { buildIncludeUserAsMemberCopy } from '../services/createChatPresentation';
import { resolveRoomTemplateCapabilityDefaults } from '../services/conversationCapabilities';
import FloatingSegmentedTabs from '../components/common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../components/common/FloatingSegmentedTabs.styles';
import AnimatedTabContent from '../components/common/AnimatedTabContent';
import { resolveTabTransitionDirection } from '../components/common/tabTransition';
import AppSnackbar from '../components/common/AppSnackbar';
import ExpandableFab from '../components/common/ExpandableFab';
import NoCharactersDialog from '../components/common/NoCharactersDialog';
import VipLimitDialog from '../components/common/VipLimitDialog';
import SurfaceCard from '../components/common/SurfaceCard';
import MarketUploadDialog, { type MarketUploadDraft } from '../components/market/MarketUploadDialog';
import { marketApi } from '../services/marketApi';
import {
  buildBundledCharacterPreview,
  buildImportedChatDraft,
  getBundledCharacterEntries,
  getMarketImportDraftState,
  remapIds,
} from '../services/marketImportDraft';
import { buildBundleMarketPayload, buildChatMarketPayload, getMarketSummaryForChat, getMarketTitleForChat } from '../services/templateMarketPayload';
import { buildOpeningTopicGuideMessage } from '../services/createChatOpening';
import { enqueueGroupVisualGeneration, type GroupVisualKind } from '../services/groupVisualGeneration';
import { prepareAvatarUploadDataUrl } from '../utils/avatarUpload';

const HotTopicDialogContainer = lazy(() => import('../components/createChat/HotTopicDialogContainer'));
const CHAT_DRAFT_KEY = storageKey('create-chat-draft');
const BATCH_GENERATED_MEMBER_IDS_KEY = storageKey('create-chat-batch-generated-member-ids');
const RuntimeSeedSection = lazy(() => import('../components/createChat/RuntimeSeedSection'));

function hasGameplayRuntimeData(chat: GroupChat) {
  const scenario = chat.scenarioState;
  return Boolean(
    (chat.runtimeTimeline || []).length
    || (chat.runtimeEventsV2 || []).length
    || (chat.relationshipLedger || []).length
    || (chat.layeredMemories || []).length
    || (chat.growthSnapshots || []).length
    || (chat.roleMemorySummaries || []).some((item) => item.summary?.trim())
    || (scenario?.choiceHistory || []).length
    || scenario?.selectedChoice
    || (scenario?.storyChapters || []).length
    || (scenario?.storyProtocolDiagnostics || []).length
    || Number(scenario?.sceneBeatCount || 0) > 0
    || Number(scenario?.choiceEpoch || 0) > 0
    || Number(scenario?.selectedChoiceEpoch || 0) > 0
  );
}

function buildInitialSessionResetPatch(chat: GroupChat): Partial<GroupChat> {
  const initialDraft = buildGroupChatDraft({
    type: 'group',
    name: chat.name,
    topic: chat.topic,
    style: chat.style,
    runtimeEvolutionIntensity: chat.runtimeEvolutionIntensity,
    sessionKind: chat.sessionKind,
    storyBranchMode: chat.scenarioState?.branches?.some((branch) => branch.status === 'chosen') ? 'open' : 'guided',
    storyBackground: String(chat.scenarioState?.storyBackground || ''),
    storyDirection: String(chat.scenarioState?.storyDirection || ''),
    storyOutline: String(chat.scenarioState?.storyOutline || ''),
    studyGoalLabel: chat.scenarioState?.goals?.find((item) => item.goalId === 'study-goal')?.label || '',
    agentGoalLabel: chat.scenarioState?.goals?.find((item) => item.goalId === 'agent-goal')?.label || '',
    boardColumns: chat.scenarioState?.board?.schema?.columns || 8,
    boardRows: chat.scenarioState?.board?.schema?.rows || 8,
    deductionFactionCount: chat.scenarioState?.factions?.length || 2,
    werewolfRoleConfig: String(chat.scenarioState?.werewolfRoleConfig || ''),
    werewolfPostGameMode: String(chat.scenarioState?.werewolfPostGameMode || 'free_talk'),
    mysteryClueCount: chat.scenarioState?.progress?.find((item) => item.key === 'mystery-progress')?.target || 6,
    mysteryScript: String(chat.scenarioState?.mysteryScript || ''),
    mysteryRoleMappingMode: String(chat.scenarioState?.mysteryRoleMappingMode || 'alias'),
    memberIds: chat.memberIds,
    operatorIds: chat.operatorIds || [],
    showRoleActions: Boolean(chat.showRoleActions),
    seedMemoryText: '',
    seedArtifactText: '',
    ownerCharacterId: chat.governance?.ownerCharacterId || null,
    adminCharacterIds: chat.governance?.adminCharacterIds || [],
    autoModeration: Boolean(chat.governance?.autoModeration),
    allowMute: chat.governance?.allowMute !== false,
    allowPrivateThreads: Boolean(chat.governance?.allowPrivateThreads),
    allowCliques: Boolean(chat.dramaRules?.allowCliques),
    allowMockery: Boolean(chat.dramaRules?.allowMockery),
    mood: '',
    focus: '',
    recentEvent: '',
    allowSpeakAs: chat.directorControls?.allowSpeakAs !== false,
    allowDirectorMode: chat.directorControls?.allowDirectorMode !== false,
    allowEventInjection: chat.directorControls?.allowEventInjection !== false,
    allowForcedReply: chat.directorControls?.allowForcedReply !== false,
  });

  return {
    isActive: false,
    modeState: {
      ...initialDraft.modeState,
      initialization: chat.modeState.initialization,
    },
    scenarioState: initialDraft.scenarioState,
    channels: initialDraft.channels,
    layoutState: initialDraft.layoutState,
    scenarioPackage: initialDraft.scenarioPackage,
    judgeAgent: initialDraft.judgeAgent,
    layeredGrowth: { persistentCharacterCores: [], conversationCharacterStates: [] },
    modeStateSummary: { family: chat.sessionKind?.family || 'conversation', scenarioId: chat.sessionKind?.scenarioId || initialDraft.scenarioPackage?.scenarioId || 'open-chat' },
    topologySummary: defaultTopologySummaryForConversation({ type: chat.type, mode: chat.mode, sessionKind: chat.sessionKind }),
    runtimeSeed: { notes: [], artifacts: [] },
    layeredMemories: [],
    runtimeTimeline: [],
    runtimeEventsV2: [],
    relationshipLedger: [],
    growthSnapshots: [],
    roleMemorySummaries: [],
    scenarioMemorySummary: { conversationId: chat.id, summary: '' },
    memoryLayerSummary: deriveSessionMemoryLayerSummary({ mode: chat.mode }),
    messageBranchState: null,
    worldState: {
      ...DEFAULT_CONVERSATION_WORLD_STATE,
      mood: '',
      focus: '',
      recentEvent: '',
      conflictAxes: [],
      structuredRoomState: null,
      conflictState: null,
    },
  };
}

function buildSaveAsChatName(sourceName: string, existingNames: string[]) {
  const fallbackName = sourceName.trim() || '未命名群聊';
  let baseName = fallbackName;
  while (/（\d+）$/.test(baseName)) {
    baseName = baseName.replace(/（\d+）$/, '').trim();
  }
  if (!baseName) baseName = fallbackName;
  const suffixPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（(\\d+)）$`);
  const maxIndex = existingNames.reduce((max, item) => {
    const match = item.trim().match(suffixPattern);
    if (!match) return max;
    return Math.max(max, Number(match[1]) || 0);
  }, 0);
  return `${baseName}（${maxIndex + 1}）`;
}

function isAgentRoomTemplate(template: ReturnType<typeof getRoomTemplate>) {
  const sessionKind = template.sessionKind;
  return sessionKind.family === 'agent' || sessionKind.scenarioId.includes('agent');
}

function normalizeReturnPath(path: string) {
  const [pathname, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  params.delete('restoreDraft');
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function readBatchGeneratedMemberIds(currentPath: string) {
  const raw = sessionStorage.getItem(BATCH_GENERATED_MEMBER_IDS_KEY);
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw) as { returnTo?: unknown; characterIds?: unknown };
    const returnTo = typeof payload.returnTo === 'string' ? normalizeReturnPath(payload.returnTo) : '';
    if (returnTo && returnTo !== normalizeReturnPath(currentPath)) return [];
    sessionStorage.removeItem(BATCH_GENERATED_MEMBER_IDS_KEY);
    return Array.isArray(payload.characterIds)
      ? payload.characterIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
  } catch {
    sessionStorage.removeItem(BATCH_GENERATED_MEMBER_IDS_KEY);
    return [];
  }
}

export default function CreateChatPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const marketImportDraft = !id ? getMarketImportDraftState(location.state) : null;
  const { setHeaderTitle, setHeaderActions, setHeaderBackAction, setHideMobileBottomNav } = useLayoutHeaderActions();
  const { chats, addChat, updateChat, deleteChat, prefetchChats, markChatsWarm } = useChatStore(useShallow((state) => ({
    chats: state.chats,
    addChat: state.addChat,
    updateChat: state.updateChat,
    deleteChat: state.deleteChat,
    prefetchChats: state.prefetchChats,
    markChatsWarm: state.markChatsWarm,
  })));
  const { characters, addCharacters, prefetchCharacters, markCharactersWarm } = useCharacterStore(useShallow((state) => ({
    characters: state.characters,
    addCharacters: state.addCharacters,
    prefetchCharacters: state.prefetchCharacters,
    markCharactersWarm: state.markCharactersWarm,
  })));
  const { chatDraftDefaults, aiProfiles, api, developerMode, setChatDraftDefaults, loadSettings } = useSettingsStore(useShallow((state) => ({
    chatDraftDefaults: state.chatDraftDefaults,
    aiProfiles: state.aiProfiles,
    api: state.api,
    developerMode: state.developerMode,
    setChatDraftDefaults: state.setChatDraftDefaults,
    loadSettings: state.loadSettings,
  })));
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const authMode = useAuthStore((state) => state.authMode);
  const currentUser = useAuthStore((state) => state.user);
  const marketUploadEntitled = currentUser?.marketUploadEntitled === true;
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [clearMessagesConfirmOpen, setClearMessagesConfirmOpen] = useState(false);
  const [clearMemoryConfirmOpen, setClearMemoryConfirmOpen] = useState(false);
  const [noCharactersDialogOpen, setNoCharactersDialogOpen] = useState(false);
  const [marketMenuAnchor, setMarketMenuAnchor] = useState<HTMLElement | null>(null);
  const [marketUploadDraft, setMarketUploadDraft] = useState<MarketUploadDraft | null>(null);
  const [marketBundleCharacterPreviews, setMarketBundleCharacterPreviews] = useState<AICharacter[]>([]);
  const [configTab, setConfigTab] = useState(0);
  const [tabTransitionDirection, setTabTransitionDirection] = useState<-1 | 1>(1);

  const editingChat = id ? chats.find((chat) => chat.id === id) : null;

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState<ChatStyle>('free');
  const [roomTemplate, setRoomTemplate] = useState<RoomTemplateKey>('open_chat');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [ownerCharacterId, setOwnerCharacterId] = useState<string>('');
  const [adminCharacterIds, setAdminCharacterIds] = useState<string[]>([]);
  const [mood, setMood] = useState('');
  const [focus, setFocus] = useState('');
  const [recentEvent, setRecentEvent] = useState('');
  const [seedMemoryText, setSeedMemoryText] = useState('');
  const [seedArtifactText, setSeedArtifactText] = useState('');
  const [allowCliques, setAllowCliques] = useState(false);
  const [allowMockery, setAllowMockery] = useState(false);
  const [showRoleActions, setShowRoleActions] = useState(true);
  const [includeUserAsMember, setIncludeUserAsMember] = useState(true);
  const [operatorIdsText, setOperatorIdsText] = useState('');
  const [runtimeEvolutionIntensity, setRuntimeEvolutionIntensity] = useState<RuntimeEvolutionIntensity>('balanced');
  const [storyBranchMode, setStoryBranchMode] = useState<'guided' | 'open'>('guided');
  const [storyBackground, setStoryBackground] = useState('');
  const [storyDirection, setStoryDirection] = useState('');
  const [storyOutline, setStoryOutline] = useState('');
  const [studyGoalLabel, setStudyGoalLabel] = useState('');
  const [teachingMode, setTeachingMode] = useState('casual');
  const [teacherExpertise, setTeacherExpertise] = useState('');
  const [assessmentPolicy, setAssessmentPolicy] = useState('evidence_only');
  const [agentGoalLabel, setAgentGoalLabel] = useState('');
  const [boardColumns, setBoardColumns] = useState(8);
  const [boardRows, setBoardRows] = useState(8);
  const [deductionFactionCount, setDeductionFactionCount] = useState(2);
  const [werewolfRoleConfig, setWerewolfRoleConfig] = useState('');
  const [werewolfPostGameMode, setWerewolfPostGameMode] = useState('free_talk');
  const [mysteryClueCount, setMysteryClueCount] = useState(6);
  const [mysteryScript, setMysteryScript] = useState('');
  const [mysteryRoleMappingMode, setMysteryRoleMappingMode] = useState('alias');
  const [allowSpeakAs, setAllowSpeakAs] = useState(true);
  const [allowDirectorMode, setAllowDirectorMode] = useState(true);
  const [allowEventInjection, setAllowEventInjection] = useState(true);
  const [allowForcedReply, setAllowForcedReply] = useState(true);
  const [autoModeration, setAutoModeration] = useState(false);
  const [allowMute, setAllowMute] = useState(true);
  const [allowPrivateThreads, setAllowPrivateThreads] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveAsChatSaving, setSaveAsChatSaving] = useState(false);
  const [membership, setMembership] = useState<BillingMembershipResponse | null>(null);
  const [freeEntitlement, setFreeEntitlement] = useState<VipEntitlementInfo | null>(null);
  const [freeEntitlementLoaded, setFreeEntitlementLoaded] = useState(false);
  const [membershipLoaded, setMembershipLoaded] = useState(authMode !== 'cloud' || !isLoggedIn);
  const [membershipLoadFailed, setMembershipLoadFailed] = useState(false);
  const [vipLimitDialog, setVipLimitDialog] = useState<{ title: string; description: string; current?: number | null; limit?: number | null; helperText?: string } | null>(null);
  const [aiAutofilling, setAiAutofilling] = useState(false);
  const [hotTopicOpenSignal, setHotTopicOpenSignal] = useState(0);
  const [hotTopicDialogEnabled, setHotTopicDialogEnabled] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });
  const [groupVisualDialog, setGroupVisualDialog] = useState<{ kind: GroupVisualKind; requirement: string } | null>(null);
  const [groupVisualExpanded, setGroupVisualExpanded] = useState(false);
  const [groupBackgroundOpacityDraft, setGroupBackgroundOpacityDraft] = useState(0.16);
  const groupVisualUploadRefs = useRef<Record<GroupVisualKind, HTMLInputElement | null>>({ avatar: null, background: null });
  const [unavailableGroupVisualUrls, setUnavailableGroupVisualUrls] = useState<Record<string, true>>({});
  const memberPressTimerRef = useRef<number | null>(null);
  const styleOverriddenRef = useRef(false);

  const showRuntimeTab = Boolean(editingChat);
  const isZh = i18n.language.startsWith('zh');
  const gameplayTabIndex = 1;
  const conversationKind = editingChat?.type === 'assistant' ? 'group' : editingChat?.type || 'group';
  const isGroupConversation = conversationKind === 'group';
  const showManagementTab = !editingChat;

  useEffect(() => {
    setGroupBackgroundOpacityDraft(Math.min(1, Math.max(0.05, Number(editingChat?.groupVisual?.backgroundOpacity ?? 0.16))));
  }, [editingChat?.id, editingChat?.groupVisual?.backgroundOpacity, editingChat?.groupVisual?.backgroundUrl]);
  useEffect(() => {
    setGroupVisualExpanded(Boolean(editingChat?.groupVisual?.avatarUrl || editingChat?.groupVisual?.backgroundUrl));
  }, [editingChat?.id, editingChat?.groupVisual?.avatarUrl, editingChat?.groupVisual?.backgroundUrl]);
  const showDirectorTab = !editingChat || isGroupConversation;
  const showGameplayTab = !editingChat || isGroupConversation;
  const useFreeEntitlement = authMode !== 'cloud' || !isLoggedIn;
  const entitlementReady = useFreeEntitlement ? freeEntitlementLoaded : membershipLoaded;
  const managementTabIndex = showGameplayTab ? 2 : 1;
  const runtimeTabIndex = showRuntimeTab ? (showManagementTab ? managementTabIndex + 1 : managementTabIndex) : managementTabIndex;
  const directorTabIndex = showDirectorTab ? (showRuntimeTab ? runtimeTabIndex + 1 : managementTabIndex + (showManagementTab ? 1 : 0)) : runtimeTabIndex;
  const conversationNoun = isZh
    ? (conversationKind === 'group' ? '群聊' : conversationKind === 'ai_direct' ? 'AI私聊' : '单聊')
    : (conversationKind === 'group' ? 'group chat' : conversationKind === 'ai_direct' ? 'AI direct chat' : 'direct chat');
  const minRequiredMembers = isGroupConversation ? MIN_MEMBERS : 1;
  const roomTemplateMemberLimit = getRoomTemplate(roomTemplate).maxMembers;
  const maxAllowedMembers = roomTemplateMemberLimit
    ?? (isGroupConversation
      ? Math.min(MAX_GROUP_MEMBERS_HARD_LIMIT, entitlementReady
        ? (useFreeEntitlement ? freeEntitlement?.maxGroupMembers : membership?.vipEntitlement?.entitlement.maxGroupMembers) ?? MAX_MEMBERS
        : MAX_MEMBERS)
      : (conversationKind === 'ai_direct' ? 2 : 1));

  const showError = (message: string) => {
    setSnackbar({ open: true, message, severity: 'error' });
  };

  const getActionErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof Error && error.message.trim()) return error.message;
    return fallback;
  };

  const normalizedOperatorResult = normalizeOperatorIdsInput(operatorIdsText, selectedMembers);
  const operatorIds = normalizedOperatorResult.effectiveIds;
  const filteredOperatorCount = normalizedOperatorResult.filteredCount;

  const seedOpeningTopicMessage = useCallback(async (chatId: string, topicText?: string | null) => {
    const openingTopic = (topicText || '').trim();
    if (!openingTopic) return;
    await useMessageStore.getState().addMessage(buildOpeningTopicGuideMessage(chatId, openingTopic));
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    markChatsWarm();
    markCharactersWarm();
    void prefetchChats();
    void prefetchCharacters();
  }, [markCharactersWarm, markChatsWarm, prefetchCharacters, prefetchChats]);

  useEffect(() => {
    let active = true;
    apiClient.getBillingMembershipConfig()
      .then((result) => {
        if (active) {
          setFreeEntitlement(result.entitlements?.free || null);
          setFreeEntitlementLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setFreeEntitlement(null);
          setFreeEntitlementLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (authMode !== 'cloud' || !isLoggedIn) {
        setMembership(null);
        setMembershipLoaded(true);
        setMembershipLoadFailed(false);
        return;
      }
      setMembershipLoaded(false);
      setMembershipLoadFailed(false);
      apiClient.getBillingMembership()
        .then((result) => {
          if (active) {
            setMembership(result);
            setMembershipLoaded(true);
            setMembershipLoadFailed(false);
          }
        })
        .catch(() => {
          if (active) {
            setMembership(null);
            setMembershipLoaded(true);
            setMembershipLoadFailed(true);
          }
        });
    });
    return () => {
      active = false;
    };
  }, [authMode, isLoggedIn]);

  useEffect(() => {
    if (id && !editingChat) return;

    if (editingChat) {
      queueMicrotask(() => {
        setMarketBundleCharacterPreviews([]);
        setName(editingChat.name || '');
        setTopic(editingChat.topic || editingChat.scenarioState?.learning?.goal || '');
        setStyle(editingChat.style);
        styleOverriddenRef.current = true;
        const matchedTemplateKey = editingChat.sessionKind ? getRoomTemplateKeyBySessionKind(editingChat.sessionKind) : null;
        setRoomTemplate(matchedTemplateKey || 'open_chat');
        setSelectedMembers(stripUserMemberId(editingChat.memberIds || []));
        setOwnerCharacterId(editingChat.governance.ownerCharacterId || '');
        setAdminCharacterIds(editingChat.governance.adminCharacterIds || []);
        setMood(editingChat.worldState.mood || '');
        setFocus(editingChat.worldState.focus || '');
        setRecentEvent(editingChat.worldState.recentEvent || '');
        setSeedMemoryText((editingChat.runtimeSeed?.notes || []).join('\n'));
        setSeedArtifactText((editingChat.runtimeSeed?.artifacts || []).join('\n'));
        setAllowCliques(editingChat.dramaRules.allowCliques);
        setAllowMockery(editingChat.dramaRules.allowMockery);
        setShowRoleActions(editingChat.showRoleActions ?? true);
        setIncludeUserAsMember((editingChat.memberIds || []).includes('user'));
        setOperatorIdsText((editingChat.operatorIds || []).join(', '));
        setRuntimeEvolutionIntensity(editingChat.runtimeEvolutionIntensity || 'balanced');
        setStoryBranchMode(editingChat.scenarioState?.branches?.[0]?.status === 'chosen' ? 'open' : 'guided');
        setStoryBackground(String(editingChat.scenarioState?.storyBackground || ''));
        setStoryDirection(String(editingChat.scenarioState?.storyDirection || ''));
        setStoryOutline(String(editingChat.scenarioState?.storyOutline || ''));
        setStudyGoalLabel(editingChat.scenarioState?.goals?.find((item) => item.goalId === 'study-goal')?.label || editingChat.scenarioState?.learning?.goal || editingChat.topic || '');
        setTeachingMode(editingChat.scenarioState?.learning?.teachingMode || 'casual');
        setTeacherExpertise(editingChat.scenarioState?.learning?.teacherExpertise || '');
        setAssessmentPolicy(editingChat.scenarioState?.learning?.assessmentPolicy || 'evidence_only');
        setAgentGoalLabel(editingChat.scenarioState?.goals?.find((item) => item.goalId === 'agent-goal')?.label || '');
        setBoardColumns(editingChat.scenarioState?.board?.schema?.columns || 8);
        setBoardRows(editingChat.scenarioState?.board?.schema?.rows || 8);
        setDeductionFactionCount(editingChat.scenarioState?.factions?.length || 2);
        setWerewolfRoleConfig(String(editingChat.scenarioState?.werewolfRoleConfig || ''));
        setWerewolfPostGameMode(String(editingChat.scenarioState?.werewolfPostGameMode || 'free_talk'));
        setMysteryClueCount(editingChat.scenarioState?.progress?.find((item) => item.key === 'mystery-progress')?.target || 6);
        setMysteryScript(String(editingChat.scenarioState?.mysteryScript || ''));
        setMysteryRoleMappingMode(String(editingChat.scenarioState?.mysteryRoleMappingMode || 'alias'));
        setAllowSpeakAs(editingChat.directorControls.allowSpeakAs);
        setAllowDirectorMode(editingChat.directorControls.allowDirectorMode);
        setAllowEventInjection(editingChat.directorControls.allowEventInjection);
        setAllowForcedReply(editingChat.directorControls.allowForcedReply);
        setAutoModeration(editingChat.governance.autoModeration);
        setAllowMute(editingChat.governance.allowMute);
        setAllowPrivateThreads(editingChat.governance.allowPrivateThreads);
      });
      return;
    }

    if (marketImportDraft?.item && ['chat_template', 'bundle_template'].includes(marketImportDraft.item.kind)) {
      queueMicrotask(() => {
        const importedChat = buildImportedChatDraft(marketImportDraft.item);
        const matchedTemplateKey = importedChat.sessionKind ? getRoomTemplateKeyBySessionKind(importedChat.sessionKind) : null;
        setName(importedChat.name || '');
        setTopic(importedChat.topic || importedChat.scenarioState?.learning?.goal || '');
        setStyle(importedChat.style || chatDraftDefaults.style);
        styleOverriddenRef.current = Boolean(importedChat.style);
        setRoomTemplate(matchedTemplateKey || 'open_chat');
        setSelectedMembers(stripUserMemberId(importedChat.memberIds || []));
        setOwnerCharacterId(importedChat.governance?.ownerCharacterId || '');
        setAdminCharacterIds(importedChat.governance?.adminCharacterIds || []);
        setMood(importedChat.worldState?.mood || '');
        setFocus(importedChat.worldState?.focus || '');
        setRecentEvent(importedChat.worldState?.recentEvent || '');
        setSeedMemoryText((importedChat.runtimeSeed?.notes || []).join('\n'));
        setSeedArtifactText((importedChat.runtimeSeed?.artifacts || []).join('\n'));
        setAllowCliques(Boolean(importedChat.dramaRules?.allowCliques));
        setAllowMockery(Boolean(importedChat.dramaRules?.allowMockery));
        setShowRoleActions(importedChat.showRoleActions ?? chatDraftDefaults.showRoleActions);
        setIncludeUserAsMember((importedChat.memberIds || []).includes('user'));
        setOperatorIdsText((importedChat.operatorIds || []).join(', '));
        setRuntimeEvolutionIntensity(importedChat.runtimeEvolutionIntensity || chatDraftDefaults.runtimeEvolutionIntensity);
        setStoryBranchMode(importedChat.scenarioState?.branches?.[0]?.status === 'chosen' ? 'open' : 'guided');
        setStoryBackground(String(importedChat.scenarioState?.storyBackground || ''));
        setStoryDirection(String(importedChat.scenarioState?.storyDirection || ''));
        setStoryOutline(String(importedChat.scenarioState?.storyOutline || ''));
        setStudyGoalLabel(importedChat.scenarioState?.goals?.find((item) => item.goalId === 'study-goal')?.label || importedChat.scenarioState?.learning?.goal || importedChat.topic || '');
        setTeachingMode(importedChat.scenarioState?.learning?.teachingMode || 'casual');
        setTeacherExpertise(importedChat.scenarioState?.learning?.teacherExpertise || '');
        setAssessmentPolicy(importedChat.scenarioState?.learning?.assessmentPolicy || 'evidence_only');
        setAgentGoalLabel(importedChat.scenarioState?.goals?.find((item) => item.goalId === 'agent-goal')?.label || '');
        setBoardColumns(importedChat.scenarioState?.board?.schema?.columns || 8);
        setBoardRows(importedChat.scenarioState?.board?.schema?.rows || 8);
        setDeductionFactionCount(importedChat.scenarioState?.factions?.length || 2);
        setWerewolfRoleConfig(String(importedChat.scenarioState?.werewolfRoleConfig || ''));
        setWerewolfPostGameMode(String(importedChat.scenarioState?.werewolfPostGameMode || 'free_talk'));
        setMysteryClueCount(importedChat.scenarioState?.progress?.find((item) => item.key === 'mystery-progress')?.target || 6);
        setMysteryScript(String(importedChat.scenarioState?.mysteryScript || ''));
        setMysteryRoleMappingMode(String(importedChat.scenarioState?.mysteryRoleMappingMode || 'alias'));
        setAllowSpeakAs(importedChat.directorControls?.allowSpeakAs ?? true);
        setAllowDirectorMode(importedChat.directorControls?.allowDirectorMode ?? true);
        setAllowEventInjection(importedChat.directorControls?.allowEventInjection ?? true);
        setAllowForcedReply(importedChat.directorControls?.allowForcedReply ?? true);
        setAutoModeration(Boolean(importedChat.governance?.autoModeration));
        setAllowMute(importedChat.governance?.allowMute ?? true);
        setAllowPrivateThreads(importedChat.governance?.allowPrivateThreads ?? true);
        setMarketBundleCharacterPreviews(marketImportDraft.item.kind === 'bundle_template' ? buildBundledCharacterPreview(marketImportDraft.item) : []);
      });
      return;
    }

    queueMicrotask(() => {
      setMarketBundleCharacterPreviews([]);
      setStyle(chatDraftDefaults.style);
      styleOverriddenRef.current = false;
      setRoomTemplate('open_chat');
      setShowRoleActions(chatDraftDefaults.showRoleActions);
      setIncludeUserAsMember(chatDraftDefaults.includeUserAsMember);
      setRuntimeEvolutionIntensity(chatDraftDefaults.runtimeEvolutionIntensity);
      setStoryBranchMode('guided');
      setStudyGoalLabel('');
      setAgentGoalLabel('');
      setBoardColumns(8);
      setBoardRows(8);
      setDeductionFactionCount(2);
      setMysteryClueCount(6);
      setOwnerCharacterId('');
      setAdminCharacterIds([]);
      setMood('');
      setFocus('');
      setRecentEvent('');
      setSeedMemoryText('');
      setSeedArtifactText('');
      setAllowCliques(false);
      setAllowMockery(false);
      setAllowSpeakAs(true);
      setAllowDirectorMode(true);
      setAllowEventInjection(true);
      setAllowForcedReply(true);
      setOperatorIdsText('');
      setAutoModeration(false);
      setAllowMute(true);
      setAllowPrivateThreads(true);
    });
  }, [chatDraftDefaults.includeUserAsMember, chatDraftDefaults.runtimeEvolutionIntensity, chatDraftDefaults.showRoleActions, chatDraftDefaults.style, editingChat, id, marketImportDraft]);

  const toggleMember = (memberId: string) => {
    setSelectedMembers((prev) => {
      if (prev.includes(memberId)) return prev.filter((m) => m !== memberId);
      if (prev.length >= maxAllowedMembers) {
        showError(isZh ? `当前${conversationNoun}最多选择${maxAllowedMembers}个AI角色` : `This ${conversationNoun} supports up to ${maxAllowedMembers} AI role(s)`);
        return prev;
      }
      return [...prev, memberId];
    });
  };

  const persistDraft = () => {
    sessionStorage.setItem(CHAT_DRAFT_KEY, JSON.stringify({
      name,
      topic,
      style,
      roomTemplate,
      selectedMembers,
      ownerCharacterId,
      adminCharacterIds,
      mood,
      focus,
      recentEvent,
      seedMemoryText,
      seedArtifactText,
      allowCliques,
      allowMockery,
      showRoleActions,
      includeUserAsMember,
      operatorIdsText,
      runtimeEvolutionIntensity,
      storyBranchMode,
      storyBackground,
      storyDirection,
      storyOutline,
      studyGoalLabel,
      teachingMode,
      teacherExpertise,
      assessmentPolicy,
      agentGoalLabel,
      boardColumns,
      boardRows,
      deductionFactionCount,
      werewolfRoleConfig,
      werewolfPostGameMode,
      mysteryClueCount,
      mysteryScript,
      mysteryRoleMappingMode,
      allowSpeakAs,
      allowDirectorMode,
      allowEventInjection,
      allowForcedReply,
      autoModeration,
      allowMute,
      allowPrivateThreads,
      configTab,
    }));
  };

  const restoreDraft = useCallback(() => {
    const raw = sessionStorage.getItem(CHAT_DRAFT_KEY);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw) as Record<string, unknown>;
      setName(String(draft.name || ''));
      setTopic(String(draft.topic || ''));
      setStyle((draft.style as ChatStyle) || chatDraftDefaults.style);
      styleOverriddenRef.current = Boolean(draft.style);
      setRoomTemplate((draft.roomTemplate as RoomTemplateKey) || 'open_chat');
      const restoredMembers = stripUserMemberId(Array.isArray(draft.selectedMembers) ? draft.selectedMembers as string[] : []);
      const batchGeneratedMemberIds = readBatchGeneratedMemberIds(location.pathname + location.search);
      setSelectedMembers(Array.from(new Set([...restoredMembers, ...batchGeneratedMemberIds])));
      setOwnerCharacterId(String(draft.ownerCharacterId || ''));
      setAdminCharacterIds(Array.isArray(draft.adminCharacterIds) ? draft.adminCharacterIds as string[] : []);
      setMood(String(draft.mood || ''));
      setFocus(String(draft.focus || ''));
      setRecentEvent(String(draft.recentEvent || ''));
      setSeedMemoryText(String(draft.seedMemoryText || draft.runtimeNotesText || ''));
      setSeedArtifactText(String(draft.seedArtifactText || draft.runtimeArtifactsText || ''));
      setAllowCliques(Boolean(draft.allowCliques));
      setAllowMockery(Boolean(draft.allowMockery));
      setShowRoleActions(Boolean(draft.showRoleActions));
      setIncludeUserAsMember(
        typeof draft.includeUserAsMember === 'boolean'
          ? Boolean(draft.includeUserAsMember)
          : true,
      );
      setOperatorIdsText(String(draft.operatorIdsText || ''));
      setRuntimeEvolutionIntensity((draft.runtimeEvolutionIntensity as RuntimeEvolutionIntensity) || chatDraftDefaults.runtimeEvolutionIntensity);
      setStoryBranchMode((draft.storyBranchMode as 'guided' | 'open') || 'guided');
      setStoryBackground(String(draft.storyBackground || ''));
      setStoryDirection(String(draft.storyDirection || ''));
      setStoryOutline(String(draft.storyOutline || ''));
      setStudyGoalLabel(String(draft.studyGoalLabel || ''));
      setTeachingMode(String(draft.teachingMode || 'casual'));
      setTeacherExpertise(String(draft.teacherExpertise || ''));
      setAssessmentPolicy(String(draft.assessmentPolicy || 'evidence_only'));
      setAgentGoalLabel(String(draft.agentGoalLabel || ''));
      setBoardColumns(Number(draft.boardColumns || 8));
      setBoardRows(Number(draft.boardRows || 8));
      setDeductionFactionCount(Number(draft.deductionFactionCount || 2));
      setWerewolfRoleConfig(String(draft.werewolfRoleConfig || ''));
      setWerewolfPostGameMode(String(draft.werewolfPostGameMode || 'free_talk'));
      setMysteryClueCount(Number(draft.mysteryClueCount || 6));
      setMysteryScript(String(draft.mysteryScript || ''));
      setMysteryRoleMappingMode(String(draft.mysteryRoleMappingMode || 'alias'));
      setAllowSpeakAs(Boolean(draft.allowSpeakAs));
      setAllowDirectorMode(Boolean(draft.allowDirectorMode));
      setAllowEventInjection(Boolean(draft.allowEventInjection));
      setAllowForcedReply(Boolean(draft.allowForcedReply));
      setAutoModeration(Boolean(draft.autoModeration));
      setAllowMute(Boolean(draft.allowMute));
      setAllowPrivateThreads(Boolean(draft.allowPrivateThreads));
      setConfigTab(Number(draft.configTab || 0));
    } finally {
      sessionStorage.removeItem(CHAT_DRAFT_KEY);
    }
  }, [
    chatDraftDefaults.runtimeEvolutionIntensity,
    chatDraftDefaults.style,
    location.pathname,
    location.search,
  ]);

  const openMemberEdit = (characterId: string) => {
    persistDraft();
    navigate(`/characters/${characterId}/edit?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
  };

  const clearMemberPressTimer = () => {
    if (memberPressTimerRef.current !== null) {
      window.clearTimeout(memberPressTimerRef.current);
      memberPressTimerRef.current = null;
    }
  };

  const startMemberLongPress = (characterId: string) => {
    clearMemberPressTimer();
    memberPressTimerRef.current = window.setTimeout(() => {
      openMemberEdit(characterId);
      clearMemberPressTimer();
    }, 450);
  };

  const handleMemberItemContextMenu = (event: React.MouseEvent, characterId: string) => {
    event.preventDefault();
    openMemberEdit(characterId);
  };

  useEffect(() => {
    if (!editingChat && new URLSearchParams(location.search).get('restoreDraft') === '1') {
      restoreDraft();
    }
  }, [editingChat, location.search, restoreDraft]);

  useEffect(() => () => clearMemberPressTimer(), []);

  useEffect(() => {
    const handler = () => clearMemberPressTimer();
    window.addEventListener('pointerup', handler);
    window.addEventListener('pointercancel', handler);
    window.addEventListener('contextmenu', handler);
    window.addEventListener('blur', handler);
    window.addEventListener('mouseup', handler);
    window.addEventListener('touchend', handler);
    window.addEventListener('keydown', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('pointerup', handler);
      window.removeEventListener('pointercancel', handler);
      window.removeEventListener('contextmenu', handler);
      window.removeEventListener('blur', handler);
      window.removeEventListener('mouseup', handler);
      window.removeEventListener('touchend', handler);
      window.removeEventListener('keydown', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, []);

  useEffect(() => {
    if (!editingChat && new URLSearchParams(location.search).get('restoreDraft') !== '1') {
      sessionStorage.removeItem(CHAT_DRAFT_KEY);
    }
  }, [editingChat, location.search]);

  const customCharacters = characters.filter((char) => !char.isPreset && !char.deletedAt);
  const selectedCharacters = [
    ...characters.filter((char) => selectedMembers.includes(char.id)),
    ...marketBundleCharacterPreviews.filter((char) => selectedMembers.includes(char.id) && !characters.some((item) => item.id === char.id)),
  ];
  const queueGroupVisualFromDialog = () => {
    if (!editingChat || !groupVisualDialog) return;
    enqueueGroupVisualGeneration({
      chat: editingChat,
      members: selectedCharacters,
      profiles: aiProfiles,
      settings: useSettingsStore.getState().avatarGeneration,
      language: isZh ? 'zh' : 'en',
      kind: groupVisualDialog.kind,
      requirement: groupVisualDialog.requirement,
    });
    setGroupVisualDialog(null);
    setSnackbar({ open: true, message: groupVisualDialog.kind === 'avatar' ? '已加入群头像生成队列' : '已加入聊天背景生成队列', severity: 'success' });
  };
  const handleGroupVisualUpload = async (kind: GroupVisualKind, file?: File | null) => {
    if (!editingChat || !file) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const prepared = await prepareAvatarUploadDataUrl(dataUrl, { maxSize: 1536, quality: 0.9 });
      let url = prepared;
      if (authMode === 'cloud') {
        const asset = await apiClient.createMediaAsset({ chatId: editingChat.id, messageId: `group-visual-${editingChat.id}`, attachmentId: `${kind}-uploaded-${Date.now()}`, kind: 'image', dataUrl: prepared });
        url = asset.url;
      }
      const current = editingChat.groupVisual || {};
      await updateChat(editingChat.id, {
        groupVisual: {
          ...current,
          ...(kind === 'avatar' ? { avatarUrl: url } : { backgroundUrl: url, backgroundOpacity: current.backgroundOpacity ?? 0.16 }),
        },
      });
    } catch (error) {
      setSnackbar({ open: true, message: error instanceof Error ? error.message : String(error), severity: 'error' });
    } finally {
      const input = groupVisualUploadRefs.current[kind];
      if (input) input.value = '';
    }
  };
  const hasCustomCharacters = customCharacters.length > 0;
  const insufficientGroupCharacterCount = !editingChat && !marketImportDraft && isGroupConversation && customCharacters.length < MIN_MEMBERS;
  const canAutofill = !editingChat && !aiAutofilling && Boolean(name.trim() || topic.trim() || selectedMembers.length);
  const agentEntitled = authMode === 'cloud' && isLoggedIn && currentUser?.agentEntitled === true;
  const availableRoomTemplates = useMemo(
    () => filterRoomTemplatesForAvailability(ROOM_TEMPLATES, { developerMode }).filter((template) => agentEntitled || !isAgentRoomTemplate(template)),
    [agentEntitled, developerMode],
  );
  const roomTemplateAvailable = availableRoomTemplates.some((template) => template.key === roomTemplate);
  const gameplaySectionTemplates = useMemo(() => {
    if (roomTemplateAvailable) return availableRoomTemplates;
    const selected = getRoomTemplate(roomTemplate);
    return [selected, ...availableRoomTemplates.filter((template) => template.key !== selected.key)];
  }, [availableRoomTemplates, roomTemplate, roomTemplateAvailable]);
  const selectedRoomTemplate = getRoomTemplate(roomTemplate);
  const gameplayRuntimeLocked = Boolean(editingChat && hasGameplayRuntimeData(editingChat));
  useEffect(() => {
    if (selectedMembers.length <= maxAllowedMembers) return;
    setSelectedMembers((current) => current.slice(0, maxAllowedMembers));
  }, [maxAllowedMembers, selectedMembers.length]);
  const includeUserAsMemberCopy = buildIncludeUserAsMemberCopy({
    isZh,
    isStoryRoom: selectedRoomTemplate.sessionKind.scenarioId === 'story-reader',
    includeUserAsMember,
  });
  const getStyleLabel = (styleValue: ChatStyle) => {
    const option = getChatStyleOption(styleValue);
    return isZh ? option.label.zh : option.label.en;
  };
  const handleStyleChange = useCallback((styleValue: ChatStyle) => {
    styleOverriddenRef.current = true;
    setStyle(styleValue);
  }, []);

  useEffect(() => {
    const defaults = selectedRoomTemplate.defaults || {};
    queueMicrotask(() => {
      if (defaults.studyGoalLabel !== undefined && !studyGoalLabel) setStudyGoalLabel(defaults.studyGoalLabel);
      if (defaults.agentGoalLabel !== undefined && !agentGoalLabel) setAgentGoalLabel(defaults.agentGoalLabel);
    });
  }, [selectedRoomTemplate, studyGoalLabel, agentGoalLabel]);

  const applyRoomTemplate = useCallback((templateKey: RoomTemplateKey) => {
    const template = getRoomTemplate(templateKey);
    const defaults = template.defaults || {};
    const capabilityDefaults = resolveRoomTemplateCapabilityDefaults(template, { showRoleActions: chatDraftDefaults.showRoleActions });
    setRoomTemplate(template.key);
    if (!styleOverriddenRef.current) setStyle(template.style);
    setRuntimeEvolutionIntensity(template.runtimeEvolutionIntensity);
    setShowRoleActions(capabilityDefaults.showRoleActions);
    setAllowMute(capabilityDefaults.allowMute);
    setAllowPrivateThreads(capabilityDefaults.allowPrivateThreads);
    setAllowCliques(capabilityDefaults.allowCliques);
    setAllowMockery(capabilityDefaults.allowMockery);
    setAllowSpeakAs(capabilityDefaults.allowSpeakAs);
    setAllowDirectorMode(capabilityDefaults.allowDirectorMode);
    setAllowEventInjection(capabilityDefaults.allowEventInjection);
    setAllowForcedReply(capabilityDefaults.allowForcedReply);
    if (template.sessionKind.scenarioId === 'story-reader' && !template.parentTemplateKey) {
      setStoryBackground('');
      setStoryDirection('');
      setStoryOutline('');
    }
    if (defaults.storyBranchMode !== undefined) setStoryBranchMode(defaults.storyBranchMode);
    if (defaults.studyGoalLabel !== undefined) {
      setStudyGoalLabel(defaults.studyGoalLabel);
      if (template.sessionKind.family === 'study') setTopic(defaults.studyGoalLabel);
    }
    if (defaults.agentGoalLabel !== undefined) setAgentGoalLabel(defaults.agentGoalLabel);
    if (defaults.storyBackground !== undefined) setStoryBackground(defaults.storyBackground);
    if (defaults.storyDirection !== undefined) setStoryDirection(defaults.storyDirection);
    if (defaults.storyOutline !== undefined) setStoryOutline(defaults.storyOutline);
    if (defaults.boardColumns !== undefined) setBoardColumns(defaults.boardColumns);
    if (defaults.boardRows !== undefined) setBoardRows(defaults.boardRows);
    if (defaults.deductionFactionCount !== undefined) setDeductionFactionCount(defaults.deductionFactionCount);
    if (defaults.mysteryClueCount !== undefined) setMysteryClueCount(defaults.mysteryClueCount);
  }, [chatDraftDefaults.showRoleActions]);

  useEffect(() => {
    if (editingChat || roomTemplateAvailable) return;
    queueMicrotask(() => {
      if (editingChat || roomTemplateAvailable) return;
      applyRoomTemplate('open_chat');
    });
  }, [applyRoomTemplate, editingChat, roomTemplateAvailable]);

  const handleRoomTemplateChange = useCallback((templateKey: RoomTemplateKey) => {
    const nextTemplate = getRoomTemplate(templateKey);
    if (!agentEntitled && isAgentRoomTemplate(nextTemplate)) {
      showError(isZh ? 'Agent 房间仅会员可用。' : 'Agent rooms are available to members only.');
      return;
    }
    if (!developerMode && !availableRoomTemplates.some((template) => template.key === templateKey)) {
      showError(isZh ? '该玩法仍在开发中，开发者模式下才可使用。' : 'This gameplay is still in development and is only available in developer mode.');
      return;
    }
    if (gameplayRuntimeLocked) {
      const currentKernelKey = getRoomTemplateKernel(selectedRoomTemplate).key;
      const nextKernelKey = getRoomTemplateKernel(templateKey).key;
      if (nextKernelKey !== currentKernelKey) {
        showError(isZh ? '已有运行数据后不能切换玩法内核，请另存为群聊后修改玩法。' : 'Rooms with runtime data cannot switch gameplay core; save as a new chat to change gameplay.');
        return;
      }
      if (gameplayRuntimeLocked && templateKey !== roomTemplate) {
        showError(isZh ? '已有运行数据后不能切换预设，请手动修改下方表单参数。' : 'Rooms with runtime data cannot switch presets; edit the form settings below.');
        return;
      }
    }
    applyRoomTemplate(templateKey);
  }, [agentEntitled, applyRoomTemplate, availableRoomTemplates, developerMode, gameplayRuntimeLocked, isZh, roomTemplate, selectedRoomTemplate]);

  const isStoryRoomTemplate = selectedRoomTemplate.sessionKind.scenarioId === 'story-reader';
  const isStudyRoomTemplate = selectedRoomTemplate.sessionKind.family === 'study';
  const studyGoalField = selectedRoomTemplate.configGroups
    ?.flatMap((group) => group.fields)
    .find((field) => field.key === 'studyGoalLabel');
  const topicPlaceholder = isStudyRoomTemplate
    ? studyGoalField?.placeholder || selectedRoomTemplate.topicPlaceholder
    : selectedRoomTemplate.topicPlaceholder;
  const topicLabel = isStoryRoomTemplate
    ? (isZh ? '开场提示' : 'Opening prompt')
    : isStudyRoomTemplate
      ? studyGoalField?.label || (isZh ? '学习目标' : 'Learning goal')
    : t('chat.topic');
  const handleTopicChange = useCallback((value: string) => {
    setTopic(value);
    if (isStudyRoomTemplate) setStudyGoalLabel(value);
  }, [isStudyRoomTemplate]);
  const handleStudyGoalChange = useCallback((value: string) => {
    setStudyGoalLabel(value);
    if (isStudyRoomTemplate) setTopic(value);
  }, [isStudyRoomTemplate]);

  const handleAutofill = useCallback(async () => {
    const profile = getPreferredAIProfile(aiProfiles, 'text') || api;
    if (!isAIProfileUsable(profile)) {
      showError(i18n.language.startsWith('zh') ? '请先配置AI模型' : 'Configure AI model first');
      return;
    }

    setAiAutofilling(true);
    try {
      const { generateChatDraftSuggestion } = await import('../services/chatDraftGenerator');
      const suggestion = await generateChatDraftSuggestion({
        config: profile,
        language: i18n.language.startsWith('zh') ? 'zh' : 'en',
        draft: {
          name,
          topic,
          roomTemplate,
          selectedMemberIds: selectedMembers,
          showRoleActions,
        },
        characters,
        gameplayFields: {
          storyBranchMode,
          storyBackground,
          storyDirection,
          storyOutline,
          studyGoalLabel,
          teachingMode,
          teacherExpertise,
          assessmentPolicy,
          agentGoalLabel,
          boardColumns,
          boardRows,
          deductionFactionCount,
          werewolfRoleConfig,
          werewolfPostGameMode,
          mysteryClueCount,
          mysteryScript,
          mysteryRoleMappingMode,
        },
      });

      const appliedName = !name.trim() && suggestion.suggestedName;
      const appliedTopic = !topic.trim() && suggestion.suggestedTopic;
      const appliedStyle = style === chatDraftDefaults.style && suggestion.suggestedStyle;
      const appliedRoleActions = showRoleActions === chatDraftDefaults.showRoleActions && suggestion.suggestedShowRoleActions !== undefined;
      const suggestedRoomTemplate = suggestion.suggestedRoomTemplate && availableRoomTemplates.some((template) => template.key === suggestion.suggestedRoomTemplate)
        ? suggestion.suggestedRoomTemplate
        : undefined;
      const appliedRoomTemplate = roomTemplate === 'open_chat' && suggestedRoomTemplate && suggestedRoomTemplate !== roomTemplate;
      const appliedMembers = !selectedMembers.length && suggestion.suggestedMemberIds?.length && suggestion.suggestedMemberIds.length >= minRequiredMembers;
      const targetRoomTemplate = getRoomTemplate(suggestedRoomTemplate || roomTemplate);

      if (appliedName) setName(suggestion.suggestedName!);
      if (appliedTopic) setTopic(suggestion.suggestedTopic!);
      if (appliedStyle) {
        styleOverriddenRef.current = true;
        setStyle(suggestion.suggestedStyle!);
      }
      if (appliedRoleActions) setShowRoleActions(suggestion.suggestedShowRoleActions!);
      if (appliedRoomTemplate) applyRoomTemplate(suggestedRoomTemplate);
      if (appliedMembers) setSelectedMembers(suggestion.suggestedMemberIds!.slice(0, maxAllowedMembers));
      const suggestedFields = suggestion.suggestedGameplayFields || {};
      const expandedFields = suggestion.expandedGameplayFields || {};
      const applyGameplayText = (current: string, key: keyof typeof suggestedFields, setter: (value: string) => void) => {
        const expanded = expandedFields[key];
        const suggested = suggestedFields[key];
        if (typeof expanded === 'string' && current.trim()) setter(expanded);
        else if (!current.trim() && typeof suggested === 'string') setter(suggested);
        return Boolean((typeof expanded === 'string' && current.trim()) || (!current.trim() && typeof suggested === 'string'));
      };
      const applyGameplayNumber = (current: number, key: keyof typeof suggestedFields, defaultValue: number, setter: (value: number) => void) => {
        const suggested = suggestedFields[key];
        if (current === defaultValue && typeof suggested === 'number') {
          setter(Math.max(['boardColumns', 'boardRows', 'deductionFactionCount'].includes(String(key)) ? 2 : 1, suggested));
          return true;
        }
        return false;
      };
      let appliedGameplay = false;
      appliedGameplay = applyGameplayText(storyBackground, 'storyBackground', setStoryBackground) || appliedGameplay;
      appliedGameplay = applyGameplayText(storyDirection, 'storyDirection', setStoryDirection) || appliedGameplay;
      appliedGameplay = applyGameplayText(storyOutline, 'storyOutline', setStoryOutline) || appliedGameplay;
      appliedGameplay = applyGameplayText(studyGoalLabel, 'studyGoalLabel', (value) => {
        setStudyGoalLabel(value);
        if (targetRoomTemplate.sessionKind.family === 'study') setTopic(value);
      }) || appliedGameplay;
      appliedGameplay = applyGameplayText(teacherExpertise, 'teacherExpertise', setTeacherExpertise) || appliedGameplay;
      appliedGameplay = applyGameplayText(agentGoalLabel, 'agentGoalLabel', setAgentGoalLabel) || appliedGameplay;
      appliedGameplay = applyGameplayText(werewolfRoleConfig, 'werewolfRoleConfig', setWerewolfRoleConfig) || appliedGameplay;
      appliedGameplay = applyGameplayText(mysteryScript, 'mysteryScript', setMysteryScript) || appliedGameplay;
      appliedGameplay = applyGameplayNumber(boardColumns, 'boardColumns', 8, setBoardColumns) || appliedGameplay;
      appliedGameplay = applyGameplayNumber(boardRows, 'boardRows', 8, setBoardRows) || appliedGameplay;
      appliedGameplay = applyGameplayNumber(deductionFactionCount, 'deductionFactionCount', 2, setDeductionFactionCount) || appliedGameplay;
      appliedGameplay = applyGameplayNumber(mysteryClueCount, 'mysteryClueCount', 6, setMysteryClueCount) || appliedGameplay;
      if (storyBranchMode === 'guided' && suggestedFields.storyBranchMode === 'open') { setStoryBranchMode('open'); appliedGameplay = true; }
      if (teachingMode === 'casual' && typeof suggestedFields.teachingMode === 'string') { setTeachingMode(suggestedFields.teachingMode); appliedGameplay = true; }
      if (assessmentPolicy === 'evidence_only' && typeof suggestedFields.assessmentPolicy === 'string') { setAssessmentPolicy(suggestedFields.assessmentPolicy); appliedGameplay = true; }
      if (werewolfPostGameMode === 'free_talk' && typeof suggestedFields.werewolfPostGameMode === 'string') { setWerewolfPostGameMode(suggestedFields.werewolfPostGameMode); appliedGameplay = true; }
      if (mysteryRoleMappingMode === 'alias' && typeof suggestedFields.mysteryRoleMappingMode === 'string') { setMysteryRoleMappingMode(suggestedFields.mysteryRoleMappingMode); appliedGameplay = true; }
      if (!appliedName && !appliedTopic && !appliedStyle && !appliedRoleActions && !appliedRoomTemplate && !appliedMembers && !appliedGameplay) {
        throw new Error(i18n.language.startsWith('zh') ? 'AI 没有返回可用建议' : 'AI did not return usable suggestions');
      }
      if (!selectedMembers.length && suggestion.suggestedMemberIds?.length && suggestion.suggestedMemberIds.length < minRequiredMembers) {
        throw new Error(i18n.language.startsWith('zh') ? 'AI 推荐的成员不足，无法自动补全' : 'Suggested members are insufficient for autofill');
      }

      setSnackbar({ open: true, message: i18n.language.startsWith('zh') ? '已自动补全群聊草稿' : 'Draft autofilled', severity: 'success' });
    } catch (error) {
      showError(getActionErrorMessage(error, t('common.error')));
    } finally {
      setAiAutofilling(false);
    }
  }, [
    aiProfiles,
    api,
    applyRoomTemplate,
    availableRoomTemplates,
    characters,
    chatDraftDefaults.showRoleActions,
    chatDraftDefaults.style,
    i18n.language,
    minRequiredMembers,
    maxAllowedMembers,
    storyBackground,
    storyDirection,
    storyOutline,
    storyBranchMode,
    studyGoalLabel,
    teachingMode,
    teacherExpertise,
    assessmentPolicy,
    agentGoalLabel,
    boardColumns,
    boardRows,
    deductionFactionCount,
    werewolfRoleConfig,
    werewolfPostGameMode,
    mysteryClueCount,
    mysteryScript,
    mysteryRoleMappingMode,
    name,
    roomTemplate,
    selectedMembers,
    showRoleActions,
    style,
    topic,
    t,
  ]);

  const handleDelete = useCallback(async () => {
    if (!editingChat) return;
    try {
      await deleteChat(editingChat.id);
      setDeleteConfirmOpen(false);
      const params = new URLSearchParams(location.search);
      const returnTo = params.get('returnTo');
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      navigate('/chats', { replace: true });
    } catch (error) {
      showError(getActionErrorMessage(error, i18n.language.startsWith('zh') ? '删除群聊失败' : 'Failed to delete chat'));
    }
  }, [deleteChat, editingChat, i18n.language, location.search, navigate]);

  const handleClearMessages = useCallback(async () => {
    if (!editingChat) return;
    try {
      // Drop locally queued creates before deleting remotely. Otherwise an
      // outbox flush racing this action can recreate pre-clear messages and
      // leave branch parents pointing at stale nodes.
      useMessageStore.getState().clearChatMessagesLocal(editingChat.id);
      useChatStore.getState().clearPendingOperationsForChat(editingChat.id);
      await apiClient.clearChatMessages(editingChat.id);
      await updateChat(editingChat.id, {
        ...buildInitialSessionResetPatch(editingChat),
        latestMessage: null,
        lastMessageAt: editingChat.createdAt,
      });
      await seedOpeningTopicMessage(editingChat.id, editingChat.topic);
      markChatsWarm();
      void prefetchChats();
      setClearMessagesConfirmOpen(false);
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '已清空聊天记录和会话状态' : 'Chat messages and session state cleared',
        severity: 'success',
      });
    } catch (error) {
      showError(getActionErrorMessage(error, i18n.language.startsWith('zh') ? '清空聊天记录失败' : 'Failed to clear chat messages'));
    }
  }, [editingChat, i18n.language, markChatsWarm, prefetchChats, seedOpeningTopicMessage, updateChat]);

  const handleClearMemory = useCallback(async () => {
    if (!editingChat) return;
    try {
      await updateChat(editingChat.id, buildInitialSessionResetPatch(editingChat));
      markChatsWarm();
      void prefetchChats();
      setClearMemoryConfirmOpen(false);
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '已清空会话状态' : 'Session state cleared',
        severity: 'success',
      });
    } catch (error) {
      showError(getActionErrorMessage(error, i18n.language.startsWith('zh') ? '重置会话状态失败' : 'Failed to reset session state'));
    }
  }, [editingChat, i18n.language, markChatsWarm, prefetchChats, updateChat]);

  const headerTitle = editingChat ? (name.trim() || editingChat.name || (isZh ? `编辑${conversationNoun}` : `Edit ${conversationNoun}`)) : t('chat.create');
  const autofillLabel = aiAutofilling ? t('common.loading') : (i18n.language.startsWith('zh') ? '自动补全' : 'Auto fill');
  const deleteLabel = t('common.delete');
  const closeMemberDialog = () => {
    setMemberDialogOpen(false);
  };
  const openDeleteDialog = useCallback(() => {
    setDeleteConfirmOpen(true);
  }, []);
  const closeDeleteDialog = () => {
    setDeleteConfirmOpen(false);
  };
  const openClearMessagesDialog = () => {
    setClearMessagesConfirmOpen(true);
  };
  const closeClearMessagesDialog = () => {
    setClearMessagesConfirmOpen(false);
  };
  const openClearMemoryDialog = () => {
    setClearMemoryConfirmOpen(true);
  };
  const closeClearMemoryDialog = () => {
    setClearMemoryConfirmOpen(false);
  };
  const openHotDialog = () => {
    setHotTopicDialogEnabled(true);
    setHotTopicOpenSignal((value) => value + 1);
  };
  const openBatchGenerate = () => {
    persistDraft();
    const params = new URLSearchParams();
    params.set('returnTo', location.pathname + location.search);
    const generationTopic = topic.trim() || name.trim();
    const generationDescription = [
      storyBackground.trim(),
      storyOutline.trim(),
      storyDirection.trim(),
      focus.trim(),
      recentEvent.trim(),
      seedMemoryText.trim(),
    ].filter(Boolean).join('\n\n');
    if (generationTopic) params.set('topic', generationTopic);
    if (generationDescription) params.set('description', generationDescription);
    navigate(`/characters/batch-generate?${params.toString()}`);
  };
  const openMemberDialog = () => {
    if (insufficientGroupCharacterCount) {
      setNoCharactersDialogOpen(true);
      return;
    }
    setMemberDialogOpen(true);
  };
  const closeSnackbar = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };
  const handleTabChange = (_: unknown, value: number) => {
    setTabTransitionDirection(resolveTabTransitionDirection(
      [
        ...(showGameplayTab ? [gameplayTabIndex] : []),
        0,
        ...(showManagementTab ? [managementTabIndex] : []),
        ...(showRuntimeTab ? [runtimeTabIndex] : []),
        ...(showDirectorTab ? [directorTabIndex] : []),
      ],
      configTab,
      value,
    ));
    setConfigTab(value);
  };
  const handleCreateAction = () => {
    void handleCreate();
  };
  const handleAutofillAction = useCallback(() => {
    void handleAutofill();
  }, [handleAutofill]);
  const openChatMarketUpload = useCallback((kind: 'chat_template' | 'bundle_template') => {
    if (!editingChat) return;
    setMarketMenuAnchor(null);
    const isBundle = kind === 'bundle_template';
    setMarketUploadDraft({
      kind,
      title: getMarketTitleForChat(editingChat),
      summary: getMarketSummaryForChat(editingChat),
      payload: isBundle ? buildBundleMarketPayload(editingChat, characters) : buildChatMarketPayload(editingChat),
      sourceEntityId: editingChat.id,
      marketItemId: null,
    });
  }, [characters, editingChat]);
  const handleDeleteAction = () => {
    void handleDelete();
  };
  const handleClearMessagesAction = () => {
    void handleClearMessages();
  };
  const handleClearMemoryAction = () => {
    void handleClearMemory();
  };
  const confirmMemberDialog = () => {
    setMemberDialogOpen(false);
    if (selectedMembers.length < MIN_MEMBERS) {
      showError(i18n.language.startsWith('zh') ? `当前至少需要${MIN_MEMBERS}个AI成员才能开始群聊` : `At least ${MIN_MEMBERS} AI members are required to start the chat`);
    }
  };
  const goBack = () => {
    navigate(-1);
  };

  const memberSummaryEmptyLabel = isZh ? '未选择AI角色' : 'No AI roles selected';
  const memberDialogConfirmLabel = t('common.confirm');
  const missingGroupCharacterCount = Math.max(0, MIN_MEMBERS - customCharacters.length);
  const noCharactersDialogTitle = customCharacters.length === 0
    ? (isZh ? '还没有AI角色' : 'No AI roles yet')
    : (isZh ? 'AI角色不足' : 'Not enough AI roles');
  const noCharactersDialogMessage = customCharacters.length === 0
    ? (isZh
        ? `创建群聊至少需要 ${MIN_MEMBERS} 个AI角色。可以先去角色库创建角色，或根据主题批量生成。`
        : `A group chat needs at least ${MIN_MEMBERS} AI roles. Create roles in the character library, or generate them in batch from your topic.`)
    : (isZh
        ? `当前只有 ${customCharacters.length} 个AI角色，群聊至少需要 ${MIN_MEMBERS} 个AI角色。请再创建 ${missingGroupCharacterCount} 个角色，或根据主题批量生成。`
        : `You currently have ${customCharacters.length} AI role(s), but a group chat needs at least ${MIN_MEMBERS}. Create ${missingGroupCharacterCount} more, or generate roles in batch from your topic.`);
  const startChatLabel = editingChat ? t('common.save') : '开始群聊';
  const maxChats = entitlementReady
    ? useFreeEntitlement
      ? freeEntitlement?.maxChats ?? null
      : membership?.vipEntitlement?.entitlement.maxChats ?? null
    : null;
  const activeChatCount = chats.filter((chat) => !chat.deletedAt).length;
  const chatLimitReached = !editingChat && maxChats != null && maxChats >= 0 && activeChatCount >= maxChats;
  const chatEntitlementUnavailable = !editingChat && !useFreeEntitlement && membershipLoaded && membershipLoadFailed;
  const showChatLimitDialog = (title = '聊天数量已达上限') => {
    setVipLimitDialog({
      title,
      description: '当前会员的聊天数量已经达到上限。升级 VIP 后可以创建更多群聊，也可以先删除不需要的聊天。',
      current: activeChatCount,
      limit: maxChats,
    });
  };
  const runtimePhaseLabel = editingChat?.worldState.phase || 'idle';
  const runtimeMoodLabel = mood || '未设置';
  const runtimeFocusLabel = focus || '未设置';
  const runtimeRecentEventLabel = recentEvent || '暂无';
  const deleteChatTitle = t('chat.delete');
  const deleteChatConfirm = t('chat.deleteConfirm');
  const cancelLabel = t('common.cancel');
  const confirmDeleteLabel = t('common.delete');
  const clearMessagesTitle = isZh ? '清空聊天记录' : 'Clear chat messages';
  const clearMessagesConfirm = isZh ? `这会永久删除当前${conversationNoun}的全部消息记录，并把场景规则、运行态、事件、会话级记忆与摘要重置成新${conversationNoun}状态；角色自身记忆会保留。此操作无法撤销。` : `This permanently deletes all messages in this ${conversationNoun} and resets scene rules, runtime state, events, session-level memory, and summaries as a fresh ${conversationNoun}. Character memory is kept. This action cannot be undone.`;
  const clearMessagesLabel = isZh ? '清空聊天记录' : 'Clear chat messages';
  const clearMemoryTitle = isZh ? '重置会话状态' : 'Reset session state';
  const clearMemoryConfirm = isZh ? `这会把当前${conversationNoun}的场景规则、运行态、事件、会话级记忆与摘要重置成新${conversationNoun}状态，但保留聊天记录和角色自身记忆。此操作无法撤销。` : `This resets scene rules, runtime state, events, session-level memory, and summaries for this ${conversationNoun} as a fresh ${conversationNoun}, while keeping message history and character memory. This action cannot be undone.`;
  const clearMemoryLabel = isZh ? '重置会话状态' : 'Reset session state';
  const noOwnerLabel = isZh ? '未设置' : 'None';
  const adminNotesValue = adminCharacterIds.length ? adminCharacterIds.map((memberId) => selectedCharacters.find((char) => char.id === memberId)?.name).filter(Boolean).join(', ') : noOwnerLabel;

  useEffect(() => {
    setHeaderTitle(headerTitle);
    setHeaderBackAction(() => () => navigate(-1));
    setHideMobileBottomNav(true);
    setHeaderActions(
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {!editingChat ? (
          <Button variant="outlined" startIcon={<AutoAwesomeIcon />} onClick={handleAutofillAction} disabled={!canAutofill}>
            {autofillLabel}
          </Button>
        ) : null}
        {editingChat && marketUploadEntitled ? (
          <IconButton size="small" onClick={(event) => setMarketMenuAnchor(event.currentTarget)} aria-label={isZh ? '更多操作' : 'More actions'}>
            <MoreVertIcon fontSize="small" />
          </IconButton>
        ) : null}
      </Box>
    );
  }, [autofillLabel, canAutofill, editingChat, handleAutofillAction, headerTitle, isZh, marketUploadEntitled, navigate, setHeaderActions, setHeaderBackAction, setHeaderTitle, setHideMobileBottomNav]);

  useEffect(() => {
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
      setHideMobileBottomNav(false);
      setHeaderActions(null);
    };
  }, [setHeaderActions, setHeaderBackAction, setHeaderTitle, setHideMobileBottomNav]);

  useEffect(() => {
    const availableTabs = [0]
      .concat(showGameplayTab ? [gameplayTabIndex] : [])
      .concat(showManagementTab ? [managementTabIndex] : [])
      .concat(showRuntimeTab ? [runtimeTabIndex] : [])
      .concat(showDirectorTab ? [directorTabIndex] : []);
    queueMicrotask(() => {
      if (!availableTabs.includes(configTab)) {
        setConfigTab(availableTabs[0] || 0);
      }
    });
  }, [configTab, directorTabIndex, gameplayTabIndex, managementTabIndex, runtimeTabIndex, showDirectorTab, showGameplayTab, showManagementTab, showRuntimeTab]);

  const desktopHeaderActions = null;
  void desktopHeaderActions;

  void goBack;
  void t;

  const buildCurrentGroupChatDraft = (
    draftName: string,
    memberIds: string[],
    normalizedOperatorIds: string[],
    normalizedOwnerCharacterId: string | null,
    normalizedAdminCharacterIds: string[],
  ) => buildGroupChatDraft({
    type: 'group',
    name: draftName,
    topic,
    style,
    runtimeEvolutionIntensity,
    sessionKind: selectedRoomTemplate.sessionKind,
    storyBranchMode,
    storyBackground,
    storyDirection,
    storyOutline,
    studyGoalLabel,
    teachingMode: teachingMode as 'entertainment' | 'casual' | 'serious',
    teacherExpertise,
    assessmentPolicy: assessmentPolicy as 'evidence_only' | 'guided_estimate' | 'strict',
    agentGoalLabel,
    boardColumns,
    boardRows,
    deductionFactionCount,
    werewolfRoleConfig,
    werewolfPostGameMode,
    mysteryClueCount,
    mysteryScript,
    mysteryRoleMappingMode,
    memberIds,
    operatorIds: normalizedOperatorIds,
    showRoleActions,
    seedMemoryText,
    seedArtifactText,
    ownerCharacterId: normalizedOwnerCharacterId,
    adminCharacterIds: normalizedAdminCharacterIds,
    autoModeration,
    allowMute,
    allowPrivateThreads,
    allowCliques,
    allowMockery,
    mood,
    focus,
    recentEvent,
    allowSpeakAs,
    allowDirectorMode,
    allowEventInjection,
    allowForcedReply,
  });

  const buildValidatedDraftContext = () => {
    const validMemberIds = Array.from(new Set(selectedMembers.filter(Boolean)));
    const normalizedOperatorIds = normalizeOperatorIdsInput(operatorIdsText, validMemberIds).effectiveIds;
    const nextMemberIds = composeGroupMemberIds(validMemberIds, includeUserAsMember);
    const normalizedOwnerCharacterId = ownerCharacterId && validMemberIds.includes(ownerCharacterId) ? ownerCharacterId : null;
    const normalizedAdminCharacterIds = Array.from(new Set(adminCharacterIds.filter((memberId) => validMemberIds.includes(memberId) && memberId !== normalizedOwnerCharacterId)));
    return {
      validMemberIds,
      normalizedOperatorIds,
      nextMemberIds,
      normalizedOwnerCharacterId,
      normalizedAdminCharacterIds,
    };
  };

  const handleSaveAsChat = async () => {
    if (!editingChat) return;
    if (saving || saveAsChatSaving) {
      showError(i18n.language.startsWith('zh') ? '正在处理中，请稍候' : 'Already processing, please wait');
      return;
    }
    if (maxChats != null && maxChats >= 0 && activeChatCount >= maxChats) {
      showChatLimitDialog('另存为会超过聊天上限');
      return;
    }
    if (!agentEntitled && isAgentRoomTemplate(selectedRoomTemplate)) {
      showError(isZh ? 'Agent 房间仅会员可用。' : 'Agent rooms are available to members only.');
      return;
    }
    const draftContext = buildValidatedDraftContext();
    if (!name.trim()) {
      showError(i18n.language.startsWith('zh') ? '请填写群聊名称' : 'Please enter a chat name');
      return;
    }
    if (draftContext.validMemberIds.length < minRequiredMembers) {
      showError(isZh ? `当前${conversationNoun}至少需要${minRequiredMembers}个AI角色` : `This ${conversationNoun} needs at least ${minRequiredMembers} AI role(s)`);
      return;
    }
    if (selectedMembers.length !== draftContext.validMemberIds.length) {
      showError(i18n.language.startsWith('zh') ? '部分成员无效，请重新选择后再试' : 'Some selected members are invalid. Please reselect and try again');
      return;
    }
    if (ownerCharacterId && !draftContext.normalizedOwnerCharacterId) {
      showError(i18n.language.startsWith('zh') ? '群主必须是当前群成员' : 'The owner must be one of the selected members');
      return;
    }
    if (adminCharacterIds.length !== draftContext.normalizedAdminCharacterIds.length) {
      showError(i18n.language.startsWith('zh') ? '管理员必须来自当前群成员，且不能与群主重复' : 'Admins must be selected members and cannot duplicate the owner');
      return;
    }

    setSaveAsChatSaving(true);
    try {
      const saveAsName = buildSaveAsChatName(editingChat.name || name, chats.map((chat) => chat.name));
      const chat = await addChat(buildCurrentGroupChatDraft(
        saveAsName,
        draftContext.nextMemberIds,
        draftContext.normalizedOperatorIds,
        draftContext.normalizedOwnerCharacterId,
        draftContext.normalizedAdminCharacterIds,
      ));
      setChatDraftDefaults({ style, showRoleActions, includeUserAsMember, runtimeEvolutionIntensity });
      navigate(`/chats/${chat.id}/edit`);
    } catch (error) {
      showError(getActionErrorMessage(error, i18n.language.startsWith('zh') ? '另存为群聊失败' : 'Failed to save as chat'));
    } finally {
      setSaveAsChatSaving(false);
    }
  };

  const handleSaveAsChatAction = () => {
    void handleSaveAsChat();
  };

  const handleCreate = async () => {
    if (saving) {
      showError(i18n.language.startsWith('zh') ? '正在处理中，请稍候' : 'Already processing, please wait');
      return;
    }
    if (chatLimitReached) {
      showChatLimitDialog();
      return;
    }
    if (!agentEntitled && isAgentRoomTemplate(selectedRoomTemplate)) {
      showError(isZh ? 'Agent 房间仅会员可用。' : 'Agent rooms are available to members only.');
      return;
    }
    if (insufficientGroupCharacterCount) {
      setNoCharactersDialogOpen(true);
      return;
    }

    const draftContext = buildValidatedDraftContext();

    if (!name.trim()) {
      showError(i18n.language.startsWith('zh') ? '请填写群聊名称' : 'Please enter a chat name');
      return;
    }
    if (draftContext.validMemberIds.length < minRequiredMembers) {
      showError(isZh ? `当前${conversationNoun}至少需要${minRequiredMembers}个AI角色` : `This ${conversationNoun} needs at least ${minRequiredMembers} AI role(s)`);
      return;
    }
    if (selectedMembers.length !== draftContext.validMemberIds.length) {
      showError(i18n.language.startsWith('zh') ? '部分成员无效，请重新选择后再试' : 'Some selected members are invalid. Please reselect and try again');
      return;
    }
    if (ownerCharacterId && !draftContext.normalizedOwnerCharacterId) {
      showError(i18n.language.startsWith('zh') ? '群主必须是当前群成员' : 'The owner must be one of the selected members');
      return;
    }
    if (adminCharacterIds.length !== draftContext.normalizedAdminCharacterIds.length) {
      showError(i18n.language.startsWith('zh') ? '管理员必须来自当前群成员，且不能与群主重复' : 'Admins must be selected members and cannot duplicate the owner');
      return;
    }

    setSaving(true);
    try {
      if (editingChat) {
        const nextDraft = buildCurrentGroupChatDraft(
          name,
          draftContext.nextMemberIds,
          draftContext.normalizedOperatorIds,
          draftContext.normalizedOwnerCharacterId,
          draftContext.normalizedAdminCharacterIds,
        );
        const nameChanged = name.trim() !== (editingChat.name || '').trim();
        await updateChat(editingChat.id, {
          ...nextDraft,
          modeState: editingChat.type === 'assistant'
            ? {
              ...editingChat.modeState,
              ...nextDraft.modeState,
              assistantTitle: nameChanged
                ? { source: 'user', updatedAt: Date.now() }
                : editingChat.modeState?.assistantTitle,
            }
            : {
              ...nextDraft.modeState,
              // Detail-page initialization owns this lifecycle. Keep a completed
              // marker until a changed member fingerprint makes it stale again.
              initialization: editingChat.modeState.initialization,
            },
          runtimeTimeline: editingChat.runtimeTimeline || nextDraft.runtimeTimeline || [],
          runtimeEventsV2: editingChat.runtimeEventsV2 || nextDraft.runtimeEventsV2 || [],
          relationshipLedger: editingChat.relationshipLedger || nextDraft.relationshipLedger || [],
          layeredMemories: editingChat.layeredMemories || nextDraft.layeredMemories || [],
          worldState: {
            ...DEFAULT_CONVERSATION_WORLD_STATE,
            ...editingChat.worldState,
            ...nextDraft.worldState,
          },
        });
        setChatDraftDefaults({ style, showRoleActions, includeUserAsMember, runtimeEvolutionIntensity });
        navigate(-1);
        return;
      }

      let creationIdMap = new Map<string, string>();
      if (marketImportDraft?.item.kind === 'bundle_template') {
        const bundledEntries = getBundledCharacterEntries(marketImportDraft.item);
        const previewByLocalId = new Map(marketBundleCharacterPreviews.map((character) => [character.id, character]));
        const createdCharacters = await addCharacters(bundledEntries.map((entry) => {
          const preview = previewByLocalId.get(entry.localId)!;
          const { id: _id, isPreset: _isPreset, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = preview;
          void _id;
          void _isPreset;
          void _createdAt;
          void _updatedAt;
          return {
            ...draft,
          sourceMarketItemId: marketImportDraft.item.id,
          sourceMarketItemVersion: marketImportDraft.item.payloadVersion,
          sourceMarketKind: marketImportDraft.item.kind,
          };
        }));
        creationIdMap = new Map(bundledEntries.map((entry, index) => [entry.localId, createdCharacters[index]?.id || entry.localId]));
      }
      const mapMemberIds = (ids: string[]) => ids.map((memberId) => creationIdMap.get(memberId) || memberId);
      const baseDraft = buildCurrentGroupChatDraft(
        name,
        mapMemberIds(draftContext.nextMemberIds),
        mapMemberIds(draftContext.normalizedOperatorIds),
        draftContext.normalizedOwnerCharacterId ? creationIdMap.get(draftContext.normalizedOwnerCharacterId) || draftContext.normalizedOwnerCharacterId : null,
        mapMemberIds(draftContext.normalizedAdminCharacterIds),
      );
      const importedChatRuntime = marketImportDraft?.item.kind === 'bundle_template'
        ? remapIds(buildImportedChatDraft(marketImportDraft.item), creationIdMap) as Partial<GroupChat>
        : null;
      const chat = await addChat({
        ...(importedChatRuntime || {}),
        ...baseDraft,
        memberIds: baseDraft.memberIds,
        sourceMarketItemId: marketImportDraft?.item.id || undefined,
        sourceMarketItemVersion: marketImportDraft?.item.payloadVersion,
        sourceMarketKind: marketImportDraft?.item.kind,
      });
      // Keep automatic avatar generation consistent with the character setting:
      // a newly created group gets a themed group avatar in the same background
      // image queue, while creation itself remains fast and non-blocking.
      if (chat.type === 'group' && useSettingsStore.getState().avatarGeneration.autoGenerateCharacterAvatar) {
        const generationMembers = [
          ...characters,
          ...marketBundleCharacterPreviews.filter((character) => !characters.some((item) => item.id === character.id)),
        ].filter((character) => chat.memberIds.includes(character.id));
        enqueueGroupVisualGeneration({
          chat,
          members: generationMembers,
          profiles: aiProfiles,
          settings: useSettingsStore.getState().avatarGeneration,
          language: isZh ? 'zh' : 'en',
          kind: 'avatar',
        });
      }
      if (draftContext.nextMemberIds.length) {
        const memberNames = baseDraft.memberIds.map((memberId) => (
          memberId === 'user' ? 'User' : characters.find((char) => char.id === memberId)?.name || marketBundleCharacterPreviews.find((char) => creationIdMap.get(char.id) === memberId || char.id === memberId)?.name || memberId
        ));
        await useMessageStore.getState().addMessage({
          chatId: chat.id,
          type: 'system',
          senderId: 'system',
          senderName: 'System',
          content: `${memberNames.join('、')} 加入群聊`,
          emotion: 0,
          timestamp: Date.now(),
        });
      }
      if (marketImportDraft?.item.id) {
        void marketApi.recordImported(marketImportDraft.item.id).catch((error) => {
          console.warn('[market:record-imported:error]', error);
        });
      }
      sessionStorage.removeItem(CHAT_DRAFT_KEY);
      setChatDraftDefaults({ style, showRoleActions, includeUserAsMember, runtimeEvolutionIntensity });
      navigate(`/chats/${chat.id}`);
    } catch (error) {
      showError(getActionErrorMessage(error, editingChat
        ? (i18n.language.startsWith('zh') ? '保存群聊失败' : 'Failed to save chat')
        : (i18n.language.startsWith('zh') ? '创建群聊失败' : 'Failed to create chat')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ p: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 18, sm: 14, md: 10 }, maxWidth: 860, mx: 'auto' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 1.5, sm: 2 } }}>
        {chatEntitlementUnavailable ? (
          <Alert severity="warning">
            {isZh ? '暂时无法确认当前账号的聊天数量权益，创建时会由服务器再次校验。' : 'Unable to confirm chat quota for this account. The server will validate it when creating.'}
          </Alert>
        ) : chatLimitReached ? (
          <Alert severity="warning">
            {isZh ? `聊天数量已达当前会员上限（${chats.filter((chat) => !chat.deletedAt).length}/${maxChats}），升级会员后可创建更多聊天。` : `Chat limit reached (${chats.filter((chat) => !chat.deletedAt).length}/${maxChats}). Upgrade membership to create more chats.`}
          </Alert>
        ) : null}
        <Box
          sx={{ ...buildFloatingTabContainerSx(), mb: 0 }}
        >
          <FloatingSegmentedTabs
            value={configTab}
            scrollContentToTopOnChange
            onChange={(value) => handleTabChange(null, value)}
            items={[
              ...(showGameplayTab ? [{ value: gameplayTabIndex, label: i18n.language.startsWith('zh') ? '玩法' : 'Gameplay' }] : []),
              { value: 0, label: i18n.language.startsWith('zh') ? '设定' : 'Config' },
              ...(showManagementTab ? [{ value: managementTabIndex, label: i18n.language.startsWith('zh') ? '管理' : 'Management' }] : []),
              ...(showRuntimeTab ? [{ value: runtimeTabIndex, label: i18n.language.startsWith('zh') ? '记忆' : 'Memory' }] : []),
              ...(showDirectorTab ? [{ value: directorTabIndex, label: i18n.language.startsWith('zh') ? '导演控制' : 'Director' }] : []),
            ]}
          />
        </Box>

        <AnimatedTabContent
          value={configTab}
          direction={tabTransitionDirection}
        >
          {configTab === 0 ? (
            <>
            <ChatConfigSection
              lockMembers={Boolean(editingChat && !isGroupConversation)}
              showMembers={Boolean(!editingChat || isGroupConversation)}
              maxMembers={maxAllowedMembers}
              name={name}
              topic={topic}
              style={style}
              runtimeEvolutionIntensity={runtimeEvolutionIntensity}
              showRoleActions={showRoleActions}
              includeUserAsMember={includeUserAsMember}
              operatorIdsText={operatorIdsText}
              showOperatorSettings={developerMode}
              ownerCharacterId={ownerCharacterId}
              adminCharacterIds={adminCharacterIds}
              noOwnerLabel={noOwnerLabel}
              adminNotesValue={adminNotesValue}
              autoModeration={autoModeration}
              allowMute={allowMute}
              allowPrivateThreads={allowPrivateThreads}
              conversationKind={conversationKind}
              conversationNoun={conversationNoun}
              editingChat={Boolean(editingChat)}
              operatorNormalizedIds={operatorIds}
              operatorValidationHint={filteredOperatorCount > 0
                ? (isZh ? `已自动忽略 ${filteredOperatorCount} 个与成员重复或无效的操作者 ID` : `${filteredOperatorCount} operator id(s) ignored because they overlap with members or are invalid`)
                : ''}
              selectedMembers={selectedMembers}
              selectedCharacters={selectedCharacters}
              language={i18n.language}
              memberSummaryEmptyLabel={memberSummaryEmptyLabel}
              topicPlaceholder={topicPlaceholder}
              getStyleLabel={getStyleLabel}
              onNameChange={setName}
              onTopicChange={handleTopicChange}
              onStyleChange={handleStyleChange}
              onRuntimeEvolutionIntensityChange={setRuntimeEvolutionIntensity}
              onShowRoleActionsChange={setShowRoleActions}
              onIncludeUserAsMemberChange={setIncludeUserAsMember}
              onOperatorIdsTextChange={setOperatorIdsText}
              onOwnerChange={setOwnerCharacterId}
              onAdminChange={setAdminCharacterIds}
              onAutoModerationChange={setAutoModeration}
              onAllowMuteChange={setAllowMute}
              onAllowPrivateThreadsChange={setAllowPrivateThreads}
              onOpenMemberDialog={openMemberDialog}
              onOpenBatchGenerate={openBatchGenerate}
              onOpenHotDialog={openHotDialog}
              onToggleMember={toggleMember}
              nameLabel={t('chat.name')}
              namePlaceholder={t('chat.namePlaceholder')}
              topicLabel={topicLabel}
              selectMembersLabel={isGroupConversation ? t('chat.selectMembers') : (isZh ? '选择角色' : 'Select role')}
              membersHintLabel={isGroupConversation ? t('chat.membersHint') : (isZh ? `${conversationNoun}中的AI角色` : `AI roles in this ${conversationNoun}`)}
              styleLabel={t('chat.style')}
              showRoleActionsLabel={i18n.language.startsWith('zh') ? '显示角色动作' : 'Show role actions'}
              includeUserAsMemberLabel={includeUserAsMemberCopy.label}
              includeUserAsMemberHint={includeUserAsMemberCopy.hint}
              operatorIdsLabel={i18n.language.startsWith('zh') ? '内部操作角色 ID（开发者）' : 'Internal operator IDs (developer)'}
              operatorIdsHint={i18n.language.startsWith('zh') ? '登记成员列表之外的内部角色；不会接入外部机器人或自动发言。身份由 ID 中的 host、narrator、gm 等关键词推断，会影响动作能力和内容可见性。多个 ID 用逗号分隔。' : 'Register internal roles outside the member list. This does not connect external bots or trigger speech. Keywords such as host, narrator and gm in each ID determine the role and affect action capabilities and content visibility. Separate IDs with commas.'}
              openTopicInspirationLabel={i18n.language.startsWith('zh') ? '打开热点灵感' : 'Open topic inspiration'}
              batchGenerateMembersLabel={i18n.language.startsWith('zh') ? '生成' : 'Generate'}
              visualSettings={editingChat ? (
              <SurfaceCard>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{isGroupConversation ? '头像和背景' : '聊天背景'}</Typography>
                  <IconButton size="small" aria-label={groupVisualExpanded ? '收起头像和背景' : '展开头像和背景'} onClick={() => setGroupVisualExpanded((current) => !current)} sx={{ transform: groupVisualExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms ease' }}>
                    <ExpandMoreIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Collapse in={groupVisualExpanded} timeout={180} unmountOnExit>
                <Box sx={{ display: 'grid', gap: 1, mt: 1.25 }}>
                  {(isGroupConversation ? (['avatar', 'background'] as const) : (['background'] as const)).map((kind) => {
                    const visual = editingChat.groupVisual || {};
                    const url = kind === 'avatar' ? visual.avatarUrl : visual.backgroundUrl;
                    const label = kind === 'avatar' ? '群头像' : '聊天背景';
                    return (
                      <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                        <Box sx={{ position: 'relative', width: 76, height: 76, flexShrink: 0, overflow: 'hidden', borderRadius: 1.25, bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
                          {url && !unavailableGroupVisualUrls[url]
                            ? <Box component="img" src={url} alt={label} onError={() => setUnavailableGroupVisualUrls((current) => ({ ...current, [url]: true }))} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: kind === 'background' ? groupBackgroundOpacityDraft : 1, transition: 'opacity 80ms linear' }} />
                            : <Typography variant="caption" color="text.secondary" sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>{url ? '图片不可用' : '未设置'}</Typography>}
                        </Box>
                        <Box sx={{ display: 'grid', gap: 0.5, minWidth: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>{label}</Typography>
                          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                          <input ref={(node) => { groupVisualUploadRefs.current[kind] = node; }} hidden type="file" accept="image/*" onChange={(event) => void handleGroupVisualUpload(kind, event.target.files?.[0])} />
                          <Button size="small" variant="outlined" onClick={() => groupVisualUploadRefs.current[kind]?.click()}>上传</Button>
                          <Button size="small" variant="outlined" onClick={() => setGroupVisualDialog({ kind, requirement: '' })}>生成</Button>
                          </Box>
                          {kind === 'background' ? (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: { xs: '100%', sm: 210 } }}>
                              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>不透明度</Typography>
                              <Slider
                                size="small"
                                min={0.05}
                                max={1}
                                step={0.01}
                                value={groupBackgroundOpacityDraft}
                                valueLabelDisplay="auto"
                                valueLabelFormat={(value) => `${Math.round(Number(value) * 100)}%`}
                                onChange={(_, value) => {
                                  setGroupBackgroundOpacityDraft(Array.isArray(value) ? value[0] : value);
                                }}
                                onChangeCommitted={(_, value) => {
                                  const nextOpacity = Array.isArray(value) ? value[0] : value;
                                  void updateChat(editingChat.id, { groupVisual: { ...visual, backgroundOpacity: nextOpacity } });
                                }}
                              />
                            </Box>
                          ) : null}
                        </Box>
                      </Box>
                    );
                  })}
                </Box>
                </Collapse>
              </SurfaceCard>
              ) : null}
            />
            {editingChat ? (
              <SurfaceCard sx={{ mt: 2, mb: 2, borderColor: 'error.light', bgcolor: 'rgba(211, 47, 47, 0.04)' }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'error.main' }}>
                  {isZh ? '危险操作' : 'Danger zone'}
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1 }}>
                  <Button color="error" variant="outlined" onClick={openClearMessagesDialog}>
                    {clearMessagesLabel}
                  </Button>
                  <Button color="error" variant="outlined" onClick={openClearMemoryDialog}>
                    {clearMemoryLabel}
                  </Button>
                  <Button color="error" variant="outlined" startIcon={<DeleteIcon />} onClick={openDeleteDialog}>
                    {deleteLabel}
                  </Button>
                </Box>
              </SurfaceCard>
            ) : null}
            </>
          ) : null}

        {showGameplayTab && configTab === gameplayTabIndex ? (
          <GameplaySection
            language={i18n.language}
            roomTemplate={roomTemplate}
            roomTemplates={gameplaySectionTemplates}
            onRoomTemplateChange={handleRoomTemplateChange}
            lockGameplayKernelSelection={gameplayRuntimeLocked}
            lockPresetSelection={gameplayRuntimeLocked}
            onSaveAsChat={editingChat ? handleSaveAsChatAction : undefined}
            saveAsChatDisabled={saving || saveAsChatSaving}
            onOpenBatchGenerate={openBatchGenerate}
            topic={topic}
            topicLabel={topicLabel}
            onTopicChange={handleTopicChange}
            storyBranchMode={storyBranchMode}
            onStoryBranchModeChange={setStoryBranchMode}
            studyGoalLabel={studyGoalLabel}
            onStudyGoalLabelChange={handleStudyGoalChange}
            teachingMode={teachingMode}
            onTeachingModeChange={setTeachingMode}
            teacherExpertise={teacherExpertise}
            onTeacherExpertiseChange={setTeacherExpertise}
            assessmentPolicy={assessmentPolicy}
            onAssessmentPolicyChange={setAssessmentPolicy}
            agentGoalLabel={agentGoalLabel}
            onAgentGoalLabelChange={setAgentGoalLabel}
            boardColumns={boardColumns}
            boardRows={boardRows}
            onBoardColumnsChange={setBoardColumns}
            onBoardRowsChange={setBoardRows}
            deductionFactionCount={deductionFactionCount}
            onDeductionFactionCountChange={setDeductionFactionCount}
            mysteryClueCount={mysteryClueCount}
            onMysteryClueCountChange={setMysteryClueCount}
            storyBackground={storyBackground}
            onStoryBackgroundChange={setStoryBackground}
            storyDirection={storyDirection}
            onStoryDirectionChange={setStoryDirection}
            storyOutline={storyOutline}
            onStoryOutlineChange={setStoryOutline}
            werewolfRoleConfig={werewolfRoleConfig}
            onWerewolfRoleConfigChange={setWerewolfRoleConfig}
            werewolfPostGameMode={werewolfPostGameMode}
            onWerewolfPostGameModeChange={setWerewolfPostGameMode}
            mysteryScript={mysteryScript}
            onMysteryScriptChange={setMysteryScript}
            mysteryRoleMappingMode={mysteryRoleMappingMode}
            onMysteryRoleMappingModeChange={setMysteryRoleMappingMode}
            allowPrivateThreads={allowPrivateThreads}
            onAllowPrivateThreadsChange={setAllowPrivateThreads}
            allowCliques={allowCliques}
            onAllowCliquesChange={setAllowCliques}
            allowMockery={allowMockery}
            onAllowMockeryChange={setAllowMockery}
          />
        ) : null}

        {showManagementTab && configTab === managementTabIndex ? (
          <ManagementSection
            selectedCharacters={selectedCharacters}
            ownerCharacterId={ownerCharacterId}
            adminCharacterIds={adminCharacterIds}
            noOwnerLabel={noOwnerLabel}
            adminNotesValue={adminNotesValue}
            autoModeration={autoModeration}
            allowMute={allowMute}
            allowPrivateThreads={allowPrivateThreads}
            allowCliques={allowCliques}
            allowMockery={allowMockery}
            editingChat={Boolean(editingChat)}
            conversationKind={conversationKind}
            conversationNoun={conversationNoun}
            language={i18n.language}
            onOwnerChange={setOwnerCharacterId}
            onAdminChange={setAdminCharacterIds}
            onAutoModerationChange={setAutoModeration}
            onAllowMuteChange={setAllowMute}
            onAllowPrivateThreadsChange={setAllowPrivateThreads}
            onAllowCliquesChange={setAllowCliques}
            onAllowMockeryChange={setAllowMockery}
          />
        ) : null}

        {showRuntimeTab && configTab === runtimeTabIndex ? (
          <Suspense fallback={null}>
            <RuntimeSeedSection
              editingChatId={editingChat?.id}
              editingChatCreatedAt={editingChat?.createdAt}
              editingChatUpdatedAt={editingChat?.updatedAt}
              editingChatLastMessageAt={editingChat?.lastMessageAt}
              editingChatTimeline={editingChat?.runtimeTimeline}
              editingChatRuntimeEvents={editingChat?.runtimeEventsV2}
              editingChatRelationshipLedger={editingChat?.relationshipLedger}
              editingChatLayeredMemories={editingChat?.layeredMemories}
              editingChatConflictAxes={editingChat?.worldState.conflictAxes}
              editingChatConflictState={editingChat?.worldState.conflictState}
              name={name}
              topic={topic}
              style={style}
              runtimeEvolutionIntensity={runtimeEvolutionIntensity}
              selectedMembers={selectedMembers}
              showRoleActions={showRoleActions}
              ownerCharacterId={ownerCharacterId}
              adminCharacterIds={adminCharacterIds}
              autoModeration={autoModeration}
              allowMute={allowMute}
              allowPrivateThreads={allowPrivateThreads}
              allowCliques={allowCliques}
              allowMockery={allowMockery}
              mood={mood}
              focus={focus}
              recentEvent={recentEvent}
              allowSpeakAs={allowSpeakAs}
              allowDirectorMode={allowDirectorMode}
              allowEventInjection={allowEventInjection}
              allowForcedReply={allowForcedReply}
              seedMemoryText={seedMemoryText}
              seedArtifactText={seedArtifactText}
              setSeedMemoryText={setSeedMemoryText}
              setSeedArtifactText={setSeedArtifactText}
              runtimePhaseLabel={runtimePhaseLabel}
              runtimeMoodLabel={runtimeMoodLabel}
              runtimeFocusLabel={runtimeFocusLabel}
              runtimeRecentEventLabel={runtimeRecentEventLabel}
              selectedCharacters={selectedCharacters}
            />
          </Suspense>
        ) : null}

          {showDirectorTab && configTab === directorTabIndex ? (
            <DirectorControlsSection
              allowSpeakAs={allowSpeakAs}
              setAllowSpeakAs={setAllowSpeakAs}
              allowDirectorMode={allowDirectorMode}
              setAllowDirectorMode={setAllowDirectorMode}
              allowEventInjection={allowEventInjection}
              setAllowEventInjection={setAllowEventInjection}
              allowForcedReply={allowForcedReply}
              setAllowForcedReply={setAllowForcedReply}
              allowCliques={allowCliques}
              setAllowCliques={setAllowCliques}
              allowMockery={allowMockery}
              setAllowMockery={setAllowMockery}
              onSaveAsChat={editingChat ? handleSaveAsChatAction : undefined}
              saveAsChatDisabled={saving || saveAsChatSaving}
            />
          ) : null}
        </AnimatedTabContent>

        <ExpandableFab
          icon={editingChat ? <SaveIcon /> : <ForumIcon />}
          label={saving ? t('common.loading') : startChatLabel}
          ariaLabel={saving ? t('common.loading') : startChatLabel}
          onClick={handleCreateAction}
          disabled={saving || saveAsChatSaving}
          sx={{
            position: 'fixed',
            right: { xs: 20, sm: 28, md: 36 },
            bottom: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', sm: 32, md: 36 },
          }}
        />
      </Box>

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={closeSnackbar}
        severity={snackbar.severity}
        message={snackbar.message}
        offset="none"
      />
      <VipLimitDialog
        open={Boolean(vipLimitDialog)}
        title={vipLimitDialog?.title || ''}
        description={vipLimitDialog?.description || ''}
        current={vipLimitDialog?.current}
        limit={vipLimitDialog?.limit}
        helperText={vipLimitDialog?.helperText}
        onClose={() => setVipLimitDialog(null)}
      />
      <NoCharactersDialog
        open={noCharactersDialogOpen}
        onClose={() => setNoCharactersDialogOpen(false)}
        returnTo={location.pathname + location.search}
        batchTopic={topic || name}
        batchDescription={[storyBackground, storyOutline, storyDirection, focus, recentEvent, seedMemoryText].filter((item) => item.trim()).join('\n\n')}
        title={noCharactersDialogTitle}
        message={noCharactersDialogMessage}
      />

      <MemberSelectionDialog
        open={memberDialogOpen}
        onClose={closeMemberDialog}
        customCharacters={customCharacters}
        presetCharacters={[]}
        selectedMembers={selectedMembers}
        hasCustomCharacters={hasCustomCharacters}
        hasPresetCharacters={false}
        title={t('chat.selectMembers')}
        presetLabel="Preset"
        confirmLabel={memberDialogConfirmLabel}
        cancelLabel={cancelLabel}
        searchPlaceholder={isZh ? '搜索角色、分组或设定' : 'Search roles, groups, or profile'}
        allGroupsLabel={isZh ? '全部分组' : 'All groups'}
        customSectionLabel={isZh ? '自定义角色' : 'Custom roles'}
        presetSectionLabel={isZh ? '预设角色' : 'Preset roles'}
        selectedCountLabel={(count) => isZh ? `已选 ${count}` : `${count} selected`}
        emptyLabel={isZh ? '没有匹配的角色' : 'No matching roles'}
        onConfirm={confirmMemberDialog}
        onToggleMember={toggleMember}
        onStartLongPress={startMemberLongPress}
        onClearPressTimer={clearMemberPressTimer}
        onContextMenu={handleMemberItemContextMenu}
      />

      <Dialog open={deleteConfirmOpen} onClose={closeDeleteDialog} maxWidth="xs" fullWidth>
        <DialogTitle>{deleteChatTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{deleteChatConfirm}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeDeleteDialog}>{cancelLabel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDeleteAction}
          >
            {confirmDeleteLabel}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={clearMessagesConfirmOpen} onClose={closeClearMessagesDialog} maxWidth="xs" fullWidth>
        <DialogTitle>{clearMessagesTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{clearMessagesConfirm}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeClearMessagesDialog}>{cancelLabel}</Button>
          <Button color="error" variant="contained" onClick={handleClearMessagesAction}>
            {clearMessagesLabel}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={clearMemoryConfirmOpen} onClose={closeClearMemoryDialog} maxWidth="xs" fullWidth>
        <DialogTitle>{clearMemoryTitle}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">{clearMemoryConfirm}</Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeClearMemoryDialog}>{cancelLabel}</Button>
          <Button color="error" variant="contained" onClick={handleClearMemoryAction}>
            {clearMemoryLabel}
          </Button>
        </DialogActions>
      </Dialog>

      {hotTopicDialogEnabled ? (
        <Suspense fallback={null}>
          <HotTopicDialogContainer
            openSignal={hotTopicOpenSignal}
            language={i18n.language}
            apiConfig={api}
            aiProfiles={aiProfiles}
            autoGenerateCharacterAvatar={useSettingsStore.getState().avatarGeneration.autoGenerateCharacterAvatar}
            characters={characters}
            name={name}
            topic={topic}
            setName={setName}
            setTopic={setTopic}
            setStyle={handleStyleChange}
            setSelectedMembers={setSelectedMembers}
            addCharacters={addCharacters}
            maxMembers={maxAllowedMembers}
            onError={showError}
            setSnackbar={setSnackbar}
            getStyleLabel={getStyleLabel}
          />
        </Suspense>
      ) : null}

      {marketUploadEntitled ? (
        <>
          <Menu
            anchorEl={marketMenuAnchor}
            open={Boolean(marketMenuAnchor)}
            onClose={() => setMarketMenuAnchor(null)}
          >
            <MenuItem onClick={() => openChatMarketUpload('chat_template')}>
              提交聊天到市场
            </MenuItem>
            <MenuItem onClick={() => openChatMarketUpload('bundle_template')}>
              上传组合包到市场
            </MenuItem>
          </Menu>

          <MarketUploadDialog
            open={Boolean(marketUploadDraft)}
            draft={marketUploadDraft}
            onClose={() => setMarketUploadDraft(null)}
            onUploaded={(item) => {
              if (!editingChat || item.kind !== 'chat_template') return;
              void updateChat(editingChat.id, {
                sourceMarketItemId: item.id,
                sourceMarketItemVersion: item.payloadVersion,
                sourceMarketKind: item.kind,
              });
            }}
          />
        </>
      ) : null}
      <Dialog open={Boolean(groupVisualDialog)} onClose={() => setGroupVisualDialog(null)} fullWidth maxWidth="sm">
        <DialogTitle>{groupVisualDialog?.kind === 'avatar' ? '生成群头像' : '生成聊天背景'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            可补充本次偏好；它不会写入聊天长期设定。{groupVisualDialog?.kind === 'background' ? ' 背景源图为方形，界面会自动裁切适配横竖屏。' : ''}
          </Typography>
          <TextField autoFocus fullWidth multiline minRows={3} value={groupVisualDialog?.requirement || ''} onChange={(event) => setGroupVisualDialog((current) => current ? { ...current, requirement: event.target.value } : current)} placeholder={groupVisualDialog?.kind === 'avatar' ? '例如：暖色、旧书与咖啡的感觉' : '例如：浅色雾感、不要抢文字'} />
        </DialogContent>
        <DialogActions><Button onClick={() => setGroupVisualDialog(null)}>取消</Button><Button variant="contained" onClick={queueGroupVisualFromDialog}>加入队列</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
