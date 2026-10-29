import { useEffect, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Chip, Dialog, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, Tabs, TextField, Typography } from '@mui/material';
import { Navigate, useParams } from 'react-router-dom';
import AdminAiUserUsageDialog from '../../components/admin/AdminAiUserUsageDialog';
import { toAceImageModelsForm } from '../../components/admin/aceImageModelForm';
import AdminRequestState, { getAdminErrorMessage } from '../../components/admin/AdminRequestState';
import { AdminSection, AdminTableFrame } from '../../components/admin/AdminSurface';
import { adminApi } from '../../services/adminApi';
import { formatAiAmount, formatAiBalanceAmount } from '../../utils/aiPoints';

type DeepSeekPricingForm = {
  pointValueCny: string;
  billingMultiplier: string;
  prompt: string;
  completion: string;
  cacheHit: string;
  cacheMiss: string;
  flashCompletion: string;
  flashCacheHit: string;
  flashCacheMiss: string;
  proCompletion: string;
  proCacheHit: string;
  proCacheMiss: string;
};

const DEFAULT_DEEPSEEK_PRICING_FORM: DeepSeekPricingForm = {
  pointValueCny: '0.01',
  billingMultiplier: '1.5',
  prompt: '1',
  completion: '2',
  cacheHit: '0.02',
  cacheMiss: '1',
  flashCompletion: '2',
  flashCacheHit: '0.02',
  flashCacheMiss: '1',
  proCompletion: '6',
  proCacheHit: '0.025',
  proCacheMiss: '3',
};

const NANOBANANA_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const NANOBANANA_IMAGE_SIZES = ['1K', '2K', '4K'];
const DEFAULT_NANOBANANA_POINT_VALUE = '0.01';
const DEFAULT_NANOBANANA_BILLING_MULTIPLIER = '1.5';
const ACE_MODEL_TABS = [
  { value: 'all', label: '全部' },
  { value: 'chat', label: '文字' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'embedding', label: '向量' },
  { value: 'search', label: '搜索' },
] as const;

function formatAcePrice(row: Record<string, unknown>) {
  const pricing = getRecord(row.pricing);
  if (pricing.kind === 'tokens') return `输入 ${String(pricing.input_credits ?? '-')}${pricing.output_credits == null ? '' : ` / 输出 ${String(pricing.output_credits)}`} 积分/百万 token`;
  if (pricing.min_credits == null && pricing.max_credits == null) return 'ACE 未提供价格';
  const lower = String(pricing.min_credits ?? pricing.max_credits);
  const upper = String(pricing.max_credits ?? pricing.min_credits);
  const units: Record<string, string> = {
    'per generation': '次', 'per second': '秒', 'per image': '张', 'per query': '次查询',
    'per 1M bytes': '百万字节', 'per 1M characters': '百万字符', '1M tokens': '百万 token',
  };
  const unit = String(row.unit || '次');
  return `${lower === upper ? lower : `${lower}–${upper}`} 积分/${units[unit] || unit}${pricing.estimated ? '（估价）' : ''}`;
}

const USER_USAGE_PAGE_SIZE = 100;
const USAGE_STATS_PAGE_SIZE = 100;
const USAGE_STATS_GROUP_STORAGE_KEY_PREFIX = 'pneumata.admin.aiProvider.usageStatsGroupBy';
const USER_STATS_GROUP_STORAGE_KEY_PREFIX = 'pneumata.admin.aiProvider.userStatsGroupBy';
const USAGE_STATS_GROUP_BY_VALUES = ['usage_type', 'model', 'user', 'day'] as const;
const USER_STATS_GROUP_BY_VALUES = ['usage_type', 'model', 'day'] as const;

type UsageStatsGroupBy = typeof USAGE_STATS_GROUP_BY_VALUES[number];
type UserStatsGroupBy = typeof USER_STATS_GROUP_BY_VALUES[number];

const AI_USAGE_TYPE_LABELS: Record<string, string> = {
  assistant_chat: '助手回复',
  direct_chat: '单聊回复',
  group_chat: '群聊回复',
  story_chat: '故事回复',
  group_creation: '生成群聊',
  character_generation: '生成角色',
  character_visual_identity: '角色视觉锚点',
  relationship_analysis: '关系分析',
  memory_distillation: '记忆蒸馏',
  memory_refinement: '记忆润色',
  character_core_profile: '角色核心画像',
  user_profile_memory: '用户画像记忆',
  companionship_assessment: '陪伴评估',
  companionship_care: '陪伴关怀',
  companionship_phase: '陪伴阶段',
  companionship_ritual: '陪伴仪式',
  world_decision: '世界决策',
  message_analysis: '消息分析',
  interaction_analysis: '互动判断',
  social_event_analysis: '社交事件分析',
  chat_draft: '群聊草稿',
  character_artifact: '角色产物',
  moment_generation: '朋友圈生成',
  image_generation: '图片生成',
  web_search: '网页搜索',
  model_test: '测试连接',
  proxy: '中转',
  other: '其他',
  unknown: '未分类',
};

type UserUsagePageInfo = {
  page?: unknown;
  limit?: unknown;
  total?: unknown;
};

type SelectedUserUsage = {
  invocations: Array<Record<string, unknown>>;
  quotaLedger: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  invocationsPage?: UserUsagePageInfo;
  quotaLedgerPage?: UserUsagePageInfo;
};

type UsageStatsResult = {
  groupBy?: string;
  items: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  total?: unknown;
  page?: unknown;
  limit?: unknown;
};

type UsageStatsFilters = {
  groupBy: UsageStatsGroupBy;
  usageType: string;
  model: string;
  search: string;
  status: string;
  from: string;
  to: string;
};

const DEFAULT_USAGE_STATS_FILTERS: UsageStatsFilters = {
  groupBy: 'usage_type',
  usageType: '',
  model: '',
  search: '',
  status: '',
  from: '',
  to: '',
};

const LEDGER_SOURCE_TYPE_LABELS: Record<string, string> = {
  default_grant: '自动分配',
  purchase_order: '订单购买',
  admin_transfer: '后台增减',
  manual_adjustment: '手动调整',
  ai_invocation: 'AI 调用',
  ai_search: 'AI 搜索',
};

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isUsageStatsGroupBy(value: unknown): value is UsageStatsGroupBy {
  return USAGE_STATS_GROUP_BY_VALUES.includes(value as UsageStatsGroupBy);
}

function isUserStatsGroupBy(value: unknown): value is UserStatsGroupBy {
  return USER_STATS_GROUP_BY_VALUES.includes(value as UserStatsGroupBy);
}

function readStoredUsageStatsGroupBy(providerCode: string): UsageStatsGroupBy {
  if (typeof window === 'undefined') return 'usage_type';
  const value = window.localStorage.getItem(`${USAGE_STATS_GROUP_STORAGE_KEY_PREFIX}.${providerCode}`);
  return isUsageStatsGroupBy(value) ? value : 'usage_type';
}

function readStoredUserStatsGroupBy(providerCode: string): UserStatsGroupBy {
  if (typeof window === 'undefined') return 'usage_type';
  const value = window.localStorage.getItem(`${USER_STATS_GROUP_STORAGE_KEY_PREFIX}.${providerCode}`);
  return isUserStatsGroupBy(value) ? value : 'usage_type';
}

function writeStoredUsageStatsGroupBy(providerCode: string, groupBy: UsageStatsGroupBy) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(`${USAGE_STATS_GROUP_STORAGE_KEY_PREFIX}.${providerCode}`, groupBy);
}

function writeStoredUserStatsGroupBy(providerCode: string, groupBy: UserStatsGroupBy) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(`${USER_STATS_GROUP_STORAGE_KEY_PREFIX}.${providerCode}`, groupBy);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return getRecord(parsed);
  } catch {
    return {};
  }
}

function numberText(value: unknown, fallback: string) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function toPositiveNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toDeepSeekPricingForm(value: unknown): DeepSeekPricingForm {
  const pricing = getRecord(value);
  const models = getRecord(pricing.models);
  const defaultModel = getRecord(models.default);
  const flashModel = getRecord(models['deepseek-v4-flash']);
  const proModel = getRecord(models['deepseek-v4-pro']);
  return {
    pointValueCny: numberText(pricing.pointValueCny, DEFAULT_DEEPSEEK_PRICING_FORM.pointValueCny),
    billingMultiplier: numberText(pricing.billingMultiplier, DEFAULT_DEEPSEEK_PRICING_FORM.billingMultiplier),
    prompt: numberText(defaultModel.prompt, DEFAULT_DEEPSEEK_PRICING_FORM.prompt),
    completion: numberText(defaultModel.completion, DEFAULT_DEEPSEEK_PRICING_FORM.completion),
    cacheHit: numberText(defaultModel.cacheHit, DEFAULT_DEEPSEEK_PRICING_FORM.cacheHit),
    cacheMiss: numberText(defaultModel.cacheMiss, DEFAULT_DEEPSEEK_PRICING_FORM.cacheMiss),
    flashCompletion: numberText(flashModel.completion ?? defaultModel.completion, DEFAULT_DEEPSEEK_PRICING_FORM.flashCompletion),
    flashCacheHit: numberText(flashModel.cacheHit ?? defaultModel.cacheHit, DEFAULT_DEEPSEEK_PRICING_FORM.flashCacheHit),
    flashCacheMiss: numberText(flashModel.cacheMiss ?? defaultModel.cacheMiss, DEFAULT_DEEPSEEK_PRICING_FORM.flashCacheMiss),
    proCompletion: numberText(proModel.completion ?? defaultModel.completion, DEFAULT_DEEPSEEK_PRICING_FORM.proCompletion),
    proCacheHit: numberText(proModel.cacheHit ?? defaultModel.cacheHit, DEFAULT_DEEPSEEK_PRICING_FORM.proCacheHit),
    proCacheMiss: numberText(proModel.cacheMiss ?? defaultModel.cacheMiss, DEFAULT_DEEPSEEK_PRICING_FORM.proCacheMiss),
  };
}

function toNanoBananaDefaultsForm(metadataValue: unknown) {
  const metadata = getRecord(metadataValue);
  const defaults = getRecord(metadata.nanobananaDefaults);
  const aspectRatio = typeof defaults.aspectRatio === 'string' && NANOBANANA_ASPECT_RATIOS.includes(defaults.aspectRatio)
    ? defaults.aspectRatio
    : '';
  const imageSize = typeof defaults.imageSize === 'string' && NANOBANANA_IMAGE_SIZES.includes(defaults.imageSize.toUpperCase())
    ? defaults.imageSize.toUpperCase()
    : '1K';
  const accountUserId = typeof defaults.accountUserId === 'string' || typeof defaults.accountUserId === 'number'
    ? String(defaults.accountUserId).trim()
    : '';
  return { aspectRatio, imageSize, accountUserId };
}

function toNanoBananaPricingForm(value: unknown) {
  const pricing = getRecord(value);
  return {
    pointValue: numberText(pricing.pointValueCny, DEFAULT_NANOBANANA_POINT_VALUE),
    billingMultiplier: numberText(pricing.billingMultiplier, DEFAULT_NANOBANANA_BILLING_MULTIPLIER),
  };
}

function buildNanoBananaPricing(form: { pointValue: string; billingMultiplier: string }) {
  return {
    unit: 'point',
    costUnit: 'USD',
    perTokens: 1,
    pointValueCny: toPositiveNumber(form.pointValue, Number(DEFAULT_NANOBANANA_POINT_VALUE)),
    billingMultiplier: toPositiveNumber(form.billingMultiplier, Number(DEFAULT_NANOBANANA_BILLING_MULTIPLIER)),
    models: {
      default: { requestCost: 0.22 },
      'gemini-3-pro-image-preview': { requestCost: 0.22 },
    },
  };
}

function buildInternalLedgerTokenPricing(providerCode: string, form: DeepSeekPricingForm) {
  const isMoacodeProvider = providerCode === 'moacode' || providerCode === 'moacode-team';
  const modelPricing = {
    prompt: toNonNegativeNumber(form.cacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.cacheMiss)),
    completion: toNonNegativeNumber(form.completion, Number(DEFAULT_DEEPSEEK_PRICING_FORM.completion)),
    cacheHit: toNonNegativeNumber(form.cacheHit, Number(DEFAULT_DEEPSEEK_PRICING_FORM.cacheHit)),
    cacheMiss: toNonNegativeNumber(form.cacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.cacheMiss)),
  };
  const flashPricing = {
    prompt: toNonNegativeNumber(form.flashCacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.flashCacheMiss)),
    completion: toNonNegativeNumber(form.flashCompletion, Number(DEFAULT_DEEPSEEK_PRICING_FORM.flashCompletion)),
    cacheHit: toNonNegativeNumber(form.flashCacheHit, Number(DEFAULT_DEEPSEEK_PRICING_FORM.flashCacheHit)),
    cacheMiss: toNonNegativeNumber(form.flashCacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.flashCacheMiss)),
  };
  const proPricing = {
    prompt: toNonNegativeNumber(form.proCacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.proCacheMiss)),
    completion: toNonNegativeNumber(form.proCompletion, Number(DEFAULT_DEEPSEEK_PRICING_FORM.proCompletion)),
    cacheHit: toNonNegativeNumber(form.proCacheHit, Number(DEFAULT_DEEPSEEK_PRICING_FORM.proCacheHit)),
    cacheMiss: toNonNegativeNumber(form.proCacheMiss, Number(DEFAULT_DEEPSEEK_PRICING_FORM.proCacheMiss)),
  };
  return {
    unit: 'point',
    costUnit: isMoacodeProvider ? 'USD' : 'CNY',
    perTokens: 1000000,
    pointValueCny: toPositiveNumber(form.pointValueCny, Number(DEFAULT_DEEPSEEK_PRICING_FORM.pointValueCny)),
    billingMultiplier: toPositiveNumber(form.billingMultiplier, Number(DEFAULT_DEEPSEEK_PRICING_FORM.billingMultiplier)),
    models: {
      default: modelPricing,
      ...(providerCode === 'deepseek' ? {
        'deepseek-v4-flash': flashPricing,
        'deepseek-v4-pro': proPricing,
      } : {}),
    },
  };
}

function formatCurrencyAmount(value: unknown, symbol: string, maximumFractionDigits = 2) {
  if (value == null || value === '') return '-';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  const rounded = Number(parsed.toFixed(maximumFractionDigits));
  const displayValue = Object.is(rounded, -0) ? 0 : rounded;
  return `${symbol}${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(displayValue)}`;
}

function formatDollarAmount(value: unknown, maximumFractionDigits = 2) {
  return formatCurrencyAmount(value, '$', maximumFractionDigits);
}

function toOptionalNumber(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDollarFraction(remaining: unknown, limit: unknown, maximumFractionDigits = 2) {
  const remainingNumber = toOptionalNumber(remaining);
  const limitNumber = toOptionalNumber(limit);
  if (remainingNumber == null && limitNumber == null) return '-';
  return `${formatDollarAmount(remainingNumber, maximumFractionDigits)} / ${formatDollarAmount(limitNumber, maximumFractionDigits)}`;
}

function formatDollarRemainingFromSpent(limit: unknown, spent: unknown, maximumFractionDigits = 2) {
  const limitNumber = toOptionalNumber(limit);
  const spentNumber = toOptionalNumber(spent);
  const remaining = limitNumber == null || spentNumber == null ? null : Math.max(0, limitNumber - spentNumber);
  return formatDollarFraction(remaining, limitNumber, maximumFractionDigits);
}

function formatBalance(balance: Record<string, unknown> | null, providerCode: string) {
  const raw = balance?.availableBalance ?? balance?.available_balance;
  const currencyUnit = String(balance?.currencyUnit ?? balance?.currency_unit ?? '').toLowerCase();
  const normalizedProviderCode = providerCode.trim().toLowerCase();
  if (normalizedProviderCode === 'moacode' || normalizedProviderCode === 'moacode-team' || currencyUnit === 'moacode_balance' || currencyUnit === 'moacode_team_balance' || currencyUnit === 'usd') {
    return typeof raw === 'number' && Number.isFinite(raw) ? `余额 ${formatDollarAmount(raw, 2)}` : '已获取';
  }
  if (currencyUnit === 'moacode_usage' && (balance?.raw || Object.keys(balance || {}).length > 0)) {
    return typeof raw === 'number' && Number.isFinite(raw) ? `成本 ${formatDollarAmount(raw, 2)}` : '已获取';
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '未获取';
  if (normalizedProviderCode === 'deepseek' || currencyUnit === 'cny' || currencyUnit === 'rmb') {
    return formatCurrencyAmount(raw, '￥', 2);
  }
  return formatAiBalanceAmount(balance, providerCode);
}

function formatPoint(value: unknown, providerCode: string) {
  return formatAiAmount(value, providerCode);
}

function formatTime(value: unknown) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString();
}

function toPageTotal(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toZeroBasedPage(value: unknown, fallback: number) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed - 1;
}

function formatUsageType(value: unknown) {
  const key = String(value || 'unknown');
  return AI_USAGE_TYPE_LABELS[key] || key;
}

function formatBillingSource(value: unknown) {
  const key = String(value || '');
  if (key === 'provider_reported') return '上游返回';
  if (key === 'provider_public_pricing') return '公开价格表';
  if (key === 'pricing_table_estimate') return '价格表估算';
  return '-';
}

function parseDateTimeInput(value: string) {
  if (!value.trim()) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatCount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? String(Math.round(parsed)) : '0';
}

function formatPlainNumber(value: unknown, maximumFractionDigits = 0) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return '-';
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(parsed);
}

function formatOptionalPlainNumber(value: unknown, maximumFractionDigits = 2) {
  if (value == null || value === '') return '-';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return formatPlainNumber(parsed, maximumFractionDigits);
}

const compactTextFieldSx = {
  '& .MuiInputBase-root': {
    borderRadius: 1.5,
  },
};

const configGridSx = {
  display: 'grid',
  gridTemplateColumns: {
    xs: '1fr',
    sm: 'repeat(2, minmax(0, 1fr))',
    md: 'minmax(140px, 180px) minmax(110px, 130px) minmax(100px, 120px) minmax(130px, 150px)',
  },
  gap: 1.25,
  alignItems: 'start',
};

const publicConfigGridSx = {
  display: 'grid',
  gridTemplateColumns: {
    xs: '1fr',
    sm: 'repeat(2, minmax(0, 1fr))',
    md: 'minmax(120px, 160px) minmax(150px, 190px) minmax(150px, 190px) minmax(260px, 1fr)',
  },
  gap: 1.25,
  alignItems: 'start',
};

const endpointGridSx = {
  display: 'grid',
  gridTemplateColumns: { xs: '1fr', md: 'minmax(320px, 1fr) minmax(320px, 1fr)' },
  gap: 1.25,
};

const shortConfigGridSx = {
  display: 'grid',
  gridTemplateColumns: {
    xs: 'repeat(2, minmax(0, 1fr))',
    sm: 'repeat(auto-fit, minmax(150px, 190px))',
  },
  gap: 1.25,
  alignItems: 'start',
};

const pricingConfigGridSx = {
  display: 'grid',
  gridTemplateColumns: {
    xs: 'repeat(2, minmax(0, 1fr))',
    sm: 'repeat(auto-fit, minmax(140px, 180px))',
  },
  gap: 1.25,
  alignItems: 'start',
};

type PublicModelGroup = {
  modelName: string;
  displayName: string;
  rows: Array<Record<string, unknown>>;
};

type PublicModelOption = {
  modelName: string;
  displayName: string;
  providerCount: number;
};

function toPublicModelString(value: unknown, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function getPublicModelRowModelName(row: Record<string, unknown>) {
  return toPublicModelString(row.modelName ?? row.model_name);
}

function getPublicModelRowDisplayName(row: Record<string, unknown>) {
  const displayName = toPublicModelString(row.displayName ?? row.display_name, '');
  const modelName = getPublicModelRowModelName(row);
  return displayName && displayName !== modelName ? displayName : '';
}

function getPublicModelRowProviderLabel(row: Record<string, unknown>) {
  return toPublicModelString(row.providerDisplay ?? row.provider_display ?? row.providerName ?? row.provider_name);
}

function getPublicModelRowProviderCode(row: Record<string, unknown>) {
  return toPublicModelString(row.providerName ?? row.provider_name ?? row.providerId ?? row.provider_id, '');
}

function getPublicModelRowBillingSelected(row: Record<string, unknown>) {
  return row.billingSelected === true || row.billing_selected === true;
}

function comparePublicModelProviderRows(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftSelected = getPublicModelRowBillingSelected(left);
  const rightSelected = getPublicModelRowBillingSelected(right);
  if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
  const leftProvider = getPublicModelRowProviderLabel(left);
  const rightProvider = getPublicModelRowProviderLabel(right);
  const providerComparison = leftProvider.localeCompare(rightProvider, 'zh-CN', { numeric: true, sensitivity: 'base' });
  if (providerComparison !== 0) return providerComparison;
  return getPublicModelRowProviderCode(left).localeCompare(getPublicModelRowProviderCode(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function buildPublicModelGroups(rows: Array<Record<string, unknown>>): PublicModelGroup[] {
  const groups = new Map<string, PublicModelGroup>();
  for (const row of rows) {
    const modelName = getPublicModelRowModelName(row);
    const displayName = getPublicModelRowDisplayName(row);
    const group = groups.get(modelName);
    if (group) {
      if (!group.displayName && displayName) group.displayName = displayName;
      group.rows.push(row);
      continue;
    }
    groups.set(modelName, {
      modelName,
      displayName,
      rows: [row],
    });
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    rows: [...group.rows].sort(comparePublicModelProviderRows),
  }));
}

function buildPublicModelOptions(rows: Array<Record<string, unknown>>): PublicModelOption[] {
  return buildPublicModelGroups(rows).map((group) => ({
    modelName: group.modelName,
    displayName: group.displayName,
    providerCount: group.rows.length,
  }));
}

function getFirstDefinedValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function formatOptionalBoolean(value: unknown) {
  if (typeof value !== 'boolean') return '-';
  return value ? '开启' : '关闭';
}

function getMoacodeBalanceSummary(balance: Record<string, unknown> | null) {
  const summary = getRecord(balance?.balanceSummary ?? balance?.balance_summary);
  if (Object.keys(summary).length) return summary;
  const raw = getRecord(balance?.raw);
  return getRecord(raw.balance);
}

function getMoacodeUsageSummary(balance: Record<string, unknown> | null) {
  const summary = getRecord(balance?.usageSummary ?? balance?.usage_summary);
  if (Object.keys(summary).length) return summary;
  const raw = getRecord(balance?.raw);
  const rawUsage = getRecord(raw.usage);
  return Object.keys(rawUsage).length ? rawUsage : raw;
}

function getNanoBananaBalanceSummary(balance: Record<string, unknown> | null) {
  const summary = getRecord(balance?.balanceSummary ?? balance?.balance_summary);
  if (Object.keys(summary).length) return summary;
  const raw = getRecord(balance?.raw);
  return getRecord(raw.data);
}

function getMoacodeUsageModels(summary: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(summary.models)) {
    return summary.models.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  return Object.entries(getRecord(summary.model_stats)).map(([model, value]) => ({
    model,
    ...getRecord(value),
  })).sort((left, right) => Number((right as Record<string, unknown>).cost || 0) - Number((left as Record<string, unknown>).cost || 0)) as Array<Record<string, unknown>>;
}

function toAmountNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLedgerSourceType(value: unknown) {
  const key = String(value || '');
  return LEDGER_SOURCE_TYPE_LABELS[key] || key || '-';
}

function getLedgerAmountSx(value: unknown) {
  const amount = toAmountNumber(value);
  if (amount > 0) return { color: '#1b5e20', fontWeight: 800 };
  if (amount < 0) return { color: 'error.main', fontWeight: 800 };
  return { color: 'text.secondary', fontWeight: 700 };
}

function formatLedgerNonInvocationSource(row: Record<string, unknown>, amount: number) {
  const sourceType = String(row.source_type || '');
  const packageCode = String(row.package_code || '').trim();
  if (sourceType === 'admin_transfer') return amount >= 0 ? '后台增额' : '后台扣除';
  if (sourceType === 'manual_adjustment') return amount >= 0 ? '手动增加' : '手动扣除';
  if (sourceType === 'purchase_order') return packageCode ? `订单购买：${packageCode}` : '订单购买';
  return formatLedgerSourceType(sourceType);
}

function getLedgerSourcePresentation(row: Record<string, unknown>) {
  const amount = toAmountNumber(row.amount);
  const sourceType = String(row.source_type || '');
  const entryType = String(row.entry_type || '');
  const metadata = parseRecord(row.metadata);
  const aiUsage = getRecord(metadata.aiUsage ?? metadata.ai_usage);
  const isInvocationConsume = sourceType === 'ai_invocation' || entryType === 'consume';

  if (isInvocationConsume) {
    const usageType = String(aiUsage.type || row.usage_type || '').trim();
    const usageTypeLabel = usageType ? AI_USAGE_TYPE_LABELS[usageType] || usageType : '';
    const usageLabel = String(aiUsage.label || '').trim();
    const model = String(metadata.model || row.model || '').trim();
    const primary = usageLabel || usageTypeLabel || 'AI 调用';
    const secondary = [
      usageLabel && usageTypeLabel && usageLabel !== usageTypeLabel ? usageTypeLabel : '',
      model ? `模型 ${model}` : '',
    ].filter(Boolean).join(' / ');
    return {
      label: primary,
      secondary,
      sx: { fontWeight: 800 },
    };
  }

  const label = formatLedgerNonInvocationSource(row, amount);
  const sourceTypeLabel = formatLedgerSourceType(sourceType);
  const secondary = sourceTypeLabel !== label ? sourceTypeLabel : '';
  return {
    label,
    secondary,
    sx: amount > 0 ? { color: '#1b5e20', fontWeight: 800 } : { fontWeight: 800 },
  };
}

export default function AdminAIProviderPage() {
  const { providerCode: routeProviderCode } = useParams();
  const providerCode = routeProviderCode || 'api2d';
  const isApi2d = providerCode === 'api2d';
  const isDeepSeek = providerCode === 'deepseek';
  const isMoacodeTeam = providerCode === 'moacode-team';
  const isMoacode = providerCode === 'moacode' || providerCode === 'moacode-team';
  const isNanoBanana = providerCode === 'nanobanana';
  const isAceNanoBanana = providerCode === 'ace-nanobanana';
  const isAce = providerCode === 'acedata';
  const isImageProvider = isNanoBanana || isAceNanoBanana;
  const providerDisplayName = isApi2d ? 'API2D' : isDeepSeek ? 'DeepSeek' : providerCode === 'moacode' ? 'Moacode' : providerCode === 'moacode-team' ? 'Moacode Team' : isNanoBanana ? 'NanoBanana' : isAceNanoBanana ? 'Ace-NanoBanana' : isAce ? 'ACE' : providerCode.toUpperCase();
  const canQueryAccountBalance = isApi2d || isDeepSeek || isMoacode || isNanoBanana;
  const accountBalanceTitle = isMoacode ? '主账号余额与用量' : isNanoBanana ? '主账号余额与请求' : '主账号总余额';
  const [tab, setTab] = useState(0);
  const [providerConfig, setProviderConfig] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({
    name: '',
    publicId: '',
    publicName: '',
    publicFamily: '',
    publicDefaultModel: '',
    publicSortOrder: '100',
    publicHidden: false,
    baseUrl: '',
    adminBaseUrl: '',
    status: 'active',
    adminToken: '',
    forwardKey: '',
    defaultKeyTypeId: '',
    quotaTransferPath: '',
    quotaTransferMethod: 'POST',
    quotaTransferBodyTemplate: '',
    deepseekPricing: DEFAULT_DEEPSEEK_PRICING_FORM,
    nanobananaAspectRatio: '',
    nanobananaImageSize: '1K',
    nanobananaAccountUserId: '',
    acedataModels: toAceImageModelsForm({}),
    moacodeImageModelsEnabled: false,
    nanobananaPricing: {
      pointValue: DEFAULT_NANOBANANA_POINT_VALUE,
      billingMultiplier: DEFAULT_NANOBANANA_BILLING_MULTIPLIER,
    },
  });
  const [loadedSecrets, setLoadedSecrets] = useState({ adminToken: '', forwardKey: '' });
  const [keys, setKeys] = useState<Array<Record<string, unknown>>>([]);
  const [keySearch, setKeySearch] = useState({ typeId: '', keyword: '' });
  const [keyCreate, setKeyCreate] = useState({ typeId: '', note: '', grantAmount: '', dailyQuota: '', monthlyQuota: '' });
  const [keyAction, setKeyAction] = useState({ externalKeyId: '', dailyQuota: '', monthlyQuota: '', minuteTimes: '', note: '', enabled: true });
  const [userBalanceSearch, setUserBalanceSearch] = useState('');
  const [userBalances, setUserBalances] = useState<Array<Record<string, unknown>>>([]);
  const [userBalancePage, setUserBalancePage] = useState(0);
  const [userBalanceRowsPerPage, setUserBalanceRowsPerPage] = useState(20);
  const [userBalanceTotal, setUserBalanceTotal] = useState(0);
  const [selectedBalanceUser, setSelectedBalanceUser] = useState<Record<string, unknown> | null>(null);
  const [selectedUserUsage, setSelectedUserUsage] = useState<SelectedUserUsage | null>(null);
  const [selectedUsageTab, setSelectedUsageTab] = useState(0);
  const [selectedInvocationPage, setSelectedInvocationPage] = useState(0);
  const [selectedLedgerPage, setSelectedLedgerPage] = useState(0);
  const [selectedUserStats, setSelectedUserStats] = useState<UsageStatsResult | null>(null);
  const [selectedUserStatsGroupBy, setSelectedUserStatsGroupBy] = useState<UserStatsGroupBy>(() => readStoredUserStatsGroupBy(providerCode));
  const [selectedUserStatsPage, setSelectedUserStatsPage] = useState(0);
  const [userPointDraft, setUserPointDraft] = useState('');
  const [usageStats, setUsageStats] = useState<UsageStatsResult | null>(null);
  const [usageStatsFilters, setUsageStatsFilters] = useState<UsageStatsFilters>(() => ({
    ...DEFAULT_USAGE_STATS_FILTERS,
    groupBy: readStoredUsageStatsGroupBy(providerCode),
  }));
  const [usageStatsPage, setUsageStatsPage] = useState(0);
  const [usageStatsRowsPerPage, setUsageStatsRowsPerPage] = useState(USAGE_STATS_PAGE_SIZE);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [userBalanceLoading, setUserBalanceLoading] = useState(false);
  const [userUsageLoading, setUserUsageLoading] = useState(false);
  const [selectedUserStatsLoading, setSelectedUserStatsLoading] = useState(false);
  const [usageStatsLoading, setUsageStatsLoading] = useState(false);
  const [accountBalance, setAccountBalance] = useState<Record<string, unknown> | null>(null);
  const [accountBalanceLoading, setAccountBalanceLoading] = useState(false);
  const [accountBalanceError, setAccountBalanceError] = useState<string | null>(null);
  const [publicModelSearch, setPublicModelSearch] = useState('');
  const [publicModels, setPublicModels] = useState<Array<Record<string, unknown>>>([]);
  const [publicModelTotal, setPublicModelTotal] = useState(0);
  const [publicModelLoading, setPublicModelLoading] = useState(false);
  const [publicModelError, setPublicModelError] = useState<string | null>(null);
  const [aceModelCategory, setAceModelCategory] = useState('all');
  const [aceModelSaving, setAceModelSaving] = useState<string | null>(null);
  const [aceConnection, setAceConnection] = useState({ status: 'inactive', apiBaseUrl: '', apiKey: '', apiKeyConfigured: false });
  const [aceConnectionLoading, setAceConnectionLoading] = useState(false);
  const [aceConnectionLoaded, setAceConnectionLoaded] = useState(false);
  const [aceConnectionError, setAceConnectionError] = useState<string | null>(null);
  const [aceConnectionSaved, setAceConnectionSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [usageStatsError, setUsageStatsError] = useState<string | null>(null);
  const usesInternalLedger = isDeepSeek || isMoacode || String(providerConfig?.billingMode || '') === 'internal_ledger';
  const moacodeBalanceSummary = isMoacode ? getMoacodeBalanceSummary(accountBalance) : {};
  const moacodeUsageSummary = isMoacode ? getMoacodeUsageSummary(accountBalance) : {};
  const moacodeUsageModels = isMoacode ? getMoacodeUsageModels(moacodeUsageSummary).slice(0, 8) : [];
  const nanobananaBalanceSummary = isNanoBanana ? getNanoBananaBalanceSummary(accountBalance) : {};
  const publicModelGroups = buildPublicModelGroups(publicModels);
  const publicModelOptions = buildPublicModelOptions(publicModels);
  const visibleAceModels = aceModelCategory === 'all' ? publicModels : publicModels.filter((row) => row.modality === aceModelCategory);
  const selectableAceModels = visibleAceModels.filter((row) => row.callable === true);
  const enabledAceModelCount = selectableAceModels.filter((row) => row.enabled === true).length;
  const hasPublicModelPricing = isMoacode || isNanoBanana || isAce || isAceNanoBanana;
  const publicModelTabIndex = hasPublicModelPricing ? 1 : -1;
  const userManagementTabIndex = hasPublicModelPricing ? 2 : 1;
  const usageStatsTabIndex = hasPublicModelPricing ? 3 : 2;

  const loadPublicModels = async (search = publicModelSearch) => {
    if (!hasPublicModelPricing) return;
    setPublicModelLoading(true);
    setPublicModelError(null);
    try {
      const result = await adminApi.getAiProviderPublicModels(providerCode, {
        search: search.trim(),
        all: true,
      });
      setPublicModels(result.items || []);
      setPublicModelTotal(toPageTotal(result.total));
    } catch (loadError) {
      setPublicModelError(getAdminErrorMessage(loadError));
    } finally {
      setPublicModelLoading(false);
    }
  };

  const toggleAceModel = async (model: string, enabled: boolean) => {
    setAceModelSaving(model);
    setPublicModelError(null);
    try {
      const result = await adminApi.setAceModelEnabled(model, enabled);
      setPublicModels((previous) => previous.map((row) => row.modelName === model ? { ...row, enabled: result.enabled } : row));
    } catch (saveError) {
      setPublicModelError(getAdminErrorMessage(saveError));
    } finally {
      setAceModelSaving(null);
    }
  };

  const toggleVisibleAceModels = async (enabled: boolean) => {
    const models = selectableAceModels.filter((row) => row.enabled !== enabled).map((row) => String(row.modelName));
    if (!models.length) return;
    setAceModelSaving('bulk');
    setPublicModelError(null);
    try {
      const result = await adminApi.setAceModelsEnabled(models, enabled);
      const changed = new Set(result.models);
      setPublicModels((previous) => previous.map((row) => changed.has(String(row.modelName)) ? { ...row, enabled: result.enabled } : row));
    } catch (saveError) {
      setPublicModelError(getAdminErrorMessage(saveError));
    } finally {
      setAceModelSaving(null);
    }
  };

  const loadAceConnection = async () => {
    setAceConnectionLoading(true);
    setAceConnectionLoaded(false);
    setAceConnectionError(null);
    try {
      const result = await adminApi.getAceConnection();
      setAceConnection({ ...result, apiKey: '' });
      setAceConnectionLoaded(true);
    } catch (loadError) {
      setAceConnectionError(getAdminErrorMessage(loadError));
    } finally {
      setAceConnectionLoading(false);
    }
  };

  const loadAccountBalance = async () => {
    setAccountBalanceLoading(true);
    setAccountBalanceError(null);
    try {
      const balance = await adminApi.getAiProviderAccountBalance(providerCode);
      setAccountBalance(balance);
    } catch (loadError) {
      setAccountBalance(null);
      setAccountBalanceError(getAdminErrorMessage(loadError));
    } finally {
      setAccountBalanceLoading(false);
    }
  };

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const config = await adminApi.getAiProviderConfig(providerCode);
      const adminToken = typeof config.adminToken === 'string' ? config.adminToken : '';
      const forwardKey = typeof config.forwardKey === 'string' ? config.forwardKey : '';
      const nanobananaDefaults = toNanoBananaDefaultsForm(config.metadata);
      const providerMetadata = getRecord(config.metadata);
      setProviderConfig(config);
      setLoadedSecrets({ adminToken, forwardKey });
      setForm({
        name: String(config.name || ''),
        publicId: String(config.publicId || ''),
        publicName: String(config.publicName || ''),
        publicFamily: String(config.publicFamily || ''),
        publicDefaultModel: isAceNanoBanana && !toAceImageModelsForm(providerMetadata).some((model) => model.code === config.publicDefaultModel)
          ? 'nano-banana-pro' : String(config.publicDefaultModel || ''),
        publicSortOrder: String(config.publicSortOrder ?? 100),
        publicHidden: Boolean(config.publicHidden),
        baseUrl: String(config.baseUrl || ''),
        adminBaseUrl: String(config.adminBaseUrl || ''),
        status: String(config.status || 'active'),
        adminToken,
        forwardKey,
        defaultKeyTypeId: config.defaultKeyTypeId == null ? '' : String(config.defaultKeyTypeId),
        quotaTransferPath: config.quotaTransferPath == null ? '' : String(config.quotaTransferPath),
        quotaTransferMethod: String(config.quotaTransferMethod || 'POST'),
        quotaTransferBodyTemplate: config.quotaTransferBodyTemplate == null
          ? ''
          : JSON.stringify(config.quotaTransferBodyTemplate, null, 2),
        deepseekPricing: toDeepSeekPricingForm(config.tokenPricing),
        nanobananaAspectRatio: nanobananaDefaults.aspectRatio,
        nanobananaImageSize: nanobananaDefaults.imageSize,
        nanobananaAccountUserId: nanobananaDefaults.accountUserId,
        acedataModels: toAceImageModelsForm(providerMetadata),
        moacodeImageModelsEnabled: providerMetadata.moacodeImageModelsEnabled === true,
        nanobananaPricing: toNanoBananaPricingForm(config.tokenPricing),
      });
      if (canQueryAccountBalance && (isApi2d || isMoacode || isNanoBanana ? config.forwardKeyConfigured : config.adminTokenConfigured)) void loadAccountBalance();
      else {
        setAccountBalance(null);
        setAccountBalanceError(null);
      }
    } catch (loadError) {
      setError(getAdminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTab(0);
    void loadConfig();
    if (isAce) void loadAceConnection();
    setAceModelCategory('all');
    setAceConnectionSaved(false);
    setKeys([]);
    setUserBalances([]);
    setUserBalancePage(0);
    setUserBalanceTotal(0);
    setSelectedBalanceUser(null);
    setSelectedUserUsage(null);
    setSelectedUsageTab(0);
    setSelectedInvocationPage(0);
    setSelectedLedgerPage(0);
    setSelectedUserStats(null);
    setSelectedUserStatsGroupBy(readStoredUserStatsGroupBy(providerCode));
    setSelectedUserStatsPage(0);
    setUsageStats(null);
    setUsageStatsPage(0);
    setUsageStatsRowsPerPage(USAGE_STATS_PAGE_SIZE);
    setUsageStatsFilters({
      ...DEFAULT_USAGE_STATS_FILTERS,
      groupBy: readStoredUsageStatsGroupBy(providerCode),
    });
    setUsageStatsError(null);
    setPublicModels([]);
    setPublicModelTotal(0);
    setPublicModelError(null);
  }, [providerCode]);

  useEffect(() => {
    if (hasPublicModelPricing && (tab === 0 || tab === publicModelTabIndex) && !publicModels.length && !publicModelLoading) void loadPublicModels();
    if (tab === userManagementTabIndex) {
      if (usesInternalLedger) void loadUserBalances();
      else void loadKeys();
    }
    if (tab === usageStatsTabIndex) void loadUsageStats();
  }, [tab, providerCode, usesInternalLedger]);

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    setSaveWarning(null);
    setAceConnectionSaved(false);
    let aceConnectionPersisted = false;
    let savingAceConnection = false;
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        publicId: form.publicId,
        publicName: form.publicName,
        publicFamily: form.publicFamily,
        publicDefaultModel: form.publicDefaultModel,
        publicSortOrder: Number(form.publicSortOrder || 100),
        publicHidden: form.publicHidden,
        baseUrl: form.baseUrl,
        adminBaseUrl: form.adminBaseUrl,
        status: form.status,
        defaultKeyTypeId: form.defaultKeyTypeId || null,
        quotaTransferPath: form.quotaTransferPath.trim() || null,
        quotaTransferMethod: form.quotaTransferMethod || 'POST',
        quotaTransferBodyTemplate: form.quotaTransferBodyTemplate.trim()
          ? JSON.parse(form.quotaTransferBodyTemplate)
          : null,
      };
      if (isImageProvider) {
        payload.tokenPricing = buildNanoBananaPricing(form.nanobananaPricing);
        if (isAceNanoBanana) payload.tokenPricing = { billingMultiplier: Number(form.nanobananaPricing.billingMultiplier), pointValueCny: 100 };
      }
      else if (isAce) payload.tokenPricing = { billingMultiplier: Number(form.deepseekPricing.billingMultiplier) };
      else if (usesInternalLedger) payload.tokenPricing = buildInternalLedgerTokenPricing(providerCode, form.deepseekPricing);
      if (isMoacode) {
        payload.metadata = {
          ...getRecord(providerConfig?.metadata),
          moacodeImageModelsEnabled: form.moacodeImageModelsEnabled,
        };
      }
      if (isImageProvider || isAce) {
        payload.metadata = {
          ...getRecord(payload.metadata || providerConfig?.metadata),
          nanobananaDefaults: {
            aspectRatio: form.nanobananaAspectRatio || '',
            imageSize: form.nanobananaImageSize || '1K',
            accountUserId: form.nanobananaAccountUserId.trim(),
          },
        };
      }
      const nextAdminToken = form.adminToken.trim();
      const nextForwardKey = form.forwardKey.trim();
      if (nextAdminToken !== loadedSecrets.adminToken) payload.adminToken = nextAdminToken;
      if (nextForwardKey !== loadedSecrets.forwardKey) payload.forwardKey = nextForwardKey;
      if (isAce) {
        if (!aceConnectionLoaded) throw new Error('请先成功加载 ACE 连接配置');
        savingAceConnection = true;
        const connection = await adminApi.updateAceConnection({
          status: aceConnection.status,
          apiBaseUrl: aceConnection.apiBaseUrl,
          ...(aceConnection.apiKey.trim() ? { apiKey: aceConnection.apiKey.trim() } : {}),
        });
        setAceConnection({ ...connection, apiKey: '' });
        setAceConnectionError(null);
        aceConnectionPersisted = true;
        savingAceConnection = false;
      }
      const updated = await adminApi.updateAiProviderConfig(providerCode, payload);
      const pricingRefresh = updated.pricingRefresh && typeof updated.pricingRefresh === 'object'
        ? updated.pricingRefresh as Record<string, unknown>
        : null;
      if (pricingRefresh?.status === 'failed') {
        setSaveWarning(String(pricingRefresh.message || 'Cookie 已保存，但模型价格刷新失败，已保留旧数据，请稍后重试。'));
      }
      const updatedAdminToken = typeof updated.adminToken === 'string' ? updated.adminToken : nextAdminToken;
      const updatedForwardKey = typeof updated.forwardKey === 'string' ? updated.forwardKey : nextForwardKey;
      setProviderConfig(updated);
      setPublicModels([]);
      setPublicModelTotal(0);
      if (hasPublicModelPricing) void loadPublicModels();
      setLoadedSecrets({ adminToken: updatedAdminToken, forwardKey: updatedForwardKey });
      const updatedNanoBananaDefaults = toNanoBananaDefaultsForm(updated.metadata);
      setForm((prev) => ({
        ...prev,
        adminToken: updatedAdminToken,
        forwardKey: updatedForwardKey,
        deepseekPricing: toDeepSeekPricingForm(updated.tokenPricing),
        nanobananaAspectRatio: updatedNanoBananaDefaults.aspectRatio,
        nanobananaImageSize: updatedNanoBananaDefaults.imageSize,
        nanobananaAccountUserId: updatedNanoBananaDefaults.accountUserId,
        acedataModels: toAceImageModelsForm(getRecord(updated.metadata)),
        moacodeImageModelsEnabled: getRecord(updated.metadata).moacodeImageModelsEnabled === true,
        nanobananaPricing: toNanoBananaPricingForm(updated.tokenPricing),
      }));
      if (isAce) setAceConnectionSaved(true);
    } catch (saveError) {
      const message = getAdminErrorMessage(saveError);
      setError(isAce
        ? savingAceConnection
          ? `ACE 连接保存失败，其他配置尚未保存：${message}`
          : aceConnectionPersisted
            ? `ACE 连接已保存，其他配置保存失败，请重试：${message}`
            : message
        : message);
    } finally {
      setSaving(false);
    }
  };

  const loadKeys = async () => {
    setKeyLoading(true);
    setKeyError(null);
    try {
      const result = await adminApi.getAiProviderKeys(providerCode, {
        typeId: keySearch.typeId || undefined,
        keyword: keySearch.keyword || undefined,
      });
      setKeys(result.items);
    } catch (loadError) {
      setKeyError(getAdminErrorMessage(loadError));
    } finally {
      setKeyLoading(false);
    }
  };

  const loadUserBalances = async (page = userBalancePage, rowsPerPage = userBalanceRowsPerPage) => {
    setUserBalanceLoading(true);
    setKeyError(null);
    try {
      const result = await adminApi.getAiProviderUserBalances(providerCode, {
        search: userBalanceSearch.trim() || undefined,
        page: page + 1,
        limit: rowsPerPage,
      });
      setUserBalances(result.items);
      setUserBalancePage(Math.max(Number(result.page || 1) - 1, 0));
      setUserBalanceRowsPerPage(Number(result.limit || rowsPerPage));
      setUserBalanceTotal(Number(result.total || 0));
    } catch (loadError) {
      setKeyError(getAdminErrorMessage(loadError));
    } finally {
      setUserBalanceLoading(false);
    }
  };

  const loadSelectedUserUsage = async (userId: string, invocationPage = selectedInvocationPage, ledgerPage = selectedLedgerPage) => {
    setUserUsageLoading(true);
    setKeyError(null);
    try {
      const result = await adminApi.getAiProviderUserUsage(providerCode, userId, {
        invocationPage: invocationPage + 1,
        invocationLimit: USER_USAGE_PAGE_SIZE,
        ledgerPage: ledgerPage + 1,
        ledgerLimit: USER_USAGE_PAGE_SIZE,
      });
      setSelectedUserUsage({
        invocations: result.invocations,
        quotaLedger: result.quotaLedger,
        totals: result.totals,
        invocationsPage: result.invocationsPage,
        quotaLedgerPage: result.quotaLedgerPage,
      });
      setSelectedInvocationPage(toZeroBasedPage(result.invocationsPage?.page, invocationPage));
      setSelectedLedgerPage(toZeroBasedPage(result.quotaLedgerPage?.page, ledgerPage));
    } catch (loadError) {
      setKeyError(getAdminErrorMessage(loadError));
    } finally {
      setUserUsageLoading(false);
    }
  };

  const loadUsageStats = async (
    page = usageStatsPage,
    rowsPerPage = usageStatsRowsPerPage,
    filters: typeof usageStatsFilters = usageStatsFilters,
  ) => {
    setUsageStatsLoading(true);
    setUsageStatsError(null);
    try {
      const result = await adminApi.getAiProviderUsageStats(providerCode, {
        groupBy: filters.groupBy,
        usageType: filters.usageType || undefined,
        model: filters.model || undefined,
        search: filters.search.trim() || undefined,
        status: filters.status || undefined,
        from: parseDateTimeInput(filters.from),
        to: parseDateTimeInput(filters.to),
        page: page + 1,
        limit: rowsPerPage,
      });
      setUsageStats(result);
      setUsageStatsPage(Math.max(Number(result.page || 1) - 1, 0));
      setUsageStatsRowsPerPage(Number(result.limit || rowsPerPage));
    } catch (loadError) {
      setUsageStatsError(getAdminErrorMessage(loadError));
    } finally {
      setUsageStatsLoading(false);
    }
  };

  const loadSelectedUserStats = async (
    userId: string,
    page = selectedUserStatsPage,
    groupBy = selectedUserStatsGroupBy,
  ) => {
    if (!userId) return;
    setSelectedUserStatsLoading(true);
    setKeyError(null);
    try {
      const result = await adminApi.getAiProviderUsageStats(providerCode, {
        userId,
        groupBy,
        status: 'success',
        page: page + 1,
        limit: USAGE_STATS_PAGE_SIZE,
      });
      setSelectedUserStats(result);
      setSelectedUserStatsPage(Math.max(Number(result.page || 1) - 1, 0));
    } catch (loadError) {
      setKeyError(getAdminErrorMessage(loadError));
    } finally {
      setSelectedUserStatsLoading(false);
    }
  };

  const openUserUsageDialog = (item: Record<string, unknown>) => {
    const userId = String(item.id || '');
    if (!userId) return;
    setSelectedBalanceUser(item);
    setSelectedUserUsage(null);
    setSelectedUsageTab(0);
    setSelectedInvocationPage(0);
    setSelectedLedgerPage(0);
    setSelectedUserStats(null);
    const groupBy = readStoredUserStatsGroupBy(providerCode);
    setSelectedUserStatsGroupBy(groupBy);
    setSelectedUserStatsPage(0);
    setUserPointDraft('');
    void loadSelectedUserUsage(userId, 0, 0);
    void loadSelectedUserStats(userId, 0, groupBy);
  };

  const transferUserPoints = async () => {
    const userId = String(selectedBalanceUser?.id || '');
    const amount = Number(userPointDraft);
    if (!userId) return;
    if (!Number.isFinite(amount) || amount === 0) {
      setKeyError('请输入非 0 的额度，负数表示扣除');
      return;
    }
    setUserUsageLoading(true);
    setKeyError(null);
    try {
      const result = await adminApi.transferAiProviderUserPoints(providerCode, userId, { amount });
      setUserPointDraft('');
      const balanceAfter = Number(result.balanceAfter);
      if (Number.isFinite(balanceAfter)) {
        setSelectedBalanceUser((prev) => prev ? { ...prev, balanceAmount: balanceAfter, balance_amount: balanceAfter } : prev);
      }
      setSelectedLedgerPage(0);
      await Promise.all([
        loadUserBalances(userBalancePage, userBalanceRowsPerPage),
        loadSelectedUserUsage(userId, selectedInvocationPage, 0),
      ]);
    } catch (saveError) {
      setKeyError(getAdminErrorMessage(saveError));
    } finally {
      setUserUsageLoading(false);
    }
  };

  const createKey = async () => {
    setKeyLoading(true);
    setKeyError(null);
    try {
      await adminApi.createAiProviderKey(providerCode, {
        typeId: keyCreate.typeId || null,
        note: keyCreate.note || undefined,
        grantAmount: keyCreate.grantAmount ? Number(keyCreate.grantAmount) : null,
        dailyQuota: keyCreate.dailyQuota ? Number(keyCreate.dailyQuota) : null,
        monthlyQuota: keyCreate.monthlyQuota ? Number(keyCreate.monthlyQuota) : null,
      });
      setCreateDialogOpen(false);
      setKeyCreate({ typeId: '', note: '', grantAmount: '', dailyQuota: '', monthlyQuota: '' });
      await loadKeys();
    } catch (createError) {
      console.error('Create AI provider key failed', createError);
      setKeyError(getAdminErrorMessage(createError));
    } finally {
      setKeyLoading(false);
    }
  };

  const updateKey = async () => {
    if (!keyAction.externalKeyId.trim()) {
      setKeyError('请输入 Key ID');
      return;
    }
    setKeyLoading(true);
    setKeyError(null);
    try {
      await adminApi.updateAiProviderKey(providerCode, keyAction.externalKeyId.trim(), {
        enabled: keyAction.enabled,
        note: keyAction.note || undefined,
        dailyQuota: keyAction.dailyQuota ? Number(keyAction.dailyQuota) : null,
        monthlyQuota: keyAction.monthlyQuota ? Number(keyAction.monthlyQuota) : null,
        minuteTimes: keyAction.minuteTimes ? Number(keyAction.minuteTimes) : null,
      });
      setUpdateDialogOpen(false);
      await loadKeys();
    } catch (updateError) {
      setKeyError(getAdminErrorMessage(updateError));
    } finally {
      setKeyLoading(false);
    }
  };

  const updateDeepSeekPricing = (field: keyof DeepSeekPricingForm, value: string) => {
    setForm((prev) => ({
      ...prev,
      deepseekPricing: {
        ...prev.deepseekPricing,
        [field]: value,
      },
    }));
  };

  const updateNanoBananaPricing = (field: 'pointValue' | 'billingMultiplier', value: string) => {
    setForm((prev) => ({
      ...prev,
      nanobananaPricing: {
        ...prev.nanobananaPricing,
        [field]: value,
      },
    }));
  };

  const openUpdateDialog = (item: Record<string, unknown>) => {
    setKeyAction({
      externalKeyId: String(item.id || ''),
      dailyQuota: item.daily_quota == null ? '' : String(item.daily_quota),
      monthlyQuota: item.monthly_quota == null ? '' : String(item.monthly_quota),
      minuteTimes: item.minute_times == null ? '' : String(item.minute_times),
      note: String(item.note || ''),
      enabled: Number(item.enabled ?? 1) !== 0,
    });
    setUpdateDialogOpen(true);
  };

  if (isAceNanoBanana) return <Navigate to="/admin/platform/ai/providers/acedata" replace />;

  return (
    <Stack spacing={2} sx={{ pb: 10 }}>
      <Tabs value={tab} onChange={(_event, value) => setTab(value)} variant="scrollable" allowScrollButtonsMobile>
        <Tab label={isAce ? '通用配置' : '配置'} />
        {hasPublicModelPricing ? <Tab label={isAce ? '模型列表与价格' : '模型价格'} /> : null}
        <Tab label={usesInternalLedger ? '通用点数' : 'Key 查询'} />
        <Tab label="用量统计" />
      </Tabs>
      <AdminRequestState
        loading={loading || saving || keyLoading || userBalanceLoading || userUsageLoading || selectedUserStatsLoading || usageStatsLoading || publicModelLoading}
        error={tab === 0 ? error : tab === publicModelTabIndex ? publicModelError : tab === userManagementTabIndex ? keyError : usageStatsError}
        onRetry={tab === 0 ? () => void loadConfig() : tab === publicModelTabIndex ? () => void loadPublicModels() : tab === userManagementTabIndex ? (usesInternalLedger ? () => void loadUserBalances() : () => void loadKeys()) : () => void loadUsageStats()}
      />

      {tab === 0 ? (
        <Stack spacing={1.25}>
          {saveWarning ? <Alert severity="warning">{saveWarning}</Alert> : null}
          {isAce && aceConnectionSaved ? <Alert severity="success">配置已保存</Alert> : null}
          <AdminSection title={isAce ? '供应商配置' : '主账号配置'}>
            <Stack spacing={1.25}>
              <Box sx={configGridSx}>
                <TextField label="名称" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} sx={compactTextFieldSx} />
                <TextField select label="状态" value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))} sx={compactTextFieldSx}>
                  <MenuItem value="active">启用</MenuItem>
                  <MenuItem value="inactive">停用</MenuItem>
                </TextField>
                <TextField
                  label="排序"
                  type="number"
                  value={form.publicSortOrder}
                  onChange={(e) => setForm((prev) => ({ ...prev, publicSortOrder: e.target.value }))}
                  sx={compactTextFieldSx}
                />
                <Box
                  sx={{
                    minHeight: 56,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    px: 1.25,
                    display: 'flex',
                    alignItems: 'center',
                    bgcolor: 'background.paper',
                  }}
                >
                  <FormControlLabel
                    control={<Switch checked={form.publicHidden} onChange={(e) => setForm((prev) => ({ ...prev, publicHidden: e.target.checked }))} />}
                    label="用户侧隐藏"
                    sx={{
                      m: 0,
                      '& .MuiFormControlLabel-label': {
                        whiteSpace: 'nowrap',
                      },
                    }}
                  />
                </Box>
              </Box>
              <Box sx={publicConfigGridSx}>
                <TextField
                  label="用户侧公开 ID"
                  value={form.publicId}
                  onChange={(e) => setForm((prev) => ({ ...prev, publicId: e.target.value }))}
                  sx={compactTextFieldSx}
                />
                <TextField
                  label="用户侧显示名"
                  value={form.publicName}
                  onChange={(e) => setForm((prev) => ({ ...prev, publicName: e.target.value }))}
                  sx={compactTextFieldSx}
                />
                <TextField
                  label="用户侧分组名"
                  value={form.publicFamily}
                  onChange={(e) => setForm((prev) => ({ ...prev, publicFamily: e.target.value }))}
                  sx={compactTextFieldSx}
                />
                <Autocomplete
                  freeSolo
                  options={publicModelOptions}
                  value={form.publicDefaultModel}
                  getOptionLabel={(option) => (typeof option === 'string' ? option : option.modelName)}
                  isOptionEqualToValue={(option, value) => {
                    const optionValue = typeof option === 'string' ? option : option.modelName;
                    const valueText = typeof value === 'string' ? value : value.modelName;
                    return optionValue === valueText;
                  }}
                  onChange={(_event, value) => {
                    const model = typeof value === 'string' ? value : value?.modelName || '';
                    setForm((prev) => ({ ...prev, publicDefaultModel: model }));
                  }}
                  onInputChange={(_event, value, reason) => {
                    if (reason === 'input' || reason === 'clear') setForm((prev) => ({ ...prev, publicDefaultModel: value }));
                  }}
                  renderOption={(props, option) => (
                    <Box component="li" {...props}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{option.modelName}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.displayName || option.modelName} · {option.providerCount} 个上游
                        </Typography>
                      </Box>
                    </Box>
                  )}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="默认模型"
                      helperText={isMoacode
                        ? publicModelLoading
                          ? '加载中'
                          : publicModelError
                            ? `模型列表加载失败：${publicModelError}`
                            : undefined
                        : undefined}
                      sx={compactTextFieldSx}
                    />
                  )}
                />
              </Box>
              {isMoacode ? (
                <FormControlLabel
                  control={(
                    <Switch
                      checked={form.moacodeImageModelsEnabled}
                      onChange={(event) => setForm((prev) => ({ ...prev, moacodeImageModelsEnabled: event.target.checked }))}
                    />
                  )}
                  label="启用图片模型"
                />
              ) : null}
              {!isAceNanoBanana && !isAce ? <Box sx={endpointGridSx}>
                <TextField label="AI 调用 Base URL" value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} fullWidth sx={compactTextFieldSx} />
                {isApi2d || isMoacode ? (
                  <TextField
                    label={isMoacode ? '余额/用量 Base URL' : '管理 API Base URL'}
                    value={form.adminBaseUrl}
                    onChange={(e) => setForm((prev) => ({ ...prev, adminBaseUrl: e.target.value }))}
                    fullWidth
                    sx={compactTextFieldSx}
                  />
                ) : null}
              </Box> : null}
              {isImageProvider || isAce ? (
                <Box sx={shortConfigGridSx}>
                  <TextField
                    select
                    label="默认宽高比"
                    value={form.nanobananaAspectRatio}
                    onChange={(e) => setForm((prev) => ({ ...prev, nanobananaAspectRatio: e.target.value }))}
                    helperText="用户指定时覆盖"
                    sx={compactTextFieldSx}
                  >
                    <MenuItem value="">不指定</MenuItem>
                    {NANOBANANA_ASPECT_RATIOS.map((value) => (
                      <MenuItem key={value} value={value}>{value}</MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="默认画质"
                    value={form.nanobananaImageSize}
                    onChange={(e) => setForm((prev) => ({ ...prev, nanobananaImageSize: e.target.value }))}
                    helperText="支持 1K、2K、4K"
                    sx={compactTextFieldSx}
                  >
                    {NANOBANANA_IMAGE_SIZES.map((value) => (
                      <MenuItem key={value} value={value}>{value}</MenuItem>
                    ))}
                  </TextField>
                  {isNanoBanana ? <TextField
                    label="余额查询用户 ID"
                    value={form.nanobananaAccountUserId}
                    onChange={(e) => setForm((prev) => ({ ...prev, nanobananaAccountUserId: e.target.value }))}
                    helperText="new-api-user"
                    sx={compactTextFieldSx}
                  /> : null}
                </Box>
              ) : null}
              {!isAceNanoBanana && !isAce ? <TextField
                label={isApi2d ? 'API2D 主账号管理 Token（不是模型调用 Key）' : `${providerDisplayName} 主账号 API Key`}
                value={form.adminToken}
                onChange={(e) => setForm((prev) => ({ ...prev, adminToken: e.target.value }))}
                fullWidth
                sx={compactTextFieldSx}
              /> : isAceNanoBanana ? <Button href="/admin/platform/ai/providers/acedata" variant="outlined" sx={{ alignSelf: 'flex-start' }}>ACE 共享连接配置</Button> : null}
              {isApi2d || isMoacode || isNanoBanana ? (
                <TextField
                  label={isMoacode
                    ? `${providerDisplayName} Cookie（用于余额和用量查询）`
                    : isNanoBanana
                      ? 'NanoBanana Session/Cookie（用于余额查询）'
                      : 'API2D 主账号 ForwardKey（用于余额查询）'}
                  value={form.forwardKey}
                  onChange={(e) => setForm((prev) => ({ ...prev, forwardKey: e.target.value }))}
                  fullWidth
                  sx={compactTextFieldSx}
                />
              ) : null}
              {canQueryAccountBalance ? (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1.25}
                  sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}
                >
                  <Box>
                    <Typography variant="caption" color="text.secondary">{accountBalanceTitle}</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
                      {accountBalanceLoading ? '查询中' : formatBalance(accountBalance, providerCode)}
                    </Typography>
                    {accountBalanceError ? <Typography variant="caption" color="error">{accountBalanceError}</Typography> : null}
                  </Box>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => void loadAccountBalance()}
                    disabled={!(isApi2d || isMoacode || isNanoBanana ? providerConfig?.forwardKeyConfigured : providerConfig?.adminTokenConfigured) || accountBalanceLoading}
                  >
                    刷新余额
                  </Button>
                </Stack>
              ) : null}
              {isNanoBanana && accountBalance ? (
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
                    gap: 1,
                  }}
                >
                  {[
                    { label: '可用余额', value: formatCurrencyAmount(getFirstDefinedValue(nanobananaBalanceSummary, ['availableBalance', 'available_balance']), '$', 2) },
                    { label: '已用额度', value: formatCurrencyAmount(getFirstDefinedValue(nanobananaBalanceSummary, ['usedAmount', 'used_amount']), '$', 2) },
                    { label: '请求次数', value: formatOptionalPlainNumber(getFirstDefinedValue(nanobananaBalanceSummary, ['requestCount', 'request_count']), 0) },
                    { label: '账号', value: String(getFirstDefinedValue(nanobananaBalanceSummary, ['displayName', 'display_name', 'username']) ?? '-') },
                  ].map((item) => (
                    <Box key={item.label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                      <Typography variant="caption" color="text.secondary">{item.label}</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 800 }}>{item.value}</Typography>
                    </Box>
                  ))}
                </Box>
              ) : null}
              {isMoacode && accountBalance ? (
                <Stack spacing={1}>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
                      gap: 1,
                    }}
                  >
                    {(isMoacodeTeam ? [
                      {
                        label: '有效可用',
                        value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['effectiveAvailableBalance', 'effective_available_balance']), 2),
                      },
                      {
                        label: '团队日剩余 / 限额',
                        value: formatDollarFraction(
                          getFirstDefinedValue(moacodeBalanceSummary, ['teamDailyRemainingBalance', 'team_daily_remaining_balance', 'dailyRemainingBalance', 'daily_remaining_balance', 'userDailyRemainingBalance', 'user_daily_remaining_balance']),
                          getFirstDefinedValue(moacodeBalanceSummary, ['teamDailyBalance', 'team_daily_balance', 'dailyBalance', 'daily_balance']),
                          2,
                        ),
                      },
                      {
                        label: '本周剩余 / 限额',
                        value: formatDollarRemainingFromSpent(
                          getFirstDefinedValue(moacodeBalanceSummary, ['weeklyLimit', 'weekly_limit']),
                          getFirstDefinedValue(moacodeBalanceSummary, ['teamWeekSpend', 'team_week_spend', 'currentWeekSpend', 'current_week_spend']),
                          2,
                        ),
                      },
                      {
                        label: '本月剩余 / 限额',
                        value: formatDollarRemainingFromSpent(
                          getFirstDefinedValue(moacodeBalanceSummary, ['teamMonthlyLimit', 'team_monthly_limit', 'monthlyLimit', 'monthly_limit']),
                          getFirstDefinedValue(moacodeBalanceSummary, ['teamMonthSpend', 'team_month_spend', 'currentMonthSpend', 'current_month_spend']),
                          2,
                        ),
                      },
                      { label: '团队', value: `${String(getFirstDefinedValue(moacodeBalanceSummary, ['teamName', 'team_name']) ?? '-')}${getFirstDefinedValue(moacodeBalanceSummary, ['hasTeam', 'has_team']) === false ? ' / 未加入' : ` / ${formatOptionalBoolean(getFirstDefinedValue(moacodeBalanceSummary, ['teamActive', 'team_active']))}`}` },
                    ] : [
                      { label: '总余额', value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['totalBalance', 'total_balance', 'balance']), 2) },
                      { label: '订阅余额', value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['subscriptionBalance', 'subscription_balance']), 2) },
                      { label: 'PAYG 余额', value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['payAsYouGoBalance', 'pay_as_you_go_balance']), 2) },
                      { label: '本周限额', value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['weeklyLimit', 'weekly_limit']), 2) },
                      { label: '本周已用', value: formatDollarAmount(getFirstDefinedValue(moacodeBalanceSummary, ['weeklySpentBalance', 'weekly_spent_balance']), 2) },
                      { label: '扣费偏好', value: String(getFirstDefinedValue(moacodeBalanceSummary, ['balancePreference', 'balance_preference']) ?? '-') },
                      { label: '自动 PAYG', value: formatOptionalBoolean(getFirstDefinedValue(moacodeBalanceSummary, ['autoSwitchToPaygEnabled', 'auto_switch_to_payg_enabled'])) },
                    ]).map((item) => (
                      <Box key={item.label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                        <Typography variant="caption" color="text.secondary">{item.label}</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 800 }}>{item.value}</Typography>
                      </Box>
                    ))}
                  </Box>
                  {Object.keys(moacodeUsageSummary).length ? (
                    <>
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
                          gap: 1,
                        }}
                      >
                        {[
                          { label: '总请求', value: formatOptionalPlainNumber(moacodeUsageSummary.totalRequests ?? moacodeUsageSummary.total_requests, 0) },
                          { label: '输入 tokens', value: formatOptionalPlainNumber(moacodeUsageSummary.totalInputTokens ?? moacodeUsageSummary.total_input_tokens, 0) },
                          { label: '输出 tokens', value: formatOptionalPlainNumber(moacodeUsageSummary.totalOutputTokens ?? moacodeUsageSummary.total_output_tokens, 0) },
                          { label: '缓存读取 tokens', value: formatOptionalPlainNumber(moacodeUsageSummary.totalCacheReadTokens ?? moacodeUsageSummary.total_cache_read_tokens, 0) },
                          { label: '总成本', value: formatDollarAmount(moacodeUsageSummary.totalCost ?? moacodeUsageSummary.total_cost, 4) },
                        ].map((item) => (
                          <Box key={item.label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                            <Typography variant="caption" color="text.secondary">{item.label}</Typography>
                            <Typography variant="body2" sx={{ fontWeight: 800 }}>{item.value}</Typography>
                          </Box>
                        ))}
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        {isMoacodeTeam ? '团队近 1 个月' : '主账号汇总'}；首次请求：{String(moacodeUsageSummary.firstRequestAt ?? moacodeUsageSummary.first_request_at ?? '-')}；最近请求：{String(moacodeUsageSummary.lastRequestAt ?? moacodeUsageSummary.last_request_at ?? '-')}
                      </Typography>
                    </>
                  ) : null}
                  {moacodeUsageModels.length ? (
                    <Stack spacing={0.75}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                        {isMoacodeTeam ? '团队模型用量（近 1 个月）' : '模型用量'}
                      </Typography>
                      <AdminTableFrame minWidth={760}>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>模型</TableCell>
                              <TableCell>请求</TableCell>
                              <TableCell>输入</TableCell>
                              <TableCell>输出</TableCell>
                              <TableCell>缓存创建</TableCell>
                              <TableCell>缓存读取</TableCell>
                              <TableCell>成本($)</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {moacodeUsageModels.map((row) => (
                              <TableRow key={String(row.model || '')}>
                                <TableCell>{String(row.model || '-')}</TableCell>
                                <TableCell>{formatPlainNumber(row.requests)}</TableCell>
                                <TableCell>{formatPlainNumber(row.inputTokens ?? row.input_tokens)}</TableCell>
                                <TableCell>{formatPlainNumber(row.outputTokens ?? row.output_tokens)}</TableCell>
                                <TableCell>{formatPlainNumber(row.cacheCreationTokens ?? row.cache_creation_tokens)}</TableCell>
                                <TableCell>{formatPlainNumber(row.cacheReadTokens ?? row.cache_read_tokens)}</TableCell>
                                <TableCell>{formatDollarAmount(row.cost ?? row.total_cost, 4)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </AdminTableFrame>
                    </Stack>
                  ) : null}
                </Stack>
              ) : null}
              </Stack>
          </AdminSection>

          {isAce ? (
            <AdminSection title="ACE 连接">
              <Stack spacing={1.25}>
                {aceConnectionError ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => void loadAceConnection()} disabled={aceConnectionLoading}>重新加载</Button>}>{aceConnectionError}</Alert> : null}
                <Box sx={endpointGridSx}>
                  <TextField
                    label="API Base URL"
                    value={aceConnection.apiBaseUrl}
                    onChange={(event) => { setAceConnection((prev) => ({ ...prev, apiBaseUrl: event.target.value })); setAceConnectionSaved(false); }}
                    disabled={aceConnectionLoading || saving}
                    fullWidth
                    sx={compactTextFieldSx}
                  />
                  <TextField
                    label="API Key"
                    type="password"
                    value={aceConnection.apiKey}
                    onChange={(event) => { setAceConnection((prev) => ({ ...prev, apiKey: event.target.value })); setAceConnectionSaved(false); }}
                    placeholder={aceConnection.apiKeyConfigured ? '已配置，留空则保持原密钥' : '填写 ACE API Key'}
                    disabled={aceConnectionLoading || saving}
                    fullWidth
                    sx={compactTextFieldSx}
                  />
                </Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <FormControlLabel control={<Switch checked={aceConnection.status === 'active'} onChange={(event) => { setAceConnection((prev) => ({ ...prev, status: event.target.checked ? 'active' : 'inactive' })); setAceConnectionSaved(false); }} disabled={aceConnectionLoading || saving} />} label="启用连接" />
                </Stack>
              </Stack>
            </AdminSection>
          ) : null}

          {usesInternalLedger ? (
            <AdminSection title={`${providerDisplayName} 扣费配置`}>
              {isAce ? (
                <TextField label="计费倍率" type="number" slotProps={{ htmlInput: { min: 0.01, step: 0.1 } }} value={form.deepseekPricing.billingMultiplier} onChange={(event) => updateDeepSeekPricing('billingMultiplier', event.target.value)} sx={compactTextFieldSx} />
              ) : isImageProvider ? (
                <Stack spacing={1.25}>
                  <Box sx={shortConfigGridSx}>
                    {!isAceNanoBanana ? <TextField
                      label="1P 等于多少美元"
                      value={form.nanobananaPricing.pointValue}
                      onChange={(e) => updateNanoBananaPricing('pointValue', e.target.value)}
                      helperText="默认 0.01"
                      sx={compactTextFieldSx}
                    /> : null}
                    <TextField
                      label={isAceNanoBanana ? '统一扣点倍率' : '扣点倍率'}
                      value={form.nanobananaPricing.billingMultiplier}
                      onChange={(e) => updateNanoBananaPricing('billingMultiplier', e.target.value)}
                      helperText={isAceNanoBanana ? '积分价格 × 100P × 倍率；默认 1.5' : '价格 × 倍率 / P价值'}
                      sx={compactTextFieldSx}
                    />
                  </Box>
                </Stack>
              ) : (
                <Stack spacing={1.25}>
                  <Box sx={isMoacode ? pricingConfigGridSx : { display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.25 }}>
                    <TextField
                      label={isMoacode ? '1P 等于多少美元' : '1P 等于多少元'}
                      value={form.deepseekPricing.pointValueCny}
                      onChange={(e) => updateDeepSeekPricing('pointValueCny', e.target.value)}
                      fullWidth={!isMoacode}
                      sx={compactTextFieldSx}
                    />
                    <TextField
                      label="计费倍率"
                      value={form.deepseekPricing.billingMultiplier}
                      onChange={(e) => updateDeepSeekPricing('billingMultiplier', e.target.value)}
                      fullWidth={!isMoacode}
                      sx={compactTextFieldSx}
                    />
                  </Box>
                  {!isMoacode ? (
                    <>
                      <Box sx={{ display: 'grid', gap: 0.75 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                          deepseek-v4-flash
                        </Typography>
                        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
                          <TextField
                            label="输入（缓存未命中，元/百万 tokens）"
                            value={form.deepseekPricing.flashCacheMiss}
                            onChange={(e) => updateDeepSeekPricing('flashCacheMiss', e.target.value)}
                            fullWidth
                          />
                          <TextField
                            label="输入（缓存命中，元/百万 tokens）"
                            value={form.deepseekPricing.flashCacheHit}
                            onChange={(e) => updateDeepSeekPricing('flashCacheHit', e.target.value)}
                            fullWidth
                          />
                          <TextField
                            label="输出（元/百万 tokens）"
                            value={form.deepseekPricing.flashCompletion}
                            onChange={(e) => updateDeepSeekPricing('flashCompletion', e.target.value)}
                            fullWidth
                          />
                        </Stack>
                      </Box>
                      <Box sx={{ display: 'grid', gap: 0.75 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                          deepseek-v4-pro
                        </Typography>
                        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
                          <TextField
                            label="输入（缓存未命中，元/百万 tokens）"
                            value={form.deepseekPricing.proCacheMiss}
                            onChange={(e) => updateDeepSeekPricing('proCacheMiss', e.target.value)}
                            fullWidth
                          />
                          <TextField
                            label="输入（缓存命中，元/百万 tokens）"
                            value={form.deepseekPricing.proCacheHit}
                            onChange={(e) => updateDeepSeekPricing('proCacheHit', e.target.value)}
                            fullWidth
                          />
                          <TextField
                            label="输出（元/百万 tokens）"
                            value={form.deepseekPricing.proCompletion}
                            onChange={(e) => updateDeepSeekPricing('proCompletion', e.target.value)}
                            fullWidth
                          />
                        </Stack>
                      </Box>
                    </>
                  ) : null}
                </Stack>
              )}
            </AdminSection>
          ) : null}

          {isApi2d ? (
          <AdminSection title="Key 分配参数">
            <Stack spacing={1.25}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
                <TextField
                  label="默认 Key 分组 ID"
                  value={form.defaultKeyTypeId}
                  onChange={(e) => setForm((prev) => ({ ...prev, defaultKeyTypeId: e.target.value }))}
                />
              </Stack>
              <>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
                  <TextField
                    label="额度转入路径"
                    value={form.quotaTransferPath}
                    onChange={(e) => setForm((prev) => ({ ...prev, quotaTransferPath: e.target.value }))}
                    fullWidth
                  />
                  <TextField
                    select
                    label="额度转入方法"
                    value={form.quotaTransferMethod}
                    onChange={(e) => setForm((prev) => ({ ...prev, quotaTransferMethod: e.target.value }))}
                    sx={{ minWidth: 140 }}
                  >
                    <MenuItem value="POST">POST</MenuItem>
                    <MenuItem value="PUT">PUT</MenuItem>
                  </TextField>
                </Stack>
                <TextField
                  label="额度转入请求体模板"
                  value={form.quotaTransferBodyTemplate}
                  onChange={(e) => setForm((prev) => ({ ...prev, quotaTransferBodyTemplate: e.target.value }))}
                  minRows={4}
                  multiline
                  fullWidth
                />
              </>
            </Stack>
          </AdminSection>
          ) : null}

        </Stack>
      ) : hasPublicModelPricing && tab === publicModelTabIndex ? (
        <Stack spacing={1.5}>
          <AdminSection title={isAce ? '模型列表与价格' : '模型价格'}>
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <TextField
                  size="small"
                  label="搜索模型或供应商"
                  value={publicModelSearch}
                  onChange={(event) => setPublicModelSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void loadPublicModels(publicModelSearch);
                  }}
                  sx={{ flex: '1 1 260px', minWidth: 180, maxWidth: 360 }}
                />
                <Button
                  variant="contained"
                  disabled={publicModelLoading}
                  onClick={() => void loadPublicModels(publicModelSearch)}
                  sx={{ height: 40 }}
                >
                  查询
                </Button>
                <Button
                  variant="outlined"
                  disabled={publicModelLoading}
                  onClick={() => {
                    if (!isAce) { void loadPublicModels(publicModelSearch); return; }
                    setPublicModelLoading(true);
                    setPublicModelError(null);
                    void adminApi.refreshAceCatalog().then(() => loadPublicModels(publicModelSearch)).catch((error: unknown) => { setPublicModelError(getAdminErrorMessage(error)); setPublicModelLoading(false); });
                  }}
                  sx={{ height: 40 }}
                >
                  刷新
                </Button>
              </Stack>
              {isAce ? (
                <Tabs value={aceModelCategory} onChange={(_event, value: string) => setAceModelCategory(value)} variant="scrollable" allowScrollButtonsMobile>
                  {ACE_MODEL_TABS.map((item) => <Tab key={item.value} value={item.value} label={`${item.label} (${item.value === 'all' ? publicModels.length : publicModels.filter((model) => model.modality === item.value).length})`} />)}
                </Tabs>
              ) : null}
              {publicModelError ? <Alert severity="error">{publicModelError}</Alert> : null}
              {!publicModels.length && !publicModelLoading && !publicModelError ? <Alert severity="info">暂无模型价格</Alert> : null}
              {isAce && publicModels.length > 0 && visibleAceModels.length === 0 ? <Alert severity="info">此分类暂无模型</Alert> : null}
              {publicModels.length && isAce ? (
                <AdminTableFrame minWidth={850}>
                  <Table size="small">
                    <TableHead><TableRow><TableCell>模型</TableCell><TableCell>分类</TableCell><TableCell>品牌</TableCell><TableCell>ACE 价格（积分）</TableCell><TableCell><Checkbox size="small" checked={selectableAceModels.length > 0 && enabledAceModelCount === selectableAceModels.length} indeterminate={enabledAceModelCount > 0 && enabledAceModelCount < selectableAceModels.length} disabled={selectableAceModels.length === 0 || aceModelSaving !== null || publicModelLoading} onChange={(_event, checked) => void toggleVisibleAceModels(checked)} slotProps={{ input: { 'aria-label': '启用当前筛选的全部可用模型' } }} />启用</TableCell><TableCell>状态</TableCell><TableCell>更新时间</TableCell></TableRow></TableHead>
                    <TableBody>{visibleAceModels.map((row) => {
                      return <TableRow key={String(row.modelName)}>
                        <TableCell sx={{ overflowWrap: 'anywhere', maxWidth: 330 }}>{String(row.displayName)}<Typography variant="caption" sx={{ display: 'block' }}>{String(row.modelName)}</Typography></TableCell>
                        <TableCell>{ACE_MODEL_TABS.find((item) => item.value === row.modality)?.label || String(row.modality)}</TableCell><TableCell>{String(row.providerName || '-')}</TableCell>
                        <TableCell>{formatAcePrice(row)}</TableCell>
                        <TableCell><Checkbox size="small" checked={row.callable === true && row.enabled === true} disabled={row.callable !== true || aceModelSaving !== null || publicModelLoading} onChange={(_event, checked) => void toggleAceModel(String(row.modelName), checked)} slotProps={{ input: { 'aria-label': `启用 ${String(row.displayName)}` } }} /></TableCell>
                        <TableCell><Chip size="small" variant="outlined" color={!row.callable ? 'error' : !row.enabled ? 'warning' : 'success'} label={!row.callable ? '不可用' : !row.enabled ? '已禁用' : '可用'} title={!row.callable ? '目录已下架或缺少受支持的接口、价格' : undefined} /></TableCell><TableCell>{row.pricingUpdatedAt ? new Date(Number(row.pricingUpdatedAt)).toLocaleString() : '-'}</TableCell>
                      </TableRow>;
                    })}</TableBody>
                  </Table>
                </AdminTableFrame>
              ) : publicModels.length && isNanoBanana ? (
                <AdminTableFrame minWidth={760}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: 300 }}>模型</TableCell>
                        <TableCell>价格($/次)</TableCell>
                        <TableCell>可用分组</TableCell>
                        <TableCell>端点</TableCell>
                        <TableCell>供应商</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {publicModels.map((row, rowIndex) => (
                        <TableRow key={String(row.id || `${getPublicModelRowModelName(row)}-${rowIndex}`)}>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 800, wordBreak: 'break-word' }}>
                              {getPublicModelRowModelName(row)}
                            </Typography>
                          </TableCell>
                          <TableCell>{formatDollarAmount(row.requestPrice ?? row.request_price, 6)}</TableCell>
                          <TableCell>
                            {Array.isArray(row.enableGroups)
                              ? row.enableGroups.join('、')
                              : Array.isArray(row.enable_groups)
                                ? row.enable_groups.join('、')
                                : '-'}
                          </TableCell>
                          <TableCell>
                            {Array.isArray(row.endpointTypes)
                              ? row.endpointTypes.join('、')
                              : Array.isArray(row.endpoint_types)
                                ? row.endpoint_types.join('、')
                                : '-'}
                          </TableCell>
                          <TableCell>{getPublicModelRowProviderLabel(row)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AdminTableFrame>
              ) : publicModels.length ? (
                <AdminTableFrame minWidth={980}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: 260 }}>模型</TableCell>
                        <TableCell>供应商</TableCell>
                        <TableCell>倍率</TableCell>
                        <TableCell>输入($/百万)</TableCell>
                        <TableCell>输出($/百万)</TableCell>
                        <TableCell>缓存写入($/百万)</TableCell>
                        <TableCell>缓存读取($/百万)</TableCell>
                        <TableCell>请求价($)</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {publicModelGroups.flatMap((group) => group.rows.map((row, rowIndex) => {
                        const billingSelected = getPublicModelRowBillingSelected(row);
                        return (
                          <TableRow
                            key={String(row.id || `${group.modelName}-${getPublicModelRowProviderCode(row) || getPublicModelRowProviderLabel(row)}-${rowIndex}`)}
                            sx={billingSelected ? {
                              '& > td': {
                                bgcolor: 'rgba(46, 125, 50, 0.08)',
                              },
                            } : undefined}
                          >
                            {rowIndex === 0 ? (
                              <TableCell
                                rowSpan={group.rows.length}
                                sx={{
                                  verticalAlign: 'top',
                                  borderRight: 1,
                                  borderRightColor: 'divider',
                                  bgcolor: 'action.hover',
                                }}
                              >
                                <Typography variant="body2" sx={{ fontWeight: 800, wordBreak: 'break-word' }}>
                                  {group.modelName}
                                </Typography>
                                {group.displayName ? (
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}>
                                    {group.displayName}
                                  </Typography>
                                ) : null}
                                {group.rows.length > 1 ? (
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                    {group.rows.length} 家上游
                                  </Typography>
                                ) : null}
                              </TableCell>
                            ) : null}
                            <TableCell>
                              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                <Typography variant="body2" sx={{ fontWeight: billingSelected ? 800 : 400 }}>
                                  {getPublicModelRowProviderLabel(row)}
                                </Typography>
                                {billingSelected ? (
                                  <Box
                                    component="span"
                                    sx={{
                                      px: 0.75,
                                      py: 0.125,
                                      borderRadius: 999,
                                      bgcolor: 'success.main',
                                      color: 'success.contrastText',
                                      fontSize: 12,
                                      fontWeight: 800,
                                      lineHeight: 1.6,
                                    }}
                                  >
                                    计费
                                  </Box>
                                ) : null}
                              </Stack>
                              <Typography variant="caption" color="text.secondary">{getPublicModelRowProviderCode(row)}</Typography>
                            </TableCell>
                            <TableCell>{formatOptionalPlainNumber(row.rateMultiplier ?? row.rate_multiplier, 4)}</TableCell>
                            <TableCell>{formatDollarAmount(row.inputTokenPrice ?? row.input_token_price, 6)}</TableCell>
                            <TableCell>{formatDollarAmount(row.outputTokenPrice ?? row.output_token_price, 6)}</TableCell>
                            <TableCell>{formatDollarAmount(row.cacheCreationTokenPrice ?? row.cache_creation_token_price, 6)}</TableCell>
                            <TableCell>{formatDollarAmount(row.cacheReadTokenPrice ?? row.cache_read_token_price, 6)}</TableCell>
                            <TableCell>{formatDollarAmount(row.requestPrice ?? row.request_price, 6)}</TableCell>
                          </TableRow>
                        );
                      }))}
                    </TableBody>
                  </Table>
                </AdminTableFrame>
              ) : null}
            </Stack>
          </AdminSection>
        </Stack>
      ) : tab === userManagementTabIndex ? (
        usesInternalLedger ? (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField size="small" label="搜索用户" value={userBalanceSearch} onChange={(e) => setUserBalanceSearch(e.target.value)} sx={{ width: { xs: 180, sm: 260 } }} />
              <Button variant="contained" disabled={userBalanceLoading} onClick={() => void loadUserBalances(0, userBalanceRowsPerPage)} sx={{ minWidth: 88, height: 40 }}>查询</Button>
            </Stack>
            <AdminSection title="通用点数" bodySx={{ p: 0 }}>
            <AdminTableFrame minWidth={760}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>用户</TableCell>
                    <TableCell>手机号</TableCell>
                    <TableCell>剩余点数</TableCell>
                    <TableCell>已用点数</TableCell>
                    <TableCell>请求数</TableCell>
                    <TableCell>最近调用</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {!userBalances.length && !userBalanceLoading ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <Alert severity="info">暂无用户额度记录</Alert>
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {userBalances.map((item) => (
                    <TableRow key={String(item.id)} hover onClick={() => openUserUsageDialog(item)} sx={{ cursor: 'pointer' }}>
                      <TableCell>{String(item.nickname || item.id || '-')}</TableCell>
                      <TableCell>{String(item.phone || '-')}</TableCell>
                      <TableCell>{formatPoint(item.balanceAmount ?? item.balance_amount, providerCode)}</TableCell>
                      <TableCell>{formatPoint(item.usedAmount ?? item.used_amount, providerCode)}</TableCell>
                      <TableCell>{String(item.requestCount ?? item.request_count ?? 0)}</TableCell>
                      <TableCell>{formatTime(item.last_used_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </AdminTableFrame>
            </AdminSection>
            <TablePagination
              component="div"
              count={userBalanceTotal}
              page={userBalancePage}
              rowsPerPage={userBalanceRowsPerPage}
              rowsPerPageOptions={[10, 20, 50, 100]}
              labelRowsPerPage="每页"
              labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
              onPageChange={(_event, nextPage) => void loadUserBalances(nextPage, userBalanceRowsPerPage)}
              onRowsPerPageChange={(event) => {
                const nextRowsPerPage = Number(event.target.value);
                void loadUserBalances(0, nextRowsPerPage);
              }}
            />
          </Stack>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <TextField size="small" label="分组 ID" value={keySearch.typeId} onChange={(e) => setKeySearch((prev) => ({ ...prev, typeId: e.target.value }))} sx={{ width: { xs: 132, sm: 180 } }} />
              <TextField size="small" label="搜索关键字" value={keySearch.keyword} onChange={(e) => setKeySearch((prev) => ({ ...prev, keyword: e.target.value }))} sx={{ width: { xs: 156, sm: 260 } }} />
              <Button variant="contained" disabled={keyLoading} onClick={() => void loadKeys()} sx={{ minWidth: 88, height: 40 }}>查询</Button>
              <Box sx={{ flex: 1 }} />
              <Button variant="contained" onClick={() => setCreateDialogOpen(true)} sx={{ minWidth: 88, height: 40 }}>创建</Button>
            </Stack>
            <AdminSection title="Key 列表" bodySx={{ p: 0 }}>
            <AdminTableFrame minWidth={980}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>ID</TableCell>
                    <TableCell>Key</TableCell>
                    <TableCell>分组</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>点数</TableCell>
                    <TableCell>每日</TableCell>
                    <TableCell>每月</TableCell>
                    <TableCell>备注</TableCell>
                    <TableCell>更新时间</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {keys.map((item) => (
                    <TableRow key={String(item.id || item.key)}>
                      <TableCell>{String(item.id || '')}</TableCell>
                      <TableCell>{String(item.key || '')}</TableCell>
                      <TableCell>{String(item.type_id || '')}</TableCell>
                      <TableCell>{String(item.enabled ?? '')}</TableCell>
                      <TableCell>{formatPoint(item.point, providerCode)}</TableCell>
                      <TableCell>{String(item.daily_quota ?? '')}</TableCell>
                      <TableCell>{String(item.monthly_quota ?? '')}</TableCell>
                      <TableCell>{String(item.note || '')}</TableCell>
                      <TableCell>{String(item.updated_at || '')}</TableCell>
                      <TableCell><Button size="small" onClick={() => openUpdateDialog(item)}>修改</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </AdminTableFrame>
            </AdminSection>
          </Stack>
        )
      ) : (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              label="分组"
              value={usageStatsFilters.groupBy}
              onChange={(e) => {
                const nextGroupBy = isUsageStatsGroupBy(e.target.value) ? e.target.value : 'usage_type';
                writeStoredUsageStatsGroupBy(providerCode, nextGroupBy);
                setUsageStatsFilters((prev) => ({ ...prev, groupBy: nextGroupBy }));
              }}
              sx={{ width: 140 }}
            >
              <MenuItem value="usage_type">用途</MenuItem>
              <MenuItem value="model">模型</MenuItem>
              <MenuItem value="user">用户</MenuItem>
              <MenuItem value="day">日期</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="用途类型"
              value={usageStatsFilters.usageType}
              onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, usageType: e.target.value }))}
              sx={{ width: 180 }}
            >
              <MenuItem value="">全部</MenuItem>
              {Object.entries(AI_USAGE_TYPE_LABELS).filter(([key]) => key !== 'unknown').map(([key, label]) => (
                <MenuItem key={key} value={key}>{label}</MenuItem>
              ))}
            </TextField>
            <TextField size="small" label="模型" value={usageStatsFilters.model} onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, model: e.target.value }))} sx={{ width: 180 }} />
            <TextField size="small" label="关键字" value={usageStatsFilters.search} onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, search: e.target.value }))} sx={{ width: { xs: 180, sm: 240 } }} />
            <TextField
              select
              size="small"
              label="状态"
              value={usageStatsFilters.status}
              onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, status: e.target.value }))}
              sx={{ width: 120 }}
            >
              <MenuItem value="">全部</MenuItem>
              <MenuItem value="failed">失败</MenuItem>
            </TextField>
            <TextField
              size="small"
              label="开始时间"
              type="datetime-local"
              value={usageStatsFilters.from}
              onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, from: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 220 }}
            />
            <TextField
              size="small"
              label="结束时间"
              type="datetime-local"
              value={usageStatsFilters.to}
              onChange={(e) => setUsageStatsFilters((prev) => ({ ...prev, to: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ width: 220 }}
            />
            <Button variant="contained" disabled={usageStatsLoading} onClick={() => void loadUsageStats(0, usageStatsRowsPerPage)} sx={{ minWidth: 88, height: 40 }}>查询</Button>
            <Button
              variant="outlined"
              disabled={usageStatsLoading}
              onClick={() => {
                const nextFilters = {
                  ...DEFAULT_USAGE_STATS_FILTERS,
                  usageType: '',
                  model: '',
                  search: '',
                  status: '',
                  from: '',
                  to: '',
                };
                writeStoredUsageStatsGroupBy(providerCode, nextFilters.groupBy);
                setUsageStatsFilters(nextFilters);
                void loadUsageStats(0, usageStatsRowsPerPage, nextFilters);
              }}
              sx={{ minWidth: 88, height: 40 }}
            >
              重置
            </Button>
          </Stack>
          {usageStats ? (
            <Alert severity="info">
              调用 {formatCount(usageStats.totals?.requestCount)}，失败 {formatCount(usageStats.totals?.failedCount)}，输入 {formatCount(usageStats.totals?.inputTokens)}，输出 {formatCount(usageStats.totals?.outputTokens)}，实扣 {formatPoint(usageStats.totals?.chargedAmount, providerCode)}
            </Alert>
          ) : null}
          <AdminSection title="用量统计" bodySx={{ p: 0 }}>
          <AdminTableFrame minWidth={1200}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>维度</TableCell>
                  <TableCell>调用数</TableCell>
                  <TableCell>失败</TableCell>
                  <TableCell>输入</TableCell>
                  <TableCell>输出</TableCell>
                  <TableCell>总量</TableCell>
                  <TableCell>计费</TableCell>
                  <TableCell>实扣</TableCell>
                  <TableCell>平均耗时</TableCell>
                  <TableCell>最近调用</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {!usageStats?.items.length && !usageStatsLoading ? (
                  <TableRow>
                    <TableCell colSpan={10}>
                      <Alert severity="info">暂无用量统计</Alert>
                    </TableCell>
                  </TableRow>
                ) : null}
                {usageStats?.items.map((row) => (
                  <TableRow key={String(row.groupKey || row.group_key || row.label || row.model || row.userId || row.user_id || 'usage-row')}>
                    <TableCell>
                      <Stack spacing={0}>
                        <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>{String(row.label || row.groupKey || row.group_key || '-')}</Typography>
                        {row.subLabel ? <Typography variant="caption" color="text.secondary">{String(row.subLabel)}</Typography> : null}
                      </Stack>
                    </TableCell>
                    <TableCell>{formatCount(row.requestCount ?? row.request_count)}</TableCell>
                    <TableCell>{formatCount(row.failedCount ?? row.failed_count)}</TableCell>
                    <TableCell>{formatCount(row.inputTokens ?? row.input_tokens)}</TableCell>
                    <TableCell>{formatCount(row.outputTokens ?? row.output_tokens)}</TableCell>
                    <TableCell>{formatCount(row.totalTokens ?? row.total_tokens)}</TableCell>
                    <TableCell>{formatPoint(row.billableAmount ?? row.billable_amount, providerCode)}</TableCell>
                    <TableCell>{formatPoint(row.chargedAmount ?? row.charged_amount, providerCode)}</TableCell>
                    <TableCell>{formatCount(row.averageLatencyMs ?? row.average_latency_ms)} ms</TableCell>
                    <TableCell>{formatTime(row.lastUsedAt ?? row.last_used_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AdminTableFrame>
          </AdminSection>
          <TablePagination
            component="div"
            count={toPageTotal(usageStats?.total)}
            page={usageStatsPage}
            rowsPerPage={usageStatsRowsPerPage}
            rowsPerPageOptions={[USAGE_STATS_PAGE_SIZE]}
            labelRowsPerPage="每页"
            labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
            onPageChange={(_event, nextPage) => {
              setUsageStatsPage(nextPage);
              void loadUsageStats(nextPage, usageStatsRowsPerPage);
            }}
            onRowsPerPageChange={undefined}
          />
        </Stack>
      )}

      {tab === 0 ? (
        <Button
          variant="contained"
          disabled={saving || (isAce && (aceConnectionLoading || !aceConnectionLoaded || !aceConnection.apiBaseUrl.trim() || (aceConnection.status === 'active' && !aceConnection.apiKeyConfigured && !aceConnection.apiKey.trim())))}
          onClick={() => void saveConfig()}
          sx={{
            position: 'fixed',
            right: { xs: 16, md: 32 },
            bottom: { xs: 16, md: 32 },
            zIndex: (theme) => theme.zIndex.drawer + 1,
            boxShadow: 6,
          }}
        >
          保存配置
        </Button>
      ) : null}
      <AdminAiUserUsageDialog
        open={Boolean(selectedBalanceUser)}
        user={selectedBalanceUser}
        providerCode={providerCode}
        onClose={() => setSelectedBalanceUser(null)}
        onTransferPoints={async (userId, amount, reason) => {
          const result = await adminApi.transferAiProviderUserPoints(providerCode, userId, { amount, reason });
          const balanceAfter = Number(result.balanceAfter);
          if (Number.isFinite(balanceAfter)) {
            setSelectedBalanceUser((prev) => prev ? { ...prev, balanceAmount: balanceAfter, balance_amount: balanceAfter } : prev);
          }
          await loadUserBalances(userBalancePage, userBalanceRowsPerPage);
          return result;
        }}
        onChanged={() => loadUserBalances(userBalancePage, userBalanceRowsPerPage)}
        sharedPointMode={usesInternalLedger}
      />
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>创建 Key</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 1 }}>
            <TextField
              label="分组 ID"
              value={keyCreate.typeId}
              onChange={(e) => setKeyCreate((prev) => ({ ...prev, typeId: e.target.value }))}
            />
            <TextField label="备注" value={keyCreate.note} onChange={(e) => setKeyCreate((prev) => ({ ...prev, note: e.target.value }))} />
            <TextField label="初始点数" value={keyCreate.grantAmount} onChange={(e) => setKeyCreate((prev) => ({ ...prev, grantAmount: e.target.value }))} />
            <TextField label="每日额度" value={keyCreate.dailyQuota} onChange={(e) => setKeyCreate((prev) => ({ ...prev, dailyQuota: e.target.value }))} />
            <TextField label="每月额度" value={keyCreate.monthlyQuota} onChange={(e) => setKeyCreate((prev) => ({ ...prev, monthlyQuota: e.target.value }))} />
            <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => setCreateDialogOpen(false)}>取消</Button>
              <Button variant="contained" disabled={keyLoading} onClick={() => void createKey()}>创建</Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>
      <Dialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>更新 Key</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 1 }}>
            <TextField label="Key ID" value={keyAction.externalKeyId} disabled />
            <FormControlLabel control={<Switch checked={keyAction.enabled} onChange={(e) => setKeyAction((prev) => ({ ...prev, enabled: e.target.checked }))} />} label="启用" />
            <TextField label="备注" value={keyAction.note} onChange={(e) => setKeyAction((prev) => ({ ...prev, note: e.target.value }))} />
            <TextField label="每日额度" value={keyAction.dailyQuota} onChange={(e) => setKeyAction((prev) => ({ ...prev, dailyQuota: e.target.value }))} />
            <TextField label="每月额度" value={keyAction.monthlyQuota} onChange={(e) => setKeyAction((prev) => ({ ...prev, monthlyQuota: e.target.value }))} />
            <TextField label="每分钟次数" value={keyAction.minuteTimes} onChange={(e) => setKeyAction((prev) => ({ ...prev, minuteTimes: e.target.value }))} />
            <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button onClick={() => setUpdateDialogOpen(false)}>取消</Button>
              <Button variant="contained" disabled={keyLoading} onClick={() => void updateKey()}>保存</Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
