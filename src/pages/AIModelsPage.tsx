import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent } from 'react';
import {
  Box, Typography, TextField, Button,
  FormControl, InputLabel, Select, MenuItem, ListSubheader,
  Alert, IconButton, InputAdornment, Autocomplete, Checkbox, Tooltip, FormControlLabel, Divider, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CloudSyncIcon from '@mui/icons-material/CloudSyncOutlined';
import VpnKeyIcon from '@mui/icons-material/VpnKeyOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmberOutlined';
import { useTranslation } from 'react-i18next';
import { useLayoutHeaderActions } from '../components/layout/AppLayoutContext';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useAuthStore } from '../stores/useAuthStore';
import { isLikelyBrowserCorsError, listAvailableModels, testConnection, type AIConnectionTestResult, type AvailableModelInfo } from '../services/aiClient';
import { synthesizeSpeechWithAdapter, transcribeAudioWithAdapter } from '../services/aiGenerationAdapter';
import { api, type OfficialAiProviderInfo } from '../services/api';
import type { AIModelImageCapabilities, AIModelInputCapabilities, AIModelType, AIProvider, ImageGenerationSize } from '../types/settings';
import { normalizeImageCapabilities, normalizeInputCapabilities, inferTextInputCapabilities, buildTextInputCapabilityPatch, getInputCapabilityLockState, getAttachmentUiCapabilitySummary, getInputCapabilityBadge, getInputCapabilityWarning, shouldShowInputCapabilityWarning, getReasoningModeUiMeta, normalizeAIModelAdvancedOptions } from '../types/settings';
import { normalizeCharacterModelProfileIds } from '../types/character';
import ConfirmDialog from '../components/common/ConfirmDialog';
import PageSection from '../components/common/PageSection';
import SurfaceCard from '../components/common/SurfaceCard';
import AppSnackbar from '../components/common/AppSnackbar';
import ExpandableFab from '../components/common/ExpandableFab';
import { AI_PROVIDER_CATALOG, getPopularModels, getProviderCatalogEntry, getProvidersForType, inferImageCapabilities, type AIProviderCatalogEntry } from '../constants/aiModelCatalog';
import { motion, transition } from '../styles/motion';
import { formatAiAmount } from '../utils/aiPoints';
import { compareModelVersionsDescending } from '../utils/modelOrder';

type AiBalanceView =
  | { status: 'idle' | 'loading' }
  | { status: 'guest' | 'unassigned' | 'error' }
  | { status: 'ready'; points: number; currencyUnit?: string };

type AIProviderOption = AIProviderCatalogEntry & {
  unavailableReason?: string;
};

type ModelDropdownOption = {
  value: string;
  label?: string;
  priceLabel?: string;
  inputPriceLabel?: string;
  outputPriceLabel?: string;
  group: string;
};

type OfficialProvidersState = {
  key: string;
  items: OfficialAiProviderInfo[];
  error: string | null;
};

type SpeechPlatformsState = {
  items: Array<{ capability: 'tts' | 'stt'; name: string; officialName: string; providerCode: string; available: boolean; modelId: string; modelName: string; providers: Array<{ providerCode: string; displayName: string; official: boolean; available: boolean; modelId: string; modelName: string }>; pricing?: { billingUnit: 'character' | 'second'; pricePerUnit: number; currency: 'CNY' | 'point'; billingMultiplier: number; pointValueCny: number; minimumCharge: number } | null }>;
  loading: boolean;
  error: string | null;
};

function maskSecret(value: string) {
  if (!value) return '';
  if (value.length <= 8) {
    const visibleCount = Math.min(4, Math.max(1, Math.ceil(value.length / 2)));
    return `${value.slice(0, visibleCount)}${'•'.repeat(Math.max(0, value.length - visibleCount))}`;
  }
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`;
}

function blockSecretCopy(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  event.preventDefault();
}

function extractConnectionErrorMessage(error: unknown) {
  if (!error) return '';
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as {
      error?: string | { message?: string };
      detail?: string;
      message?: string;
    };
    const upstreamDetail = parsed.detail ? JSON.parse(parsed.detail) as { message?: string } : null;
    const errorMessage = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    return upstreamDetail?.message || errorMessage || parsed.message || raw;
  } catch {
    return raw;
  }
}

function blockSecretDrag(event: DragEvent<HTMLInputElement | HTMLTextAreaElement>) {
  event.preventDefault();
}

function blockSecretContextMenu(event: MouseEvent<HTMLInputElement | HTMLTextAreaElement>) {
  event.preventDefault();
}

function createSpeechTestWavDataUrl() {
  const sampleRate = 16_000;
  const dataSize = sampleRate / 4 * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => value.split('').forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function SettingsSyncErrorAlert() {
  const syncStatus = useSettingsStore((state) => state.syncStatus);
  const syncError = useSettingsStore((state) => state.syncError);
  if (syncStatus !== 'error' || !syncError) return null;
  return (
    <Alert severity="error" variant="outlined">
      {syncError}
    </Alert>
  );
}

function fieldSx() {
  return {
    '& .MuiOutlinedInput-root': {
      borderRadius: 1,
      bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.56)' : 'rgba(255,255,255,0.045)',
      transition: transition(['background-color', 'border-color', 'box-shadow'], motion.durations.fast, motion.softOut),
      '&:hover': {
        bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.065)',
      },
      '&.Mui-focused': {
        boxShadow: (theme: Theme) => theme.palette.mode === 'light'
          ? '0 0 0 3px rgba(49,90,156,0.10)'
          : '0 0 0 3px rgba(120,156,220,0.12)',
      },
    },
  };
}

function modelCardSx() {
  return {
    position: 'relative',
    overflow: 'hidden',
    transition: transition(['border-color', 'box-shadow'], motion.durations.base, motion.softOut),
    '&:hover': {
      borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(49,90,156,0.28)' : 'rgba(120,156,220,0.28)',
      boxShadow: (theme: Theme) => theme.palette.mode === 'light'
        ? '0 1px 2px rgba(15,23,42,0.03), 0 18px 52px rgba(15,23,42,0.06)'
        : '0 1px 0 rgba(255,255,255,0.035) inset, 0 20px 56px rgba(0,0,0,0.30)',
    },
  };
}

function solidPopupPaperSx() {
  return {
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? '#fff' : '#171923',
    backgroundImage: 'none',
    border: '1px solid',
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.10)' : 'rgba(226,232,240,0.12)',
    boxShadow: (theme: Theme) => theme.palette.mode === 'light'
      ? '0 18px 42px rgba(15,23,42,0.16)'
      : '0 20px 48px rgba(0,0,0,0.48)',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    '& .MuiAutocomplete-groupLabel': {
      py: 0.25,
      lineHeight: 1.6,
      fontSize: 12,
    },
    '& .MuiAutocomplete-groupUl': {
      py: 0,
    },
    '& .MuiListSubheader-root': {
      bgcolor: 'transparent',
      color: 'text.secondary',
      fontSize: 12,
      fontWeight: 700,
      lineHeight: 1.8,
      pt: 0.5,
      pb: 0.25,
    },
  };
}

function buildModelOptionSignature(options: ModelDropdownOption[]) {
  return options
    .map((option) => [
      option.value,
      option.label || '',
      option.priceLabel || '',
      option.inputPriceLabel || '',
      option.outputPriceLabel || '',
      option.group,
    ].join('\u0001'))
    .join('\u0002');
}

type ModelAutocompleteProps = {
  profileId: string;
  model: string;
  activeType: AIModelType;
  options: ModelDropdownOption[];
  open: boolean;
  modelLabel: string;
  placeholder: string;
  onOpen: () => void;
  onClose: () => void;
  onCommitModel: (value: string) => void;
  setInputRef: (node: HTMLInputElement | null) => void;
};

const ModelAutocomplete = memo(function ModelAutocomplete({
  profileId,
  model,
  activeType,
  options,
  open,
  modelLabel,
  placeholder,
  onOpen,
  onClose,
  onCommitModel,
  setInputRef,
}: ModelAutocompleteProps) {
  const centeredForCurrentOpenRef = useRef(false);
  const selectedModelOption = options.find((item) => item.value === model) || null;
  const selectedModelLabel = selectedModelOption?.label || model;
  const [inputValue, setInputValue] = useState(selectedModelLabel);
  const firstModelGroup = options[0]?.group || '';
  const showModelPriceColumn = options.some((item) => Boolean(item.priceLabel));
  const priceTextSx = {
    color: (theme: Theme) => `${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.34)'} !important`,
  };
  const handleListboxRef = useCallback((node: HTMLUListElement | null) => {
    if (!node || centeredForCurrentOpenRef.current) return;
    centeredForCurrentOpenRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        node
          .querySelector<HTMLElement>('[aria-selected="true"]')
          ?.scrollIntoView({ block: 'center' });
      });
    });
  }, []);

  useEffect(() => {
    if (!open) centeredForCurrentOpenRef.current = false;
  }, [open]);

  useEffect(() => {
    setInputValue(selectedModelLabel);
  }, [selectedModelLabel]);

  return (
    <Autocomplete<ModelDropdownOption, false, false, true>
      freeSolo
      options={options}
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      slotProps={{
        popper: {
          sx: {
            width: {
              xs: 'calc(100vw - 32px) !important',
              sm: 'min(400px, calc(100vw - 48px)) !important',
            },
          },
        },
        paper: {
          sx: solidPopupPaperSx(),
        },
        listbox: {
          ref: handleListboxRef,
        },
      }}
      filterOptions={(items, state) => {
        const input = state.inputValue.trim();
        if (!input || input === model || input === selectedModelLabel) return items;
        const normalizedInput = input.toLowerCase();
        return items.filter((option) => `${option.label || option.value} ${option.value} ${option.group}`.toLowerCase().includes(normalizedInput));
      }}
      groupBy={(option) => option.group}
      renderGroup={(params) => (
        <Box component="li" key={params.key} sx={{ listStyle: 'none' }}>
          <ListSubheader
            component="div"
            disableSticky
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              bgcolor: 'background.paper',
              borderBottom: '1px solid',
              borderColor: 'divider',
              color: 'text.secondary',
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.15,
              minHeight: 38,
              py: 0.5,
              px: 2,
            }}
          >
            <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {params.group}
            </Box>
            {showModelPriceColumn && params.group === firstModelGroup ? (
              <Box
                component="span"
                sx={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 0.5,
                  flexShrink: 0,
                  minWidth: activeType === 'image' ? 72 : 76,
                  textAlign: 'right',
                }}
              >
                {activeType === 'image' ? (
                  <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 0.25, minWidth: 72, whiteSpace: 'nowrap' }}>
                    <Box component="span">价格</Box>
                    <Box component="span" sx={{ ...priceTextSx, fontWeight: 500 }}>(张)</Box>
                  </Box>
                ) : (
                  <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 76, fontSize: 11 }}>
                    <Box component="span" sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.25 }}>
                      <Box component="span" sx={{ width: 30 }}>输入</Box>
                      <Box component="span" sx={{ width: 40 }}>输出</Box>
                    </Box>
                    <Box component="span" sx={{ ...priceTextSx, fontWeight: 500, textAlign: 'right' }}>(万token)</Box>
                  </Box>
                )}
              </Box>
            ) : null}
          </ListSubheader>
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            {params.children}
          </Box>
        </Box>
      )}
      getOptionLabel={(option) => {
        if (typeof option !== 'string') return option.label || option.value;
        return option;
      }}
      isOptionEqualToValue={(option, value) => {
        const optionValue = typeof option === 'string' ? option : option.value;
        const selectedValue = typeof value === 'string' ? value : value.value;
        return optionValue === selectedValue;
      }}
      value={selectedModelOption}
      inputValue={inputValue}
      onChange={(_event, value) => {
        const nextModel = typeof value === 'string' ? value : (value?.value || '');
        setInputValue(typeof value === 'string' ? value : (value?.label || value?.value || ''));
        onCommitModel(nextModel);
      }}
      onInputChange={(_event, value, reason) => {
        if (reason === 'input' || reason === 'clear') {
          setInputValue(value);
          onCommitModel(value);
        }
      }}
      renderOption={(props, option) => {
        const { key, ...optionProps } = props;
        return (
        <Box
          component="li"
          key={key}
          {...optionProps}
          data-model-profile-id={profileId}
          data-model-option-value={option.value}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
        >
          <Typography component="span" variant="body2" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {option.label || option.value}
          </Typography>
          {option.priceLabel ? (
            activeType === 'image' ? (
              <Typography component="span" variant="caption" sx={{ ...priceTextSx, flexShrink: 0, minWidth: 72, ml: 'auto', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {option.priceLabel}
              </Typography>
            ) : (
              <Box component="span" sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.25, flexShrink: 0, minWidth: 76, ml: 'auto', textAlign: 'right' }}>
                <Typography component="span" variant="caption" sx={{ ...priceTextSx, width: 30, whiteSpace: 'nowrap' }}>
                  {option.inputPriceLabel || '-'}
                </Typography>
                <Typography component="span" variant="caption" sx={{ ...priceTextSx, width: 40, whiteSpace: 'nowrap' }}>
                  {option.outputPriceLabel || '-'}
                </Typography>
              </Box>
            )
          ) : null}
        </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={modelLabel}
          placeholder={placeholder}
          size="small"
          fullWidth
          inputRef={setInputRef}
          onBlur={onClose}
          sx={fieldSx()}
        />
      )}
      sx={{ flex: 1, minWidth: 0 }}
    />
  );
}, (prev, next) => (
  prev.profileId === next.profileId
  && prev.model === next.model
  && prev.activeType === next.activeType
  && prev.open === next.open
  && prev.modelLabel === next.modelLabel
  && prev.placeholder === next.placeholder
  && buildModelOptionSignature(prev.options) === buildModelOptionSignature(next.options)
));

const OFFICIAL_MODEL_GROUP_ORDER = [
  'gpt',
  'claude',
  'gemini',
  'other',
] as const;

function getOfficialModelGroupKey(model: string) {
  const normalized = model.trim().toLowerCase();
  if (/^(?:gpt-|codex(?:[.-]|$)|o\d)/.test(normalized)) return 'gpt';
  if (/^claude(?:[.-]|$)/.test(normalized)) return 'claude';
  if (/^gemini(?:[.-]|$)/.test(normalized)) return 'gemini';
  return 'other';
}

function isImageModelName(model: string) {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('image') || normalized.includes('dall-e') || normalized.includes('seedream') || normalized.startsWith('nano-banana');
}

function isEmbeddingModelName(model: string) {
  return model.trim().toLowerCase().includes('embedding');
}

function isImageModelInfo(model: AvailableModelInfo) {
  if (isImageModelName(model.id)) return true;
  const metadata = model.raw && typeof model.raw === 'object' && !Array.isArray(model.raw)
    ? model.raw as Record<string, unknown>
    : {};
  const family = String(metadata.family || '').trim().toLowerCase();
  return family === 'image' || family === 'images';
}

function filterModelsForType(models: AvailableModelInfo[], type: AIModelType) {
  return models.filter((model) => {
    const metadata = getModelMetadata(model);
    if (typeof metadata.aceModality === 'string') {
      if (type === 'text') return metadata.aceModality === 'chat';
      if (type === 'image') return metadata.aceModality === 'image';
      if (type === 'tts' || type === 'stt' || type === 'audio') return metadata.aceModality === 'audio';
      return false;
    }
    if (type === 'image') return isImageModelInfo(model);
    if (type === 'text' || type === 'document') return !isImageModelInfo(model) && !isEmbeddingModelName(model.id);
    if (type === 'audio') {
      const normalized = model.id.trim().toLowerCase();
      return normalized.includes('audio') || normalized.includes('voice') || normalized.includes('tts') || normalized.includes('speech');
    }
    return true;
  });
}

function getModelMetadata(model: AvailableModelInfo) {
  return model.raw && typeof model.raw === 'object' && !Array.isArray(model.raw)
    ? model.raw as Record<string, unknown>
    : {};
}

function getNanoBananaVendorGroup(model: AvailableModelInfo, isZh: boolean) {
  const metadata = getModelMetadata(model);
  const normalizeVendor = (value: unknown) => {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : '';
  };
  const providerDisplay = normalizeVendor(metadata.providerDisplay || metadata.provider_display);
  const providerName = normalizeVendor(metadata.providerName || metadata.provider_name);
  const providerCode = normalizeVendor(metadata.providerCode || metadata.provider_code);
  const normalizedModel = model.id.trim().toLowerCase();
  return providerDisplay
    || providerName
    || (normalizedModel.startsWith('gemini-') ? 'Google' : '')
    || (normalizedModel.startsWith('doubao-') ? '豆包' : '')
    || (normalizedModel.startsWith('gpt-') ? 'OpenAI' : '')
    || providerCode
    || (isZh ? '其他供应商' : 'Other vendors');
}

function buildRemoteModelOption(model: AvailableModelInfo, type: AIModelType, provider: AIProvider, usesOfficialProxy: boolean, isZh: boolean): ModelDropdownOption {
  const raw = model.raw && typeof model.raw === 'object' && !Array.isArray(model.raw) ? model.raw as Record<string, unknown> : {};
  const billingDisplay = typeof raw.billingDisplay === 'string' && raw.billingDisplay.trim() ? raw.billingDisplay.trim() : '';
  const inputPriceLabel = typeof raw.billingInputDisplay === 'string' && raw.billingInputDisplay.trim() ? raw.billingInputDisplay.trim() : '';
  const outputPriceLabel = typeof raw.billingOutputDisplay === 'string' && raw.billingOutputDisplay.trim() ? raw.billingOutputDisplay.trim() : '';
  const priceLabel = inputPriceLabel || outputPriceLabel
    ? `${inputPriceLabel} ${outputPriceLabel}`.trim()
    : billingDisplay;
  // Keep the model name independent from billing metadata. The autocomplete
  // renders prices in their own column; appending them here makes the price
  // look like part of the model name and also leaks into the input value.
  const label = provider === 'official-acedata' ? model.label : model.id;
  const aceGroup = typeof raw.aceModality === 'string' ? String(raw.aceProvider || (isZh ? 'ACE 模型' : 'ACE models')) : '';
  if (type === 'image' && provider === 'official-nanobanana') {
    return {
      value: model.id,
      label,
      priceLabel: priceLabel || undefined,
      inputPriceLabel: inputPriceLabel || undefined,
      outputPriceLabel: outputPriceLabel || billingDisplay || undefined,
      group: getNanoBananaVendorGroup(model, isZh),
    };
  }
  return {
    value: model.id,
    label,
    priceLabel: priceLabel || undefined,
    inputPriceLabel: inputPriceLabel || undefined,
    outputPriceLabel: outputPriceLabel || undefined,
    group: aceGroup || (usesOfficialProxy ? getOfficialModelGroupLabel(model.id, isZh) : (isZh ? '远程可用模型' : 'Available from provider')),
  };
}

function getOfficialModelGroupLabel(model: string, isZh: boolean) {
  const key = getOfficialModelGroupKey(model);
  if (isZh) {
    const labels: Record<(typeof OFFICIAL_MODEL_GROUP_ORDER)[number], string> = {
      gpt: 'GPT 系列',
      claude: 'Claude 系列',
      gemini: 'Gemini 系列',
      other: '其他模型',
    };
    return labels[key];
  }
  const labels: Record<(typeof OFFICIAL_MODEL_GROUP_ORDER)[number], string> = {
    gpt: 'GPT',
    claude: 'Claude',
    gemini: 'Gemini',
    other: 'Other models',
  };
  return labels[key];
}

function compareOfficialModels(left: string, right: string) {
  const leftGroup = getOfficialModelGroupKey(left);
  const rightGroup = getOfficialModelGroupKey(right);
  const leftGroupIndex = OFFICIAL_MODEL_GROUP_ORDER.indexOf(leftGroup);
  const rightGroupIndex = OFFICIAL_MODEL_GROUP_ORDER.indexOf(rightGroup);
  if (leftGroupIndex !== rightGroupIndex) return leftGroupIndex - rightGroupIndex;
  return compareModelVersionsDescending(left, right);
}

function resolveAiBalanceView(balance: Record<string, unknown> | null, loading: boolean): AiBalanceView {
  if (loading) return { status: 'loading' };
  if (!balance) return { status: 'idle' };
  const raw = balance.availableBalance ?? balance.available_balance;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return {
      status: 'ready',
      points: raw,
      currencyUnit: String(balance.currencyUnit ?? balance.currency_unit ?? ''),
    };
  }
  return { status: 'unassigned' };
}

function getAiBalanceLabel(view: AiBalanceView, providerKey: string, zh: boolean) {
  if (view.status === 'loading') return zh ? '点数刷新中' : 'Refreshing points';
  if (view.status === 'ready' && view.currencyUnit?.trim().toLowerCase() === 'usd') return formatAiAmount(view.points, providerKey, { prefix: '$', suffix: '' });
  if (view.status === 'ready') return formatAiAmount(view.points, resolveOfficialBackendProvider(providerKey));
  if (view.status === 'guest') return zh ? '登录后查看点数' : 'Sign in to view points';
  if (view.status === 'unassigned') return zh ? '未分配点数' : 'No points assigned';
  if (view.status === 'error') return zh ? '点数读取失败，点击重试' : 'Failed to load points. Retry';
  return zh ? '点击查看点数' : 'View points';
}

function isOfficialProviderKey(provider: string) {
  return provider === 'official' || provider.startsWith('official-');
}

const MANAGED_SPEECH_PROVIDER_PREFIX = 'managed:';

function isManagedSpeechProvider(provider: string) {
  return provider === 'official' || provider.startsWith(MANAGED_SPEECH_PROVIDER_PREFIX);
}

function resolveOfficialBackendProvider(provider: string) {
  return provider === 'official' ? 'official-2' : provider;
}

function resolveLegacyOfficialProviderKey(provider: string) {
  if (provider === 'official' || provider === 'official-moacode') return 'official-2';
  if (provider === 'official-deepseek') return 'official-1';
  if (provider === 'official-moacode-team') return 'official-team';
  if (provider === 'official-gpt') return 'official-4';
  return provider;
}

function buildOnlineOfficialProviderOption(provider: OfficialAiProviderInfo): (AIProviderOption & { sortOrder: number }) | null {
  if (!provider.officialProvider?.trim()) return null;
  const providerKey = provider.officialProvider.trim() as AIProvider;
  const fallbackDefault = { baseUrl: '/api/ai', model: provider.defaultModel || '' };
  const catalogEntry = AI_PROVIDER_CATALOG.find((item) => item.key === providerKey)
    || (providerKey === 'official-1' ? AI_PROVIDER_CATALOG.find((item) => item.key === 'official-deepseek') : null)
    || (providerKey === 'official-2' ? AI_PROVIDER_CATALOG.find((item) => item.key === 'official-moacode') : null)
    || (providerKey === 'official-team' ? AI_PROVIDER_CATALOG.find((item) => item.key === 'official-moacode-team') : null)
    || {
    key: providerKey,
    label: provider.label || providerKey,
    family: provider.family || '官方模型',
    defaults: {
      text: fallbackDefault,
      image: fallbackDefault,
      audio: fallbackDefault,
      document: fallbackDefault,
    },
    popularModels: {
      text: provider.defaultModel ? [provider.defaultModel] : [],
      image: provider.defaultModel ? [provider.defaultModel] : [],
      audio: provider.defaultModel ? [provider.defaultModel] : [],
      document: provider.defaultModel ? [provider.defaultModel] : [],
    },
  };
  const remoteDefaultModel = provider.defaultModel || '';
  const remoteImageDefaultModel = provider.imageDefaultModel || (isImageModelName(remoteDefaultModel) ? remoteDefaultModel : '');
  const imageDefaultModel = remoteImageDefaultModel || catalogEntry.defaults.image?.model || '';
  const textDefaultModel = !isImageModelName(remoteDefaultModel)
    ? remoteDefaultModel
    : (catalogEntry.defaults.text?.model || '');
  const nextDefaults: AIProviderCatalogEntry['defaults'] = {
    ...catalogEntry.defaults,
    text: textDefaultModel || catalogEntry.defaults.text?.model
      ? { ...(catalogEntry.defaults.text || fallbackDefault), model: textDefaultModel || catalogEntry.defaults.text?.model || '' }
      : catalogEntry.defaults.text,
    audio: catalogEntry.defaults.audio?.model ? { ...catalogEntry.defaults.audio, model: catalogEntry.defaults.audio.model } : catalogEntry.defaults.audio,
    document: textDefaultModel || catalogEntry.defaults.document?.model
      ? { ...(catalogEntry.defaults.document || fallbackDefault), model: textDefaultModel || catalogEntry.defaults.document?.model || '' }
      : catalogEntry.defaults.document,
  };
  if (imageDefaultModel || catalogEntry.defaults.image?.model) {
    nextDefaults.image = { ...(catalogEntry.defaults.image || fallbackDefault), model: imageDefaultModel || catalogEntry.defaults.image?.model || '' };
  } else {
    delete nextDefaults.image;
  }
  return {
    ...catalogEntry,
    key: providerKey,
    label: provider.label || catalogEntry.label,
    family: provider.family || catalogEntry.family,
    hidden: Boolean(provider.hidden),
    unavailableReason: provider.accessAllowed === false ? '当前会员不可用' : undefined,
    defaults: nextDefaults,
    popularModels: {
      text: textDefaultModel ? [textDefaultModel] : [],
      image: imageDefaultModel ? [imageDefaultModel] : [],
      audio: [],
      document: textDefaultModel ? [textDefaultModel] : [],
    },
    sortOrder: typeof provider.sortOrder === 'number' ? provider.sortOrder : 999,
  };
}

function getProviderDefaultsFromOptions(provider: AIProvider, type: AIModelType, providerOptions: AIProviderOption[]) {
  const entry = providerOptions.find((item) => item.key === provider) || getProviderCatalogEntry(provider);
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  return entry.defaults[catalogType] || { baseUrl: '', model: '' };
}

function providerSupportsType(option: AIProviderOption, type: AIModelType) {
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  const defaults = option.defaults[catalogType];
  const popularModels = option.popularModels[catalogType] || [];
  return Boolean(defaults?.model || popularModels.length);
}

function resolveSelectableProviderKey(provider: string, type: AIModelType, providerOptions: AIProviderOption[] = getProvidersForType(type)) {
  const catalogType = type === 'tts' || type === 'stt' ? 'audio' : type;
  const exactProvider = providerOptions.find((item) => item.key === provider);
  if (exactProvider?.defaults[catalogType]) return exactProvider.key;
  if (isOfficialProviderKey(provider)) {
    const legacyProvider = resolveLegacyOfficialProviderKey(provider);
    const mappedProvider = providerOptions.find((item) => item.key === legacyProvider);
    if (mappedProvider?.defaults[type]) return mappedProvider.key;
  }
  const catalogProvider = getProviderCatalogEntry(provider as AIProvider);
  if (catalogProvider.defaults[catalogType]) return catalogProvider.key;
  return providerOptions.find((item) => item.key === catalogProvider.key)?.key
    || providerOptions[0]?.key
    || catalogProvider.key;
}

export function AIModelsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { setHeaderActions, setHeaderTitle, setHeaderBackAction, setHideMobileBottomNav } = useLayoutHeaderActions();
  const aiProfiles = useSettingsStore((state) => state.aiProfiles);
  const updateAIProfile = useSettingsStore((state) => state.updateAIProfile);
  const addAIProfile = useSettingsStore((state) => state.addAIProfile);
  const removeAIProfile = useSettingsStore((state) => state.removeAIProfile);
  const syncCurrentSettingsToServer = useSettingsStore((state) => state.syncCurrentSettingsToServer);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const authMode = useAuthStore((state) => state.authMode);
  const canUseOfficialProviders = authMode === 'cloud' && isLoggedIn;
  const [showKey, setShowKey] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [applyingKeyId, setApplyingKeyId] = useState<string | null>(null);
  const [confirmAssignProfileId, setConfirmAssignProfileId] = useState<string | null>(null);
  const [remoteModelOptions, setRemoteModelOptions] = useState<Record<string, ModelDropdownOption[]>>({});
  const [fetchedModelKeys, setFetchedModelKeys] = useState<Record<string, string>>({});
  const [fetchingModelIds, setFetchingModelIds] = useState<Record<string, boolean>>({});
  const [fetchModelFailedIds, setFetchModelFailedIds] = useState<Record<string, boolean>>({});
  const [openModelDropdownIds, setOpenModelDropdownIds] = useState<Record<string, boolean>>({});
  const [aiBalances, setAiBalances] = useState<Record<string, Record<string, unknown> | null>>({});
  const [aiBalanceLoadingIds, setAiBalanceLoadingIds] = useState<Record<string, boolean>>({});
  const [aiBalanceStatuses, setAiBalanceStatuses] = useState<Record<string, 'idle' | 'guest' | 'unassigned' | 'error'>>({});
  const officialProvidersRequestKey = `${canUseOfficialProviders ? 'private' : 'public'}:${i18n.language}`;
  const [officialProvidersState, setOfficialProvidersState] = useState<OfficialProvidersState>({
    key: officialProvidersRequestKey,
    items: [],
    error: null,
  });
  const [speechPlatforms, setSpeechPlatforms] = useState<SpeechPlatformsState>({ items: [], loading: true, error: null });
  const officialProviders = useMemo(
    () => (officialProvidersState.key === officialProvidersRequestKey ? officialProvidersState.items : []),
    [officialProvidersRequestKey, officialProvidersState.items, officialProvidersState.key],
  );
  const officialProvidersError = officialProvidersState.key === officialProvidersRequestKey ? officialProvidersState.error : null;
  const officialProvidersLoading = officialProvidersState.key !== officialProvidersRequestKey;
  const modelInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const fetchingModelKeysRef = useRef<Record<string, string>>({});
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const modelTypeLabels: Record<AIModelType, string> = {
    text: i18n.language.startsWith('zh') ? '文本' : 'Text',
    image: i18n.language.startsWith('zh') ? '图片' : 'Image',
    tts: i18n.language.startsWith('zh') ? '语音（TTS）' : 'Speech (TTS)',
    stt: i18n.language.startsWith('zh') ? '语音（STT）' : 'Speech (STT)',
    audio: i18n.language.startsWith('zh') ? '语音' : 'Audio',
    document: i18n.language.startsWith('zh') ? '文档' : 'Document',
  };
  const imageCapabilityLabels: Array<{ key: keyof AIModelImageCapabilities; label: string; tooltip: string }> = i18n.language.startsWith('zh')
    ? [
        { key: 'referenceImage', label: '参考图', tooltip: '模型接口支持把图片作为参考输入，而不是只在提示词里描述形象。' },
        { key: 'multiReferenceImage', label: '多参考图', tooltip: '模型接口支持一次传入多张参考图。' },
        { key: 'seed', label: 'Seed', tooltip: '模型接口支持传入 seed 或等价的随机种子参数。' },
        { key: 'negativePrompt', label: '避免内容', tooltip: '模型接口支持单独的 negative prompt 参数。' },
      ]
    : [
        { key: 'referenceImage', label: 'Reference image', tooltip: 'The image API accepts an image as reference input, not only text prompt descriptions.' },
        { key: 'multiReferenceImage', label: 'Multiple refs', tooltip: 'The image API accepts multiple reference images in one request.' },
        { key: 'seed', label: 'Seed', tooltip: 'The image API accepts a seed or equivalent randomness control parameter.' },
        { key: 'negativePrompt', label: 'Negative prompt', tooltip: 'The image API supports a separate negative prompt parameter.' },
      ];
  const inputCapabilityLabels: Array<{ key: keyof Pick<AIModelInputCapabilities, 'imageInput' | 'multiImageInput'>; label: string; tooltip: string }> = i18n.language.startsWith('zh')
    ? [
        { key: 'imageInput', label: '图片输入', tooltip: '允许在聊天输入框选择图片并发送给文本模型。' },
        { key: 'multiImageInput', label: '多图输入', tooltip: '允许一次选择并发送多张图片。' },
      ]
    : [
        { key: 'imageInput', label: 'Image input', tooltip: 'Allow selecting images in chat and sending them to the text model.' },
        { key: 'multiImageInput', label: 'Multi-image input', tooltip: 'Allow selecting and sending multiple images at once.' },
      ];
  const groupedModelLabels = {
    popular: i18n.language.startsWith('zh') ? '推荐模型' : 'Recommended models',
    remote: i18n.language.startsWith('zh') ? '远程可用模型' : 'Available from provider',
  } as const;
  const onlineOfficialProviderOptions = useMemo(() => officialProviders
    .map(buildOnlineOfficialProviderOption)
    .filter((item): item is AIProviderOption & { sortOrder: number } => Boolean(item))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label)), [officialProviders]);
  const onlineOfficialProviderKeySet = useMemo(
    () => new Set(onlineOfficialProviderOptions.map((item) => item.key)),
    [onlineOfficialProviderOptions],
  );
  const isOnlineOfficialProviderKey = useCallback((provider: string) => {
    const resolved = isOfficialProviderKey(provider) ? resolveLegacyOfficialProviderKey(provider) : provider;
    return onlineOfficialProviderKeySet.has(resolved as AIProvider);
  }, [onlineOfficialProviderKeySet]);
  const isOfficialProxyProviderKey = useCallback((provider: string) => (
    isOfficialProviderKey(provider) || isOnlineOfficialProviderKey(provider)
  ), [isOnlineOfficialProviderKey]);
  const getProviderOptionsForType = useCallback((type: AIModelType, selectedProvider?: string): AIProviderOption[] => {
    const speechPlatform = (type === 'tts' || type === 'stt')
      ? speechPlatforms.items.find((item) => item.capability === type)
      : null;
    // The default speech integration is represented by the gateway entry below.
    // Do not render it again by its provider name (for example, both “豆包语音”
    // and “火山引擎豆包语音” would otherwise select the exact same integration).
    const managedSpeechOptions: AIProviderOption[] = (speechPlatform?.providers || []).filter((item) => item.available).map((item) => {
      const catalog = getProviderCatalogEntry(item.providerCode as AIProvider);
      const fallback = { ...(catalog.defaults.audio || { baseUrl: '', model: '' }), model: item.modelId || catalog.defaults.audio?.model || '' };
      return {
        ...catalog,
        key: (item.official ? 'official' : `${MANAGED_SPEECH_PROVIDER_PREFIX}${item.providerCode}`) as AIProvider,
        label: item.modelName || item.displayName || catalog.label,
        family: i18n.language.startsWith('zh') ? '官方' : 'Official',
        hidden: false,
        defaults: { ...catalog.defaults, audio: { ...fallback, baseUrl: '/api' } },
        popularModels: { ...catalog.popularModels, audio: catalog.popularModels.audio || [] },
      };
    });
    // Speech is served by the speech gateway, not the text/image AI proxy.
    // Keep its selectable providers isolated so text-model official entries can
    // never leak into a TTS/STT model dropdown.
    if (type === 'tts' || type === 'stt') {
      const directOptions = getProvidersForType(type)
        .filter((item) => !isOfficialProviderKey(item.key))
        .map((item) => ({ ...item, family: i18n.language.startsWith('zh') ? '自定义' : 'Custom' }));
      return [...managedSpeechOptions, ...directOptions];
    }
    const nonOfficialOptions = getProvidersForType(type)
      .filter((item) => !isOfficialProviderKey(item.key) && !onlineOfficialProviderKeySet.has(item.key));
    const visibleOfficialOptions = !canUseOfficialProviders
      ? onlineOfficialProviderOptions
        .filter((item) => {
          const resolvedSelected = resolveLegacyOfficialProviderKey(selectedProvider || '');
          const isSelected = item.key === selectedProvider || item.key === resolvedSelected;
          return (
            providerSupportsType(item, type)
            || isSelected
          ) && (!item.hidden || isSelected);
        })
        .map((item) => ({
          ...item,
          label: `${item.label}（登录后可用）`,
          unavailableReason: i18n.language.startsWith('zh') ? '登录后可用' : 'sign in required',
        }))
      : officialProvidersError
        ? []
        : onlineOfficialProviderOptions.filter((item) => {
          const resolvedSelected = resolveLegacyOfficialProviderKey(selectedProvider || '');
          const isSelected = item.key === selectedProvider || item.key === resolvedSelected;
          return (
            providerSupportsType(item, type)
            || isSelected
          ) && (!item.hidden || isSelected);
        });
    const resolvedSelectedProvider = selectedProvider ? resolveLegacyOfficialProviderKey(selectedProvider) : '';
    const selectedOfficialKey = selectedProvider && (isOfficialProviderKey(selectedProvider) || onlineOfficialProviderKeySet.has(resolvedSelectedProvider as AIProvider))
      ? resolvedSelectedProvider
      : '';
    const selectedOfficialOption = selectedOfficialKey
      ? onlineOfficialProviderOptions.find((item) => item.key === selectedOfficialKey)
        || getProvidersForType(type, { includeHidden: true }).find((item) => item.key === selectedProvider)
        || getProviderCatalogEntry(selectedProvider as AIProvider)
      : null;
    const selectedOfficialIsListed = selectedOfficialKey
      ? visibleOfficialOptions.some((item) => item.key === selectedOfficialKey || item.key === selectedProvider)
      : true;
    if (selectedOfficialOption && !selectedOfficialIsListed) {
      const reason = officialProvidersLoading
        ? (i18n.language.startsWith('zh') ? '正在确认可用性' : 'checking availability')
        : !canUseOfficialProviders
          ? (i18n.language.startsWith('zh') ? '登录后可用' : 'sign in required')
          : officialProvidersError
          ? (i18n.language.startsWith('zh') ? '在线列表获取失败' : 'online list failed')
          : (i18n.language.startsWith('zh') ? '后台未启用' : 'disabled by backend');
      return [
        {
          ...selectedOfficialOption,
          hidden: false,
          label: selectedOfficialOption.label,
          unavailableReason: reason,
        },
        ...visibleOfficialOptions,
        ...nonOfficialOptions,
      ];
    }
    return [
      ...visibleOfficialOptions,
      ...nonOfficialOptions,
    ];
  }, [canUseOfficialProviders, i18n.language, officialProvidersError, officialProvidersLoading, onlineOfficialProviderKeySet, onlineOfficialProviderOptions, speechPlatforms.items]);

  useEffect(() => {
    if (embedded) return undefined;
    setHeaderTitle(t('nav.models'));
    setHeaderBackAction(null);
    setHideMobileBottomNav(false);
    setHeaderActions(null);
    return () => {
      setHeaderTitle(null);
      setHeaderBackAction(null);
      setHideMobileBottomNav(false);
      setHeaderActions(null);
    };
  }, [embedded, setHeaderActions, setHeaderBackAction, setHeaderTitle, setHideMobileBottomNav, t]);

  useEffect(() => {
    let cancelled = false;
    void api.getSpeechPlatforms()
      .then((result) => {
        if (!cancelled) setSpeechPlatforms({ items: result.items, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setSpeechPlatforms({ items: [], loading: false, error: extractConnectionErrorMessage(error) || '语音平台读取失败' });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let active = true;
    const request = canUseOfficialProviders ? api.getOfficialAiProviders() : api.getPublicOfficialAiProviders();
    request
      .then((result) => {
        if (!active) return;
        setOfficialProvidersState({
          key: officialProvidersRequestKey,
          items: Array.isArray(result.items) ? result.items : [],
          error: null,
        });
      })
      .catch((error) => {
        if (!active) return;
        setOfficialProvidersState({
          key: officialProvidersRequestKey,
          items: [],
          error: extractConnectionErrorMessage(error) || (i18n.language.startsWith('zh') ? '官方 AI 供应商列表获取失败' : 'Failed to load official AI providers'),
        });
      });
    return () => {
      active = false;
    };
  }, [canUseOfficialProviders, i18n.language, officialProvidersRequestKey]);

  const commitModelValue = useCallback((profileId: string, value: string) => {
    const { aiProfiles: currentProfiles, updateAIProfile: updateCurrentAIProfile } = useSettingsStore.getState();
    const profile = currentProfiles.find((item) => item.id === profileId);
    if (profile?.model === value) return;
    updateCurrentAIProfile(profileId, {
      model: value,
      ...(profile?.type === 'image' ? { imageCapabilities: inferImageCapabilities(profile.provider, value) } : {}),
      ...(profile?.type === 'text' ? {
        inputCapabilities: inferTextInputCapabilities(profile.provider, value),
        advancedOptions: normalizeAIModelAdvancedOptions(profile.provider, value, profile.advancedOptions),
      } : {}),
    });
  }, []);

  const refreshAiBalance = useCallback(async (providerKey: string) => {
    if (!canUseOfficialProviders) {
      setAiBalances((prev) => ({ ...prev, [providerKey]: null }));
      setAiBalanceStatuses((prev) => ({ ...prev, [providerKey]: 'guest' }));
      return;
    }
    const backendProvider = resolveOfficialBackendProvider(providerKey);
    setAiBalanceLoadingIds((prev) => ({ ...prev, [providerKey]: true }));
    try {
      const balance = await api.getAiBalance(backendProvider, { force: true });
      setAiBalances((prev) => ({ ...prev, [providerKey]: balance }));
      const raw = balance.availableBalance ?? balance.available_balance;
      setAiBalanceStatuses((prev) => ({ ...prev, [providerKey]: typeof raw === 'number' && Number.isFinite(raw) ? 'idle' : 'unassigned' }));
    } catch {
      setAiBalances((prev) => ({ ...prev, [providerKey]: null }));
      setAiBalanceStatuses((prev) => ({ ...prev, [providerKey]: 'error' }));
    } finally {
      setAiBalanceLoadingIds((prev) => {
        const next = { ...prev };
        delete next[providerKey];
        return next;
      });
    }
  }, [canUseOfficialProviders]);

  useEffect(() => {
    const providers = Array.from(new Set(aiProfiles
      .filter((profile) => isOfficialProxyProviderKey(profile.provider) || profile.baseUrl.replace(/\/+$/, '') === '/api/ai')
      .map((profile) => profile.provider)));
    providers.forEach((provider) => void refreshAiBalance(provider));
  }, [aiProfiles, isOfficialProxyProviderKey, refreshAiBalance]);

  const handleTestConnection = async (profileId: string) => {
    const profile = aiProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    const profileUsesManagedSpeech = (profile.type === 'tts' || profile.type === 'stt') && isManagedSpeechProvider(profile.provider);
    const profileUsesOfficialProxy = profileUsesManagedSpeech || isOfficialProxyProviderKey(profile.provider) || profile.baseUrl.replace(/\/+$/, '') === '/api/ai';
    if (profileUsesOfficialProxy && !canUseOfficialProviders) {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '官方模型需要登录后使用' : 'Official models require sign-in',
        severity: 'error',
      });
      return;
    }
    setTestingId(profileId);
    try {
      const result: AIConnectionTestResult = await (profile.type === 'tts'
        ? (profileUsesManagedSpeech
          ? api.synthesizeSpeech({
            text: i18n.language.startsWith('zh') ? '这是一条语音模型连接测试。' : 'This is a speech model connection test.',
            providerCode: profile.provider.startsWith(MANAGED_SPEECH_PROVIDER_PREFIX) ? profile.provider.slice(MANAGED_SPEECH_PROVIDER_PREFIX.length) : undefined,
            modelId: profile.model,
          })
          : synthesizeSpeechWithAdapter({ profile, input: i18n.language.startsWith('zh') ? '这是一条语音模型连接测试。' : 'This is a speech model connection test.', format: 'mp3', intent: 'chat-audio' })
        ).then(() => ({ success: true as const }))
        : profile.type === 'stt'
          ? (profileUsesManagedSpeech
            ? api.transcribeSpeech({
              audioDataUrl: createSpeechTestWavDataUrl(),
              providerCode: profile.provider.startsWith(MANAGED_SPEECH_PROVIDER_PREFIX) ? profile.provider.slice(MANAGED_SPEECH_PROVIDER_PREFIX.length) : undefined,
              modelId: profile.model,
              fileName: 'speech-connection-test.wav',
            })
            : fetch(createSpeechTestWavDataUrl())
              .then((response) => response.blob())
              .then((file) => transcribeAudioWithAdapter({ profile, file, fileName: 'speech-connection-test.wav', intent: 'audio-transcription' }))
          ).then(() => ({ success: true as const }))
          : testConnection(profile));
      const corsBlocked = isLikelyBrowserCorsError(result.error);
      const shouldSave = result.success || corsBlocked;
      if (shouldSave) {
        await syncCurrentSettingsToServer();
      }
      const corsHint = i18n.language.startsWith('zh')
        ? '浏览器直连被目标站跨域策略拦截，配置已保存，实际使用建议走服务端代理。'
        : 'Browser-direct request was blocked by the target CORS policy. Config saved; production use should go through your server proxy.';
      const successMessage = i18n.language.startsWith('zh')
        ? '连接测试成功，配置已保存'
        : 'Connection test succeeded. Config saved.';
      const errorMessage = extractConnectionErrorMessage(result.error);
      const message = result.success
        ? successMessage
        : corsBlocked
          ? corsHint
          : errorMessage || t('settings.connectionFailed');
      setSnackbar({
        open: true,
        message,
        severity: shouldSave ? 'success' : 'error',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error
          ? error.message
          : (i18n.language.startsWith('zh') ? '保存配置失败' : 'Failed to save config'),
        severity: 'error',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleApplyOfficialKey = async (profileId: string, providerKey: string) => {
    if (!canUseOfficialProviders) {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '请先登录后申请官方模型 Key' : 'Sign in before requesting an official model key',
        severity: 'error',
      });
      return;
    }
    const backendProvider = resolveOfficialBackendProvider(providerKey);
    setApplyingKeyId(profileId);
    try {
      const result = await api.assignAiProviderKey(backendProvider);
      const balance = result.balance && typeof result.balance === 'object'
        ? result.balance as Record<string, unknown>
        : null;
      if (balance) {
        const raw = balance.availableBalance ?? balance.available_balance;
        setAiBalances((prev) => ({ ...prev, [providerKey]: balance }));
        setAiBalanceStatuses((prev) => ({ ...prev, [providerKey]: typeof raw === 'number' && Number.isFinite(raw) ? 'idle' : 'unassigned' }));
      } else {
        await refreshAiBalance(providerKey);
      }
      await syncCurrentSettingsToServer();
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? 'Key 已申请并分配额度' : 'Key created and quota assigned',
        severity: 'success',
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: error instanceof Error
          ? error.message
          : (i18n.language.startsWith('zh') ? '申请 Key 失败' : 'Failed to request key'),
        severity: 'error',
      });
    } finally {
      setApplyingKeyId(null);
    }
  };

  const handleAssignToAllRoles = async (profileId: string) => {
    const profile = aiProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    setAssigningId(profileId);
    try {
      const initialCharacterState = useCharacterStore.getState();
      if (initialCharacterState.characters.length === 0) {
        await initialCharacterState.loadCharacters();
      }

      const { characters: latestCharacters, updateCharacter } = useCharacterStore.getState();
      const editableCharacters = latestCharacters.filter((character) => !character.isPreset && character.deletedAt == null);
      if (!editableCharacters.length) {
        setSnackbar({
          open: true,
          message: i18n.language.startsWith('zh') ? '还没有可编辑角色，请先创建至少一个角色' : 'No editable characters yet. Create at least one custom character first.',
          severity: 'error',
        });
        return;
      }

      await Promise.all(editableCharacters.map((character) => {
        const modelProfileIds = normalizeCharacterModelProfileIds(character.modelProfileIds, character.modelProfileId || null);
        const nextModelProfileIds = {
          ...modelProfileIds,
          [profile.type || 'text']: profile.id,
        };
        return updateCharacter(character.id, {
          modelProfileId: nextModelProfileIds.text || null,
          modelProfileIds: nextModelProfileIds,
        });
      }));
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh')
          ? `已为 ${editableCharacters.length} 个角色配置${modelTypeLabels[profile.type || 'text']}模型`
          : `Assigned ${modelTypeLabels[profile.type || 'text']} model to ${editableCharacters.length} characters`,
        severity: 'success',
      });
    } catch {
      setSnackbar({
        open: true,
        message: i18n.language.startsWith('zh') ? '批量配置角色模型失败' : 'Failed to assign model to characters',
        severity: 'error',
      });
    } finally {
      setAssigningId(null);
    }
  };

  const fetchAvailableModels = async (profileId: string, silent = false, force = false) => {
    const profile = aiProfiles.find((item) => item.id === profileId);
    if (!profile) return false;
    const activeType = profile.type || 'text';
    const providerOptions = getProviderOptionsForType(activeType, profile.provider);
    const effectiveProvider = resolveSelectableProviderKey(profile.provider, activeType, providerOptions);
    const providerDefaults = getProviderDefaultsFromOptions(effectiveProvider, activeType, providerOptions);
    const effectiveProfile = {
      ...profile,
      provider: effectiveProvider,
      baseUrl: providerDefaults.baseUrl || profile.baseUrl,
      model: profile.model || providerDefaults.model,
    };
    if (activeType === 'tts' || activeType === 'stt') {
      const fetchKey = `${effectiveProfile.provider}__${activeType}__speech`;
      setRemoteModelOptions((prev) => ({ ...prev, [profileId]: [] }));
      setFetchedModelKeys((prev) => ({ ...prev, [profileId]: fetchKey }));
      if (!silent) {
        setSnackbar({
          open: true,
          message: i18n.language.startsWith('zh') ? '语音模型由后台语音平台配置提供，无需拉取文本模型列表' : 'Speech models come from the configured speech platform; text model discovery is not used.',
          severity: 'success',
        });
      }
      return true;
    }
    const profileUsesOfficialProxy = isOfficialProxyProviderKey(effectiveProfile.provider) || effectiveProfile.baseUrl.replace(/\/+$/, '') === '/api/ai';
    if (profileUsesOfficialProxy && !canUseOfficialProviders) {
      setRemoteModelOptions((prev) => ({ ...prev, [profileId]: [] }));
      if (!silent) {
        setSnackbar({
          open: true,
          message: i18n.language.startsWith('zh') ? '登录后才能获取官方模型列表' : 'Sign in to load official models',
          severity: 'error',
        });
      }
      return false;
    }
    if (!profileUsesOfficialProxy && !profile.apiKey) {
      setRemoteModelOptions((prev) => ({ ...prev, [profileId]: [] }));
      return false;
    }

    const fetchKey = `${effectiveProfile.provider}__${activeType}__${effectiveProfile.baseUrl}__${effectiveProfile.apiKey || 'account'}`;
    if (!force && fetchedModelKeys[profileId] === fetchKey) return true;
    if (fetchingModelKeysRef.current[profileId] === fetchKey) return false;

    fetchingModelKeysRef.current[profileId] = fetchKey;
    setFetchingModelIds((prev) => ({ ...prev, [profileId]: true }));
    setFetchModelFailedIds((prev) => {
      const next = { ...prev };
      delete next[profileId];
      return next;
    });
    try {
      const models = await listAvailableModels(effectiveProfile);
      const uniqueModels = Array.from(new Map(models.filter((item) => Boolean(item.id)).map((item) => [item.id, item])).values());
      const options = filterModelsForType(uniqueModels, activeType)
        .map((item) => buildRemoteModelOption(item, activeType, effectiveProfile.provider, profileUsesOfficialProxy, i18n.language.startsWith('zh')));
      options.sort((left, right) => {
        if (effectiveProfile.provider === 'official-acedata') {
          const groupOrder = left.group.localeCompare(right.group);
          if (groupOrder) return groupOrder;
          return compareModelVersionsDescending(left.value, right.value);
        }
        return profileUsesOfficialProxy
          ? compareOfficialModels(left.value, right.value)
          : compareModelVersionsDescending(left.value, right.value);
      });
      setRemoteModelOptions((prev) => ({ ...prev, [profileId]: options }));
      setFetchedModelKeys((prev) => ({ ...prev, [profileId]: fetchKey }));
      if (!silent) {
        setSnackbar({
          open: true,
          message: i18n.language.startsWith('zh')
            ? `已拉取 ${options.length} 个模型`
            : `Loaded ${options.length} models`,
          severity: 'success',
        });
      }
      return true;
    } catch (error) {
      setRemoteModelOptions((prev) => ({ ...prev, [profileId]: [] }));
      setFetchedModelKeys((prev) => ({ ...prev, [profileId]: fetchKey }));
      if (!silent) {
        setFetchModelFailedIds((prev) => ({ ...prev, [profileId]: true }));
      }
      if (!silent) {
        setSnackbar({
          open: true,
          message: error instanceof Error
            ? error.message
            : (i18n.language.startsWith('zh') ? '拉取模型列表失败' : 'Failed to load models'),
          severity: 'error',
        });
      }
      return false;
    } finally {
      delete fetchingModelKeysRef.current[profileId];
      setFetchingModelIds((prev) => {
        const next = { ...prev };
        delete next[profileId];
        return next;
      });
    }
  };

  const handleFetchModels = async (profileId: string) => {
    const success = await fetchAvailableModels(profileId, false, true);
    if (success) {
      modelInputRefs.current[profileId]?.focus();
      requestAnimationFrame(() => {
        setOpenModelDropdownIds((prev) => ({ ...prev, [profileId]: true }));
      });
    }
  };

  useEffect(() => {
    // Keep model discovery manual to avoid browser-side CORS noise on third-party endpoints.
  }, []);

  return (
    <Box sx={embedded
      ? { width: '100%' }
      : { flex: 1, overflow: 'auto', p: 3, pt: { xs: 1, sm: 1, md: 3 }, pb: { xs: 15, sm: 12 }, width: '100%', maxWidth: 1320, mx: 'auto' }}
    >
      <PageSection spacing={2}>
      <SettingsSyncErrorAlert />
      {officialProvidersError ? (
        <Alert severity="error" variant="outlined">
          {i18n.language.startsWith('zh') ? `官方 AI 供应商列表获取失败：${officialProvidersError}` : `Failed to load official AI providers: ${officialProvidersError}`}
        </Alert>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          width: '100%',
          mx: 'auto',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))',
          justifyContent: 'center',
          gap: 2,
        }}
      >
            {aiProfiles.map((profile, index) => (
              <SurfaceCard key={profile.id} sx={modelCardSx()} contentSx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
                  {(() => {
                    const activeType = profile.type || 'text';
                    const providerOptions = getProviderOptionsForType(activeType, profile.provider);
                    const selectedProviderKey = resolveSelectableProviderKey(profile.provider, activeType, providerOptions);
                    const selectedProvider = providerOptions.find((item) => item.key === selectedProviderKey) || getProviderCatalogEntry(selectedProviderKey);
                    const selectedProviderUnavailable = Boolean((selectedProvider as AIProviderOption).unavailableReason);
                    const providerDefaults = getProviderDefaultsFromOptions(selectedProvider.key, activeType, providerOptions);
                    const providerGroups = providerOptions.reduce<Array<{ label: string; options: AIProviderOption[] }>>((groups, option) => {
                      const groupLabel = option.family || (i18n.language.startsWith('zh') ? '其他服务商' : 'Other providers');
                      const group = groups.find((item) => item.label === groupLabel);
                      if (group) {
                        group.options.push(option);
                      } else {
                        groups.push({ label: groupLabel, options: [option] });
                      }
                      return groups;
                    }, []);
                    const usesManagedSpeech = (activeType === 'tts' || activeType === 'stt') && isManagedSpeechProvider(selectedProvider.key);
                    const usesOfficialProxy = usesManagedSpeech || isOfficialProxyProviderKey(selectedProvider.key) || providerDefaults.baseUrl.replace(/\/+$/, '') === '/api/ai';
                    const fetchedModels = remoteModelOptions[profile.id] || [];
                    const catalogType = activeType === 'tts' || activeType === 'stt' ? 'audio' : activeType;
                    const speechModelOptions: ModelDropdownOption[] = (activeType === 'tts' || activeType === 'stt')
                      ? [...(speechPlatforms.items.find((item) => item.capability === activeType)?.providers || [])]
                        .filter((item) => item.available)
                        .sort((left, right) => Number(right.official) - Number(left.official))
                        .filter((item, index, items) => items.findIndex((candidate) => candidate.modelId === item.modelId) === index)
                        .map((item) => ({
                          value: item.modelId,
                          label: item.modelName || item.modelId,
                          group: i18n.language.startsWith('zh') ? '可用语音模型' : 'Available speech models',
                        }))
                      : [];
                    const providerPopularModels = selectedProvider.popularModels[catalogType] || getPopularModels(selectedProvider.key, activeType);
                    const popularModels = usesOfficialProxy && fetchedModels.length > 0 ? [] : providerPopularModels;
                    const popularModelSet = new Set(popularModels);
                    const remoteModels = fetchedModels.filter((item) => !popularModelSet.has(item.value));
                    const fetchingModels = Boolean(fetchingModelIds[profile.id]);
                    const balanceView = usesOfficialProxy
                      ? (aiBalanceStatuses[selectedProvider.key] === 'guest' || aiBalanceStatuses[selectedProvider.key] === 'error'
                        ? { status: aiBalanceStatuses[selectedProvider.key] } as AiBalanceView
                        : resolveAiBalanceView(aiBalances[selectedProvider.key] || null, Boolean(aiBalanceLoadingIds[selectedProvider.key])))
                      : null;
                    const requiresApi2dKeyApplication = selectedProvider.key === 'official-gpt' && balanceView?.status === 'unassigned';
                    const checkingApi2dKey = selectedProvider.key === 'official-gpt' && (balanceView?.status === 'idle' || balanceView?.status === 'loading');
                    const modelOptions: ModelDropdownOption[] = speechModelOptions.length ? speechModelOptions : [
                      ...popularModels.map((value) => ({
                        value,
                        group: usesOfficialProxy ? getOfficialModelGroupLabel(value, i18n.language.startsWith('zh')) : groupedModelLabels.popular,
                      })),
                      ...remoteModels,
                    ];
                    return (
                      <>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                    <TextField
                      label={i18n.language.startsWith('zh') ? '模型名称' : 'Profile name'}
                      value={profile.name}
                      onChange={(e) => updateAIProfile(profile.id, { name: e.target.value })}
                      size="small"
                      fullWidth
                      sx={fieldSx()}
                    />
                  </Box>
                  <Divider />

                  <FormControl fullWidth size="small">
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <FormControl fullWidth size="small" sx={fieldSx()}>
                        <InputLabel>{i18n.language.startsWith('zh') ? '类型' : 'Type'}</InputLabel>
                        <Select
                          value={profile.type || 'text'}
                          label={i18n.language.startsWith('zh') ? '类型' : 'Type'}
                          MenuProps={{ slotProps: { paper: { sx: solidPopupPaperSx() } } }}
                          onChange={(e) => {
                            const type = e.target.value as AIModelType;
                            const nextProviderOptions = getProviderOptionsForType(type, profile.provider);
                            const nextProvider = resolveSelectableProviderKey(profile.provider, type, nextProviderOptions);
                            const nextDefaults = getProviderDefaultsFromOptions(nextProvider, type, nextProviderOptions);
                            setFetchedModelKeys((prev) => {
                              const next = { ...prev };
                              delete next[profile.id];
                              return next;
                            });
                            setRemoteModelOptions((prev) => ({ ...prev, [profile.id]: [] }));
                            setFetchModelFailedIds((prev) => {
                              const next = { ...prev };
                              delete next[profile.id];
                              return next;
                            });
                            updateAIProfile(profile.id, {
                              type,
                              provider: nextProvider,
                              baseUrl: nextDefaults.baseUrl,
                              model: nextDefaults.model,
                              imageCapabilities: type === 'image' ? inferImageCapabilities(nextProvider, nextDefaults.model) : undefined,
                              inputCapabilities: type === 'text' ? inferTextInputCapabilities(nextProvider, nextDefaults.model) : undefined,
                              advancedOptions: type === 'text' ? normalizeAIModelAdvancedOptions(nextProvider, nextDefaults.model, profile.advancedOptions) : undefined,
                            });
                          }}
                        >
                          <MenuItem value="text">{modelTypeLabels.text}</MenuItem>
                          <MenuItem value="image">{modelTypeLabels.image}</MenuItem>
                          <MenuItem value="tts">{modelTypeLabels.tts}</MenuItem>
                          <MenuItem value="stt">{modelTypeLabels.stt}</MenuItem>
                          <MenuItem value="document">{modelTypeLabels.document}</MenuItem>
                        </Select>
                      </FormControl>
                      <Tooltip title={i18n.language.startsWith('zh') ? '设为该类型默认的模型' : 'Set as the default model for this type'}>
                        <FormControlLabel
                          sx={{ mr: 0, ml: 0, whiteSpace: 'nowrap' }}
                          control={(
                            <Checkbox
                              checked={Boolean(profile.isDefault)}
                              onChange={(e) => updateAIProfile(profile.id, { isDefault: e.target.checked })}
                            />
                          )}
                          label={i18n.language.startsWith('zh') ? '默认' : 'Default'}
                        />
                      </Tooltip>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => setConfirmAssignProfileId(profile.id)}
                        disabled={assigningId === profile.id}
                        sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        {assigningId === profile.id
                          ? t('common.loading')
                          : (i18n.language.startsWith('zh') ? '应用到角色' : 'Apply to roles')}
                      </Button>
                    </Box>
                  </FormControl>

                  <FormControl fullWidth size="small" sx={fieldSx()}>
                    <InputLabel>{t('settings.provider')}</InputLabel>
                    <Select
                      value={selectedProvider.key}
                      label={t('settings.provider')}
                      MenuProps={{ slotProps: { paper: { sx: solidPopupPaperSx() } } }}
                      onChange={(e) => {
                        const provider = e.target.value as typeof selectedProvider.key;
                        const nextDefaults = getProviderDefaultsFromOptions(provider, activeType, providerOptions);
                        setFetchedModelKeys((prev) => {
                          const next = { ...prev };
                          delete next[profile.id];
                          return next;
                        });
                        setRemoteModelOptions((prev) => ({ ...prev, [profile.id]: [] }));
                        setFetchModelFailedIds((prev) => {
                          const next = { ...prev };
                          delete next[profile.id];
                          return next;
                        });
                        updateAIProfile(profile.id, {
                          provider,
                          baseUrl: nextDefaults.baseUrl,
                          model: nextDefaults.model,
                          imageCapabilities: activeType === 'image' ? inferImageCapabilities(provider, nextDefaults.model) : profile.imageCapabilities,
                          inputCapabilities: activeType === 'text' ? inferTextInputCapabilities(provider, nextDefaults.model) : profile.inputCapabilities,
                          advancedOptions: activeType === 'text' ? normalizeAIModelAdvancedOptions(provider, nextDefaults.model, profile.advancedOptions) : profile.advancedOptions,
                        });
                      }}
                    >
                      {providerGroups.flatMap((group, groupIndex) => [
                        groupIndex > 0 ? <Divider key={`${group.label}-divider`} sx={{ my: 0.5 }} /> : null,
                        <ListSubheader key={`${group.label}-header`} disableSticky>{group.label}</ListSubheader>,
                        ...group.options.map((option) => (
                          <MenuItem key={option.key} value={option.key} disabled={Boolean(option.unavailableReason)}>
                            {option.label}
                          </MenuItem>
                        )),
                      ])}
                    </Select>
                  </FormControl>

                  <TextField
                    label={t('settings.apiKey')}
                    placeholder={usesOfficialProxy
                      ? (i18n.language.startsWith('zh') ? '使用当前登录账号，无需填写密钥' : 'Uses your signed-in account; no key required')
                      : t('settings.apiKeyPlaceholder')}
                    value={usesOfficialProxy ? '' : (showKey ? maskSecret(profile.apiKey) : profile.apiKey)}
                    onChange={(e) => {
                      if (!usesOfficialProxy) updateAIProfile(profile.id, { apiKey: e.target.value });
                    }}
                    type={showKey ? 'text' : 'password'}
                    size="small"
                    fullWidth
                    disabled={usesOfficialProxy}
                    helperText={usesOfficialProxy
                      ? (i18n.language.startsWith('zh') ? '官方服务商会通过后台账号权益获取中转 Key。' : 'Official provider uses your account entitlement through the backend proxy.')
                      : undefined}
                    sx={fieldSx()}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton size="small" onClick={() => setShowKey(!showKey)}>
                              {showKey ? <VisibilityOff /> : <Visibility />}
                            </IconButton>
                          </InputAdornment>
                        ),
                      },
                      htmlInput: {
                        readOnly: showKey,
                        onCopy: blockSecretCopy,
                        onCut: blockSecretCopy,
                        onDragStart: blockSecretDrag,
                        onContextMenu: blockSecretContextMenu,
                        autoComplete: 'off',
                        spellCheck: false,
                        style: {
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                        },
                      },
                    }}
                  />

                  <TextField
                    label={t('settings.baseUrl')}
                    placeholder={usesOfficialProxy ? '/api/ai' : (selectedProvider.key === 'custom' ? 'https://example.com/v1' : providerDefaults.baseUrl)}
                    value={profile.baseUrl}
                    onChange={(e) => {
                      if (usesOfficialProxy) return;
                      setFetchModelFailedIds((prev) => {
                        const next = { ...prev };
                        delete next[profile.id];
                        return next;
                      });
                      updateAIProfile(profile.id, { baseUrl: e.target.value });
                    }}
                    size="small"
                    fullWidth
                    disabled={usesOfficialProxy}
                    helperText={usesOfficialProxy
                      ? (i18n.language.startsWith('zh') ? '请求固定发送到本程序后台中转。' : 'Requests are routed through this app backend.')
                      : undefined}
                    sx={fieldSx()}
                  />

                  {(activeType === 'tts' || activeType === 'stt') && usesManagedSpeech ? (
                    <TextField
                      label={i18n.language.startsWith('zh') ? '语音模型' : 'Speech model'}
                      value={speechModelOptions.find((item) => item.value === profile.model)?.label || profile.model}
                      size="small"
                      fullWidth
                      disabled
                      helperText={i18n.language.startsWith('zh') ? '由后台语音平台配置管理，切换服务商时自动更新。' : 'Managed by the backend speech platform and updated when the provider changes.'}
                      sx={fieldSx()}
                    />
                  ) : (
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                      <ModelAutocomplete
                        profileId={profile.id}
                        model={profile.model}
                        activeType={activeType}
                        options={modelOptions}
                        open={Boolean(openModelDropdownIds[profile.id])}
                        onOpen={() => {
                          setOpenModelDropdownIds((prev) => ({ ...prev, [profile.id]: true }));
                        }}
                        onClose={() => setOpenModelDropdownIds((prev) => {
                          const next = { ...prev };
                          delete next[profile.id];
                          return next;
                        })}
                        onCommitModel={(nextModel) => commitModelValue(profile.id, nextModel)}
                        setInputRef={(node) => {
                          modelInputRefs.current[profile.id] = node;
                        }}
                        modelLabel={t('settings.model')}
                        placeholder={modelOptions[0]?.value || (i18n.language.startsWith('zh') ? '可手动输入模型名' : 'Enter any model name')}
                      />
                      <Button
                        variant="outlined"
                        onClick={() => handleFetchModels(profile.id)}
                        disabled={fetchingModels || selectedProviderUnavailable || (!usesOfficialProxy && !profile.apiKey)}
                        sx={{ minWidth: 64, height: 40, px: 1.5, flexShrink: 0 }}
                      >
                        {fetchingModels
                          ? (i18n.language.startsWith('zh') ? '获取中' : 'Loading')
                          : fetchModelFailedIds[profile.id]
                            ? (i18n.language.startsWith('zh') ? '失败' : 'Failed')
                            : (i18n.language.startsWith('zh') ? '获取' : 'Fetch')}
                      </Button>
                    </Box>
                  )}

                  {activeType === 'text' ? (
                    <>
                    <Box sx={{
                      display: 'grid',
                      gap: 1,
                      p: 1.25,
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
                      bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(248,250,252,0.58)' : 'rgba(255,255,255,0.045)',
                    }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {i18n.language.startsWith('zh') ? '输入能力' : 'Input capabilities'}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="caption" color="text.secondary">
                          {getAttachmentUiCapabilitySummary(profile, i18n.language.startsWith('zh') ? 'zh' : 'en')}
                        </Typography>
                        <Typography variant="caption" color={getInputCapabilityBadge(profile, i18n.language.startsWith('zh') ? 'zh' : 'en') === (i18n.language.startsWith('zh') ? '第三方推断' : '3rd-party inferred') ? 'warning.main' : 'text.secondary'}>
                          {getInputCapabilityBadge(profile, i18n.language.startsWith('zh') ? 'zh' : 'en')}
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        {inputCapabilityLabels.map((item) => {
                          const capabilities = normalizeInputCapabilities(profile.inputCapabilities);
                          const locks = getInputCapabilityLockState(profile);
                          const showInferenceWarning = shouldShowInputCapabilityWarning(profile) && (item.key === 'imageInput' || item.key === 'multiImageInput');
                          const disabled = item.key === 'imageInput'
                            ? locks.imageInput
                            : item.key === 'multiImageInput'
                              ? locks.multiImageInput || !capabilities.imageInput
                              : false;
                          return (
                            <Tooltip key={item.key} title={disabled ? (i18n.language.startsWith('zh') ? '当前模型未识别到该输入能力，不能手动开启。' : 'This model was not identified as supporting this input capability, so it cannot be enabled manually.') : item.tooltip}>
                              <FormControlLabel
                                sx={{ mr: 1, ml: 0, opacity: disabled ? 0.58 : 1 }}
                                control={(
                                  <Checkbox
                                    checked={Boolean(capabilities[item.key])}
                                    disabled={disabled}
                                    onChange={(e) => {
                                      const nextCapabilities = buildTextInputCapabilityPatch(profile.provider, profile.model, capabilities, {
                                        [item.key]: e.target.checked,
                                      });
                                      updateAIProfile(profile.id, { inputCapabilities: nextCapabilities });
                                    }}
                                  />
                                )}
                                label={(
                                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35 }}>
                                    <span>{item.label}</span>
                                    {showInferenceWarning ? (
                                      <Tooltip title={getInputCapabilityWarning(profile, i18n.language.startsWith('zh') ? 'zh' : 'en')}>
                                        <WarningAmberIcon sx={{ fontSize: 15, color: 'warning.main' }} />
                                      </Tooltip>
                                    ) : null}
                                  </Box>
                                )}
                              />
                            </Tooltip>
                          );
                        })}
                      </Box>
                      {(() => {
                        const reasoningMeta = getReasoningModeUiMeta(profile, i18n.language.startsWith('zh') ? 'zh' : 'en');
                        const normalizedAdvancedOptions = normalizeAIModelAdvancedOptions(profile.provider, profile.model, profile.advancedOptions);
                        return (
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Tooltip title={reasoningMeta.tooltip}>
                              <FormControlLabel
                                sx={{ mr: 1, ml: 0, opacity: reasoningMeta.supported ? 1 : 0.58 }}
                                control={(
                                  <Checkbox
                                    checked={reasoningMeta.supported && normalizedAdvancedOptions.reasoningMode !== 'disabled'}
                                    disabled={!reasoningMeta.supported}
                                    onChange={(e) => {
                                      updateAIProfile(profile.id, {
                                        advancedOptions: {
                                          ...normalizedAdvancedOptions,
                                          reasoningMode: e.target.checked ? 'enabled' : 'disabled',
                                        },
                                      });
                                    }}
                                  />
                                )}
                                label={reasoningMeta.label}
                              />
                            </Tooltip>
                            {!reasoningMeta.supported ? (
                              <Typography variant="caption" color="warning.main">
                                {reasoningMeta.badge}
                              </Typography>
                            ) : null}
                          </Box>
                        );
                      })()}
                    </Box>
                    <Box sx={{
                      display: 'grid',
                      gap: 1,
                      mt: 1,
                      p: 1.25,
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
                      bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(248,250,252,0.58)' : 'rgba(255,255,255,0.045)',
                    }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {i18n.language.startsWith('zh') ? '输出能力' : 'Output capabilities'}
                      </Typography>
                      <TextField
                        label={i18n.language.startsWith('zh') ? '最高输出 Token' : 'Maximum output tokens'}
                        type="number"
                        size="small"
                        value={profile.maxOutputTokens ?? 65536}
                        onChange={(event) => updateAIProfile(profile.id, { maxOutputTokens: Math.max(256, Math.min(1_000_000, Math.floor(Number(event.target.value) || 65536))) })}
                        slotProps={{ htmlInput: { min: 256, max: 1_000_000, step: 1 } }}
                        sx={fieldSx()}
                      />
                    </Box>
                    </>
                  ) : null}

                  {activeType === 'image' ? (
                    <Box sx={{
                      display: 'grid',
                      gap: 1,
                      p: 1.25,
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: (theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.08)' : 'rgba(226,232,240,0.10)',
                      bgcolor: (theme) => theme.palette.mode === 'light' ? 'rgba(248,250,252,0.58)' : 'rgba(255,255,255,0.045)',
                    }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {i18n.language.startsWith('zh') ? '图片能力' : 'Image capabilities'}
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Typography variant="body2">
                            {i18n.language.startsWith('zh') ? '默认分辨率' : 'Default resolution'}
                          </Typography>
                          <ToggleButtonGroup
                            exclusive
                            size="small"
                            value={profile.defaultImageSize || '1K'}
                            aria-label={i18n.language.startsWith('zh') ? '默认分辨率' : 'Default resolution'}
                            onChange={(_event, value: ImageGenerationSize | null) => {
                              if (value) updateAIProfile(profile.id, { defaultImageSize: value });
                            }}
                          >
                            {(['1K', '2K', '4K'] as const).map((size) => (
                              <ToggleButton key={size} value={size} sx={{ minWidth: 52 }}>{size}</ToggleButton>
                            ))}
                          </ToggleButtonGroup>
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                          {imageCapabilityLabels.map((item) => {
                            const capabilities = normalizeImageCapabilities(profile.imageCapabilities);
                            return (
                              <Tooltip key={item.key} title={item.tooltip}>
                                <FormControlLabel
                                  sx={{ mr: 1, ml: 0 }}
                                  control={(
                                    <Checkbox
                                      checked={Boolean(capabilities[item.key])}
                                      onChange={(e) => {
                                        const nextCapabilities = normalizeImageCapabilities({
                                          ...capabilities,
                                          [item.key]: e.target.checked,
                                        });
                                        if (item.key === 'referenceImage' && !e.target.checked) {
                                          nextCapabilities.multiReferenceImage = false;
                                        }
                                        if (item.key === 'multiReferenceImage' && e.target.checked) {
                                          nextCapabilities.referenceImage = true;
                                        }
                                        updateAIProfile(profile.id, { imageCapabilities: nextCapabilities });
                                      }}
                                    />
                                  )}
                                  label={item.label}
                                />
                              </Tooltip>
                            );
                          })}
                        </Box>
                    </Box>
                  ) : null}

                  <Divider />
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                    {checkingApi2dKey ? (
                      <Button
                        variant="outlined"
                        startIcon={<VpnKeyIcon />}
                        disabled
                      >
                        {i18n.language.startsWith('zh') ? '检查 Key' : 'Checking key'}
                      </Button>
                    ) : requiresApi2dKeyApplication ? (
                      <Button
                        variant="outlined"
                        startIcon={<VpnKeyIcon />}
                        onClick={() => handleApplyOfficialKey(profile.id, selectedProvider.key)}
                        disabled={applyingKeyId === profile.id}
                      >
                        {applyingKeyId === profile.id ? t('common.loading') : (i18n.language.startsWith('zh') ? '申请 Key' : 'Request key')}
                      </Button>
                    ) : (
                      <Button
                        variant="outlined"
                        startIcon={<CloudSyncIcon />}
                        onClick={() => handleTestConnection(profile.id)}
                        disabled={testingId === profile.id || selectedProviderUnavailable || (!usesOfficialProxy && !profile.apiKey)}
                      >
                        {testingId === profile.id ? t('common.loading') : (i18n.language.startsWith('zh') ? '测试并保存' : 'Test & save')}
                      </Button>
                    )}
                    {index > 0 ? (
                      <Button
                        color="error"
                        variant="outlined"
                        startIcon={<DeleteIcon />}
                        onClick={() => removeAIProfile(profile.id)}
                      >
                        {t('common.delete')}
                      </Button>
                    ) : null}
                    <Box sx={{ flex: 1 }} />
                    {balanceView ? (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => void refreshAiBalance(selectedProvider.key)}
                        disabled={Boolean(aiBalanceLoadingIds[selectedProvider.key])}
                        sx={{ minHeight: 30, px: 1, color: 'text.secondary', flexShrink: 0 }}
                      >
                        {getAiBalanceLabel(balanceView, selectedProvider.key, i18n.language.startsWith('zh'))}
                      </Button>
                    ) : null}
                  </Box>
                      </>
                    );
                  })()}
              </SurfaceCard>
            ))}
          </Box>
      </PageSection>

      <AppSnackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        severity={snackbar.severity}
        message={snackbar.message}
      />

      <ConfirmDialog
        open={Boolean(confirmAssignProfileId)}
        title={i18n.language.startsWith('zh') ? '确认批量配置角色模型' : 'Confirm Bulk Character Model Update'}
        message={i18n.language.startsWith('zh')
          ? '这会将所有可编辑角色对应类型的模型统一改为当前模型。此操作影响范围较大，请确认继续。'
          : 'This will update the matching model type for all editable characters to the selected model. This affects many characters.'}
        onConfirm={async () => {
          if (!confirmAssignProfileId) return;
          const targetId = confirmAssignProfileId;
          setConfirmAssignProfileId(null);
          await handleAssignToAllRoles(targetId);
        }}
        onCancel={() => setConfirmAssignProfileId(null)}
        destructive
      />

      <ExpandableFab
        icon={<AddIcon />}
        label={i18n.language.startsWith('zh') ? '添加模型' : 'Add model'}
        ariaLabel={i18n.language.startsWith('zh') ? '添加模型' : 'Add model'}
        onClick={() => addAIProfile()}
        sx={{
          position: 'fixed',
          right: { xs: 20, sm: 28, md: 36 },
          bottom: { xs: 'calc(env(safe-area-inset-bottom, 0px) + 76px)', sm: 32, md: 36 },
        }}
      />
    </Box>
  );
}

export default function AIModelsPage() {
  return <AIModelsPanel />;
}
