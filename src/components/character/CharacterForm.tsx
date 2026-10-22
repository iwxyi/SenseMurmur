import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Chip,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  Card,
  CardContent,
  Stack,
  FormControlLabel,
  Switch,
  Autocomplete,
  Collapse,
  Tooltip,
  Alert,
  CircularProgress,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ImageIcon from '@mui/icons-material/Image';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme } from '@mui/material/styles';
import type { AICharacter, PersonalityParams, CharacterBehaviorParams, CharacterMemoryConfig, CharacterInterventionConfig, CharacterSpeechProfile, CharacterVoiceConfig, CharacterCoreProfile, CharacterGenerationPreferences, CharacterGenerationOverride } from '../../types/character';
import { getCharacterGroupList, normalizeCharacterGroup, normalizeCharacterModelProfileIds, getDuplicateCharacterNameKeys, getDuplicateCharacterWarningText, hasDuplicateCharacterName } from '../../types/character';
import type { BubbleStyleDefinition } from '../../types/bubbleStyle';
import { DEFAULT_PERSONALITY, DEFAULT_CHARACTER_BEHAVIOR, DEFAULT_CHARACTER_MEMORY, DEFAULT_CHARACTER_INTERVENTION, DEFAULT_CORE_PROFILE } from '../../types/character';
import { buildFallbackCharacterVisualGenerationPlan, generateCharacterProfile, generateCharacterVisualGenerationPlan, generateCharacterVisualIdentityDraft, generateCharacterVoiceProfileDraft } from '../../services/characterGenerator';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useCharacterArtifactStore, type CharacterArtifactEntry } from '../../stores/useCharacterArtifactStore';
import type { AIModelType } from '../../types/settings';
import { getPreferredAIProfile, isAIProfileUsable } from '../../types/settings';
import type { GroupChat } from '../../types/chat';
import { avatarGenerationQueue, type AvatarGenerationStatus } from '../../services/avatarGenerationQueue';
import { canAutoGenerateAvatarDraft, enqueueAvatarGenerationForCharacter } from '../../services/avatarGeneration';
import { isImageAvatar as isImageAvatarValue } from '../../utils/avatar';
import { prepareAvatarUploadDataUrl } from '../../utils/avatarUpload';
import { api } from '../../services/api';
import { assignGeneratedVoiceProfile } from '../../services/speechVoiceAssignment';
import PersonalitySliders from './PersonalitySliders';
import NumericSliders from './NumericSliders';
import RuntimeInsightsPanel, { CharacterMemoryInspector, CharacterRelationshipInspector } from './RuntimeInsightsPanel';
import CollapsibleParamGroup from './CollapsibleParamGroup';
import { AVATAR_OPTIONS } from '../../constants/presets';
import { DEFAULT_AI_BUBBLE_STYLE_ID } from '../../constants/bubbleStyles';
import { buildBubblePreview, cloneBubbleStyle, createCharacterBubbleStyleId, resolveCharacterBubbleStyle } from '../../utils/bubbleStyle';
import ArtifactCalendarReader from '../artifacts/ArtifactCalendarReader';
import BubbleStylePickerDialog from '../bubble/BubbleStylePickerDialog';
import ExpandableFab from '../common/ExpandableFab';
import WorldCalendarPanel from '../calendar/WorldCalendarPanel';
import { buildCharacterFormTabs } from './characterFormTabs';

function buildEditorCardSx() {
  return {
    borderRadius: 1,
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(18,20,28,0.72)',
    backdropFilter: 'blur(18px) saturate(1.12)',
    WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
    boxShadow: (theme: Theme) => theme.palette.mode === 'light'
      ? '0 1px 2px rgba(15,23,42,0.03), 0 14px 38px rgba(15,23,42,0.045)'
      : '0 1px 0 rgba(255,255,255,0.035) inset, 0 18px 44px rgba(0,0,0,0.26)',
  };
}

function buildAvatarOptionSx(selected: boolean) {
  return {
    width: '100%',
    aspectRatio: '1 / 1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.35rem',
    borderRadius: 1,
    cursor: 'pointer',
    border: '1px solid',
    borderColor: selected ? 'primary.main' : (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
    bgcolor: selected
      ? (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.12)' : 'rgba(120,156,220,0.18)'
      : (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.76)' : 'rgba(255,255,255,0.075)',
    boxShadow: selected ? '0 0 0 1px rgba(49,90,156,0.12) inset' : 'none',
    transition: 'background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
    '&:hover': {
      borderColor: 'primary.main',
      bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.12)',
    },
    '&:active': {
      transform: 'scale(0.986)',
    },
  };
}

function buildGeneratedVoiceInstructions(profile: NonNullable<CharacterVoiceConfig['voiceProfile']>, language: string) {
  const zh = language.startsWith('zh');
  const parts = [
    profile.traits?.length ? `${zh ? '音色特征' : 'Timbre'}：${profile.traits.join(zh ? '、' : ', ')}` : '',
    profile.styles?.length ? `${zh ? '表达风格' : 'Delivery'}：${profile.styles.join(zh ? '、' : ', ')}` : '',
    profile.emotions?.length ? `${zh ? '情绪倾向' : 'Emotional tone'}：${profile.emotions.join(zh ? '、' : ', ')}` : '',
    profile.energy ? `${zh ? '整体能量' : 'Energy'}：${profile.energy}` : '',
    zh ? '保持自然口语感，避免播音腔。' : 'Keep it conversational and natural; avoid a broadcast-announcer voice.',
  ];
  return parts.filter(Boolean).join('；');
}

function buildGeneratedVoicePitch(profile: NonNullable<CharacterVoiceConfig['voiceProfile']>) {
  if (profile.gender === 'male' || profile.age === 'senior') return '-1';
  if (profile.gender === 'female' && (profile.age === 'child' || profile.age === 'young')) return '+1';
  return '0';
}

import type { CharacterVisualIdentity, CharacterVisualReferenceImage } from '../../types/character';
import FloatingSegmentedTabs from '../common/FloatingSegmentedTabs';
import { buildFloatingTabContainerSx } from '../common/FloatingSegmentedTabs.styles';
import AnimatedTabContent from '../common/AnimatedTabContent';
import { resolveTabTransitionDirection } from '../common/tabTransition';

function getDiaryEntriesSorted<T extends { dateKey?: string | null; createdAt: number }>(entries: T[]) {
  return entries
    .filter((entry): entry is T & { dateKey: string } => Boolean(entry.dateKey))
    .slice()
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.createdAt - b.createdAt);
}

function getGenerateButtonLabel(language: string, generating: boolean) {
  if (generating) return language.startsWith('zh') ? '生成中' : 'Generating';
  return language.startsWith('zh') ? '生成' : 'Generate';
}
function getGenerateError(language: string) {
  return language.startsWith('zh') ? '角色生成失败，请检查 AI 设置后重试' : 'Failed to generate character profile. Check AI settings and try again.';
}
function getGenerateNoKeyError(language: string) {
  return language.startsWith('zh') ? '请先在设置中填写 AI 配置' : 'Configure AI settings first.';
}
function getGenerateAriaLabel(language: string) {
  return language.startsWith('zh') ? '生成角色资料' : 'Generate character profile';
}
function getHelperText(_language: string, error: string | null) {
  return error || '';
}
function renderAvatarPreview(avatar: string, isImageAvatar: boolean, size: number) {
  return (
    <Box sx={{ width: size, height: size, borderRadius: '50%', bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
      {isImageAvatar
        ? <Box component="img" src={avatar} alt="avatar" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : avatar}
    </Box>
  );
}
function pickRandomExample(options: string[]) {
  return options[Math.floor(Math.random() * options.length)] || '';
}

function getVisualAssetIdentity(asset: CharacterVisualReferenceImage) {
  // 资产 ID 可能因重复上传而不同，优先用内容指纹/URL 去重。
  return asset.checksum || asset.url || asset.assetId || asset.id;
}

function dedupeVisualAssets(assets: CharacterVisualReferenceImage[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = getVisualAssetIdentity(asset);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MODEL_TYPE_ORDER: Array<Exclude<AIModelType, 'audio'>> = ['text', 'image', 'tts', 'stt', 'document'];

interface CharacterFormProps {
  initial?: Partial<AICharacter>;
  existingNames?: string[];
  saveError?: string | null;
  onDraftNameChange?: (name: string) => void;
  onDelete?: () => void;
  deleteLabel?: string;
  calendarContext?: {
    chats: GroupChat[];
    characters: AICharacter[];
    updateChat: (id: string, patch: Partial<GroupChat>) => Promise<void>;
    actorId: string;
  };
  onDiaryTabOpen?: () => void;
  onVisualAssetsChange?: (assets: CharacterVisualReferenceImage[], primaryReferenceImageId: string | null) => void;
  onSave: (data: {
    name: string;
    avatar: string;
    personality: PersonalityParams;
    behavior: CharacterBehaviorParams;
    expertise: string[];
    speakingStyle: string;
    background: string;
    speechProfile?: CharacterSpeechProfile;
    voiceConfig?: CharacterVoiceConfig;
    relationships: AICharacter['relationships'];
    group?: string | null;
    memory: CharacterMemoryConfig;
    coreProfile: CharacterCoreProfile;
    intervention: CharacterInterventionConfig;
    modelProfileId?: string | null;
    modelProfileIds?: Partial<Record<AIModelType, string | null>>;
    generationPreferences?: CharacterGenerationPreferences;
    bubbleStyle?: BubbleStyleDefinition | null;
    bubbleStyleId?: string | null;
    visualIdentity?: CharacterVisualIdentity | null;
    generatedByAI?: boolean;
  }) => void;
  onCancel: () => void;
}

interface InlineTagEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}

function InlineTagEditor({ value, onChange, placeholder, addLabel }: InlineTagEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editing]);

  const commitDraft = () => {
    const nextValue = draft.trim();
    if (nextValue && !value.includes(nextValue)) {
      onChange([...value, nextValue]);
    }
    setDraft('');
    setEditing(false);
  };

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
      {value.map((item) => <Chip key={item} label={item} onDelete={() => onChange(value.filter((entry) => entry !== item))} size="small" />)}
      {editing ? (
        <Chip
          label={
            <TextField
              inputRef={inputRef}
              variant="standard"
              placeholder={value.length === 0 ? placeholder : ''}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitDraft();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft('');
                  setEditing(false);
                }
              }}
              onBlur={commitDraft}
              slotProps={{ input: { disableUnderline: true } }}
              sx={{ width: draft ? `${Math.max(4, draft.length + 1)}ch` : '8em', minWidth: '4em', maxWidth: 180, '& .MuiInputBase-root': { fontSize: 13 }, '& .MuiInputBase-input': { py: 0, px: 0, width: '100%' } }}
            />
          }
          size="small"
          variant="outlined"
          sx={{ width: 'fit-content', maxWidth: 210, '& .MuiChip-label': { px: 0.75, py: 0.25 } }}
        />
      ) : (
        <IconButton
          size="small"
          aria-label={addLabel}
          onClick={() => setEditing(true)}
          sx={{
            width: 28,
            height: 28,
            border: '1px dashed',
            borderColor: 'divider',
            color: 'text.secondary',
            '&:hover': {
              borderColor: 'primary.main',
              color: 'primary.main',
              bgcolor: 'action.hover',
            },
          }}
        >
          <AddIcon fontSize="inherit" />
        </IconButton>
      )}
    </Box>
  );
}

export default function CharacterForm({ initial, existingNames = [], saveError = null, onDraftNameChange, onDelete, deleteLabel, calendarContext, onDiaryTabOpen, onVisualAssetsChange, onSave }: CharacterFormProps) {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore(useShallow((state) => ({
    aiProfiles: state.aiProfiles,
    avatarGeneration: state.avatarGeneration,
    customBubbleStyles: state.customBubbleStyles,
    artifactAppearance: state.artifactAppearance,
    developerMode: state.developerMode,
    developerUI: state.developerUI,
    setCustomBubbleStyles: state.setCustomBubbleStyles,
  })));
  const showSpeechStyle = settings.developerMode && settings.developerUI.showSpeechStyle;
  const isEditingExistingCharacter = Boolean(initial?.id);
  const [name, setName] = useState(initial?.name || '');
  const [avatar, setAvatar] = useState(initial?.avatar || '🤖');
  const [personality, setPersonality] = useState<PersonalityParams>(initial?.personality || DEFAULT_PERSONALITY);
  const [behavior, setBehavior] = useState<CharacterBehaviorParams>(initial?.behavior || DEFAULT_CHARACTER_BEHAVIOR);
  const [expertise, setExpertise] = useState<string[]>(initial?.expertise || []);
  const [speakingStyle, setSpeakingStyle] = useState(initial?.speakingStyle || '');
  const [background, setBackground] = useState(initial?.background || '');
  const [visualIdentity, setVisualIdentity] = useState<CharacterVisualIdentity>(() => ({
    description: initial?.visualIdentity?.description || '',
    styleHint: initial?.visualIdentity?.styleHint || '',
    negativePrompt: initial?.visualIdentity?.negativePrompt || '',
    seed: initial?.visualIdentity?.seed ?? null,
    referenceImages: initial?.visualIdentity?.referenceImages || [],
    primaryReferenceImageId: initial?.visualIdentity?.primaryReferenceImageId ?? null,
    defaults: initial?.visualIdentity?.defaults || { useReferenceImages: false },
  }));
  const [speechProfile, setSpeechProfile] = useState<CharacterSpeechProfile | undefined>(initial?.speechProfile);
  const [voiceConfig, setVoiceConfig] = useState<CharacterVoiceConfig>(initial?.voiceConfig || { enabled: false });
  const [speechVoices, setSpeechVoices] = useState<Array<{ id: string; name: string; language?: string; gender?: string; age?: string; traits?: string[]; styles?: string[] }>>([]);
  const [speechVoicesLoading, setSpeechVoicesLoading] = useState(false);
  const [assigningVoice, setAssigningVoice] = useState(false);
  const [generatingVoiceProfile, setGeneratingVoiceProfile] = useState(false);
  const [voiceAssignmentError, setVoiceAssignmentError] = useState<string | null>(null);
  const [group, setGroup] = useState(initial?.group || '');
  const [memory, setMemory] = useState<CharacterMemoryConfig>(initial?.memory || DEFAULT_CHARACTER_MEMORY);
  const [coreProfile, setCoreProfile] = useState<CharacterCoreProfile>(() => ({
    ...DEFAULT_CORE_PROFILE,
    ...(initial?.coreProfile || {}),
      valuePriority: initial?.coreProfile?.valuePriority || [],
      biases: initial?.coreProfile?.biases || [],
      values: initial?.coreProfile?.values || initial?.coreProfile?.valuePriority || [],
      sensitivities: initial?.coreProfile?.sensitivities || [],
      perceptionBiases: initial?.coreProfile?.perceptionBiases || initial?.coreProfile?.biases || [],
      interactionHabits: initial?.coreProfile?.interactionHabits || [],
      unmetNeeds: initial?.coreProfile?.unmetNeeds || [],
      hiddenSoftSpots: initial?.coreProfile?.hiddenSoftSpots || [],
  }));
  const [intervention, setIntervention] = useState<CharacterInterventionConfig>(initial?.intervention || DEFAULT_CHARACTER_INTERVENTION);
  const [modelProfileIds, setModelProfileIds] = useState(() => normalizeCharacterModelProfileIds(initial?.modelProfileIds, initial?.modelProfileId || null));
  const [generationPreferences, setGenerationPreferences] = useState<CharacterGenerationPreferences>({
    moments: initial?.generationPreferences?.moments || 'follow_global',
    diaries: initial?.generationPreferences?.diaries || 'follow_global',
    companionship: initial?.generationPreferences?.companionship || 'follow_global',
  });
  const [bubbleStyleId, setBubbleStyleId] = useState<string>(initial?.bubbleStyleId || DEFAULT_AI_BUBBLE_STYLE_ID);
  const [bubbleStyle, setBubbleStyle] = useState<BubbleStyleDefinition>(() => cloneBubbleStyle(initial?.bubbleStyle) || { ...resolveCharacterBubbleStyle({ bubbleStyleId: initial?.bubbleStyleId, customStyles: settings.customBubbleStyles || [] }) });
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [bubblePickerOpen, setBubblePickerOpen] = useState(false);
  const [configTab, setConfigTab] = useState(0);
  const [tabTransitionDirection, setTabTransitionDirection] = useState<-1 | 1>(1);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const modelDefaultsAppliedRef = useRef(false);
  const characters = useCharacterStore((state) => state.characters);
  const artifactItems = useCharacterArtifactStore((state) => state.items);
  const regenerateArtifact = useCharacterArtifactStore((state) => state.regenerateArtifact);
  const [personalityExpanded, setPersonalityExpanded] = useState(true);
  const [socialExpanded, setSocialExpanded] = useState(true);
  const [discussionExpanded, setDiscussionExpanded] = useState(true);
  const [modelConfigExpanded, setModelConfigExpanded] = useState(false);
  const [coreProfileExpanded, setCoreProfileExpanded] = useState(false);
  const [visualIdentityExpanded, setVisualIdentityExpanded] = useState(true);
  const [voiceIdentityExpanded, setVoiceIdentityExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [generatingVisualDescription, setGeneratingVisualDescription] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const duplicateNameErrorText = i18n.language.startsWith('zh') ? '已存在同名角色' : 'A character with the same name already exists';
  const [generatedByAI, setGeneratedByAI] = useState(false);
  const [avatarTaskId, setAvatarTaskId] = useState<string | null>(null);
  const [avatarTaskStatus, setAvatarTaskStatus] = useState<AvatarGenerationStatus | null>(null);
  const [avatarTaskError, setAvatarTaskError] = useState<string | null>(null);
  const [visualImageTaskId, setVisualImageTaskId] = useState<string | null>(null);
  const [visualImageTaskStatus, setVisualImageTaskStatus] = useState<AvatarGenerationStatus | null>(null);
  const [visualImageTaskError, setVisualImageTaskError] = useState<string | null>(null);
  const [visualImagePlanWarning, setVisualImagePlanWarning] = useState<string | null>(null);
  const [visualAssets, setVisualAssets] = useState<CharacterVisualReferenceImage[]>(() => dedupeVisualAssets(initial?.visualIdentity?.referenceImages || initial?.visualReferenceImages || []));
  const visualAssetInputRef = useRef<HTMLInputElement | null>(null);
  const visualAssetsRef = useRef<CharacterVisualReferenceImage[]>(dedupeVisualAssets(initial?.visualIdentity?.referenceImages || initial?.visualReferenceImages || []));
  const loadedInitialSignatureRef = useRef<string | null>(initial ? `${initial.id || 'draft'}:${initial.updatedAt || 0}:${initial.characterDetailLoaded ? 'detail' : 'summary'}` : null);
  const processedVisualImageTaskIdsRef = useRef(new Set<string>());
  const avatarTaskTargetKey = initial?.id ? `character:${initial.id}` : 'character-form:draft';
  const visualImageTargetKey = initial?.id ? `character-visual:${initial.id}` : 'character-form:visual-draft';

  const modelTypeLabels: Record<AIModelType, string> = {
    text: i18n.language.startsWith('zh') ? '文本' : 'Text',
    image: i18n.language.startsWith('zh') ? '图片' : 'Image',
    tts: i18n.language.startsWith('zh') ? '语音（TTS）' : 'Speech (TTS)',
    stt: i18n.language.startsWith('zh') ? '语音（STT）' : 'Speech (STT)',
    audio: i18n.language.startsWith('zh') ? '语音' : 'Audio',
    document: i18n.language.startsWith('zh') ? '文档' : 'Document',
  };
  const customBubbleStyles = settings.customBubbleStyles || [];
  const selectedBubbleStyle = resolveCharacterBubbleStyle({ bubbleStyle, bubbleStyleId, customStyles: customBubbleStyles });
  const selectedBubblePreview = buildBubblePreview(selectedBubbleStyle);
  const bubblePreviewText = useMemo(() => (i18n.language.startsWith('zh') ? '这是角色气泡预览' : 'Bubble style preview'), [i18n.language]);
  const visualIdentityExamples = useMemo(() => ({
    description: i18n.language.startsWith('zh')
      ? [
          '二十多岁，短发，银色细框眼镜，干净利落的衬衫；深夜台灯下盯着代码，桌上散着写满批注的便签。',
          '三十岁上下，皮肤偏白，眼神很稳，头发随手扎起，宽松但有质感的衣服；雨后站在旧书店门口，指尖夹着一页折角的诗稿。',
          '神情放松却带疲惫，发型利落，衣着有生活气息；下班后的空地铁车厢里靠窗坐着，窗外霓虹从脸侧掠过。',
        ]
      : [
          'Mid-20s, short hair, thin silver glasses, clean shirt; focused on code beneath a late-night desk lamp, annotated sticky notes scattered nearby.',
          'Around 30, fair skin, calm eyes, casually tied hair, loose textured clothes; standing outside an old bookshop after rain, holding a folded page of poetry.',
          'Relaxed but slightly tired, neat hair, lived-in outfit; seated by the window of an empty subway after work, neon light passing across the face.',
        ],
    styleHint: i18n.language.startsWith('zh')
      ? [
          '电影感叙事构图，动作和光影服务于人物身份，主体清晰，不要普通摆拍。',
          '具有代表性的场景与道具，画面有故事正在发生的感觉，人物仍然清楚可辨。',
          '可写实或风格化，但要让姿态、环境和色彩共同强化人物气质。',
        ]
      : [
          'Cinematic narrative composition: action and lighting serve the role, with a clear subject and no generic posed portrait.',
          'Use representative setting and props so the image feels like a story in progress while the character remains recognizable.',
          'May be realistic or stylized, but pose, environment, and color must reinforce the character’s temperament.',
        ],
    negativePrompt: i18n.language.startsWith('zh')
      ? [
          '避免水印、文字、过度磨皮、塑料感皮肤、夸张滤镜、额外肢体、多人误入。',
          '不要文字叠加、不要海报感、不要棚拍感、不要脸部失真。',
          '避免卡通化过强、AI 味太重、肢体重复、背景杂乱到看不清主体。',
        ]
      : [
          'Avoid watermarks, text, heavy skin smoothing, plastic skin, extreme filters, extra limbs, accidental crowding.',
          'No captions, no poster look, no studio-photo feel, no facial distortion.',
          'Avoid overly cartoonish output, obvious AI look, duplicated limbs, or cluttered backgrounds that hide the subject.',
        ],
    seed: i18n.language.startsWith('zh')
      ? [
          '如果想稳定同一角色外观，可以填一个固定整数，例如 123456。',
          '相同 seed 往往会让构图和气质更接近，但不同模型不一定完全一致。',
          '不想固定风格时可以留空，让每次结果稍有变化。',
        ]
      : [
          'Use a fixed integer like 123456 if you want a more stable look.',
          'The same seed often keeps composition and vibe closer, but models can still vary.',
          'Leave it empty if you want the result to vary a bit each time.',
        ],
  }), [i18n.language]);
  const existingGroups = useMemo(() => getCharacterGroupList(characters.filter((character) => !character.isPreset)), [characters]);
  const duplicateNameKeys = useMemo(() => getDuplicateCharacterNameKeys(characters.filter((character) => !character.isPreset)), [characters]);
  const hasLegacyDuplicateName = Boolean(initial?.id && initial?.name && hasDuplicateCharacterName({ name: initial.name }, duplicateNameKeys));
  const duplicateNameWarning = hasLegacyDuplicateName ? getDuplicateCharacterWarningText({ name: initial?.name || '', group: initial?.group || null }, i18n.language) : '';
  const profilesByType = useMemo(() => ({
    text: settings.aiProfiles.filter((profile) => (profile.type || 'text') === 'text'),
    image: settings.aiProfiles.filter((profile) => profile.type === 'image'),
    tts: settings.aiProfiles.filter((profile) => profile.type === 'tts'),
    stt: settings.aiProfiles.filter((profile) => profile.type === 'stt'),
    document: settings.aiProfiles.filter((profile) => profile.type === 'document'),
  }), [settings.aiProfiles]);
  const selectedTtsProfile = profilesByType.tts.find((profile) => profile.id === modelProfileIds.tts) || getPreferredAIProfile(profilesByType.tts, 'tts');

  useEffect(() => {
    let cancelled = false;
    if (!selectedTtsProfile?.provider) { setSpeechVoices([]); return () => { cancelled = true; }; }
    setSpeechVoicesLoading(true);
    void api.listSpeechVoices(selectedTtsProfile.provider, selectedTtsProfile.model).then((result) => {
      if (!cancelled) setSpeechVoices(result.voices || []);
    }).catch(() => {
      if (!cancelled) setSpeechVoices([]);
    }).finally(() => {
      if (!cancelled) setSpeechVoicesLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedTtsProfile?.provider, selectedTtsProfile?.model]);

  useEffect(() => {
    onDraftNameChange?.(name);
  }, [name, onDraftNameChange]);

  useEffect(() => {
    if (!isEditingExistingCharacter) {
      requestAnimationFrame(() => nameInputRef.current?.focus());
    }
  }, [isEditingExistingCharacter]);

  useEffect(() => {
    if (initial?.id || modelDefaultsAppliedRef.current) return;
    setModelProfileIds((current) => {
      const next = { ...current };
      for (const type of MODEL_TYPE_ORDER) {
        if (next[type]) continue;
        next[type] = getPreferredAIProfile(profilesByType[type], type)?.id || null;
      }
      return next;
    });
    modelDefaultsAppliedRef.current = true;
  }, [initial?.id, profilesByType]);

  useEffect(() => {
    if (!initial) return;
    const initialSignature = `${initial.id || 'draft'}:${initial.updatedAt || 0}:${initial.characterDetailLoaded ? 'detail' : 'summary'}`;
    if (loadedInitialSignatureRef.current === initialSignature) return;
    loadedInitialSignatureRef.current = initialSignature;
    setModelProfileIds(normalizeCharacterModelProfileIds(initial.modelProfileIds, initial.modelProfileId || null));
    setAvatar(initial.avatar || '🤖');
    setGenerationPreferences({
      moments: initial.generationPreferences?.moments || 'follow_global',
      diaries: initial.generationPreferences?.diaries || 'follow_global',
      companionship: initial.generationPreferences?.companionship || 'follow_global',
    });
    setVoiceConfig(initial.voiceConfig || { enabled: false });
    setVisualIdentity({
      description: initial.visualIdentity?.description || '',
      styleHint: initial.visualIdentity?.styleHint || '',
      negativePrompt: initial.visualIdentity?.negativePrompt || '',
      seed: initial.visualIdentity?.seed ?? null,
      referenceImages: initial.visualIdentity?.referenceImages || initial.visualReferenceImages || [],
      primaryReferenceImageId: initial.visualIdentity?.primaryReferenceImageId ?? null,
      defaults: initial.visualIdentity?.defaults || { useReferenceImages: false },
    });
    setVisualAssets(dedupeVisualAssets(initial.visualIdentity?.referenceImages || initial.visualReferenceImages || []));
    setCoreProfile({
      ...DEFAULT_CORE_PROFILE,
      ...(initial.coreProfile || {}),
      valuePriority: initial.coreProfile?.valuePriority || [],
      biases: initial.coreProfile?.biases || [],
      values: initial.coreProfile?.values || initial.coreProfile?.valuePriority || [],
      sensitivities: initial.coreProfile?.sensitivities || [],
      perceptionBiases: initial.coreProfile?.perceptionBiases || initial.coreProfile?.biases || [],
      interactionHabits: initial.coreProfile?.interactionHabits || [],
      unmetNeeds: initial.coreProfile?.unmetNeeds || [],
      hiddenSoftSpots: initial.coreProfile?.hiddenSoftSpots || [],
    });
  }, [initial]);

  useEffect(() => {
    visualAssetsRef.current = visualAssets;
  }, [visualAssets]);

  useEffect(() => {
    const current = avatarGenerationQueue.getLatestTaskForTarget(avatarTaskTargetKey);
    if (current) {
      setAvatarTaskId(current.id);
      setAvatarTaskStatus(current.status);
      setAvatarTaskError(current.error);
      if (current.status === 'succeeded' && current.imageDataUrl) {
        setAvatar(current.imageDataUrl);
      }
    }

    return avatarGenerationQueue.subscribeTarget(avatarTaskTargetKey, (state) => {
      setAvatarTaskStatus(state.status);
      setAvatarTaskError(state.error);
      setAvatarTaskId(state.status === 'queued' || state.status === 'running' ? state.id : null);
      if (state.status === 'succeeded' && state.imageDataUrl) {
        setAvatar(state.imageDataUrl);
      }
    });
  }, [avatarTaskTargetKey]);

  useEffect(() => {
    const current = avatarGenerationQueue.getLatestTaskForTarget(visualImageTargetKey);
    if (current) {
      setVisualImageTaskId(current.id);
      setVisualImageTaskStatus(current.status);
      setVisualImageTaskError(current.error);
    }

    return avatarGenerationQueue.subscribeTarget(visualImageTargetKey, async (state) => {
      setVisualImageTaskStatus(state.status);
      setVisualImageTaskError(state.error);
      setVisualImageTaskId(state.status === 'queued' || state.status === 'running' ? state.id : null);
      if (state.status === 'succeeded' && state.imageDataUrl) {
        if (processedVisualImageTaskIdsRef.current.has(state.id)) return;
        processedVisualImageTaskIdsRef.current.add(state.id);
        const shouldBePrimary = visualAssetsRef.current.length === 0;
        const localAsset: CharacterVisualReferenceImage = {
          id: `local-visual-${Date.now()}`,
          assetId: `local-visual-${Date.now()}`,
          url: state.imageDataUrl,
          mimeType: 'image/png',
          source: 'generated',
          isPrimary: shouldBePrimary,
          createdAt: Date.now(),
        };
        if (initial?.id) {
          try {
            const prepared = await prepareAvatarUploadDataUrl(state.imageDataUrl, { maxSize: 1024, quality: 0.9 });
            const saved = await api.createCharacterVisualAsset(initial.id, {
              dataUrl: prepared,
              label: i18n.language.startsWith('zh') ? '形象图' : 'Visual identity',
              source: 'generated',
              isPrimary: shouldBePrimary,
            });
            const savedAsset: CharacterVisualReferenceImage = {
              id: saved.id,
              assetId: saved.assetId || saved.id,
              url: saved.url,
              mimeType: saved.mimeType,
              sizeBytes: saved.sizeBytes,
              checksum: saved.checksum,
              label: saved.label || undefined,
              source: saved.source,
              isPrimary: saved.isPrimary,
              createdAt: saved.createdAt,
            };
            const currentAssets = visualAssetsRef.current;
            const nextAssets = savedAsset.isPrimary
              ? [...currentAssets.map((item) => ({ ...item, isPrimary: false })), savedAsset]
              : [...currentAssets, savedAsset];
            commitVisualAssets(nextAssets, savedAsset.isPrimary ? savedAsset.id : undefined);
            return;
          } catch (error) {
            setVisualImageTaskStatus('failed');
            setVisualImageTaskError(error instanceof Error ? error.message : String(error));
            return;
          }
        }
        commitVisualAssets([...visualAssetsRef.current, localAsset], localAsset.isPrimary ? localAsset.id : undefined);
      }
    });
  }, [initial?.id, i18n.language, visualImageTargetKey]);


  const handleGenerate = async () => {
    if (!name.trim() || generating) return;
    const textModelProfileId = modelProfileIds.text || null;
    const selectedProfile = settings.aiProfiles.find((profile) => profile.id === textModelProfileId) || getPreferredAIProfile(settings.aiProfiles, 'text') || settings.aiProfiles[0];
    if (!isAIProfileUsable(selectedProfile)) {
      setGenerateError(getGenerateNoKeyError(i18n.language));
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      const generated = await generateCharacterProfile(selectedProfile, name.trim(), i18n.language.startsWith('zh') ? 'zh' : 'en', normalizeCharacterGroup(group));
      const generatedBubbleStyleId = createCharacterBubbleStyleId();
      setAvatar(generated.avatar);
      setPersonality(generated.personality);
      setBehavior(generated.behavior);
      setExpertise(generated.expertise);
      setSpeakingStyle(generated.speakingStyle);
      setBackground(generated.background);
      setSpeechProfile(generated.speechProfile);
      const generatedVoiceProfile = generated.voiceProfile || {};
      setVoiceConfig((prev) => ({
        ...prev,
        ...generated.voiceConfig,
        voiceProfile: generatedVoiceProfile,
        pitch: prev.pitch || buildGeneratedVoicePitch(generatedVoiceProfile),
        instructions: prev.instructions || buildGeneratedVoiceInstructions(generatedVoiceProfile, i18n.language),
      }));
      setCoreProfile({
        ...DEFAULT_CORE_PROFILE,
        ...generated.coreProfile,
        values: generated.coreProfile.values || generated.coreProfile.valuePriority || [],
        valuePriority: generated.coreProfile.valuePriority || generated.coreProfile.values || [],
        perceptionBiases: generated.coreProfile.perceptionBiases || generated.coreProfile.biases || [],
        biases: generated.coreProfile.biases || generated.coreProfile.perceptionBiases || [],
        sensitivities: generated.coreProfile.sensitivities || [],
        interactionHabits: generated.coreProfile.interactionHabits || [],
        unmetNeeds: generated.coreProfile.unmetNeeds || [],
        hiddenSoftSpots: generated.coreProfile.hiddenSoftSpots || [],
      });
      setVisualIdentity((prev) => ({
        ...prev,
        description: generated.visualIdentity?.description || prev.description || '',
        styleHint: generated.visualIdentity?.styleHint || prev.styleHint || '',
        negativePrompt: generated.visualIdentity?.negativePrompt || prev.negativePrompt || '',
        seed: generated.visualIdentity?.seed ?? prev.seed ?? null,
      }));
      setBubbleStyleId(generatedBubbleStyleId);
      setBubbleStyle({ ...generated.bubbleStyle, id: generatedBubbleStyleId });
      setGeneratedByAI(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setGenerateError(detail && detail !== getGenerateError(i18n.language) ? `${getGenerateError(i18n.language)}：${detail}` : getGenerateError(i18n.language));
    } finally {
      setGenerating(false);
    }
  };

  const matchVoiceForProfile = async (profile: NonNullable<CharacterVoiceConfig['voiceProfile']>) => {
    if (!selectedTtsProfile?.provider) return false;
    setAssigningVoice(true);
    setVoiceAssignmentError(null);
    try {
      const usedVoiceIds = characters
        .filter((character) => character.id !== initial?.id)
        .map((character) => character.voiceConfig?.voiceName)
        .filter((voice): voice is string => Boolean(voice));
      const result = await assignGeneratedVoiceProfile(profile, initial?.id || name || 'character', usedVoiceIds, selectedTtsProfile.provider);
      if (!result.voiceConfig.voiceName) {
        setVoiceAssignmentError(i18n.language.startsWith('zh') ? '当前语音画像没有匹配到可用音色' : 'No available voice matches this profile');
        return false;
      }
      setVoiceConfig((prev) => ({ ...prev, ...result.voiceConfig, enabled: true, voiceProfile: profile }));
      return true;
    } finally {
      setAssigningVoice(false);
    }
  };

  const handleAutoAssignVoice = async () => {
    if (!selectedTtsProfile?.provider || assigningVoice) return;
    const profile = voiceConfig.voiceProfile || {
      gender: 'unknown' as const,
      age: 'unknown',
      language: i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US',
      traits: [speakingStyle, background].filter(Boolean).slice(0, 2),
      styles: [],
      emotions: voiceConfig.emotion ? [voiceConfig.emotion] : [],
      energy: 'medium',
    };
    await matchVoiceForProfile(profile);
  };

  const handleGenerateVoiceProfile = async () => {
    if (generatingVoiceProfile) return;
    const textModelProfileId = modelProfileIds.text || null;
    const selectedProfile = settings.aiProfiles.find((profile) => profile.id === textModelProfileId)
      || getPreferredAIProfile(settings.aiProfiles, 'text')
      || settings.aiProfiles.find((profile) => isAIProfileUsable(profile));
    if (!isAIProfileUsable(selectedProfile)) {
      setVoiceAssignmentError(getGenerateNoKeyError(i18n.language));
      return;
    }
    setGeneratingVoiceProfile(true);
    setVoiceAssignmentError(null);
    try {
      const draft = await generateCharacterVoiceProfileDraft(selectedProfile, {
        name,
        background,
        speakingStyle,
        expertise,
        group,
        coreProfile,
        speechProfile,
      }, i18n.language.startsWith('zh') ? 'zh' : 'en');
      const generatedInstructions = buildGeneratedVoiceInstructions(draft, i18n.language);
      const generatedPitch = buildGeneratedVoicePitch(draft);
      setVoiceConfig((prev) => ({
        ...prev,
        voiceProfile: draft,
        style: prev.style || draft.styles?.join(i18n.language.startsWith('zh') ? '、' : ', '),
        pitch: prev.pitch || generatedPitch,
        instructions: prev.instructions || generatedInstructions,
      }));
      if (selectedTtsProfile?.provider) {
        await matchVoiceForProfile(draft);
      }
    } catch (error) {
      setVoiceAssignmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingVoiceProfile(false);
    }
  };

  const handleGenerateVisualDescription = async () => {
    if (generatingVisualDescription) return;
    const textModelProfileId = modelProfileIds.text || null;
    const selectedProfile = settings.aiProfiles.find((profile) => profile.id === textModelProfileId)
      || getPreferredAIProfile(settings.aiProfiles, 'text')
      || settings.aiProfiles.find((profile) => isAIProfileUsable(profile));
    if (!isAIProfileUsable(selectedProfile)) {
      setVisualImageTaskError(getGenerateNoKeyError(i18n.language));
      return;
    }
    setGeneratingVisualDescription(true);
    setVisualImageTaskError(null);
    try {
      const draft = await generateCharacterVisualIdentityDraft(selectedProfile, {
        name,
        background,
        speakingStyle,
        expertise,
        group,
      }, i18n.language.startsWith('zh') ? 'zh' : 'en');
      setVisualIdentity((prev) => ({
        ...prev,
        description: draft.description || prev.description || '',
        styleHint: draft.styleHint || prev.styleHint || '',
        negativePrompt: draft.negativePrompt || prev.negativePrompt || '',
        seed: draft.seed ?? prev.seed ?? null,
      }));
    } catch (error) {
      setVisualImageTaskError(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingVisualDescription(false);
    }
  };

  const handleAvatarAutoGenerate = async () => {
    if (avatarTaskId) {
      avatarGenerationQueue.cancel(avatarTaskId);
      return;
    }

    const imageProfile = getPreferredAIProfile(settings.aiProfiles, 'image');
    if (!isAIProfileUsable(imageProfile)) {
      setAvatarTaskStatus('failed');
      setAvatarTaskError(i18n.language.startsWith('zh') ? '请先配置默认图片模型' : 'Configure a default image model first.');
      return;
    }

    setAvatarTaskError(null);
    setAvatarTaskStatus('queued');
    try {
      const taskId = await enqueueAvatarGenerationForCharacter({
        id: initial?.id || 'draft-character',
        name,
        background,
        speakingStyle,
        expertise,
        group,
        personality,
        speechProfile,
        coreProfile,
        visualIdentity,
      }, settings.aiProfiles, i18n.language.startsWith('zh') ? 'zh' : 'en', settings.avatarGeneration, {
        targetKey: avatarTaskTargetKey,
        characterId: initial?.id || null,
      });
      setAvatarTaskId(taskId);
    } catch (error) {
      setAvatarTaskStatus('failed');
      setAvatarTaskError(error instanceof Error ? error.message : String(error));
    }
  };

  const commitVisualAssets = (assets: CharacterVisualReferenceImage[], requestedPrimaryId?: string) => {
    const dedupedAssets = dedupeVisualAssets(assets);
    const primaryReferenceImageId = dedupedAssets.some((asset) => asset.id === requestedPrimaryId)
      ? requestedPrimaryId!
      : dedupedAssets.find((asset) => asset.isPrimary)?.id || dedupedAssets[0]?.id || null;
    const normalizedAssets = dedupedAssets.map((asset) => ({ ...asset, isPrimary: asset.id === primaryReferenceImageId }));
    visualAssetsRef.current = normalizedAssets;
    setVisualAssets(normalizedAssets);
    setVisualIdentity((prev) => ({
      ...prev,
      referenceImages: normalizedAssets,
      primaryReferenceImageId,
    }));
    if (initial?.id) onVisualAssetsChange?.(normalizedAssets, primaryReferenceImageId);
    return normalizedAssets;
  };

  const handleVisualAssetUpload = async (file?: File | null) => {
    if (!file) return;
    setVisualImageTaskError(null);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const prepared = await prepareAvatarUploadDataUrl(dataUrl, { maxSize: 1024, quality: 0.9 });
        const shouldBePrimary = visualAssets.length === 0;
        if (initial?.id) {
          const saved = await api.createCharacterVisualAsset(initial.id, {
            dataUrl: prepared,
            label: file.name,
            source: 'uploaded',
            isPrimary: shouldBePrimary,
          });
          const asset: CharacterVisualReferenceImage = {
            id: saved.id,
            assetId: saved.assetId || saved.id,
            url: saved.url,
            mimeType: saved.mimeType,
            sizeBytes: saved.sizeBytes,
            checksum: saved.checksum,
            label: saved.label || file.name,
            source: saved.source,
            isPrimary: saved.isPrimary,
            createdAt: saved.createdAt,
          };
          const next = asset.isPrimary ? visualAssets.map((item) => ({ ...item, isPrimary: false })) : visualAssets;
          const merged = dedupeVisualAssets([...next, asset]);
          commitVisualAssets(merged, asset.isPrimary ? asset.id : undefined);
          return;
        }
        const asset: CharacterVisualReferenceImage = {
          id: `local-visual-${Date.now()}`,
          assetId: `local-visual-${Date.now()}`,
          url: prepared,
          mimeType: file.type || 'image/webp',
          label: file.name,
          source: 'uploaded',
          isPrimary: shouldBePrimary,
          createdAt: Date.now(),
        };
        const merged = dedupeVisualAssets([...visualAssets, asset]);
        commitVisualAssets(merged, asset.isPrimary ? asset.id : undefined);
      } catch (error) {
        setVisualImageTaskError(error instanceof Error ? error.message : String(error));
      } finally {
        if (visualAssetInputRef.current) visualAssetInputRef.current.value = '';
      }
    };
    reader.onerror = () => {
      setVisualImageTaskError(i18n.language.startsWith('zh') ? '读取图片失败' : 'Failed to read image');
    };
    reader.readAsDataURL(file);
  };

  const handleSetPrimaryVisualAsset = async (assetId: string) => {
    if (initial?.id && !assetId.startsWith('local-')) {
      await api.updateCharacterVisualAsset(initial.id, assetId, { isPrimary: true });
    }
    const next = dedupeVisualAssets(visualAssets.map((asset) => ({ ...asset, isPrimary: asset.id === assetId })));
    commitVisualAssets(next, assetId);
  };

  const handleDeleteVisualAsset = async (assetId: string) => {
    if (initial?.id && !assetId.startsWith('local-')) {
      await api.deleteCharacterVisualAsset(initial.id, assetId);
      const next = visualAssets.filter((asset) => asset.id !== assetId);
      const nextPrimary = next.find((asset) => asset.isPrimary)?.id || next[0]?.id || null;
      commitVisualAssets(next, nextPrimary || undefined);
      return;
    }
    const next = dedupeVisualAssets(visualAssets.filter((asset) => asset.id !== assetId));
    const nextPrimary = next.find((asset) => asset.isPrimary)?.id || next[0]?.id || null;
    const normalized = next.map((asset, index) => ({ ...asset, isPrimary: nextPrimary ? asset.id === nextPrimary : index === 0 }));
    commitVisualAssets(normalized, nextPrimary || undefined);
  };

  const handleGenerateVisualImage = async () => {
    if (visualImageTaskId) {
      avatarGenerationQueue.cancel(visualImageTaskId);
      return;
    }
    const imageProfile = getPreferredAIProfile(settings.aiProfiles, 'image');
    if (!isAIProfileUsable(imageProfile)) {
      setVisualImageTaskStatus('failed');
      setVisualImageTaskError(i18n.language.startsWith('zh') ? '请先配置默认图片模型' : 'Configure a default image model first.');
      return;
    }
    const language = i18n.language.startsWith('zh') ? 'zh' : 'en';
    const textProfile = settings.aiProfiles.find((profile) => profile.id === modelProfileIds.text)
      || getPreferredAIProfile(settings.aiProfiles, 'text')
      || settings.aiProfiles.find((profile) => isAIProfileUsable(profile));
    const fallbackReasons: string[] = [];
    setVisualImageTaskError(null);
    setVisualImagePlanWarning(null);
    let nextVisualIdentity = visualIdentity;
    if (!visualAssets.length && (!visualIdentity.description?.trim() || !visualIdentity.styleHint?.trim() || !visualIdentity.negativePrompt?.trim())) {
      if (!isAIProfileUsable(textProfile)) {
        fallbackReasons.push(getGenerateNoKeyError(i18n.language));
      } else try {
        const draft = await generateCharacterVisualIdentityDraft(textProfile, {
          name,
          background,
          speakingStyle,
          expertise,
          group,
        }, i18n.language.startsWith('zh') ? 'zh' : 'en');
        nextVisualIdentity = {
          ...visualIdentity,
          description: visualIdentity.description?.trim() || draft.description,
          styleHint: visualIdentity.styleHint?.trim() || draft.styleHint,
          negativePrompt: visualIdentity.negativePrompt?.trim() || draft.negativePrompt,
          seed: visualIdentity.seed ?? draft.seed,
        };
        setVisualIdentity(nextVisualIdentity);
      } catch (error) {
        fallbackReasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    const directorInput = { name, background, speakingStyle, expertise, group, personality, coreProfile, visualIdentity: nextVisualIdentity };
    let visualPlan = buildFallbackCharacterVisualGenerationPlan(directorInput, language);
    if (!isAIProfileUsable(textProfile)) {
      fallbackReasons.push(getGenerateNoKeyError(i18n.language));
    } else {
      try {
        visualPlan = await generateCharacterVisualGenerationPlan(textProfile, directorInput, language);
      } catch (error) {
        fallbackReasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (visualPlan.fallbackUsed) {
      const reason = [...new Set(fallbackReasons.filter(Boolean))].join('；');
      setVisualImagePlanWarning(i18n.language.startsWith('zh')
        ? `视觉方案生成失败，已使用基础模板继续生成。${reason ? `原因：${reason}` : ''}`
        : `Visual-plan generation failed. Continuing with the base template.${reason ? ` Reason: ${reason}` : ''}`);
    }
    setVisualImageTaskStatus('queued');
    setVisualImageTaskId(avatarGenerationQueue.enqueue(imageProfile, visualPlan.prompt, {
      targetKey: visualImageTargetKey,
      negativePrompt: visualPlan.negativePrompt,
      seed: nextVisualIdentity.seed,
    }) || null);
  };

  const isImageAvatar = isImageAvatarValue(avatar);
  const inlineError = saveError || generateError;

  const handleSubmit = async () => {
    const normalizedName = name.trim();
    if (!normalizedName || generating || isSaving) return;
    const isSameAsInitial = initial?.name?.trim().toLowerCase() === normalizedName.toLowerCase();
    const duplicated = !isSameAsInitial && existingNames.some((item) => item.trim().toLowerCase() === normalizedName.toLowerCase());
    if (duplicated) {
      setGenerateError(duplicateNameErrorText);
      return;
    }
    const relationshipNotes = initial?.relationships || [];
    const normalizedVisualAssets = visualAssets.map((asset) => ({
      ...asset,
      isPrimary: asset.id === (visualIdentity.primaryReferenceImageId || visualAssets.find((item) => item.isPrimary)?.id || visualAssets[0]?.id),
    }));
    const normalizedVisualIdentity = {
      ...visualIdentity,
      referenceImages: normalizedVisualAssets,
      primaryReferenceImageId: visualIdentity.primaryReferenceImageId || normalizedVisualAssets.find((asset) => asset.isPrimary)?.id || null,
    };
    setIsSaving(true);
    try {
      await onSave({
        name: normalizedName,
        avatar,
        personality,
        behavior,
        expertise,
        speakingStyle,
        background,
        visualIdentity: normalizedVisualIdentity,
        speechProfile,
        voiceConfig,
        relationships: relationshipNotes,
        group: normalizeCharacterGroup(group),
        memory,
        coreProfile: {
          ...DEFAULT_CORE_PROFILE,
          ...coreProfile,
          valuePriority: coreProfile.valuePriority || [],
          biases: coreProfile.biases || [],
          values: coreProfile.values || coreProfile.valuePriority || [],
          sensitivities: coreProfile.sensitivities || [],
          perceptionBiases: coreProfile.perceptionBiases || coreProfile.biases || [],
          interactionHabits: coreProfile.interactionHabits || [],
          unmetNeeds: coreProfile.unmetNeeds || [],
          hiddenSoftSpots: coreProfile.hiddenSoftSpots || [],
        },
        intervention,
        modelProfileId: modelProfileIds.text || null,
        modelProfileIds,
        generationPreferences,
        bubbleStyle: { ...bubbleStyle, id: bubbleStyleId || bubbleStyle.id || DEFAULT_AI_BUBBLE_STYLE_ID },
        bubbleStyleId,
        generatedByAI,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const renderTagEditor = (value: string[], onChange: (next: string[]) => void, placeholder: string) => (
    <InlineTagEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      addLabel={i18n.language.startsWith('zh') ? '添加' : 'Add'}
    />
  );

  const behaviorGroups: Array<{ title: string; items: Array<{ key: keyof CharacterBehaviorParams; label: string; description: string }> }> = [
    {
      title: i18n.language.startsWith('zh') ? '社交表达' : 'Social style',
      items: [
        { key: 'proactivity', label: i18n.language.startsWith('zh') ? '主动性' : 'Proactivity', description: i18n.language.startsWith('zh') ? '越高越容易主动开口' : 'Higher means starts talking more often' },
        { key: 'humorIntensity', label: i18n.language.startsWith('zh') ? '幽默感' : 'Humor', description: i18n.language.startsWith('zh') ? '越高越容易插科打诨' : 'Higher means more joking' },
        { key: 'empathyLevel', label: i18n.language.startsWith('zh') ? '共情度' : 'Empathy', description: i18n.language.startsWith('zh') ? '越高越会照顾他人情绪' : 'Higher means more emotionally responsive' },
      ],
    },
    {
      title: i18n.language.startsWith('zh') ? '讨论风格' : 'Discussion style',
      items: [
        { key: 'aggressiveness', label: i18n.language.startsWith('zh') ? '攻击性' : 'Aggressiveness', description: i18n.language.startsWith('zh') ? '越高越容易反驳或施压' : 'Higher means more confrontational' },
        { key: 'summarizing', label: i18n.language.startsWith('zh') ? '总结倾向' : 'Summarizing', description: i18n.language.startsWith('zh') ? '越高越喜欢收束观点' : 'Higher means more likely to summarize' },
        { key: 'offTopic', label: i18n.language.startsWith('zh') ? '跑题倾向' : 'Off-topic', description: i18n.language.startsWith('zh') ? '越高越容易把话题带偏' : 'Higher means more likely to derail topics' },
      ],
    },
  ];

  const runtimeCharacter = {
    ...initial,
    name,
    avatar,
    personality,
    behavior,
    expertise,
    speakingStyle,
    background,
    group,
    speechProfile,
    voiceConfig,
    relationships: initial?.relationships || [],
    memory,
    coreProfile,
    intervention,
    modelProfileIds,
    bubbleStyle,
    bubbleStyleId,
    visualIdentity,
  };
  const diaryRelatedCharacters = useMemo(() => (runtimeCharacter.relationships || [])
    .map((relation) => characters.find((character) => character.id === relation.characterId))
    .filter((character): character is AICharacter => Boolean(character))
    .map((character) => ({ id: character.id, name: character.name })), [characters, runtimeCharacter.relationships]);
  const handleRegenerateDiaryDebug = async (item: CharacterArtifactEntry) => {
    try {
      await regenerateArtifact({ itemId: item.id, character: runtimeCharacter, relatedCharacters: diaryRelatedCharacters });
    } catch (error) {
      console.error('Failed to regenerate character diary:', { item, error });
    }
  };
  const diaryEntries = useMemo(() => {
    if (!initial?.id) return [];
    return getDiaryEntriesSorted(artifactItems
      .filter((item) => item.deletedAt == null && item.kind === 'diary' && item.characterId === initial.id)
    );
  }, [artifactItems, initial?.id]);
  const deletedDiaryEntries = useMemo(() => {
    if (!initial?.id) return [];
    return getDiaryEntriesSorted(artifactItems
      .filter((item) => item.deletedAt != null && item.kind === 'diary' && item.characterId === initial.id)
    );
  }, [artifactItems, initial?.id]);
  const artifactReaderHeight = 'clamp(420px, calc(100dvh - 180px), 1040px)';
  const generateLabel = getGenerateButtonLabel(i18n.language, generating);
  const helperText = getHelperText(i18n.language, inlineError);
  const generateAriaLabel = getGenerateAriaLabel(i18n.language);

  const coreProfileCard = (
    <Card variant="outlined" sx={buildEditorCardSx()}>
      <CardContent sx={{ display: 'grid', gap: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, width: 'fit-content' }}>{i18n.language.startsWith('zh') ? '核心画像' : 'Core profile'}</Typography>
          <Button size="small" onClick={() => setCoreProfileExpanded((prev) => !prev)} endIcon={coreProfileExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}>
            {coreProfileExpanded ? (i18n.language.startsWith('zh') ? '收起' : 'Collapse') : (i18n.language.startsWith('zh') ? '展开' : 'Expand')}
          </Button>
        </Box>
        <Collapse in={coreProfileExpanded}>
          <Box sx={{ display: 'grid', gap: 1.25, pt: 0.5 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '核心欲望' : 'Core desire'}
                value={coreProfile.coreDesire || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, coreDesire: e.target.value }))}
                multiline
                rows={2}
              />
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '核心恐惧' : 'Core fear'}
                value={coreProfile.coreFear || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, coreFear: e.target.value }))}
                multiline
                rows={2}
              />
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '社交面具' : 'Social mask'}
                value={coreProfile.socialMask || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, socialMask: e.target.value }))}
                multiline
                rows={2}
                sx={{ gridColumn: { md: '1 / -1' } }}
              />
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '依恋/关系倾向' : 'Attachment style'}
                value={coreProfile.attachmentStyle || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, attachmentStyle: e.target.value }))}
                multiline
                rows={2}
              />
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '冲突方式' : 'Conflict style'}
                value={coreProfile.conflictStyle || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, conflictStyle: e.target.value }))}
                multiline
                rows={2}
              />
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '自我形象' : 'Self image'}
                value={coreProfile.selfImage || ''}
                onChange={(e) => setCoreProfile((prev) => ({ ...prev, selfImage: e.target.value }))}
                multiline
                rows={2}
                sx={{ gridColumn: { md: '1 / -1' } }}
              />
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '价值优先级' : 'Value priorities'}</Typography>
              {renderTagEditor(coreProfile.values || coreProfile.valuePriority || [], (next) => setCoreProfile((prev) => ({ ...prev, values: next, valuePriority: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '敏感点' : 'Sensitivities'}</Typography>
              {renderTagEditor(coreProfile.sensitivities || [], (next) => setCoreProfile((prev) => ({ ...prev, sensitivities: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '认知滤镜 / 误读倾向' : 'Perception biases'}</Typography>
              {renderTagEditor(coreProfile.perceptionBiases || coreProfile.biases || [], (next) => setCoreProfile((prev) => ({ ...prev, perceptionBiases: next, biases: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '未满足需求' : 'Unmet needs'}</Typography>
              {renderTagEditor(coreProfile.unmetNeeds || [], (next) => setCoreProfile((prev) => ({ ...prev, unmetNeeds: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '隐秘柔软点' : 'Hidden soft spots'}</Typography>
              {renderTagEditor(coreProfile.hiddenSoftSpots || [], (next) => setCoreProfile((prev) => ({ ...prev, hiddenSoftSpots: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '互动习惯' : 'Interaction habits'}</Typography>
              {renderTagEditor(coreProfile.interactionHabits || [], (next) => setCoreProfile((prev) => ({ ...prev, interactionHabits: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
          </Box>
        </Collapse>
      </CardContent>
    </Card>
  );

  const openBubblePicker = () => {
    setBubblePickerOpen(true);
  };

  const settingTab = (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        {duplicateNameWarning ? <Alert severity="warning">{duplicateNameWarning}</Alert> : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', gap: { xs: 1.25, sm: 1.5 }, alignItems: 'center' }}>
          <Box onClick={() => setAvatarPickerOpen(true)} sx={{ width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.15rem', borderRadius: 1.25, cursor: 'pointer', position: 'relative', overflow: 'hidden', bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.045)', transition: 'transform 160ms ease, background-color 160ms ease', '&::after': { content: '""', position: 'absolute', inset: 3, borderRadius: 1, border: '1px dashed', borderColor: 'primary.main', opacity: 0, pointerEvents: 'none', transition: 'opacity 160ms ease' }, '&::before': { content: '""', position: 'absolute', inset: 0, bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.18)', opacity: 0, pointerEvents: 'none', transition: 'opacity 160ms ease' }, '&:hover': { transform: 'translateY(-1px)', bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.58)' : 'rgba(255,255,255,0.07)' }, '&:hover::after, &:hover::before': { opacity: 1 } }}>
            {isImageAvatar ? <Box component="img" src={avatar} alt={name || 'avatar'} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : avatar}
          </Box>
          <Box sx={{ display: 'grid', gap: 0.35, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
              <TextField
                inputRef={nameInputRef}
                placeholder={t('character.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                helperText={helperText}
                error={Boolean(inlineError)}
                required
                fullWidth
                variant="standard"
                slotProps={{ input: { disableUnderline: true } }}
                sx={{
                  width: 'fit-content',
                  maxWidth: '100%',
                  minWidth: { xs: 0, sm: '14em' },
                  flex: '1 1 auto',
                  border: '1px solid transparent',
                  borderStyle: 'solid',
                  borderRadius: 1,
                  px: 0.75,
                  py: 0.2,
                  transition: 'border-color 160ms ease, background-color 160ms ease, border-style 160ms ease',
                  '&:hover': {
                    borderStyle: 'dashed',
                    borderColor: 'primary.main',
                    bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.035)',
                  },
                  '&:focus-within': {
                    borderStyle: 'solid',
                    borderColor: 'primary.main',
                    bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.045)',
                  },
                  '& .MuiInputBase-root': { width: '100%' },
                  '& .MuiInputBase-input': {
                    px: 0,
                    py: 0.25,
                    fontSize: { xs: '1.35rem', sm: '1.55rem' },
                    fontWeight: 780,
                    lineHeight: 1.18,
                  },
                  '& .MuiFormHelperText-root': { mx: 0, mt: 0.4 },
                }}
              />
              {!isEditingExistingCharacter ? (
                <Button variant="outlined" onClick={handleGenerate} aria-label={generateAriaLabel} sx={{ flex: '0 0 auto', alignSelf: 'center', minWidth: { xs: 68, sm: 88 }, height: 40, whiteSpace: 'nowrap', px: { xs: 1.1, sm: 2 } }} disabled={!name.trim() || generating}>{generateLabel}</Button>
              ) : null}
            </Box>
            <Autocomplete
              freeSolo
              options={existingGroups}
              value={normalizeCharacterGroup(group) || group || ''}
              onChange={(_, value) => setGroup(typeof value === 'string' ? value : '')}
              onInputChange={(_, value) => setGroup(value)}
              selectOnFocus
              clearOnBlur={false}
              handleHomeEndKeys
              openOnFocus
              slotProps={{
                paper: {
                  sx: {
                    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.86)' : 'rgba(20,22,30,0.88)',
                    backgroundImage: 'none',
                    backdropFilter: 'blur(24px) saturate(1.18)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.18)',
                    border: '1px solid',
                    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.10)' : 'rgba(226,232,240,0.12)',
                    boxShadow: (theme: Theme) => theme.palette.mode === 'light' ? '0 18px 44px rgba(15,23,42,0.14)' : '0 20px 52px rgba(0,0,0,0.42)',
                  },
                },
              }}
              sx={{
                width: { xs: 'min(100%, 16em)', sm: 'min(100%, 24em)' },
                minWidth: { xs: 'min(100%, 12em)', sm: '16em' },
                maxWidth: '100%',
                border: '1px solid transparent',
                borderStyle: 'solid',
                borderRadius: 1,
                px: 0.75,
                py: 0.1,
                transition: 'border-color 160ms ease, background-color 160ms ease, border-style 160ms ease',
                '&:hover': {
                  borderStyle: 'dashed',
                  borderColor: 'primary.main',
                  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.035)',
                },
                '&:focus-within': {
                  borderStyle: 'solid',
                  borderColor: 'primary.main',
                  bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.04)',
                },
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={i18n.language.startsWith('zh') ? '无分组' : 'No group'}
                  fullWidth
                  size="small"
                  variant="standard"
                  slotProps={{
                    input: {
                      ...params.slotProps.input,
                      disableUnderline: true,
                      endAdornment: null,
                    },
                    htmlInput: params.slotProps.htmlInput,
                  }}
                  sx={{
                    '& .MuiInputBase-root': { px: 0, color: 'text.secondary', minWidth: 0 },
                    '& .MuiInputBase-input': {
                      px: '0 !important',
                      py: 0.15,
                      fontSize: '0.92rem',
                      fontWeight: 520,
                      '&::placeholder': {
                        color: 'text.disabled',
                        opacity: 1,
                      },
                    },
                  }}
                />
              )}
            />
          </Box>
        </Box>
      </Box>

      <Box sx={{ width: '100%' }}>
        <Card variant="outlined" sx={{ ...buildEditorCardSx(), cursor: 'pointer' }} onClick={openBubblePicker}>
          <CardContent sx={{ p: 1.5, display: 'grid', gap: 1.2, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>{i18n.language.startsWith('zh') ? '气泡样式' : 'Bubble style'}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
              {renderAvatarPreview(avatar, isImageAvatar, 28)}
              <Box sx={{ px: 1.5, py: 0.875, border: selectedBubblePreview.border, borderRadius: selectedBubblePreview.borderRadius, boxShadow: selectedBubblePreview.boxShadow, color: selectedBubblePreview.color, background: selectedBubblePreview.background, flex: 1, minWidth: 0 }}>
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, opacity: 0.9 }}>{selectedBubbleStyle.name}</Typography>
                <Typography variant="body2" noWrap>{bubblePreviewText}</Typography>
              </Box>
              <IconButton size="small"><EditIcon fontSize="small" /></IconButton>
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Card variant="outlined" sx={{ ...buildEditorCardSx(), width: '100%' }}>
        <CardContent sx={{ display: 'grid', gap: 1.5, '&:last-child': { pb: 2 } }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>{i18n.language.startsWith('zh') ? '基本信息' : 'Basic info'}</Typography>
          <Box
            sx={{
              position: 'relative',
              border: '1px solid',
              borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.20)' : 'rgba(226,232,240,0.22)',
              borderRadius: 1,
              px: 1.75,
              pt: 2,
              pb: 1.35,
              mt: 0.5,
              transition: 'border-color 160ms ease, box-shadow 160ms ease',
              '&:hover': {
                borderColor: (theme: Theme) => theme.palette.text.primary,
              },
              '&:focus-within': {
                borderColor: 'primary.main',
                boxShadow: (theme: Theme) => theme.palette.mode === 'light'
                  ? '0 0 0 3px rgba(49,90,156,0.08)'
                  : '0 0 0 3px rgba(120,156,220,0.10)',
              },
            }}
          >
            <Typography
              variant="caption"
              sx={{
                position: 'absolute',
                top: -9,
                left: 10,
                px: 0.75,
                lineHeight: 1.2,
                color: 'text.secondary',
                bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(18,20,28,0.96)',
                borderRadius: 0.5,
              }}
            >
              {t('character.expertise')}
            </Typography>
            <InlineTagEditor
              value={expertise}
              onChange={setExpertise}
              placeholder={t('character.expertisePlaceholder')}
              addLabel={i18n.language.startsWith('zh') ? '添加专业领域' : 'Add expertise'}
            />
          </Box>
          <TextField label={t('character.speakingStyle')} placeholder={t('character.speakingStylePlaceholder')} value={speakingStyle} onChange={(e) => setSpeakingStyle(e.target.value)} multiline rows={2} fullWidth />
          <TextField label={t('character.background')} placeholder={t('character.backgroundPlaceholder')} value={background} onChange={(e) => setBackground(e.target.value)} multiline rows={3} fullWidth />
        </CardContent>
      </Card>

      <Card variant="outlined" sx={buildEditorCardSx()}>
        <CardContent sx={{ display: 'grid', gap: 1.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{i18n.language.startsWith('zh') ? '视觉形象' : 'Visual identity'}</Typography>
            </Box>
            <Button size="small" onClick={() => setVisualIdentityExpanded((prev) => !prev)} endIcon={visualIdentityExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}>
              {visualIdentityExpanded ? (i18n.language.startsWith('zh') ? '收起' : 'Collapse') : (i18n.language.startsWith('zh') ? '展开' : 'Expand')}
            </Button>
          </Box>
          <Collapse in={visualIdentityExpanded}>
            <Box sx={{ display: 'grid', gap: 1.25, pt: 0.5 }}>
              <TextField
                size="small"
                label={i18n.language.startsWith('zh') ? '形象描述' : 'Visual description'}
                placeholder={visualIdentityExamples.description[0]}
                value={visualIdentity.description || ''}
                onChange={(e) => setVisualIdentity((prev) => ({ ...prev, description: e.target.value }))}
                multiline
                rows={3}
                fullWidth
              />
              <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon />} onClick={() => void handleGenerateVisualDescription()} disabled={generatingVisualDescription} sx={{ minWidth: 0, width: 'fit-content' }}>
                  {generatingVisualDescription ? (i18n.language.startsWith('zh') ? '生成中' : 'Generating') : (i18n.language.startsWith('zh') ? '生成描述' : 'Generate description')}
                </Button>
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
                <TextField
                  size="small"
                  label={i18n.language.startsWith('zh') ? '风格提示' : 'Style hint'}
                  placeholder={pickRandomExample(visualIdentityExamples.styleHint)}
                  value={visualIdentity.styleHint || ''}
                  onChange={(e) => setVisualIdentity((prev) => ({ ...prev, styleHint: e.target.value }))}
                />
                <TextField
                  size="small"
                  label={i18n.language.startsWith('zh') ? '避免内容' : 'Negative prompt'}
                  placeholder={pickRandomExample(visualIdentityExamples.negativePrompt)}
                  value={visualIdentity.negativePrompt || ''}
                  onChange={(e) => setVisualIdentity((prev) => ({ ...prev, negativePrompt: e.target.value }))}
                />
                <TextField
                  size="small"
                  label="Seed"
                  placeholder={pickRandomExample(visualIdentityExamples.seed)}
                  value={visualIdentity.seed ?? ''}
                  onChange={(e) => setVisualIdentity((prev) => ({ ...prev, seed: e.target.value || null }))}
                />
              </Box>
              {visualImageTaskStatus === 'queued' || visualImageTaskStatus === 'running' ? (
                <Alert severity="info">{i18n.language.startsWith('zh') ? '正在生成形象图...' : 'Generating visual identity image...'}</Alert>
              ) : null}
              {visualImagePlanWarning ? <Alert severity="warning">{visualImagePlanWarning}</Alert> : null}
              {visualImageTaskError ? <Alert severity="error">{visualImageTaskError}</Alert> : null}

              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
                  <input
                    ref={visualAssetInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => void handleVisualAssetUpload(event.target.files?.[0] || null)}
                  />
                  <Button size="small" variant="outlined" startIcon={<ImageIcon />} onClick={handleGenerateVisualImage}>
                    {visualImageTaskId ? (i18n.language.startsWith('zh') ? '取消生成' : 'Cancel') : (i18n.language.startsWith('zh') ? '生成形象图' : 'Generate')}
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<UploadIcon />} onClick={() => visualAssetInputRef.current?.click()}>
                    {i18n.language.startsWith('zh') ? '上传' : 'Upload'}
                  </Button>
                </Box>
                <Tooltip title={i18n.language.startsWith('zh') ? '聊天图片需要角色出镜时优先使用参考图；只有当前图片模型在模型库启用并支持参考图功能时才会生效' : 'Prefer reference images when the character appears in chat images. This only works when the selected image model has reference-image capability enabled and supported.'}>
                  <FormControlLabel
                    control={<Switch checked={Boolean(visualIdentity.defaults?.useReferenceImages)} onChange={(e) => setVisualIdentity((prev) => ({ ...prev, defaults: { ...(prev.defaults || {}), useReferenceImages: e.target.checked } }))} />}
                    label={i18n.language.startsWith('zh') ? '出镜' : 'Reference'}
                    sx={{ mr: 0, flexShrink: 0 }}
                  />
                </Tooltip>
              </Box>

              {visualAssets.length ? (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
                  {visualAssets.map((asset) => (
                    <Card key={asset.id} variant="outlined" sx={{ overflow: 'hidden', borderColor: asset.isPrimary ? 'primary.main' : 'divider' }}>
                      <Box component="img" src={asset.url} alt={asset.label || 'visual reference'} sx={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block', bgcolor: 'action.hover' }} />
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.75, py: 0.5, gap: 0.5 }}>
                        <Typography variant="caption" noWrap title={asset.label || asset.source || ''}>{asset.label || (asset.source === 'generated' ? (i18n.language.startsWith('zh') ? '生成图' : 'Generated') : (i18n.language.startsWith('zh') ? '参考图' : 'Reference'))}</Typography>
                        <Box sx={{ display: 'flex', gap: 0.25 }}>
                          <Tooltip title={asset.isPrimary ? (i18n.language.startsWith('zh') ? '主参考图' : 'Primary') : (i18n.language.startsWith('zh') ? '设为主图' : 'Set primary')}>
                            <IconButton size="small" onClick={() => void handleSetPrimaryVisualAsset(asset.id)}>
                              {asset.isPrimary ? <StarIcon fontSize="inherit" color="primary" /> : <StarBorderIcon fontSize="inherit" />}
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={i18n.language.startsWith('zh') ? '删除' : 'Delete'}>
                            <IconButton size="small" color="error" onClick={() => void handleDeleteVisualAsset(asset.id)}>
                              <DeleteIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </Box>
                    </Card>
                  ))}
                </Box>
              ) : null}
            </Box>
          </Collapse>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={buildEditorCardSx()}>
        <CardContent sx={{ display: 'grid', gap: 1.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{i18n.language.startsWith('zh') ? '语音形象' : 'Voice identity'}</Typography>
            </Box>
            <Button size="small" onClick={() => setVoiceIdentityExpanded((prev) => !prev)} endIcon={voiceIdentityExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}>
              {voiceIdentityExpanded ? (i18n.language.startsWith('zh') ? '收起' : 'Collapse') : (i18n.language.startsWith('zh') ? '展开' : 'Expand')}
            </Button>
          </Box>
          <Collapse in={voiceIdentityExpanded}>
          <Box sx={{ display: 'grid', gap: 1.25, pt: 0.5 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 0.75 }}>
            <TextField select size="small" label={i18n.language.startsWith('zh') ? '性别' : 'Gender'} value={voiceConfig.voiceProfile?.gender || 'unknown'} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, voiceProfile: { ...(prev.voiceProfile || {}), gender: e.target.value as 'female' | 'male' | 'neutral' | 'unknown' } }))} sx={{ minWidth: 0 }}>
              <MenuItem value="unknown">{i18n.language.startsWith('zh') ? '未指定' : 'Unspecified'}</MenuItem>
              <MenuItem value="female">{i18n.language.startsWith('zh') ? '女声' : 'Female'}</MenuItem>
              <MenuItem value="male">{i18n.language.startsWith('zh') ? '男声' : 'Male'}</MenuItem>
              <MenuItem value="neutral">{i18n.language.startsWith('zh') ? '中性' : 'Neutral'}</MenuItem>
            </TextField>
            <TextField select size="small" label={i18n.language.startsWith('zh') ? '年龄' : 'Age'} value={voiceConfig.voiceProfile?.age || 'unknown'} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, voiceProfile: { ...(prev.voiceProfile || {}), age: e.target.value } }))} sx={{ minWidth: 0 }}>
              {['unknown', 'child', 'young', 'adult', 'senior'].map((value) => <MenuItem key={value} value={value}>{i18n.language.startsWith('zh') ? ({ unknown: '未指定', child: '儿童', young: '年轻', adult: '成年', senior: '年长' } as Record<string, string>)[value] : value}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={i18n.language.startsWith('zh') ? '能量' : 'Energy'} value={voiceConfig.voiceProfile?.energy || 'medium'} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, voiceProfile: { ...(prev.voiceProfile || {}), energy: e.target.value } }))} sx={{ minWidth: 0 }}>
              <MenuItem value="low">{i18n.language.startsWith('zh') ? '低沉克制' : 'Low / calm'}</MenuItem>
              <MenuItem value="medium">{i18n.language.startsWith('zh') ? '自然适中' : 'Medium / natural'}</MenuItem>
              <MenuItem value="high">{i18n.language.startsWith('zh') ? '明亮有活力' : 'High / lively'}</MenuItem>
            </TextField>
            <TextField size="small" label={i18n.language.startsWith('zh') ? '语言' : 'Language'} value={voiceConfig.voiceProfile?.language || ''} placeholder="zh-CN" onChange={(e) => setVoiceConfig((prev) => ({ ...prev, voiceProfile: { ...(prev.voiceProfile || {}), language: e.target.value } }))} sx={{ minWidth: 0 }} />
          </Box>
          <TextField size="small" label={i18n.language.startsWith('zh') ? '音色特征' : 'Voice traits'} placeholder={i18n.language.startsWith('zh') ? '温柔、清冷、磁性，用逗号分隔' : 'warm, clear, husky, comma separated'} value={(voiceConfig.voiceProfile?.traits || []).join(i18n.language.startsWith('zh') ? '、' : ', ')} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, voiceProfile: { ...(prev.voiceProfile || {}), traits: e.target.value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean).slice(0, 6) } }))} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' }, gap: 0.75, alignItems: 'start' }}>
            <Autocomplete
              freeSolo
              options={speechVoices}
              value={speechVoices.find((voice) => voice.id === voiceConfig.voiceName) || (voiceConfig.voiceName ? { id: voiceConfig.voiceName, name: voiceConfig.role || voiceConfig.voiceName } : null)}
              getOptionLabel={(option) => typeof option === 'string' ? option : `${option.name}（${option.id}）`}
              isOptionEqualToValue={(option, value) => option.id === (typeof value === 'string' ? value : value.id)}
              onChange={(_event, value) => setVoiceConfig((prev) => ({ ...prev, voiceName: typeof value === 'string' ? value : value?.id || '', role: typeof value === 'string' ? prev.role : value?.name || '', voiceSource: typeof value === 'string' ? 'manual' : 'auto' }))}
              onInputChange={(_event, value, reason) => { if (reason === 'input') setVoiceConfig((prev) => ({ ...prev, voiceName: value, voiceSource: 'manual' })); }}
              loading={speechVoicesLoading}
              disabled={!selectedTtsProfile}
              renderInput={(params) => <TextField {...params} size="small" label={i18n.language.startsWith('zh') ? '发音人（可搜索或手动输入）' : 'Voice (search or enter ID)'} helperText={!selectedTtsProfile ? (i18n.language.startsWith('zh') ? '请先在 AI模型 中选择语音（TTS）模型' : 'Select a TTS model in AI Models first') : speechVoicesLoading ? (i18n.language.startsWith('zh') ? '正在读取当前平台音色…' : 'Loading voices…') : undefined} />}
            />
            <Button variant="outlined" sx={{ minWidth: 0, whiteSpace: 'nowrap', justifySelf: 'start' }} startIcon={assigningVoice ? <CircularProgress size={16} /> : <AutoAwesomeIcon />} onClick={() => void handleAutoAssignVoice()} disabled={!selectedTtsProfile || assigningVoice}>
              {i18n.language.startsWith('zh') ? '自动匹配音色' : 'Match voice'}
            </Button>
          </Box>
          <TextField size="small" label={i18n.language.startsWith('zh') ? '风格' : 'Style'} placeholder={i18n.language.startsWith('zh') ? '如 cheerful / sad' : 'e.g. cheerful / sad'} value={voiceConfig.style || ''} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, style: e.target.value }))} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(220px, 0.65fr) minmax(0, 1.35fr)' }, gap: 0.75, alignItems: 'start' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 0.75 }}>
              <TextField size="small" label={i18n.language.startsWith('zh') ? '语速' : 'Rate'} placeholder="+0%" value={voiceConfig.rate || ''} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, rate: e.target.value }))} />
              <TextField size="small" label={i18n.language.startsWith('zh') ? '音调' : 'Pitch'} placeholder="0" helperText={i18n.language.startsWith('zh') ? '默认 0，常用 -2～+2' : 'Default 0, usually -2 to +2'} value={voiceConfig.pitch || ''} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, pitch: e.target.value }))} />
            </Box>
            <TextField size="small" label={i18n.language.startsWith('zh') ? '语音指令' : 'Voice instructions'} placeholder={i18n.language.startsWith('zh') ? '如：自然、亲切，避免播音腔' : 'e.g. natural and warm, avoid announcer voice'} helperText={i18n.language.startsWith('zh') ? '传给支持语音指令的 TTS，不支持的平台会忽略' : 'Used by TTS providers that support instructions'} value={voiceConfig.instructions || ''} onChange={(e) => setVoiceConfig((prev) => ({ ...prev, instructions: e.target.value }))} />
          </Box>
          {voiceAssignmentError ? <Typography variant="caption" color="warning.main">{voiceAssignmentError}</Typography> : null}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" startIcon={generatingVoiceProfile ? <CircularProgress size={14} /> : <AutoAwesomeIcon fontSize="small" />} onClick={() => void handleGenerateVoiceProfile()} disabled={generatingVoiceProfile}>
              {generatingVoiceProfile ? (i18n.language.startsWith('zh') ? '生成中' : 'Generating') : (i18n.language.startsWith('zh') ? '生成描述' : 'Generate description')}
            </Button>
          </Box>
          </Box>
          </Collapse>
        </CardContent>
      </Card>

      {showSpeechStyle ? (
        <Card variant="outlined" sx={buildEditorCardSx()}>
          <CardContent sx={{ display: 'grid', gap: 1.25 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{i18n.language.startsWith('zh') ? '发言风格' : 'Speech style'}</Typography>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '口头禅' : 'Catchphrases'}</Typography>
              {renderTagEditor(speechProfile?.catchphrases || [], (next) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), catchphrases: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '语气词' : 'Fillers'}</Typography>
              {renderTagEditor(speechProfile?.fillers || [], (next) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), fillers: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{i18n.language.startsWith('zh') ? '避免表达' : 'Taboo phrases'}</Typography>
              {renderTagEditor(speechProfile?.tabooPhrases || [], (next) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), tabooPhrases: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
              <TextField size="small" select label={i18n.language.startsWith('zh') ? '句长偏好' : 'Sentence length'} value={speechProfile?.sentenceLengthBias || 'mixed'} onChange={(e) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), sentenceLengthBias: e.target.value as 'short' | 'mixed' | 'long' }))}>
                <MenuItem value="short">{i18n.language.startsWith('zh') ? '短句' : 'Short'}</MenuItem>
                <MenuItem value="mixed">{i18n.language.startsWith('zh') ? '混合' : 'Mixed'}</MenuItem>
                <MenuItem value="long">{i18n.language.startsWith('zh') ? '长句' : 'Long'}</MenuItem>
              </TextField>
              <TextField size="small" type="number" label={i18n.language.startsWith('zh') ? '提问倾向' : 'Question bias'} value={speechProfile?.questionBias ?? 50} onChange={(e) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), questionBias: Number(e.target.value) }))} />
              <TextField size="small" type="number" label={i18n.language.startsWith('zh') ? '阴阳倾向' : 'Sarcasm bias'} value={speechProfile?.sarcasmBias ?? 50} onChange={(e) => setSpeechProfile((prev) => ({ ...(prev || { catchphrases: [], fillers: [], tabooPhrases: [], preferredOpeners: [], preferredClosers: [], sentenceLengthBias: 'mixed', questionBias: 50, sarcasmBias: 50 }), sarcasmBias: Number(e.target.value) }))} />
            </Box>
          </CardContent>
        </Card>
      ) : null}

      <Stack spacing={1.5}>
        <Card variant="outlined" sx={buildEditorCardSx()}>
          <CardContent sx={{ display: 'grid', gap: 1.25 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{i18n.language.startsWith('zh') ? 'AI模型' : 'AI Models'}</Typography>
              <Button size="small" onClick={() => setModelConfigExpanded((prev) => !prev)} endIcon={modelConfigExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}>
                {modelConfigExpanded ? (i18n.language.startsWith('zh') ? '收起' : 'Collapse') : (i18n.language.startsWith('zh') ? '展开' : 'Expand')}
              </Button>
            </Box>
            <Collapse in={modelConfigExpanded}>
              <Box sx={{ display: 'grid', gap: 1, pt: 0.5 }}>
                {MODEL_TYPE_ORDER.map((type) => (
                  <FormControl key={type} size="small" fullWidth>
                    <InputLabel>{modelTypeLabels[type]}</InputLabel>
                    <Select
                      value={modelProfileIds[type] || ''}
                      label={modelTypeLabels[type]}
                      onChange={(e) => {
                        const nextValue = typeof e.target.value === 'string' ? e.target.value : '';
                        setModelProfileIds((prev) => ({
                          ...prev,
                          [type]: nextValue || null,
                        }));
                      }}
                    >
                      <MenuItem value="">{i18n.language.startsWith('zh') ? '无' : 'None'}</MenuItem>
                      {profilesByType[type].map((profile) => (
                        <MenuItem key={profile.id} value={profile.id}>{profile.name}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                ))}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
                  <FormControl size="small" fullWidth>
                    <InputLabel>{i18n.language.startsWith('zh') ? '发朋友圈' : 'Post moments'}</InputLabel>
                    <Select
                      value={generationPreferences.moments || 'follow_global'}
                      label={i18n.language.startsWith('zh') ? '发朋友圈' : 'Post moments'}
                      onChange={(e) => {
                        const value = (typeof e.target.value === 'string' ? e.target.value : 'follow_global') as CharacterGenerationOverride;
                        setGenerationPreferences((prev) => ({ ...prev, moments: value }));
                      }}
                    >
                      <MenuItem value="follow_global">{i18n.language.startsWith('zh') ? '跟随全局' : 'Follow global'}</MenuItem>
                      <MenuItem value="on">{i18n.language.startsWith('zh') ? '开启' : 'On'}</MenuItem>
                      <MenuItem value="off">{i18n.language.startsWith('zh') ? '关闭' : 'Off'}</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" fullWidth>
                    <InputLabel>{i18n.language.startsWith('zh') ? '主动陪伴' : 'Proactive care'}</InputLabel>
                    <Select
                      value={generationPreferences.companionship || 'follow_global'}
                      label={i18n.language.startsWith('zh') ? '主动陪伴' : 'Proactive care'}
                      onChange={(e) => {
                        const value = (typeof e.target.value === 'string' ? e.target.value : 'follow_global') as CharacterGenerationOverride;
                        setGenerationPreferences((prev) => ({ ...prev, companionship: value }));
                      }}
                    >
                      <MenuItem value="follow_global">{i18n.language.startsWith('zh') ? '跟随全局' : 'Follow global'}</MenuItem>
                      <MenuItem value="on">{i18n.language.startsWith('zh') ? '开启' : 'On'}</MenuItem>
                      <MenuItem value="off">{i18n.language.startsWith('zh') ? '关闭' : 'Off'}</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" fullWidth>
                    <InputLabel>{i18n.language.startsWith('zh') ? '写日记' : 'Write diaries'}</InputLabel>
                    <Select
                      value={generationPreferences.diaries || 'follow_global'}
                      label={i18n.language.startsWith('zh') ? '写日记' : 'Write diaries'}
                      onChange={(e) => {
                        const value = (typeof e.target.value === 'string' ? e.target.value : 'follow_global') as CharacterGenerationOverride;
                        setGenerationPreferences((prev) => ({ ...prev, diaries: value }));
                      }}
                    >
                      <MenuItem value="follow_global">{i18n.language.startsWith('zh') ? '跟随全局' : 'Follow global'}</MenuItem>
                      <MenuItem value="on">{i18n.language.startsWith('zh') ? '开启' : 'On'}</MenuItem>
                      <MenuItem value="off">{i18n.language.startsWith('zh') ? '关闭' : 'Off'}</MenuItem>
                    </Select>
                  </FormControl>
                </Box>
              </Box>
            </Collapse>
          </CardContent>
        </Card>
        <Card variant="outlined" sx={buildEditorCardSx()}>
          <CardContent sx={{ display: 'grid', gap: 0.5, '&:last-child': { pb: 2 } }}>
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.25 }}>
              {i18n.language.startsWith('zh') ? '交互权限' : 'Interaction permissions'}
            </Typography>
            <FormControlLabel control={<Switch checked={intervention.allowSpeakAs} onChange={(e) => setIntervention((prev) => ({ ...prev, allowSpeakAs: e.target.checked }))} />} label={i18n.language.startsWith('zh') ? '允许用户以该角色身份发言' : 'Allow speak as'} />
            <FormControlLabel control={<Switch checked={intervention.allowDirectorPrompt} onChange={(e) => setIntervention((prev) => ({ ...prev, allowDirectorPrompt: e.target.checked }))} />} label={i18n.language.startsWith('zh') ? '允许导演强制干预' : 'Allow director prompts'} />
            <FormControlLabel control={<Switch checked={intervention.allowPrivateThread} onChange={(e) => setIntervention((prev) => ({ ...prev, allowPrivateThread: e.target.checked }))} />} label={i18n.language.startsWith('zh') ? '允许被拉入AI私聊' : 'Allow AI private thread'} />
          </CardContent>
        </Card>
      </Stack>
      {onDelete ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-start', mt: 2 }}>
          <Button color="error" variant="outlined" onClick={onDelete} fullWidth sx={{ maxWidth: { sm: 260 }, justifyContent: 'center' }}>
            {deleteLabel || (i18n.language.startsWith('zh') ? '删除角色' : 'Delete character')}
          </Button>
        </Box>
      ) : null}
    </Box>
  );

  const behaviorTab = (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      {coreProfileCard}
      <Card variant="outlined" sx={buildEditorCardSx()}>
        <CardContent>
          <CollapsibleParamGroup title={t('character.personality')} open={personalityExpanded} onToggle={() => setPersonalityExpanded((prev) => !prev)} contentSx={{ pl: 0, ml: 0, borderLeft: 'none' }}>
            <Box>
              <PersonalitySliders values={personality} onChange={setPersonality} drift={initial?.personalityDrift} />
            </Box>
          </CollapsibleParamGroup>
        </CardContent>
      </Card>
      <Card variant="outlined" sx={buildEditorCardSx()}>
        <CardContent>
          <CollapsibleParamGroup title={behaviorGroups[0].title} open={socialExpanded} onToggle={() => setSocialExpanded((prev) => !prev)} contentSx={{ pl: 0, ml: 0, borderLeft: 'none' }}>
            <Box>
              <NumericSliders values={behavior} items={behaviorGroups[0].items} onChange={setBehavior} />
            </Box>
          </CollapsibleParamGroup>
        </CardContent>
      </Card>
      <Card variant="outlined" sx={buildEditorCardSx()}>
        <CardContent>
          <CollapsibleParamGroup title={behaviorGroups[1].title} open={discussionExpanded} onToggle={() => setDiscussionExpanded((prev) => !prev)} contentSx={{ pl: 0, ml: 0, borderLeft: 'none' }}>
            <Box>
              <NumericSliders values={behavior} items={behaviorGroups[1].items} onChange={setBehavior} />
            </Box>
          </CollapsibleParamGroup>
        </CardContent>
      </Card>
    </Box>
  );

  const runtimeTab = <RuntimeInsightsPanel character={runtimeCharacter} />;
  const availableTabs = useMemo(() => {
    return buildCharacterFormTabs({
      isEditingExistingCharacter,
      isZh: i18n.language.startsWith('zh'),
    });
  }, [i18n.language, isEditingExistingCharacter]);

  useEffect(() => {
    if (!availableTabs.some((item) => item.value === configTab)) {
      setConfigTab(0);
    }
  }, [availableTabs, configTab]);

  useEffect(() => {
    if (configTab === 6) onDiaryTabOpen?.();
  }, [configTab, onDiaryTabOpen]);

  const handleRegenerateBubble = async () => {
    if (!name.trim() || generating) return null;
    const textModelProfileId = modelProfileIds.text || null;
    const selectedProfile = settings.aiProfiles.find((profile) => profile.id === textModelProfileId) || getPreferredAIProfile(settings.aiProfiles, 'text') || settings.aiProfiles[0];
    if (!isAIProfileUsable(selectedProfile)) {
      setGenerateError(getGenerateNoKeyError(i18n.language));
      return null;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      const generated = await generateCharacterProfile(selectedProfile, name.trim(), i18n.language.startsWith('zh') ? 'zh' : 'en');
      const nextBubbleStyleId = createCharacterBubbleStyleId();
      const nextBubbleStyle = { ...generated.bubbleStyle, id: nextBubbleStyleId };
      return nextBubbleStyle;
    } catch {
      setGenerateError(getGenerateError(i18n.language));
      return null;
    } finally {
      setGenerating(false);
    }
  };

  const regenerateBubbleLabel = i18n.language.startsWith('zh') ? 'AI生成' : 'AI generate';

  const avatarPlanResolving = !avatarTaskId && avatarTaskStatus === 'queued';
  const avatarGenerateLabel = avatarPlanResolving
    ? (i18n.language.startsWith('zh') ? '设计头像中' : 'Designing avatar')
    : avatarTaskId
    ? (avatarTaskStatus === 'running'
        ? (i18n.language.startsWith('zh') ? '正在生成' : 'Generating')
        : (i18n.language.startsWith('zh') ? '等待生成' : 'Queued'))
    : (i18n.language.startsWith('zh') ? '自动生成' : 'Auto generate');
  const canGenerateAvatar = canAutoGenerateAvatarDraft({ name, background });
  const avatarGenerateDisabledReason = i18n.language.startsWith('zh') ? '要先设置角色' : 'Set the character first';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75, position: 'relative', pb: 10 }}>
      <Box
        sx={buildFloatingTabContainerSx()}
      >
        <FloatingSegmentedTabs
          value={configTab}
          scrollContentToTopOnChange
          onChange={(nextTab) => {
            setTabTransitionDirection(resolveTabTransitionDirection(availableTabs.map((item) => item.value), configTab, nextTab));
            setConfigTab(nextTab);
          }}
          items={availableTabs}
        />
      </Box>

      <AnimatedTabContent value={configTab} direction={tabTransitionDirection}>
        {configTab === 0 ? settingTab : null}

        {configTab === 1 ? behaviorTab : null}

        {configTab === 2 ? <CharacterRelationshipInspector character={runtimeCharacter} /> : null}

        {configTab === 3 ? (
          <Box sx={{ display: 'grid', gap: 2 }}>
            <CharacterMemoryInspector character={runtimeCharacter} />
            <Card variant="outlined">
              <CardContent sx={{ display: 'grid', gap: 1.5 }}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>{i18n.language.startsWith('zh') ? '手工记忆设定' : 'Manual memory seeds'}</Typography>
                </Box>
                <TextField
                  label={i18n.language.startsWith('zh') ? '短期记忆摘要' : 'Short-term summary'}
                  value={memory.shortTermSummary}
                  onChange={(e) => setMemory((prev) => ({ ...prev, shortTermSummary: e.target.value }))}
                  multiline
                  rows={3}
                  fullWidth
                />
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>{i18n.language.startsWith('zh') ? '长期记忆' : 'Long-term memory'}</Typography>
                  {renderTagEditor(memory.longTerm, (next) => setMemory((prev) => ({ ...prev, longTerm: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
                </Box>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>{i18n.language.startsWith('zh') ? '秘密' : 'Secrets'}</Typography>
                  {renderTagEditor(memory.secrets, (next) => setMemory((prev) => ({ ...prev, secrets: next })), i18n.language.startsWith('zh') ? '输入后回车' : 'Type and press Enter')}
                </Box>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>{i18n.language.startsWith('zh') ? '执念 / 禁区 / 用户记忆' : 'Obsessions / taboo / user memory'}</Typography>
                  <Stack spacing={1.25}>
                    {renderTagEditor(memory.obsessions, (next) => setMemory((prev) => ({ ...prev, obsessions: next })), i18n.language.startsWith('zh') ? '执念，输入后回车' : 'Obsessions, press Enter')}
                    {renderTagEditor(memory.tabooTopics, (next) => setMemory((prev) => ({ ...prev, tabooTopics: next })), i18n.language.startsWith('zh') ? '禁区话题，输入后回车' : 'Taboo topics, press Enter')}
                    {renderTagEditor(memory.userMemories, (next) => setMemory((prev) => ({ ...prev, userMemories: next })), i18n.language.startsWith('zh') ? '用户相关记忆，输入后回车' : 'User memories, press Enter')}
                  </Stack>
                </Box>
              </CardContent>
            </Card>
          </Box>
        ) : null}

        {configTab === 4 ? runtimeTab : null}

        {configTab === 5 ? (
          calendarContext ? (
            <WorldCalendarPanel
              chats={calendarContext.chats}
              characters={calendarContext.characters}
              updateChat={calendarContext.updateChat}
              isZh={i18n.language.startsWith('zh')}
              actorId={calendarContext.actorId}
              title={i18n.language.startsWith('zh') ? '活动' : 'Activities'}
              showHeader
            />
          ) : null
        ) : null}

        {configTab === 6 ? (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <ArtifactCalendarReader
              items={diaryEntries}
              deletedItems={deletedDiaryEntries}
              language={i18n.language}
              paperVariant={settings.artifactAppearance.paperVariant}
              readerHeight={artifactReaderHeight}
              countUnit={i18n.language.startsWith('zh') ? '篇' : ''}
              emptyTitle={i18n.language.startsWith('zh') ? '暂无日记' : 'No diary entries yet'}
              emptyDescription=""
              getMeta={(item) => item.dateKey || new Date(item.createdAt).toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US')}
              onRegenerateDebug={settings.developerMode ? handleRegenerateDiaryDebug : undefined}
            />
          </Box>
        ) : null}
      </AnimatedTabContent>


      <Dialog open={avatarPickerOpen} onClose={() => setAvatarPickerOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <Box component="span">{t('character.avatar')}</Box>
          <Tooltip title={!canGenerateAvatar && !avatarTaskId ? avatarGenerateDisabledReason : ''}>
            <Box component="span">
              <Button
                variant="outlined"
                startIcon={<AutoAwesomeIcon />}
                onClick={handleAvatarAutoGenerate}
                disabled={avatarPlanResolving || (!avatarTaskId && !canGenerateAvatar)}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {avatarGenerateLabel}
              </Button>
            </Box>
          </Tooltip>
        </DialogTitle>
        <DialogContent
          sx={{
            bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)',
          }}
        >
          {avatarTaskStatus === 'running' ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {i18n.language.startsWith('zh') ? '正在生成头像…' : 'Generating avatar...'}
            </Typography>
          ) : null}
          {avatarTaskStatus === 'queued' ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {i18n.language.startsWith('zh') ? '头像已加入队列，等待开始…' : 'Avatar queued and waiting to start...'}
            </Typography>
          ) : null}
          {avatarTaskError ? (
            <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
              {avatarTaskError}
            </Typography>
          ) : null}
          {isImageAvatar ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 1.5 }}>
              <Box component="img" src={avatar} alt={name || 'avatar'} sx={{ width: 132, height: 132, objectFit: 'cover', borderRadius: 1, border: '1px solid', borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.12)', boxShadow: (theme) => theme.palette.mode === 'light' ? '0 16px 36px rgba(15,23,42,0.10)' : '0 18px 42px rgba(0,0,0,0.35)' }} />
            </Box>
          ) : null}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 1 }}>
            {AVATAR_OPTIONS.map((emoji) => (
              <Box key={emoji} onClick={() => { setAvatar(emoji); setAvatarPickerOpen(false); }} sx={buildAvatarOptionSx(avatar === emoji)}>{emoji}</Box>
            ))}
          </Box>
        </DialogContent>
      </Dialog>

      <BubbleStylePickerDialog
        open={bubblePickerOpen}
        title={i18n.language.startsWith('zh') ? '角色气泡' : 'Character bubble'}
        valueStyleId={bubbleStyleId}
        valueStyle={bubbleStyle}
        customStyles={customBubbleStyles}
        allCharacters={characters}
        avatar={avatar}
        isImageAvatar={isImageAvatar}
        previewText={bubblePreviewText}
        inlineError={inlineError}
        generateLabel={regenerateBubbleLabel}
        generateDisabled={!name.trim() || generating}
        onGenerateStyle={handleRegenerateBubble}
        onClose={() => setBubblePickerOpen(false)}
        onConfirm={(styleId, style) => {
          setBubbleStyleId(styleId);
          setBubbleStyle({ ...style, id: styleId });
          setBubblePickerOpen(false);
        }}
        onCustomStylesChange={settings.setCustomBubbleStyles}
      />

      <ExpandableFab
        icon={isSaving ? <CircularProgress size={20} color="inherit" /> : <SaveIcon fontSize="small" />}
        label={t('character.save')}
        ariaLabel={t('character.save')}
        onClick={handleSubmit}
        disabled={!name.trim() || generating || isSaving}
        sx={{ position: 'fixed', right: { xs: 24, sm: 32, md: 36 }, bottom: { xs: 24, sm: 32, md: 36 } }}
        expandedWidth={132}
      />
    </Box>
  );
}
