import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import PaidIcon from '@mui/icons-material/Paid';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AdminRequestState, { getAdminErrorMessage } from '../../components/admin/AdminRequestState';
import { AdminMetricGrid, AdminSection, AdminTableFrame, type AdminMetricItem } from '../../components/admin/AdminSurface';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { adminApi } from '../../services/adminApi';
import { readPersistentUiValue, writePersistentUiValue } from '../../utils/persistentUiState';

type PlanForm = {
  id: string;
  code: string;
  name: string;
  description: string;
  vipEnabled: boolean;
  pointsEnabled: boolean;
  priceAmount: string;
  currency: string;
  durationDays: string;
  grantPoints: string;
  storageBytes: string;
  storageDurationDays: string;
  storageEnabled: boolean;
  status: string;
  visibleToUsers: boolean;
  featured: boolean;
  sortOrder: string;
  featureUnlockEnabled: boolean;
  featuresText: string;
  displayGroup: string;
  displayGroupName: string;
  durationLabel: string;
  badgeText: string;
  highlightReason: string;
  originalPriceAmount: string;
  sortOrderInGroup: string;
  vipTierCode: string;
};

type VipTierForm = {
  code: string;
  name: string;
  rank: string;
  enabled: boolean;
  description: string;
  conversionRatio: string;
  benefitsMarkdown: string;
};

type VipEntitlementForm = {
  description: string;
  benefitsMarkdown: string;
  maxCharacters: string;
  maxChats: string;
  maxGroupMembers: string;
  dailyAiGenerationLimit: string;
  batchGenerationLimit: string;
  officialProviderAccessText: string;
  aiBillingDiscount: string;
  dailyPointGrant: string;
  monthlyPointGrant: string;
  cloudSyncEnabled: boolean;
  cloudStorageBytes: string;
  maxFileSizeBytes: string;
  assistantArtifactCloudSync: boolean;
  aiProxyEnabled: boolean;
  agentEnabled: boolean;
  aiSearchEnabled: boolean;
  multimediaGenerationEnabled: boolean;
  marketAccessEnabled: boolean;
  marketUploadEnabled: boolean;
  chatShareEnabled: boolean;
  retentionLimitsText: string;
};

type OfficialProviderOption = {
  value: string;
  label: string;
};

type MembershipConfigForm = {
  title: string;
  subtitle: string;
  description: string;
  benefitsText: string;
  fulfillmentNote: string;
  tiers: VipTierForm[];
  entitlements: Record<string, VipEntitlementForm>;
};

const DEFAULT_BASIC_RETENTION_LIMITS = {
  characterLayeredMemories: { storage: 80, recall: 6 },
  characterRuntimeTimeline: { storage: 80, recall: 6 },
  chatLayeredMemories: { storage: 80, recall: 8 },
  runtimeEventsV2: { storage: 120, recall: 16 },
  runtimeTimeline: { storage: 80, recall: 10 },
  relationshipLedger: { storage: 120, recall: 12 },
  roleMemorySummaries: { storage: 32, recall: 8 },
  growthSnapshots: { storage: 40, recall: 8 },
  runtimeSeedNotes: { storage: 40, recall: 8 },
  runtimeSeedArtifacts: { storage: 40, recall: 8 },
};

function scaleRetentionLimits(factor: number) {
  return Object.fromEntries(Object.entries(DEFAULT_BASIC_RETENTION_LIMITS).map(([key, value]) => [key, {
    storage: Math.max(1, Math.round(value.storage * factor)),
    recall: Math.max(1, Math.round(value.recall * factor)),
  }]));
}

function retentionLimitsText(value: unknown, fallback: Record<string, { storage: number; recall: number }>) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  return JSON.stringify(record, null, 2);
}

function parseRetentionLimitsText(value: string, fallback: Record<string, { storage: number; recall: number }>) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const EMPTY_PLAN_FORM: PlanForm = {
  id: '',
  code: '',
  name: '',
  description: '',
  vipEnabled: false,
  pointsEnabled: true,
  priceAmount: '',
  currency: 'CNY',
  durationDays: '30',
  grantPoints: '',
  storageBytes: '',
  storageDurationDays: '',
  storageEnabled: false,
  status: 'active',
  visibleToUsers: true,
  featured: false,
  sortOrder: '0',
  featureUnlockEnabled: true,
  featuresText: '',
  displayGroup: 'points',
  displayGroupName: '点数包',
  durationLabel: '',
  badgeText: '',
  highlightReason: '',
  originalPriceAmount: '',
  sortOrderInGroup: '0',
  vipTierCode: 'basic',
};
const DEFAULT_VIP_TIERS: VipTierForm[] = [
  {
    code: 'basic',
    name: '基础会员',
    rank: '10',
    enabled: true,
    description: '适合轻量体验和基础创作。',
    conversionRatio: '1',
    benefitsMarkdown: '- 基础角色与群聊权益\n- 标准记忆能力\n- 基础 AI 生成能力',
  },
  {
    code: 'pro',
    name: '高级会员',
    rank: '20',
    enabled: true,
    description: '适合高频聊天、角色创作和长期记忆。',
    conversionRatio: '0.5',
    benefitsMarkdown: '- 包含基础会员权益\n- **更高角色与群聊上限**\n- **长期记忆与高级生成**',
  },
  {
    code: 'premium',
    name: '旗舰会员',
    rank: '30',
    enabled: true,
    description: '适合重度创作和更高性能需求。',
    conversionRatio: '0.5',
    benefitsMarkdown: '- 包含高级会员权益\n- **最高使用上限**\n- **优先体验新功能**',
  },
];
const DEFAULT_VIP_ENTITLEMENTS: Record<string, VipEntitlementForm> = {
  free: {
    description: '基础体验，适合先试用。',
    benefitsMarkdown: '- 基础聊天体验\n- 每日/每月免费点数\n- 100MB 云空间\n- 本地数据可用',
    maxCharacters: '10',
    maxChats: '30',
    maxGroupMembers: '10',
    dailyAiGenerationLimit: '3',
    batchGenerationLimit: '3',
    officialProviderAccessText: 'official-1',
    aiBillingDiscount: '1',
    dailyPointGrant: '30',
    monthlyPointGrant: '100',
    cloudSyncEnabled: true,
    cloudStorageBytes: '100',
    maxFileSizeBytes: '0',
    assistantArtifactCloudSync: false,
    aiProxyEnabled: false,
    agentEnabled: false,
    aiSearchEnabled: false,
    multimediaGenerationEnabled: false,
    marketAccessEnabled: false,
    marketUploadEnabled: false,
    chatShareEnabled: false,
    retentionLimitsText: retentionLimitsText(scaleRetentionLimits(0.5), scaleRetentionLimits(0.5)),
  },
  basic: {
    description: '',
    benefitsMarkdown: '',
    maxCharacters: '50',
    maxChats: '200',
    maxGroupMembers: '15',
    dailyAiGenerationLimit: '20',
    batchGenerationLimit: '10',
    officialProviderAccessText: 'official-1\nofficial-2',
    aiBillingDiscount: '0.95',
    dailyPointGrant: '30',
    monthlyPointGrant: '300',
    cloudSyncEnabled: true,
    cloudStorageBytes: '500',
    maxFileSizeBytes: '10',
    assistantArtifactCloudSync: false,
    aiProxyEnabled: false,
    agentEnabled: true,
    aiSearchEnabled: false,
    multimediaGenerationEnabled: false,
    marketAccessEnabled: false,
    marketUploadEnabled: false,
    chatShareEnabled: false,
    retentionLimitsText: retentionLimitsText(DEFAULT_BASIC_RETENTION_LIMITS, DEFAULT_BASIC_RETENTION_LIMITS),
  },
  pro: {
    description: '',
    benefitsMarkdown: '',
    maxCharacters: '500',
    maxChats: '2000',
    maxGroupMembers: '20',
    dailyAiGenerationLimit: '100',
    batchGenerationLimit: '30',
    officialProviderAccessText: 'official-1\nofficial-2\nofficial-team',
    aiBillingDiscount: '0.9',
    dailyPointGrant: '30',
    monthlyPointGrant: '500',
    cloudSyncEnabled: true,
    cloudStorageBytes: '5120',
    maxFileSizeBytes: '50',
    assistantArtifactCloudSync: true,
    aiProxyEnabled: true,
    agentEnabled: true,
    aiSearchEnabled: true,
    multimediaGenerationEnabled: false,
    marketAccessEnabled: false,
    marketUploadEnabled: false,
    chatShareEnabled: false,
    retentionLimitsText: retentionLimitsText(scaleRetentionLimits(1.5), scaleRetentionLimits(1.5)),
  },
  premium: {
    description: '',
    benefitsMarkdown: '',
    maxCharacters: '500',
    maxChats: '2000',
    maxGroupMembers: '30',
    dailyAiGenerationLimit: '100',
    batchGenerationLimit: '30',
    officialProviderAccessText: 'official-1\nofficial-2\nofficial-team\nofficial-4',
    aiBillingDiscount: '0.9',
    dailyPointGrant: '30',
    monthlyPointGrant: '500',
    cloudSyncEnabled: true,
    cloudStorageBytes: '51200',
    maxFileSizeBytes: '200',
    assistantArtifactCloudSync: true,
    aiProxyEnabled: true,
    agentEnabled: true,
    aiSearchEnabled: true,
    multimediaGenerationEnabled: false,
    marketAccessEnabled: false,
    marketUploadEnabled: false,
    chatShareEnabled: false,
    retentionLimitsText: retentionLimitsText({
      characterLayeredMemories: { storage: 200, recall: 15 },
      characterRuntimeTimeline: { storage: 200, recall: 15 },
      chatLayeredMemories: { storage: 200, recall: 18 },
      runtimeEventsV2: { storage: 300, recall: 36 },
      runtimeTimeline: { storage: 200, recall: 22 },
      relationshipLedger: { storage: 300, recall: 28 },
      roleMemorySummaries: { storage: 80, recall: 18 },
      growthSnapshots: { storage: 100, recall: 18 },
      runtimeSeedNotes: { storage: 100, recall: 18 },
      runtimeSeedArtifacts: { storage: 100, recall: 18 },
    }, DEFAULT_BASIC_RETENTION_LIMITS),
  },
};
const EMPTY_MEMBERSHIP_CONFIG_FORM: MembershipConfigForm = {
  title: 'VIP 会员',
  subtitle: '解锁完整体验并获得 AI 点数',
  description: '开通会员解锁产品能力，购买点数用于官方 AI 调用。支付成功后权益和点数会自动到账。',
  benefitsText: '解锁会员功能权益\n会员专属体验\n优先使用新功能',
  fulfillmentNote: '支付完成后自动履约',
  tiers: DEFAULT_VIP_TIERS,
  entitlements: DEFAULT_VIP_ENTITLEMENTS,
};
const BILLING_TAB_STORAGE_KEY = 'admin.billing.tab';
const EMPTY_ORDER_SUMMARY = { total: 0, pending: 0, paid: 0, cancelled: 0, partiallyRefunded: 0, refunded: 0, failed: 0 };
const LEGACY_OFFICIAL_PROVIDER_PUBLIC_IDS: Record<string, string> = {
  deepseek: 'official-1',
  moacode: 'official-2',
  'moacode-team': 'official-team',
  api2d: 'official-4',
};

function isBillingTab(value: unknown): value is number {
  return value === 0 || value === 1 || value === 2;
}

function formatOrderTime(value: unknown) {
  const parsed = Number(value || 0);
  return parsed > 0 ? new Date(parsed).toLocaleString() : '-';
}

function toBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function numberText(value: unknown, fallback = '') {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : fallback;
}

function formatMoney(value: unknown, currency: unknown = 'CNY') {
  const parsed = Number(value || 0);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  return `${amount.toFixed(2)} ${String(currency || 'CNY')}`;
}

function formatPoints(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0P';
  return `${Number.isInteger(parsed) ? parsed : Number(parsed.toFixed(2))}P`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasOwnRecordValue(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
}

function formatPercent(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : '-';
}

function jsonText(value: unknown) {
  if (!value || (typeof value === 'object' && Object.keys(asRecord(value)).length === 0)) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nonEmptyText(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function planBenefitsLabel(planKind: unknown, grantPoints: unknown, metadata?: unknown) {
  const benefits = [];
  if (String(planKind || '') === 'vip') benefits.push('VIP');
  if (Number(grantPoints || 0) > 0) benefits.push('点数');
  if (Number(parsePlanMetadata(metadata).storageBytes || 0) > 0 || String(planKind || '') === 'storage') benefits.push('容量');
  return benefits.length ? benefits.join(' / ') : '-';
}

function statusLabel(value: unknown) {
  const status = String(value || '');
  if (status === 'active') return '启用';
  if (status === 'inactive') return '停用';
  if (status === 'archived') return '归档';
  if (status === 'paid') return '已支付';
  if (status === 'pending') return '待支付';
  if (status === 'cancelled' || status === 'canceled') return '已关闭';
  if (status === 'converted') return '已转换';
  if (status === 'failed') return '失败';
  if (status === 'partially_refunded') return '部分退款';
  if (status === 'refunded') return '已退款';
  if (status === 'processing') return '处理中';
  if (status === 'requested') return '已申请';
  if (status === 'succeeded') return '成功';
  return status || '-';
}

function orderStatusColor(value: unknown): 'default' | 'error' | 'info' | 'success' | 'warning' {
  const status = String(value || '');
  if (status === 'paid') return 'success';
  if (status === 'succeeded') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'processing' || status === 'requested') return 'warning';
  if (status === 'cancelled' || status === 'canceled' || status === 'failed') return 'error';
  if (status === 'partially_refunded' || status === 'refunded') return 'info';
  return 'default';
}

function OrderStatusChip({ status }: { status: unknown }) {
  return (
    <Chip
      size="small"
      label={statusLabel(status)}
      color={orderStatusColor(status)}
      variant={String(status || '') === 'pending' ? 'filled' : 'outlined'}
      sx={{ fontWeight: 800 }}
    />
  );
}

function canDeleteOrder(order: Record<string, unknown> | null) {
  if (!order) return false;
  const status = String(order.status || '');
  return status !== 'paid' && status !== 'partially_refunded' && status !== 'refunded';
}

function canCancelOrder(order: Record<string, unknown> | null) {
  if (!order) return false;
  const status = String(order.status || '');
  return status !== 'paid' && status !== 'partially_refunded' && status !== 'refunded' && status !== 'cancelled' && status !== 'canceled';
}

function parsePlanMetadata(value: unknown) {
  if (!value) return {};
  let metadata: Record<string, unknown> = {};
  if (typeof value === 'object' && !Array.isArray(value)) metadata = value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return metadata;
}

function parseMetadataFeatures(value: unknown) {
  const metadata = parsePlanMetadata(value);
  return Array.isArray(metadata.features) ? metadata.features.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function metadataText(metadata: Record<string, unknown>, key: string, fallback = '') {
  const value = metadata[key];
  return value === null || value === undefined ? fallback : String(value);
}

function vipTierLabelFromMetadata(value: unknown, fallback = '-') {
  const metadata = parsePlanMetadata(value);
  return metadataText(metadata, 'vipTierName', metadataText(metadata, 'vipTierCode', fallback));
}

function toPlanForm(item: Record<string, unknown>): PlanForm {
  const planKind = String(item.plan_kind || '') === 'vip' ? 'vip' : 'points';
  const grantPoints = numberText(item.grant_points);
  const metadata = parsePlanMetadata(item.metadata);
  return {
    id: String(item.id || ''),
    code: String(item.code || ''),
    name: String(item.name || ''),
    description: String(item.description || ''),
    vipEnabled: planKind === 'vip',
    pointsEnabled: Number(item.grant_points || 0) > 0,
    priceAmount: numberText(item.price_amount),
    currency: String(item.currency || 'CNY'),
    durationDays: item.duration_days == null ? '30' : numberText(item.duration_days, '30'),
    grantPoints,
    // 云端以字节存储，表单统一使用 MB，避免再次打开时出现单位混淆。
    storageBytes: bytesToMbText(metadata.storageBytes),
    storageDurationDays: numberText(metadata.storageDurationDays),
    storageEnabled: Number(metadata.storageBytes || 0) > 0,
    status: String(item.status || 'active'),
    visibleToUsers: toBoolean(item.visible_to_users, true),
    featured: toBoolean(item.featured, false),
    sortOrder: numberText(item.sort_order, '0'),
    // VIP 套餐始终包含功能解锁；旧套餐即使遗留了 false，也在下次保存时一并修正。
    featureUnlockEnabled: planKind === 'vip',
    featuresText: parseMetadataFeatures(item.metadata).join('\n'),
    displayGroup: metadataText(metadata, 'displayGroup', planKind === 'vip' ? 'vip' : 'points'),
    displayGroupName: metadataText(metadata, 'displayGroupName', planKind === 'vip' ? 'VIP 套餐' : '点数包'),
    durationLabel: metadataText(metadata, 'durationLabel', ''),
    badgeText: metadataText(metadata, 'badgeText', ''),
    highlightReason: metadataText(metadata, 'highlightReason', ''),
    originalPriceAmount: numberText(metadata.originalPriceAmount, ''),
    sortOrderInGroup: numberText(metadata.sortOrderInGroup, '0'),
    vipTierCode: metadataText(metadata, 'vipTierCode', 'basic'),
  };
}

function toNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function limitText(value: unknown, fallback: string) {
  if (value == null) return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.floor(parsed)) : fallback;
}

function toEntitlementForm(value: unknown, fallback: VipEntitlementForm): VipEntitlementForm {
  const record = asRecord(value);
  const providerAccess = Array.isArray(record.officialProviderAccess)
    ? record.officialProviderAccess.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
    : fallback.officialProviderAccessText;
  return {
    description: hasOwnRecordValue(record, 'description') ? String(record.description || '') : fallback.description,
    benefitsMarkdown: hasOwnRecordValue(record, 'benefitsMarkdown') ? String(record.benefitsMarkdown || '') : fallback.benefitsMarkdown,
    maxCharacters: hasOwnRecordValue(record, 'maxCharacters') ? limitText(record.maxCharacters, fallback.maxCharacters) : fallback.maxCharacters,
    maxChats: hasOwnRecordValue(record, 'maxChats') ? limitText(record.maxChats, fallback.maxChats) : fallback.maxChats,
    maxGroupMembers: hasOwnRecordValue(record, 'maxGroupMembers') ? limitText(record.maxGroupMembers, fallback.maxGroupMembers) : fallback.maxGroupMembers,
    dailyAiGenerationLimit: hasOwnRecordValue(record, 'dailyAiGenerationLimit') ? limitText(record.dailyAiGenerationLimit, fallback.dailyAiGenerationLimit) : fallback.dailyAiGenerationLimit,
    batchGenerationLimit: hasOwnRecordValue(record, 'batchGenerationLimit') ? limitText(record.batchGenerationLimit, fallback.batchGenerationLimit) : fallback.batchGenerationLimit,
    officialProviderAccessText: providerAccess,
    aiBillingDiscount: numberText(record.aiBillingDiscount, fallback.aiBillingDiscount),
    dailyPointGrant: hasOwnRecordValue(record, 'dailyPointGrant') ? numberText(record.dailyPointGrant, fallback.dailyPointGrant) : fallback.dailyPointGrant,
    monthlyPointGrant: hasOwnRecordValue(record, 'monthlyPointGrant') ? numberText(record.monthlyPointGrant, fallback.monthlyPointGrant) : fallback.monthlyPointGrant,
    cloudSyncEnabled: hasOwnRecordValue(record, 'cloudSyncEnabled') ? toBoolean(record.cloudSyncEnabled, fallback.cloudSyncEnabled) : fallback.cloudSyncEnabled,
    cloudStorageBytes: hasOwnRecordValue(record, 'cloudStorageBytes') ? bytesToMbText(record.cloudStorageBytes, fallback.cloudStorageBytes) : fallback.cloudStorageBytes,
    maxFileSizeBytes: hasOwnRecordValue(record, 'maxFileSizeBytes') ? bytesToMbText(record.maxFileSizeBytes, fallback.maxFileSizeBytes) : fallback.maxFileSizeBytes,
    assistantArtifactCloudSync: hasOwnRecordValue(record, 'assistantArtifactCloudSync') ? toBoolean(record.assistantArtifactCloudSync, fallback.assistantArtifactCloudSync) : fallback.assistantArtifactCloudSync,
    aiProxyEnabled: hasOwnRecordValue(record, 'aiProxyEnabled') ? toBoolean(record.aiProxyEnabled, fallback.aiProxyEnabled) : fallback.aiProxyEnabled,
    agentEnabled: hasOwnRecordValue(record, 'agentEnabled') ? toBoolean(record.agentEnabled, fallback.agentEnabled) : fallback.agentEnabled,
    aiSearchEnabled: hasOwnRecordValue(record, 'aiSearchEnabled') ? toBoolean(record.aiSearchEnabled, fallback.aiSearchEnabled) : fallback.aiSearchEnabled,
    multimediaGenerationEnabled: hasOwnRecordValue(record, 'multimediaGenerationEnabled') ? toBoolean(record.multimediaGenerationEnabled, fallback.multimediaGenerationEnabled) : fallback.multimediaGenerationEnabled,
    marketAccessEnabled: hasOwnRecordValue(record, 'marketAccessEnabled') ? toBoolean(record.marketAccessEnabled, fallback.marketAccessEnabled) : fallback.marketAccessEnabled,
    marketUploadEnabled: hasOwnRecordValue(record, 'marketUploadEnabled') ? toBoolean(record.marketUploadEnabled, fallback.marketUploadEnabled) : fallback.marketUploadEnabled,
    chatShareEnabled: hasOwnRecordValue(record, 'chatShareEnabled') ? toBoolean(record.chatShareEnabled, fallback.chatShareEnabled) : fallback.chatShareEnabled,
    retentionLimitsText: hasOwnRecordValue(record, 'retentionLimits')
      ? retentionLimitsText(record.retentionLimits, parseRetentionLimitsText(fallback.retentionLimitsText, DEFAULT_BASIC_RETENTION_LIMITS) as Record<string, { storage: number; recall: number }>)
      : fallback.retentionLimitsText,
  };
}

function parseLimitValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed < 0 ? -1 : Math.floor(parsed);
}

function bytesToMbText(value: unknown, fallback = '') {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? String(Math.round(bytes / (1024 * 1024))) : fallback;
}

function mbToBytes(value: string) {
  const mb = Number(value);
  if (!Number.isFinite(mb)) return 0;
  return mb < 0 ? -1 : Math.round(mb * 1024 * 1024);
}

function filterAllowedProviderAccess(values: string[], allowedProviderIds?: Set<string>) {
  if (!allowedProviderIds?.size) return values;
  return values.filter((value) => allowedProviderIds.has(value));
}

function buildEntitlementPayload(form: VipEntitlementForm, allowedProviderIds?: Set<string>) {
  return {
    description: form.description.trim(),
    benefitsMarkdown: form.benefitsMarkdown,
    maxCharacters: parseLimitValue(form.maxCharacters),
    maxChats: parseLimitValue(form.maxChats),
    maxGroupMembers: parseLimitValue(form.maxGroupMembers),
    dailyAiGenerationLimit: parseLimitValue(form.dailyAiGenerationLimit),
    batchGenerationLimit: parseLimitValue(form.batchGenerationLimit),
    officialProviderAccess: filterAllowedProviderAccess(parseProviderAccessText(form.officialProviderAccessText), allowedProviderIds),
    aiBillingDiscount: Math.max(0, Math.min(1, toNumber(form.aiBillingDiscount, 1))),
    dailyPointGrant: Math.max(0, toNumber(form.dailyPointGrant, 0)),
    monthlyPointGrant: Math.max(0, toNumber(form.monthlyPointGrant, 0)),
    cloudSyncEnabled: form.cloudSyncEnabled,
    cloudStorageBytes: mbToBytes(form.cloudStorageBytes),
    maxFileSizeBytes: mbToBytes(form.maxFileSizeBytes),
    assistantArtifactCloudSync: form.assistantArtifactCloudSync,
    aiProxyEnabled: form.aiProxyEnabled,
    agentEnabled: form.agentEnabled,
    aiSearchEnabled: form.aiSearchEnabled,
    multimediaGenerationEnabled: form.multimediaGenerationEnabled,
    marketAccessEnabled: form.marketAccessEnabled,
    marketUploadEnabled: form.marketUploadEnabled,
    chatShareEnabled: form.chatShareEnabled,
    retentionLimits: parseRetentionLimitsText(form.retentionLimitsText, DEFAULT_BASIC_RETENTION_LIMITS),
  };
}

function buildPlanPayload(form: PlanForm, tiers: VipTierForm[] = DEFAULT_VIP_TIERS) {
  const isVip = form.vipEnabled;
  const pointsEnabled = form.pointsEnabled;
  const storageEnabled = form.storageEnabled;
  const enabledTiers = tiers.filter((tier) => tier.enabled);
  const selectedTier = tiers.find((tier) => tier.code === form.vipTierCode) || enabledTiers[0] || tiers[0] || DEFAULT_VIP_TIERS[0];
  const benefits = [
    isVip ? 'vip' : '',
    pointsEnabled ? 'points' : '',
    storageEnabled ? 'storage' : '',
  ].filter(Boolean);
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    description: form.description.trim() || null,
    planKind: isVip ? 'vip' : 'points',
    vipEnabled: isVip,
    pointsEnabled,
    benefits,
    priceAmount: Math.max(0, toNumber(form.priceAmount, 0)),
    currency: form.currency.trim() || 'CNY',
    durationDays: isVip ? Math.max(1, Math.floor(toNumber(form.durationDays, 30))) : null,
    grantPoints: pointsEnabled ? Math.max(0, toNumber(form.grantPoints, 0)) : 0,
    storageBytes: storageEnabled ? mbToBytes(form.storageBytes) : 0,
    storageDurationDays: storageEnabled
      ? (isVip ? Math.max(1, Math.floor(toNumber(form.durationDays, 30))) : Math.max(0, toNumber(form.storageDurationDays, 0)))
      : null,
    status: form.status,
    visibleToUsers: form.visibleToUsers,
    featured: false,
    sortOrder: Math.floor(toNumber(form.sortOrder, 0)),
    aiEnabled: isVip,
    featureUnlockEnabled: isVip,
    features: form.featuresText.split('\n').map((item) => item.trim()).filter(Boolean),
    displayGroup: form.displayGroup.trim() || (isVip ? 'vip' : 'points'),
    displayGroupName: isVip ? '会员套餐' : storageEnabled && !pointsEnabled ? '容量包' : '点数包',
    durationLabel: form.durationLabel.trim() || null,
    badgeText: null,
    highlightReason: form.highlightReason.trim() || null,
    originalPriceAmount: form.originalPriceAmount.trim() ? Math.max(0, toNumber(form.originalPriceAmount, 0)) : null,
    sortOrderInGroup: Math.floor(toNumber(form.sortOrder, 0)),
    vipTierCode: isVip ? form.vipTierCode : 'basic',
    vipTierName: isVip ? selectedTier.name : '基础会员',
    vipTierRank: isVip ? Math.floor(toNumber(selectedTier.rank, 10)) : 10,
  };
}

function toMembershipConfigForm(config: Record<string, unknown>): MembershipConfigForm {
  const benefits = Array.isArray(config.benefits) ? config.benefits.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const tiers = Array.isArray(config.tiers)
    ? config.tiers.map((item, index) => {
      const record = asRecord(item);
      const fallback = DEFAULT_VIP_TIERS[index] || DEFAULT_VIP_TIERS[0];
      return {
        code: String(record.code || fallback.code),
        name: String(record.name || fallback.name),
        rank: numberText(record.rank, fallback.rank),
        enabled: toBoolean(record.enabled, fallback.enabled ?? true),
        description: hasOwnRecordValue(record, 'description') ? String(record.description || '') : fallback.description,
        conversionRatio: numberText(record.conversionRatio, fallback.conversionRatio),
        benefitsMarkdown: String(record.benefitsMarkdown || fallback.benefitsMarkdown),
      };
    })
    : DEFAULT_VIP_TIERS;
  return {
    title: String(config.title || EMPTY_MEMBERSHIP_CONFIG_FORM.title),
    subtitle: hasOwnRecordValue(config, 'subtitle') ? String(config.subtitle || '') : EMPTY_MEMBERSHIP_CONFIG_FORM.subtitle,
    description: hasOwnRecordValue(config, 'description') ? String(config.description || '') : EMPTY_MEMBERSHIP_CONFIG_FORM.description,
    benefitsText: hasOwnRecordValue(config, 'benefits') ? benefits.join('\n') : EMPTY_MEMBERSHIP_CONFIG_FORM.benefitsText,
    fulfillmentNote: hasOwnRecordValue(config, 'fulfillmentNote') ? String(config.fulfillmentNote || '') : EMPTY_MEMBERSHIP_CONFIG_FORM.fulfillmentNote,
    tiers: tiers.length ? tiers : DEFAULT_VIP_TIERS,
    entitlements: {
      free: toEntitlementForm(asRecord(config.entitlements).free, DEFAULT_VIP_ENTITLEMENTS.free),
      basic: toEntitlementForm(asRecord(config.entitlements).basic, DEFAULT_VIP_ENTITLEMENTS.basic),
      pro: toEntitlementForm(asRecord(config.entitlements).pro, DEFAULT_VIP_ENTITLEMENTS.pro),
      premium: toEntitlementForm(asRecord(config.entitlements).premium, DEFAULT_VIP_ENTITLEMENTS.premium),
    },
  };
}

function buildMembershipConfigPayload(form: MembershipConfigForm, allowedProviderIds?: Set<string>) {
  return {
    title: form.title.trim(),
    subtitle: form.subtitle.trim(),
    description: form.description.trim(),
    benefits: form.benefitsText.split('\n').map((item) => item.trim()).filter(Boolean),
    fulfillmentNote: form.fulfillmentNote.trim(),
    tiers: form.tiers.map((tier) => ({
      code: tier.code.trim(),
      name: tier.name.trim(),
      rank: Math.floor(toNumber(tier.rank, 10)),
      enabled: tier.enabled,
      description: tier.description.trim(),
      conversionRatio: Math.max(0, toNumber(tier.conversionRatio, 1)),
      benefitsMarkdown: tier.benefitsMarkdown,
    })).filter((tier) => tier.code && tier.name),
    entitlements: Object.fromEntries(Object.entries(form.entitlements).map(([code, entitlement]) => [code, buildEntitlementPayload(entitlement, allowedProviderIds)])),
  };
}

function DetailLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', gap: 1, py: 0.75 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 96 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 700, textAlign: { xs: 'left', sm: 'right' }, wordBreak: 'break-all' }}>{value}</Typography>
    </Stack>
  );
}

const RETENTION_LIMIT_ROWS: Array<{ key: string; label: string; description: string }> = [
  { key: 'characterLayeredMemories', label: '角色长期记忆', description: '角色自身长期记忆条数' },
  { key: 'characterRuntimeTimeline', label: '角色时间线', description: '角色运行时间线条数' },
  { key: 'chatLayeredMemories', label: '会话长期记忆', description: '房间/会话长期记忆条数' },
  { key: 'runtimeEventsV2', label: '运行事件', description: '结构化运行事件条数' },
  { key: 'runtimeTimeline', label: '会话时间线', description: '轻量时间线条数' },
  { key: 'relationshipLedger', label: '关系账本', description: '关系状态与变化账本条数' },
  { key: 'roleMemorySummaries', label: '角色摘要', description: '会话内角色摘要条数' },
  { key: 'growthSnapshots', label: '成长快照', description: '成长/状态快照条数' },
  { key: 'runtimeSeedNotes', label: '种子笔记', description: 'runtimeSeed notes 条数' },
  { key: 'runtimeSeedArtifacts', label: '种子产物', description: 'runtimeSeed artifacts 条数' },
];

function parseRetentionLimitsForForm(form: VipEntitlementForm) {
  return parseRetentionLimitsText(form.retentionLimitsText, DEFAULT_BASIC_RETENTION_LIMITS) as Record<string, { storage?: unknown; recall?: unknown }>;
}

function updateRetentionLimitText(form: VipEntitlementForm, key: string, field: 'storage' | 'recall', value: string) {
  const current = parseRetentionLimitsForForm(form);
  const parsed = Number(value);
  const nextValue = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
  return retentionLimitsText({
    ...current,
    [key]: {
      ...(current[key] || {}),
      [field]: nextValue,
    },
  }, DEFAULT_BASIC_RETENTION_LIMITS);
}

function parseProviderAccessText(value: string) {
  return value
    .split('\n')
    .map((item) => item.trim().toLowerCase())
    .map((item) => LEGACY_OFFICIAL_PROVIDER_PUBLIC_IDS[item] || item)
    .filter(Boolean);
}

function providerAccessText(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim().toLowerCase()).filter(Boolean))).join('\n');
}

function providerOptionsForEntitlement(options: OfficialProviderOption[]) {
  return options;
}

function RetentionLimitsTable({
  entitlement,
  onChange,
}: {
  entitlement: VipEntitlementForm;
  onChange: (value: string) => void;
}) {
  const limits = parseRetentionLimitsForForm(entitlement);
  return (
    <AdminTableFrame minWidth={720}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>项目</TableCell>
            <TableCell>说明</TableCell>
            <TableCell width={130}>存储/同步上限</TableCell>
            <TableCell width={130}>提示词召回</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {RETENTION_LIMIT_ROWS.map((row) => {
            const pair = limits[row.key] || DEFAULT_BASIC_RETENTION_LIMITS[row.key as keyof typeof DEFAULT_BASIC_RETENTION_LIMITS];
            return (
              <TableRow key={row.key}>
                <TableCell sx={{ fontWeight: 800 }}>{row.label}</TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">{row.description}</Typography>
                </TableCell>
                <TableCell>
                  <TextField
                    size="small"
                    type="number"
                    value={String(pair.storage || 1)}
                    onChange={(event) => onChange(updateRetentionLimitText(entitlement, row.key, 'storage', event.target.value))}
                    slotProps={{ htmlInput: { min: 1 } }}
                    fullWidth
                  />
                </TableCell>
                <TableCell>
                  <TextField
                    size="small"
                    type="number"
                    value={String(pair.recall || 1)}
                    onChange={(event) => onChange(updateRetentionLimitText(entitlement, row.key, 'recall', event.target.value))}
                    slotProps={{ htmlInput: { min: 1 } }}
                    fullWidth
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </AdminTableFrame>
  );
}

function EntitlementEditor({
  title,
  tier,
  entitlement,
  officialProviderOptions,
  onTierChange,
  onEntitlementChange,
}: {
  title: string;
  tier?: VipTierForm;
  entitlement: VipEntitlementForm;
  officialProviderOptions: OfficialProviderOption[];
  onTierChange?: <K extends keyof VipTierForm>(key: K, value: VipTierForm[K]) => void;
  onEntitlementChange: <K extends keyof VipEntitlementForm>(key: K, value: VipEntitlementForm[K]) => void;
}) {
  const selectedProviders = parseProviderAccessText(entitlement.officialProviderAccessText);
  const providerOptions = providerOptionsForEntitlement(officialProviderOptions);
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 950 }}>{title}</Typography>
        {tier && onTierChange ? (
          <FormControlLabel
            control={<Switch checked={tier.enabled} onChange={(event) => onTierChange('enabled', event.target.checked)} />}
            label={tier.enabled ? '启用' : '停用'}
          />
        ) : null}
      </Stack>
      {tier && onTierChange ? (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField label="等级ID" value={tier.code} onChange={(event) => onTierChange('code', event.target.value)} fullWidth />
            <TextField label="等级名称" value={tier.name} onChange={(event) => onTierChange('name', event.target.value)} fullWidth />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField label="等级排序" value={tier.rank} onChange={(event) => onTierChange('rank', event.target.value)} fullWidth />
            <TextField label="升级折算比例" value={tier.conversionRatio} onChange={(event) => onTierChange('conversionRatio', event.target.value)} fullWidth />
          </Stack>
          <TextField label="等级说明" value={tier.description} onChange={(event) => onTierChange('description', event.target.value)} fullWidth />
          <TextField label="等级权益 Markdown" value={tier.benefitsMarkdown} onChange={(event) => onTierChange('benefitsMarkdown', event.target.value)} fullWidth multiline minRows={4} />
        </>
      ) : null}
      {!tier ? (
        <>
          <TextField label="免费说明" value={entitlement.description} onChange={(event) => onEntitlementChange('description', event.target.value)} fullWidth />
          <TextField label="免费权益 Markdown" value={entitlement.benefitsMarkdown} onChange={(event) => onEntitlementChange('benefitsMarkdown', event.target.value)} fullWidth multiline minRows={4} />
        </>
      ) : null}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
        <TextField label="角色上限" value={entitlement.maxCharacters} onChange={(event) => onEntitlementChange('maxCharacters', event.target.value)} fullWidth />
        <TextField label="聊天上限" value={entitlement.maxChats} onChange={(event) => onEntitlementChange('maxChats', event.target.value)} fullWidth />
        <TextField label="群成员上限" value={entitlement.maxGroupMembers} onChange={(event) => onEntitlementChange('maxGroupMembers', event.target.value)} fullWidth />
        <TextField label="每日生成次数" value={entitlement.dailyAiGenerationLimit} onChange={(event) => onEntitlementChange('dailyAiGenerationLimit', event.target.value)} fullWidth />
        <TextField label="单次批量生成上限" value={entitlement.batchGenerationLimit} onChange={(event) => onEntitlementChange('batchGenerationLimit', event.target.value)} fullWidth />
        <TextField label="每日领取点数" value={entitlement.dailyPointGrant} onChange={(event) => onEntitlementChange('dailyPointGrant', event.target.value)} fullWidth />
        <TextField label="每月领取点数" value={entitlement.monthlyPointGrant} onChange={(event) => onEntitlementChange('monthlyPointGrant', event.target.value)} fullWidth />
        <TextField label="点数扣费折扣" value={entitlement.aiBillingDiscount} onChange={(event) => onEntitlementChange('aiBillingDiscount', event.target.value)} fullWidth />
        <TextField label="容量（MB）" value={entitlement.cloudStorageBytes} onChange={(event) => onEntitlementChange('cloudStorageBytes', event.target.value)} fullWidth />
        <TextField label="单文件容量上限（MB）" value={entitlement.maxFileSizeBytes} onChange={(event) => onEntitlementChange('maxFileSizeBytes', event.target.value)} fullWidth />
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(180px, 1fr))' }, gap: 0.5 }}>
        <FormControlLabel control={<Switch checked={entitlement.cloudSyncEnabled} onChange={(event) => onEntitlementChange('cloudSyncEnabled', event.target.checked)} />} label="允许云同步" />
        <FormControlLabel control={<Switch checked={entitlement.assistantArtifactCloudSync} disabled={!entitlement.cloudSyncEnabled} onChange={(event) => onEntitlementChange('assistantArtifactCloudSync', event.target.checked)} />} label="允许 AI 产物云同步" />
        <FormControlLabel control={<Switch checked={entitlement.aiProxyEnabled} onChange={(event) => onEntitlementChange('aiProxyEnabled', event.target.checked)} />} label="允许中转站" />
        <FormControlLabel control={<Switch checked={entitlement.agentEnabled} onChange={(event) => onEntitlementChange('agentEnabled', event.target.checked)} />} label="允许 Agent" />
        <FormControlLabel control={<Switch checked={entitlement.aiSearchEnabled} onChange={(event) => onEntitlementChange('aiSearchEnabled', event.target.checked)} />} label="允许 AI 搜索" />
        <FormControlLabel control={<Switch checked={entitlement.multimediaGenerationEnabled} onChange={(event) => onEntitlementChange('multimediaGenerationEnabled', event.target.checked)} />} label="允许多媒体生成" />
        <FormControlLabel control={<Switch checked={entitlement.marketAccessEnabled} onChange={(event) => onEntitlementChange('marketAccessEnabled', event.target.checked)} />} label="允许市场浏览/下载" />
        <FormControlLabel control={<Switch checked={entitlement.marketUploadEnabled} onChange={(event) => onEntitlementChange('marketUploadEnabled', event.target.checked)} />} label="允许上传市场" />
        <FormControlLabel control={<Switch checked={entitlement.chatShareEnabled} onChange={(event) => onEntitlementChange('chatShareEnabled', event.target.checked)} />} label="允许分享聊天" />
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 1 }}>支持的官方 AI 供应商</Typography>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
          {providerOptions.map((option) => {
            const selected = selectedProviders.includes(option.value);
            return (
              <Chip
                key={option.value}
                label={option.label}
                color={selected ? 'primary' : 'default'}
                variant={selected ? 'filled' : 'outlined'}
                onClick={() => onEntitlementChange(
                  'officialProviderAccessText',
                  providerAccessText(selected
                    ? selectedProviders.filter((item) => item !== option.value)
                    : [...selectedProviders, option.value]),
                )}
              />
            );
          })}
        </Stack>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 1 }}>记忆/运行态上限</Typography>
        <RetentionLimitsTable entitlement={entitlement} onChange={(value) => onEntitlementChange('retentionLimitsText', value)} />
      </Box>
    </Stack>
  );
}

function DetailMetric({ label, value, tone }: { label: string; value: ReactNode; tone?: 'primary' | 'success' | 'warning' }) {
  const color = tone === 'success' ? 'success.main' : tone === 'warning' ? 'warning.main' : 'primary.main';
  return (
    <Paper
      variant="outlined"
      sx={{
        flex: '1 1 160px',
        minWidth: 0,
        p: 1.5,
        borderRadius: 2,
        bgcolor: 'background.default',
      }}
    >
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h6" sx={{ mt: 0.25, fontWeight: 900, color, wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Paper>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Box sx={{ px: 1.5, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>{title}</Typography>
      </Box>
      <Stack divider={<Divider flexItem />} sx={{ px: 1.5, py: 0.25 }}>
        {children}
      </Stack>
    </Paper>
  );
}

function OrderTimelineItem({ label, time, active }: { label: string; time: unknown; active?: boolean }) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'flex-start' }}>
      <Box
        sx={{
          width: 10,
          height: 10,
          mt: 0.65,
          borderRadius: '50%',
          bgcolor: active ? 'primary.main' : 'divider',
          flex: '0 0 auto',
        }}
      />
      <Stack spacing={0.25} sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 800 }}>{label}</Typography>
        <Typography variant="caption" color="text.secondary">{formatOrderTime(time)}</Typography>
      </Stack>
    </Stack>
  );
}

function OrderStatusFilterButton({
  active,
  label,
  count,
  color,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  color?: 'default' | 'error' | 'info' | 'success' | 'warning';
  onClick: () => void;
}) {
  const buttonColor = color === 'default' || !color ? 'primary' : color;
  return (
    <Button
      variant={active ? 'contained' : 'outlined'}
      color={buttonColor}
      onClick={onClick}
      sx={{ flex: '0 0 auto' }}
    >
      {label} {count}
    </Button>
  );
}

function JsonDetails({ title, payload }: { title: string; payload: unknown }) {
  const text = jsonText(payload);
  if (!text) return null;
  return (
    <Box
      component="details"
      sx={{
        mt: 1,
        '& summary': { cursor: 'pointer', color: 'text.secondary', fontSize: 13, fontWeight: 800 },
      }}
    >
      <Box component="summary">{title}</Box>
      <Box
        component="pre"
        sx={{
          mt: 0.75,
          p: 1,
          borderRadius: 1,
          bgcolor: 'background.default',
          border: 1,
          borderColor: 'divider',
          overflow: 'auto',
          maxHeight: 240,
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {text}
      </Box>
    </Box>
  );
}

function PaymentAttemptCard({ item }: { item: Record<string, unknown> }) {
  const info = asRecord(item.paymentInfo);
  const fundBills = asArray(info.fundBillList);
  const fields: Array<[string, unknown]> = [
    ['外部交易号', info.tradeNo || item.provider_transaction_id],
    ['商户订单号', info.outTradeNo],
    ['交易状态', info.tradeStatus],
    ['买家账号', info.buyerLogonId],
    ['买家 ID', info.buyerUserId],
    ['订单总额', info.totalAmount],
    ['实收金额', info.receiptAmount],
    ['买家付款', info.buyerPayAmount],
    ['开票金额', info.invoiceAmount],
    ['集分宝金额', info.pointAmount],
    ['支付时间', info.gmtPayment],
  ];
  return (
    <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 2, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip size="small" label={String(item.channel || 'unknown')} color={String(item.channel || '') === 'alipay' ? 'primary' : 'default'} />
          <Chip size="small" label={statusLabel(item.status)} color={orderStatusColor(item.status)} variant="outlined" />
        </Stack>
        <Typography variant="caption" color="text.secondary">{formatOrderTime(item.created_at)}</Typography>
      </Stack>
      <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
        {fields.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => (
          <DetailLine key={label} label={label} value={nonEmptyText(value)} />
        ))}
      </Stack>
      {fundBills.length ? (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>资金渠道</Typography>
          <Table size="small" sx={{ mt: 0.5 }}>
            <TableHead>
              <TableRow>
                <TableCell>渠道</TableCell>
                <TableCell>金额</TableCell>
                <TableCell>实际金额</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {fundBills.map((row, index) => (
                <TableRow key={`${String(row.fund_channel || '')}-${index}`}>
                  <TableCell>{String(row.fund_channel || row.fundChannel || '-')}</TableCell>
                  <TableCell>{String(row.amount || '-')}</TableCell>
                  <TableCell>{String(row.real_amount || row.realAmount || '-')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ) : null}
      <JsonDetails title="完整支付返回" payload={item.responsePayload} />
    </Paper>
  );
}

function RefundRecordCard({
  item,
  syncing,
  onSync,
}: {
  item: Record<string, unknown>;
  syncing?: boolean;
  onSync?: (refundId: string) => void;
}) {
  const info = asRecord(item.refundInfo);
  const refundDetails = asArray(info.refundDetailItemList);
  const canSync = String(item.channel || '') === 'alipay';
  return (
    <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 2, bgcolor: 'background.default' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip size="small" label={String(item.refund_no || '')} />
          <Chip size="small" label={statusLabel(item.status)} color={orderStatusColor(item.status)} variant={String(item.status || '') === 'failed' ? 'filled' : 'outlined'} />
          <Chip size="small" label={String(item.channel || 'manual')} color={String(item.channel || '') === 'alipay' ? 'primary' : 'default'} />
        </Stack>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 900 }}>{formatMoney(item.amount, item.currency)}</Typography>
          {canSync && onSync ? (
            <Button size="small" variant="outlined" disabled={syncing} onClick={() => onSync(String(item.id || ''))}>
              同步退款
            </Button>
          ) : null}
        </Stack>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ mt: 1 }}>
        <DetailMetric label="扣回点数" value={formatPoints(item.point_reversal_amount)} tone="warning" />
        <DetailMetric label="点数退款金额" value={formatMoney(item.point_refund_amount, item.currency)} tone="primary" />
        <DetailMetric label="VIP 退款金额" value={formatMoney(item.vip_refund_amount, item.currency)} tone="success" />
      </Stack>
      <DetailSection title="退款进度">
        <OrderTimelineItem label="申请退款" time={item.requested_at} active />
        <OrderTimelineItem label="处理完成" time={item.processed_at} active={String(item.status || '') === 'succeeded'} />
        <OrderTimelineItem label="处理失败" time={item.failed_at} active={String(item.status || '') === 'failed'} />
      </DetailSection>
      <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
        <DetailLine label="退款原因" value={nonEmptyText(item.reason)} />
        <DetailLine label="外部交易号" value={nonEmptyText(info.tradeNo || item.provider_transaction_id)} />
        <DetailLine label="外部退款号" value={nonEmptyText(info.outRequestNo || item.provider_refund_id)} />
        <DetailLine label="退款流水金额" value={nonEmptyText(info.refundFee)} />
        <DetailLine label="资金变动" value={nonEmptyText(info.fundChange)} />
        <DetailLine label="退款到账时间" value={nonEmptyText(info.gmtRefundPay)} />
      </Stack>
      {refundDetails.length ? (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>退款资金渠道</Typography>
          <Table size="small" sx={{ mt: 0.5 }}>
            <TableHead>
              <TableRow>
                <TableCell>渠道</TableCell>
                <TableCell>金额</TableCell>
                <TableCell>类型</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {refundDetails.map((row, index) => (
                <TableRow key={`${String(row.fund_channel || '')}-${index}`}>
                  <TableCell>{String(row.fund_channel || row.fundChannel || '-')}</TableCell>
                  <TableCell>{String(row.amount || '-')}</TableCell>
                  <TableCell>{String(row.bank_code || row.bankCode || row.fund_type || '-')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ) : null}
      <JsonDetails title="完整退款返回" payload={item.responsePayload} />
    </Paper>
  );
}

function OrderDetailDialog({
  order,
  detail,
  detailLoading,
  detailError,
  markingPaid,
  cancelling,
  deleting,
  refunding,
  syncingPayment,
  syncingRefundId,
  onClose,
  onReload,
  onMarkPaid,
  onRefund,
  onSyncPayment,
  onSyncRefund,
  onRequestCancel,
  onRequestDelete,
}: {
  order: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  detailLoading: boolean;
  detailError: string | null;
  markingPaid: boolean;
  cancelling: boolean;
  deleting: boolean;
  refunding: boolean;
  syncingPayment: boolean;
  syncingRefundId: string | null;
  onClose: () => void;
  onReload: () => void;
  onMarkPaid: (orderId: string) => void;
  onRefund: (payload: Record<string, unknown>) => void;
  onSyncPayment: (orderId: string) => void;
  onSyncRefund: (refundId: string) => void;
  onRequestCancel: (order: Record<string, unknown>) => void;
  onRequestDelete: (order: Record<string, unknown>) => void;
}) {
  const open = Boolean(order);
  const detailOrder = asRecord(detail?.order);
  const displayOrder = Object.keys(detailOrder).length ? detailOrder : order;
  const orderId = String(displayOrder?.id || order?.id || '');
  const status = String(displayOrder?.status || order?.status || '');
  const isPaid = status === 'paid' || status === 'partially_refunded';
  const isPending = status === 'pending';
  const canSyncPayment = String(displayOrder?.payment_channel || order?.payment_channel || '') === 'alipay';
  const cancellable = canCancelOrder(displayOrder || order);
  const deletable = canDeleteOrder(displayOrder || order);
  const busy = markingPaid || cancelling || deleting || refunding || syncingPayment || Boolean(syncingRefundId);
  const detailRecord = asRecord(detail);
  const paymentAttempts = asArray(detailRecord.paymentAttempts);
  const refunds = asArray(detailRecord.refunds);
  const subscriptions = asArray(detailRecord.subscriptions);
  const pointLedgers = asArray(detailRecord.pointLedgers);
  const preview = asRecord(detailRecord.refundPreview);
  const previewPoints = asRecord(preview.points);
  const previewVip = asRecord(preview.vip);
  const maxRefundAmount = Number(preview.maxRefundAmount || 0);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('管理员退款');
  const refundAmountNumber = Number(refundAmount);
  const canRefund = isPaid && maxRefundAmount > 0 && Number.isFinite(refundAmountNumber) && refundAmountNumber > 0 && refundAmountNumber <= maxRefundAmount + 0.005 && !busy;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setRefundAmount(maxRefundAmount > 0 ? maxRefundAmount.toFixed(2) : '');
      setRefundReason('管理员退款');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, orderId, maxRefundAmount]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
            <ReceiptLongIcon color="primary" />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 900 }}>订单详情</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
                {String(displayOrder?.order_no || order?.order_no || '')}
              </Typography>
            </Box>
          </Stack>
          <IconButton onClick={onClose} disabled={busy} aria-label="关闭">
            <CloseIcon />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        {displayOrder ? (
          <Stack spacing={1.5}>
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: 'background.default',
              }}
            >
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 1 }}>
                <Stack spacing={0.35} sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 900, wordBreak: 'break-all' }}>
                    {String(displayOrder.plan_name || '未命名套餐')}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {String(displayOrder.user_nickname || displayOrder.user_phone || '未知用户')}
                  </Typography>
                </Stack>
                <OrderStatusChip status={displayOrder.status} />
              </Stack>
            </Paper>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25}>
              <DetailMetric label="订单金额" value={formatMoney(displayOrder.amount, displayOrder.currency)} tone="primary" />
              <DetailMetric label="已退金额" value={formatMoney(displayOrder.refunded_amount, displayOrder.currency)} tone="warning" />
              <DetailMetric label="套餐权益" value={planBenefitsLabel(displayOrder.order_type || displayOrder.plan_kind, displayOrder.grant_points)} tone="success" />
            </Stack>

            <DetailSection title="基础信息">
              <DetailLine label="订单号" value={String(displayOrder.order_no || '-')} />
              <DetailLine label="订单 ID" value={orderId || '-'} />
              <DetailLine label="用户" value={String(displayOrder.user_nickname || displayOrder.user_phone || '-')} />
              <DetailLine label="套餐编码" value={String(displayOrder.plan_code || '-')} />
              <DetailLine label="支付渠道" value={String(displayOrder.payment_channel || '未选择')} />
            </DetailSection>

            <DetailSection title="订单时间">
              <OrderTimelineItem label="创建订单" time={displayOrder.created_at} active />
              <OrderTimelineItem label="支付完成" time={displayOrder.paid_at} active={isPaid} />
              <OrderTimelineItem label="退款处理" time={displayOrder.refunded_at} active={status === 'partially_refunded' || status === 'refunded'} />
              <OrderTimelineItem label="关闭订单" time={displayOrder.cancelled_at} active={status === 'cancelled' || status === 'canceled'} />
            </DetailSection>

            <AdminRequestState loading={detailLoading} error={detailError} onRetry={onReload} />

            {detail && !detailLoading ? (
              <>
                <DetailSection title="支付信息">
                  {paymentAttempts.length ? (
                    <Stack spacing={1}>
                      {paymentAttempts.map((item) => <PaymentAttemptCard key={String(item.id)} item={item} />)}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>暂无支付尝试记录。</Typography>
                  )}
                </DetailSection>

                {preview && Object.keys(preview).length ? (
                  <DetailSection title="退款测算">
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ py: 1 }}>
                      <DetailMetric label="当前可退" value={formatMoney(preview.maxRefundAmount, displayOrder.currency)} tone="primary" />
                      <DetailMetric label="可扣回点数" value={formatPoints(previewPoints.reversiblePoints)} tone="warning" />
                      <DetailMetric label="当前点数余额" value={formatPoints(previewPoints.currentBalance)} tone="success" />
                    </Stack>
                    <DetailLine label="订单金额" value={formatMoney(preview.orderAmount, displayOrder.currency)} />
                    <DetailLine label="已退金额" value={formatMoney(preview.alreadyRefundedAmount, displayOrder.currency)} />
                    <DetailLine label="点数可退比例" value={formatPercent(previewPoints.refundRatio)} />
                    <DetailLine label="VIP 可退比例" value={formatPercent(previewVip.refundRatio)} />
                    <DetailLine label="VIP 剩余" value={Number(previewVip.remainingMs || 0) > 0 ? `${Math.ceil(Number(previewVip.remainingMs) / 86400000)} 天` : '-'} />
                  </DetailSection>
                ) : null}

                <DetailSection title="退款记录">
                  {refunds.length ? (
                    <Stack spacing={1}>
                      {refunds.map((item) => (
                        <RefundRecordCard
                          key={String(item.id)}
                          item={item}
                          syncing={syncingRefundId === String(item.id || '')}
                          onSync={onSyncRefund}
                        />
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>暂无退款记录。</Typography>
                  )}
                </DetailSection>

                <DetailSection title="权益与点数流水">
                  {subscriptions.length ? (
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>VIP 状态</TableCell>
                          <TableCell>开始</TableCell>
                          <TableCell>结束</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {subscriptions.map((item) => (
                          <TableRow key={String(item.id)}>
                            <TableCell>{statusLabel(item.status)}</TableCell>
                            <TableCell>{formatOrderTime(item.current_period_start || item.started_at)}</TableCell>
                            <TableCell>{formatOrderTime(item.current_period_end)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>暂无 VIP 权益记录。</Typography>
                  )}
                  {pointLedgers.length ? (
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>时间</TableCell>
                          <TableCell>来源</TableCell>
                          <TableCell>变动</TableCell>
                          <TableCell>余额</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {pointLedgers.map((item) => (
                          <TableRow key={String(item.id)}>
                            <TableCell>{formatOrderTime(item.created_at)}</TableCell>
                            <TableCell>{String(item.source_type || '-')}</TableCell>
                            <TableCell>
                              <Typography variant="body2" color={Number(item.amount || 0) < 0 ? 'error.main' : 'success.main'} sx={{ fontWeight: 900 }}>
                                {formatPoints(item.amount)}
                              </Typography>
                            </TableCell>
                            <TableCell>{formatPoints(item.balance_after)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>暂无点数流水。</Typography>
                  )}
                </DetailSection>
              </>
            ) : null}

            {deletable ? null : (
              <Alert severity="info" sx={{ mt: 0.5 }}>
                已支付或退款订单会关联权益、点数和财务记录，不能关闭或删除。
              </Alert>
            )}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between', alignItems: 'center', gap: 1.25, flexWrap: 'wrap' }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', maxWidth: { xs: '100%', md: 'calc(100% - 96px)' } }}>
          {order && isPending ? (
            <Button
              variant="outlined"
              startIcon={<PaidIcon />}
              disabled={busy}
              onClick={() => onMarkPaid(orderId)}
            >
              确认支付
            </Button>
          ) : null}
          {order && canSyncPayment ? (
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              disabled={busy}
              onClick={() => onSyncPayment(orderId)}
            >
              同步支付
            </Button>
          ) : null}
          {order && cancellable ? (
            <Button
              color="warning"
              variant="outlined"
              startIcon={<EventBusyIcon />}
              disabled={busy}
              onClick={() => onRequestCancel(order)}
            >
              关闭订单
            </Button>
          ) : null}
          {order && deletable ? (
            <Button
              color="error"
              variant="contained"
              startIcon={<DeleteIcon />}
              disabled={busy}
              onClick={() => onRequestDelete(order)}
            >
              删除订单
            </Button>
          ) : null}
          {displayOrder && isPaid && maxRefundAmount > 0 ? (
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip size="small" color={String(displayOrder.payment_channel || '') === 'alipay' ? 'primary' : 'default'} label={String(displayOrder.payment_channel || '') === 'alipay' ? '支付宝自动退款' : '人工退款记录'} />
              <TextField
                size="small"
                label="退款金额"
                value={refundAmount}
                error={refundAmount !== '' && !canRefund}
                onChange={(event) => setRefundAmount(event.target.value)}
                sx={{ width: 128 }}
              />
              <TextField
                size="small"
                label="退款原因"
                value={refundReason}
                onChange={(event) => setRefundReason(event.target.value)}
                sx={{ width: { xs: '100%', sm: 180 } }}
              />
              <Button
                variant="contained"
                color="info"
                disabled={!canRefund}
                onClick={() => onRefund({ amount: refundAmountNumber, reason: refundReason.trim() || '管理员退款' })}
              >
                执行退款
              </Button>
            </Stack>
          ) : null}
        </Stack>
        <Button onClick={onClose} disabled={busy} sx={{ ml: 'auto' }}>返回</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AdminBillingPage() {
  const [tab, setTab] = useState(() => readPersistentUiValue<number>(BILLING_TAB_STORAGE_KEY, 0, isBillingTab));
  const [plans, setPlans] = useState<Array<Record<string, unknown>>>([]);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [orderStatusSummary, setOrderStatusSummary] = useState<Record<string, number>>(EMPTY_ORDER_SUMMARY);
  const [selectedOrder, setSelectedOrder] = useState<Record<string, unknown> | null>(null);
  const [selectedOrderDetail, setSelectedOrderDetail] = useState<Record<string, unknown> | null>(null);
  const [planForm, setPlanForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [membershipConfigForm, setMembershipConfigForm] = useState<MembershipConfigForm>(EMPTY_MEMBERSHIP_CONFIG_FORM);
  const [officialProviderOptions, setOfficialProviderOptions] = useState<OfficialProviderOption[]>([]);
  const [membershipEntitlementTab, setMembershipEntitlementTab] = useState(0);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
  const [cancelOrderTarget, setCancelOrderTarget] = useState<Record<string, unknown> | null>(null);
  const [deleteOrderTarget, setDeleteOrderTarget] = useState<Record<string, unknown> | null>(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [savingMembershipConfig, setSavingMembershipConfig] = useState(false);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [refundingOrderId, setRefundingOrderId] = useState<string | null>(null);
  const [syncingPaymentOrderId, setSyncingPaymentOrderId] = useState<string | null>(null);
  const [syncingRefundId, setSyncingRefundId] = useState<string | null>(null);
  const [closingExpiredOrders, setClosingExpiredOrders] = useState(false);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [planDialogError, setPlanDialogError] = useState<string | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);
  const [orderDetailError, setOrderDetailError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const selectedPlanId = planForm.id;

  const orderListAmount = useMemo(() => orders.reduce((total, item) => total + Number(item.amount || 0), 0), [orders]);

  const planSummary = useMemo(() => ({
    vip: plans.filter((item) => String(item.plan_kind || '') === 'vip').length,
    points: plans.filter((item) => Number(item.grant_points || 0) > 0).length,
    active: plans.filter((item) => String(item.status || '') === 'active').length,
  }), [plans]);
  const planMetrics = useMemo<AdminMetricItem[]>(() => [
    { key: 'vip', label: 'VIP 套餐', value: planSummary.vip, tone: 'primary' },
    { key: 'points', label: '含点数套餐', value: planSummary.points, tone: 'success' },
    { key: 'active', label: '启用中', value: planSummary.active, tone: 'warning' },
  ], [planSummary]);
  const orderMetrics = useMemo<AdminMetricItem[]>(() => [
    { key: 'total', label: '全部订单', value: Number(orderStatusSummary.total || 0), tone: 'primary' },
    { key: 'pending', label: '待支付', value: Number(orderStatusSummary.pending || 0), tone: 'warning' },
    { key: 'paid', label: '已支付', value: Number(orderStatusSummary.paid || 0), tone: 'success' },
    { key: 'refunded', label: '退款订单', value: Number(orderStatusSummary.refunded || 0) + Number(orderStatusSummary.partiallyRefunded || 0), tone: 'info' },
    { key: 'cancelled', label: '已关闭', value: Number(orderStatusSummary.cancelled || 0), tone: 'error' },
    { key: 'amount', label: '当前列表金额', value: orderListAmount.toFixed(2), helper: '按当前筛选汇总' },
  ], [orderListAmount, orderStatusSummary]);
  const planHasBenefit = planForm.vipEnabled || planForm.pointsEnabled || planForm.storageEnabled;
  const planPointsValid = !planForm.pointsEnabled || toNumber(planForm.grantPoints, 0) > 0;
  const planStorageValid = !planForm.storageEnabled || toNumber(planForm.storageBytes, 0) > 0;
  const canSavePlan = planHasBenefit && planPointsValid && planStorageValid && Boolean(planForm.code.trim()) && Boolean(planForm.name.trim()) && !savingPlan;
  const hasEnabledMembershipTier = membershipConfigForm.tiers.some((tier) => tier.enabled);
  const canSaveMembershipConfig = Boolean(membershipConfigForm.title.trim()) && hasEnabledMembershipTier && !savingMembershipConfig;
  const selectableVipTiers = membershipConfigForm.tiers.filter((tier) => tier.enabled || tier.code === planForm.vipTierCode);

  const loadOfficialProviderOptions = async () => {
    try {
      const result = await adminApi.getAiProviders();
      const runtimeCodes = new Set(
        (Array.isArray(result.runtime) ? result.runtime : [])
          .map((provider) => String(provider.code || '').trim().toLowerCase())
          .filter(Boolean),
      );
      const options = Array.from(new Map((Array.isArray(result.items) ? result.items : [])
        .map((provider) => {
          const code = String(provider.code || '').trim().toLowerCase();
          const publicId = String(provider.publicId || provider.public_id || '').trim().toLowerCase();
          if (!code || !runtimeCodes.has(code)) return null;
          if (!publicId) return null;
          const name = String(provider.publicName || provider.public_name || provider.name || publicId);
          return {
            value: publicId,
            label: `${name}（${publicId}）`,
          };
        })
        .filter((option): option is OfficialProviderOption => Boolean(option))
        .map((option) => [option.value, option])).values());
      setOfficialProviderOptions(options);
    } catch (loadError) {
      console.error('Failed to load AI provider options', loadError);
      setOfficialProviderOptions([]);
    }
  };
  const allowedOfficialProviderIds = useMemo(
    () => new Set(officialProviderOptions.map((option) => option.value)),
    [officialProviderOptions],
  );

  const loadPlans = async () => {
    setPlansLoading(true);
    setPlansError(null);
    try {
      const [result, config] = await Promise.all([
        adminApi.getBillingPlans(),
        adminApi.getBillingMembershipConfig(),
      ]);
      setPlans(result.items || []);
      setMembershipConfigForm(toMembershipConfigForm(config));
      if (planDialogOpen && selectedPlanId) {
        const next = result.items.find((item) => String(item.id) === selectedPlanId);
        if (next) setPlanForm(toPlanForm(next));
      }
    } catch (loadError) {
      setPlansError(getAdminErrorMessage(loadError));
    } finally {
      setPlansLoading(false);
    }
  };

  const loadOrders = async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const result = await adminApi.getOrders({ status: status || undefined });
      setOrders(result.items || []);
      setOrderStatusSummary({ ...EMPTY_ORDER_SUMMARY, ...(result.summary || {}) });
      if (selectedOrder) {
        const next = result.items.find((item) => String(item.id) === String(selectedOrder.id));
        if (next) setSelectedOrder(next);
      }
    } catch (loadError) {
      setOrdersError(getAdminErrorMessage(loadError));
    } finally {
      setOrdersLoading(false);
    }
  };

  const loadOrderDetail = async (orderId: string) => {
    if (!orderId) return;
    setOrderDetailLoading(true);
    setOrderDetailError(null);
    try {
      const detail = await adminApi.getOrderDetail(orderId);
      setSelectedOrderDetail(detail);
      const detailOrder = asRecord(detail.order);
      if (detailOrder.id) setSelectedOrder(detailOrder);
    } catch (loadError) {
      setOrderDetailError(getAdminErrorMessage(loadError));
    } finally {
      setOrderDetailLoading(false);
    }
  };

  const savePlan = async () => {
    setSavingPlan(true);
    setPlansError(null);
    setPlanDialogError(null);
    try {
      const payload = buildPlanPayload(planForm, membershipConfigForm.tiers);
      if (planForm.id) await adminApi.updateBillingPlan(planForm.id, payload);
      else await adminApi.createBillingPlan(payload);
      setPlanForm(EMPTY_PLAN_FORM);
      setPlanDialogOpen(false);
      await loadPlans();
    } catch (saveError) {
      const message = getAdminErrorMessage(saveError);
      setPlanDialogError(message);
      setPlansError(message);
    } finally {
      setSavingPlan(false);
    }
  };

  const saveMembershipConfig = async () => {
    if (!canSaveMembershipConfig) return;
    setSavingMembershipConfig(true);
    setPlansError(null);
    try {
      const config = await adminApi.updateBillingMembershipConfig(buildMembershipConfigPayload(membershipConfigForm, allowedOfficialProviderIds));
      setMembershipConfigForm(toMembershipConfigForm(config));
    } catch (saveError) {
      setPlansError(getAdminErrorMessage(saveError));
    } finally {
      setSavingMembershipConfig(false);
    }
  };

  const deletePlan = async () => {
    if (deletingPlanId) return;
    const planId = String(deleteTarget?.id || '');
    if (!planId) return;
    setDeletingPlanId(planId);
    setPlansError(null);
    try {
      await adminApi.deleteBillingPlan(planId);
      if (selectedPlanId === planId) {
        setPlanDialogOpen(false);
        setPlanForm(EMPTY_PLAN_FORM);
      }
      setDeleteTarget(null);
      await loadPlans();
    } catch (deleteError) {
      setPlansError(getAdminErrorMessage(deleteError));
    } finally {
      setDeletingPlanId(null);
    }
  };

  const markPaid = async (orderId: string) => {
    setActionLoadingId(orderId);
    setOrdersError(null);
    try {
      await adminApi.markOrderPaid(orderId, { paymentChannel: 'admin_manual' });
      await loadOrders();
      await loadOrderDetail(orderId);
    } catch (actionError) {
      setOrdersError(getAdminErrorMessage(actionError));
    } finally {
      setActionLoadingId(null);
    }
  };

  const syncPayment = async (orderId: string) => {
    if (!orderId || syncingPaymentOrderId) return;
    setSyncingPaymentOrderId(orderId);
    setOrdersError(null);
    setOrderDetailError(null);
    try {
      const result = await adminApi.syncOrderPayment(orderId);
      const detail = asRecord(result.detail);
      if (Object.keys(detail).length) {
        setSelectedOrderDetail(detail);
        const detailOrder = asRecord(detail.order);
        if (detailOrder.id) setSelectedOrder(detailOrder);
      } else {
        await loadOrderDetail(orderId);
      }
      await loadOrders();
    } catch (syncError) {
      setOrderDetailError(getAdminErrorMessage(syncError));
    } finally {
      setSyncingPaymentOrderId(null);
    }
  };

  const syncRefund = async (refundId: string) => {
    const orderId = String(asRecord(selectedOrderDetail?.order).id || selectedOrder?.id || '');
    if (!orderId || !refundId || syncingRefundId) return;
    setSyncingRefundId(refundId);
    setOrdersError(null);
    setOrderDetailError(null);
    try {
      const result = await adminApi.syncOrderRefund(orderId, refundId);
      const detail = asRecord(result.detail);
      if (Object.keys(detail).length) {
        setSelectedOrderDetail(detail);
        const detailOrder = asRecord(detail.order);
        if (detailOrder.id) setSelectedOrder(detailOrder);
      } else {
        await loadOrderDetail(orderId);
      }
      await loadOrders();
    } catch (syncError) {
      setOrderDetailError(getAdminErrorMessage(syncError));
    } finally {
      setSyncingRefundId(null);
    }
  };

  const closeExpiredOrders = async () => {
    if (closingExpiredOrders) return;
    setClosingExpiredOrders(true);
    setOrdersError(null);
    try {
      await adminApi.closeExpiredOrders({ olderThanMinutes: 60, limit: 100 });
      await loadOrders();
      if (selectedOrder) await loadOrderDetail(String(selectedOrder.id || ''));
    } catch (closeError) {
      setOrdersError(getAdminErrorMessage(closeError));
    } finally {
      setClosingExpiredOrders(false);
    }
  };

  const refundOrder = async (payload: Record<string, unknown>) => {
    const orderId = String(asRecord(selectedOrderDetail?.order).id || selectedOrder?.id || '');
    if (!orderId || refundingOrderId) return;
    setRefundingOrderId(orderId);
    setOrdersError(null);
    setOrderDetailError(null);
    try {
      const detail = await adminApi.refundOrder(orderId, payload);
      setSelectedOrderDetail(detail);
      const detailOrder = asRecord(detail.order);
      if (detailOrder.id) setSelectedOrder(detailOrder);
      await loadOrders();
    } catch (refundError) {
      setOrderDetailError(getAdminErrorMessage(refundError));
    } finally {
      setRefundingOrderId(null);
    }
  };

  const cancelOrder = async () => {
    if (cancellingOrderId) return;
    const orderId = String(cancelOrderTarget?.id || '');
    if (!orderId) return;
    setCancellingOrderId(orderId);
    setOrdersError(null);
    try {
      await adminApi.cancelOrder(orderId, { reason: 'admin_cancelled' });
      setCancelOrderTarget(null);
      await loadOrders();
      await loadOrderDetail(orderId);
    } catch (cancelError) {
      setOrdersError(getAdminErrorMessage(cancelError));
    } finally {
      setCancellingOrderId(null);
    }
  };

  const deleteOrder = async () => {
    if (deletingOrderId) return;
    const orderId = String(deleteOrderTarget?.id || '');
    if (!orderId) return;
    setDeletingOrderId(orderId);
    setOrdersError(null);
    try {
      await adminApi.deleteOrder(orderId);
      if (String(selectedOrder?.id || '') === orderId) {
        setSelectedOrder(null);
        setSelectedOrderDetail(null);
      }
      setDeleteOrderTarget(null);
      await loadOrders();
    } catch (deleteError) {
      setOrdersError(getAdminErrorMessage(deleteError));
    } finally {
      setDeletingOrderId(null);
    }
  };

  useEffect(() => {
    void loadOfficialProviderOptions();
  }, []);

  useEffect(() => {
    if (tab === 0 || tab === 2) void loadPlans();
    if (tab === 1) void loadOrders();
  }, [tab]);

  useEffect(() => {
    if (tab === 1) void loadOrders();
  }, [status]);

  const updateForm = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => {
    setPlanForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'vipEnabled' || key === 'pointsEnabled' || key === 'storageEnabled') {
        // 组合套餐归类保持稳定：VIP > 点数 > 容量；容量分组只留给纯容量套餐。
        next.displayGroup = next.vipEnabled ? 'vip' : next.pointsEnabled ? 'points' : next.storageEnabled ? 'storage' : prev.displayGroup;
      }
      return next;
    });
  };

  const updateMembershipConfigForm = <K extends keyof MembershipConfigForm>(key: K, value: MembershipConfigForm[K]) => {
    setMembershipConfigForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateMembershipTierForm = <K extends keyof VipTierForm>(index: number, key: K, value: VipTierForm[K]) => {
    setMembershipConfigForm((prev) => ({
      ...prev,
      tiers: prev.tiers.map((tier, tierIndex) => (tierIndex === index ? { ...tier, [key]: value } : tier)),
    }));
  };

  const updateMembershipEntitlementForm = <K extends keyof VipEntitlementForm>(tierCode: string, key: K, value: VipEntitlementForm[K]) => {
    setMembershipConfigForm((prev) => ({
      ...prev,
      entitlements: {
        ...prev.entitlements,
        [tierCode]: {
          ...(prev.entitlements[tierCode] || DEFAULT_VIP_ENTITLEMENTS[tierCode] || DEFAULT_VIP_ENTITLEMENTS.free),
          [key]: value,
        },
      },
    }));
  };

  const openCreatePlanDialog = () => {
    setTab(0);
    writePersistentUiValue(BILLING_TAB_STORAGE_KEY, 0);
    setPlanDialogError(null);
    setPlanForm({ ...EMPTY_PLAN_FORM });
    setPlanDialogOpen(true);
  };

  const openEditPlanDialog = (item: Record<string, unknown>) => {
    setPlanDialogError(null);
    setPlanForm(toPlanForm(item));
    setPlanDialogOpen(true);
  };

  const changeTab = (_event: unknown, value: number) => {
    setTab(value);
    writePersistentUiValue(BILLING_TAB_STORAGE_KEY, value);
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Tabs value={tab} onChange={changeTab} variant="scrollable" allowScrollButtonsMobile sx={{ minWidth: 0, flex: '1 1 auto' }}>
          <Tab label="套餐" />
          <Tab label="订单" />
          <Tab label="会员权益" />
        </Tabs>
      </Box>

      {tab === 0 ? (
        <Stack spacing={2}>
          <AdminRequestState loading={plansLoading} error={plansError} onRetry={() => void loadPlans()} />
          <AdminSection
            title="套餐概览"
            subtitle="套餐可以单独售卖 VIP、点数，也可以同时包含多种权益。"
          >
            <AdminMetricGrid items={planMetrics} compact minWidth={132} />
          </AdminSection>

          <AdminSection
            title="套餐列表"
            subtitle="点击套餐行可以进入编辑。"
            bodySx={{ p: 0 }}
            action={(
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={openCreatePlanDialog}
                sx={{ flex: '0 0 auto' }}
              >
                新建套餐
              </Button>
            )}
          >
            <AdminTableFrame minWidth={900}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>套餐</TableCell>
                    <TableCell>权益</TableCell>
                    <TableCell>价格</TableCell>
                    <TableCell>包含点数</TableCell>
                    <TableCell>时长</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell align="right">操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plans.map((item) => (
                    <TableRow
                      key={String(item.id)}
                      hover
                      selected={planDialogOpen && selectedPlanId === String(item.id)}
                      onClick={() => openEditPlanDialog(item)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell>
                        <Stack spacing={0.25}>
                          <Typography variant="body2" sx={{ fontWeight: 800 }}>{String(item.name || '')}</Typography>
                          <Typography variant="caption" color="text.secondary">{String(item.code || '')}</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
                          <Chip size="small" label={planBenefitsLabel(item.plan_kind, item.grant_points, item.metadata)} color={String(item.plan_kind || '') === 'vip' ? 'primary' : 'default'} />
                          {String(item.plan_kind || '') === 'vip' ? <Chip size="small" label={vipTierLabelFromMetadata(item.metadata)} variant="outlined" /> : null}
                        </Stack>
                      </TableCell>
                      <TableCell>{formatMoney(item.price_amount, item.currency)}</TableCell>
                      <TableCell>{formatPoints(item.grant_points)}</TableCell>
                      <TableCell>{String(item.plan_kind || '') === 'vip' ? `${String(item.duration_days || 0)} 天` : '-'}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                          <Chip size="small" label={statusLabel(item.status)} color={String(item.status || '') === 'active' ? 'success' : 'default'} />
                          {toBoolean(item.visible_to_users, true) ? null : <Chip size="small" label="隐藏" />}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <Button size="small" onClick={(event) => { event.stopPropagation(); openEditPlanDialog(item); }}>编辑</Button>
                          <Button
                            size="small"
                            color="error"
                            startIcon={<DeleteIcon />}
                            disabled={deletingPlanId === String(item.id)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteTarget(item);
                            }}
                          >
                            删除
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </AdminTableFrame>
          </AdminSection>

          <Dialog
            open={planDialogOpen}
            onClose={() => setPlanDialogOpen(false)}
            maxWidth="lg"
            fullWidth
            slotProps={{ paper: { sx: { borderRadius: { xs: 0, sm: 3 }, overflow: 'hidden' } } }}
          >
            <DialogTitle sx={{ px: { xs: 2, sm: 3 }, pt: 2.5, pb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="overline" sx={{ color: 'primary.main', fontWeight: 800, letterSpacing: '.12em' }}>套餐配置</Typography>
                  <Typography variant="h5" sx={{ fontWeight: 900, letterSpacing: '-.02em' }}>{planForm.id ? '编辑套餐' : '新增套餐'}</Typography>
                </Box>
                {planForm.id ? <Chip size="small" label={planForm.status === 'active' ? '启用中' : '未启用'} color={planForm.status === 'active' ? 'success' : 'default'} sx={{ mt: 1 }} /> : null}
              </Stack>
            </DialogTitle>
            <DialogContent sx={{ bgcolor: 'grey.50', px: { xs: 1.5, sm: 3 }, py: { xs: 2, sm: 2.5 } }}>
              <Stack spacing={2}>
                {planDialogError ? <Alert severity="error">{planDialogError}</Alert> : null}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.12fr) minmax(290px, .88fr)' }, gap: 2, alignItems: 'start' }}>
                  <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, borderRadius: 3, bgcolor: 'background.paper', boxShadow: '0 1px 2px rgba(15, 23, 42, .04)' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>套餐基础信息</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.25 }}>
                    <TextField label="套餐编码" required value={planForm.code} onChange={(event) => updateForm('code', event.target.value)} fullWidth />
                    <TextField label="套餐名称" required value={planForm.name} onChange={(event) => updateForm('name', event.target.value)} fullWidth />
                    <TextField label="价格" required value={planForm.priceAmount} onChange={(event) => updateForm('priceAmount', event.target.value)} fullWidth />
                    <TextField label="划线价" value={planForm.originalPriceAmount} onChange={(event) => updateForm('originalPriceAmount', event.target.value)} fullWidth />
                    <TextField label="币种" value={planForm.currency} onChange={(event) => updateForm('currency', event.target.value)} fullWidth />
                    </Box>
                  </Paper>
                  <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, borderRadius: 3, bgcolor: 'background.paper', boxShadow: '0 1px 2px rgba(15, 23, 42, .04)' }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>展示与状态</Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: '1.15fr .85fr' }, gap: 1.25, mt: 1.5, alignItems: 'center' }}>
                    <TextField select label="状态" value={planForm.status} onChange={(event) => updateForm('status', event.target.value)}><MenuItem value="active">启用</MenuItem><MenuItem value="inactive">停用</MenuItem><MenuItem value="archived">归档</MenuItem></TextField>
                    <TextField label="排序" value={planForm.sortOrder} onChange={(event) => updateForm('sortOrder', event.target.value)} />
                  </Box>
                  <FormControlLabel sx={{ mt: 1 }} control={<Switch checked={planForm.visibleToUsers} onChange={(event) => updateForm('visibleToUsers', event.target.checked)} />} label="全部用户可见" />
                </Paper>
                </Box>
                <Paper variant="outlined" sx={{ px: { xs: 1.5, sm: 2 }, py: 1.25, borderRadius: 3, bgcolor: 'rgba(99, 102, 241, .045)', borderColor: 'rgba(99, 102, 241, .16)' }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <FormControlLabel control={<Switch checked={planForm.vipEnabled} onChange={(event) => updateForm('vipEnabled', event.target.checked)} />} label="VIP" />
                    <FormControlLabel control={<Switch checked={planForm.pointsEnabled} onChange={(event) => updateForm('pointsEnabled', event.target.checked)} />} label="点数" />
                    <FormControlLabel control={<Switch checked={planForm.storageEnabled} onChange={(event) => updateForm('storageEnabled', event.target.checked)} />} label="容量" />
                    </Stack>
                </Paper>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
                  {planForm.vipEnabled ? <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, borderRadius: 3, bgcolor: 'background.paper', borderTop: '3px solid', borderTopColor: 'primary.main' }}><Typography variant="subtitle1" sx={{ fontWeight: 900 }}>VIP 权益</Typography><Box sx={{ display: 'grid', gap: 1.25, mt: 1.5 }}><TextField select label="VIP 等级" value={planForm.vipTierCode} onChange={(event) => updateForm('vipTierCode', event.target.value)} size="small">{selectableVipTiers.map((tier) => <MenuItem key={tier.code} value={tier.code}>{tier.name || tier.code}</MenuItem>)}</TextField><Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}><TextField label="有效天数" value={planForm.durationDays} onChange={(event) => updateForm('durationDays', event.target.value)} size="small" /><TextField label="时长标签" value={planForm.durationLabel} onChange={(event) => updateForm('durationLabel', event.target.value)} size="small" /></Box></Box></Paper> : null}
                  {planForm.pointsEnabled ? <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, borderRadius: 3, bgcolor: 'background.paper', borderTop: '3px solid', borderTopColor: 'success.main' }}><Typography variant="subtitle1" sx={{ fontWeight: 900 }}>点数权益</Typography><TextField sx={{ mt: 1.5 }} label="包含点数（P）" value={planForm.grantPoints} onChange={(event) => updateForm('grantPoints', event.target.value)} size="small" error={!planPointsValid} helperText={!planPointsValid ? '必须大于 0' : undefined} fullWidth /></Paper> : null}
                  {planForm.storageEnabled ? <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2.25 }, borderRadius: 3, bgcolor: 'background.paper', borderTop: '3px solid', borderTopColor: 'info.main' }}><Typography variant="subtitle1" sx={{ fontWeight: 900 }}>容量权益</Typography><Box sx={{ display: 'grid', gap: 1.25, mt: 1.5 }}><TextField label="容量（MB）" value={planForm.storageBytes} onChange={(event) => updateForm('storageBytes', event.target.value)} size="small" />{planForm.vipEnabled ? null : <TextField label="有效期（天）" value={planForm.storageDurationDays} onChange={(event) => updateForm('storageDurationDays', event.target.value)} size="small" />}</Box></Paper> : null}
                </Box>
                {!planHasBenefit ? <Alert severity="warning">至少选择一个套餐权益。</Alert> : null}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPlanDialogOpen(false)} disabled={savingPlan}>取消</Button>
              <Button variant="contained" startIcon={<SaveIcon />} disabled={!canSavePlan} onClick={() => void savePlan()}>
                {planForm.id ? '保存套餐' : '添加套餐'}
              </Button>
            </DialogActions>
          </Dialog>
          <ConfirmDialog
            open={Boolean(deleteTarget)}
            title="删除套餐"
            message={`确认删除套餐“${String(deleteTarget?.name || deleteTarget?.code || '')}”？如果已有订单或订阅引用它，系统会自动归档并隐藏，而不是破坏历史数据。`}
            destructive
            onCancel={() => {
              if (!deletingPlanId) setDeleteTarget(null);
            }}
            onConfirm={() => void deletePlan()}
          />
        </Stack>
      ) : tab === 2 ? (
        <Stack spacing={2}>
          <AdminRequestState loading={plansLoading} error={plansError} onRetry={() => void loadPlans()} />
          <AdminSection
            title="会员权益"
            subtitle="统一维护会员展示文案、等级权益、功能开关、存储/同步上限和提示词召回上限。"
            action={(
              <Button variant="contained" startIcon={<SaveIcon />} disabled={!canSaveMembershipConfig} onClick={() => void saveMembershipConfig()}>
                保存会员权益
              </Button>
            )}
          >
            <Tabs value={membershipEntitlementTab} onChange={(_event, value: number) => setMembershipEntitlementTab(value)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2 }}>
              <Tab label="说明" />
              <Tab label="免费" />
              {membershipConfigForm.tiers.map((tier, index) => (
                <Tab key={tier.code || index} label={`会员${index + 1}`} />
              ))}
            </Tabs>
            {membershipEntitlementTab === 0 ? (
              <Stack spacing={1.25}>
                <TextField label="标题" required value={membershipConfigForm.title} onChange={(event) => updateMembershipConfigForm('title', event.target.value)} fullWidth />
                <TextField label="副标题" value={membershipConfigForm.subtitle} onChange={(event) => updateMembershipConfigForm('subtitle', event.target.value)} fullWidth />
                <TextField label="介绍文案" value={membershipConfigForm.description} onChange={(event) => updateMembershipConfigForm('description', event.target.value)} fullWidth multiline minRows={2} />
                <TextField label="统一 VIP 权益（每行一项）" helperText="可留空；留空后前台不显示统一权益标签。" value={membershipConfigForm.benefitsText} onChange={(event) => updateMembershipConfigForm('benefitsText', event.target.value)} fullWidth multiline minRows={5} />
                <TextField label="履约说明" value={membershipConfigForm.fulfillmentNote} onChange={(event) => updateMembershipConfigForm('fulfillmentNote', event.target.value)} fullWidth />
                {!hasEnabledMembershipTier ? <Alert severity="warning">至少需要启用一个 VIP 等级，否则前台无法展示会员套餐。</Alert> : null}
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                  {membershipConfigForm.benefitsText.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 8).map((item) => (
                    <Chip key={item} size="small" label={item} />
                  ))}
                </Stack>
              </Stack>
            ) : membershipEntitlementTab === 1 ? (
              <EntitlementEditor
                title="免费用户"
                entitlement={membershipConfigForm.entitlements.free || DEFAULT_VIP_ENTITLEMENTS.free}
                officialProviderOptions={officialProviderOptions}
                onEntitlementChange={(key, value) => updateMembershipEntitlementForm('free', key, value)}
              />
            ) : (() => {
              const tierIndex = membershipEntitlementTab - 2;
              const tier = membershipConfigForm.tiers[tierIndex] || DEFAULT_VIP_TIERS[tierIndex] || DEFAULT_VIP_TIERS[0];
              const tierCode = tier.code || DEFAULT_VIP_TIERS[tierIndex]?.code || 'basic';
              const entitlement = membershipConfigForm.entitlements[tierCode] || DEFAULT_VIP_ENTITLEMENTS[tierCode] || DEFAULT_VIP_ENTITLEMENTS.basic;
              return (
                <EntitlementEditor
                  title={tier.name || `会员${tierIndex + 1}`}
                  tier={tier}
                  entitlement={entitlement}
                  officialProviderOptions={officialProviderOptions}
                  onTierChange={(key, value) => updateMembershipTierForm(tierIndex, key, value)}
                  onEntitlementChange={(key, value) => updateMembershipEntitlementForm(tierCode, key, value)}
                />
              );
            })()}
          </AdminSection>
        </Stack>
      ) : (
        <Stack spacing={2}>
          <AdminSection title="订单概览">
            <AdminMetricGrid items={orderMetrics} compact minWidth={128} />
          </AdminSection>
          <AdminSection
            title="订单筛选"
            subtitle="筛选订单状态，或批量关闭超时待支付订单。"
            action={(
              <OrderStatusFilterButton active={status === ''} label="全部" count={Number(orderStatusSummary.total || 0)} onClick={() => setStatus('')} />
            )}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <OrderStatusFilterButton active={status === 'pending'} label="待支付" count={Number(orderStatusSummary.pending || 0)} color="warning" onClick={() => setStatus('pending')} />
              <OrderStatusFilterButton active={status === 'paid'} label="已支付" count={Number(orderStatusSummary.paid || 0)} color="success" onClick={() => setStatus('paid')} />
              <OrderStatusFilterButton active={status === 'partially_refunded'} label="部分退款" count={Number(orderStatusSummary.partiallyRefunded || 0)} color="info" onClick={() => setStatus('partially_refunded')} />
              <OrderStatusFilterButton active={status === 'refunded'} label="已退款" count={Number(orderStatusSummary.refunded || 0)} color="info" onClick={() => setStatus('refunded')} />
              <OrderStatusFilterButton active={status === 'cancelled'} label="已关闭" count={Number(orderStatusSummary.cancelled || 0)} color="error" onClick={() => setStatus('cancelled')} />
              <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => void loadOrders()}>刷新</Button>
              <Button
                color="warning"
                variant="outlined"
                startIcon={<EventBusyIcon />}
                disabled={closingExpiredOrders}
                onClick={() => void closeExpiredOrders()}
              >
                关闭超时待支付
              </Button>
            </Stack>
          </AdminSection>
          <AdminRequestState loading={ordersLoading} error={ordersError} onRetry={() => void loadOrders()} />
          <AdminSection title="订单列表" subtitle="点击订单行可以查看支付、退款和权益详情。" bodySx={{ p: 0 }}>
            <AdminTableFrame minWidth={820}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>订单号</TableCell>
                  <TableCell>用户</TableCell>
                  <TableCell>套餐</TableCell>
                  <TableCell>权益</TableCell>
                  <TableCell>金额</TableCell>
                  <TableCell>状态</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {orders.map((item) => (
                  <TableRow
                    key={String(item.id)}
                    hover
                    selected={String(selectedOrder?.id || '') === String(item.id)}
                    onClick={() => {
                      setSelectedOrder(item);
                      setSelectedOrderDetail(null);
                      void loadOrderDetail(String(item.id || ''));
                    }}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>{String(item.order_no || '')}</TableCell>
                    <TableCell>{String(item.user_nickname || item.user_phone || '')}</TableCell>
                    <TableCell>{String(item.plan_name || '')}</TableCell>
                    <TableCell>{planBenefitsLabel(item.order_type || item.plan_kind, item.grant_points)}</TableCell>
                    <TableCell>{formatMoney(item.amount, item.currency)}</TableCell>
                    <TableCell><OrderStatusChip status={item.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </AdminTableFrame>
          </AdminSection>
          <OrderDetailDialog
            order={selectedOrder}
            detail={selectedOrderDetail}
            detailLoading={orderDetailLoading}
            detailError={orderDetailError}
            markingPaid={actionLoadingId === String(selectedOrder?.id || '')}
            cancelling={cancellingOrderId === String(selectedOrder?.id || '')}
            deleting={deletingOrderId === String(selectedOrder?.id || '')}
            refunding={refundingOrderId === String(selectedOrder?.id || '')}
            syncingPayment={syncingPaymentOrderId === String(selectedOrder?.id || '')}
            syncingRefundId={syncingRefundId}
            onClose={() => {
              if (!actionLoadingId && !cancellingOrderId && !deletingOrderId && !refundingOrderId && !syncingPaymentOrderId && !syncingRefundId) {
                setSelectedOrder(null);
                setSelectedOrderDetail(null);
                setOrderDetailError(null);
              }
            }}
            onReload={() => void loadOrderDetail(String(selectedOrder?.id || ''))}
            onMarkPaid={(orderId) => void markPaid(orderId)}
            onRefund={(payload) => void refundOrder(payload)}
            onSyncPayment={(orderId) => void syncPayment(orderId)}
            onSyncRefund={(refundId) => void syncRefund(refundId)}
            onRequestCancel={setCancelOrderTarget}
            onRequestDelete={setDeleteOrderTarget}
          />
          <ConfirmDialog
            open={Boolean(cancelOrderTarget)}
            title="关闭订单"
            message={`确认关闭订单“${String(cancelOrderTarget?.order_no || '')}”？关闭会保留订单与支付尝试记录，但不会产生权益或点数。`}
            onCancel={() => {
              if (!cancellingOrderId) setCancelOrderTarget(null);
            }}
            onConfirm={() => void cancelOrder()}
          />
          <ConfirmDialog
            open={Boolean(deleteOrderTarget)}
            title="删除订单"
            message={`确认删除订单“${String(deleteOrderTarget?.order_no || '')}”？只能删除未支付且未产生权益记录的订单，删除后不会保留在订单列表中。`}
            destructive
            onCancel={() => {
              if (!deletingOrderId) setDeleteOrderTarget(null);
            }}
            onConfirm={() => void deleteOrder()}
          />
        </Stack>
      )}
    </Stack>
  );
}
