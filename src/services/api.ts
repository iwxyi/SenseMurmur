// HTTP API client for chat backend

import type { BubbleStyleDefinition } from '../types/bubbleStyle';
import type { AICharacter, CharacterVisualIdentity, CharacterVisualReferenceImage } from '../types/character';
import type { ConversationMode } from '../types/chat';
import type { Message } from '../types/message';
import type { AssistantArtifactItem } from '../types/assistantArtifact';
import { dispatchAuthSessionExpired } from './authSession';
import { backendUrl } from './backendUrl';
import { assertWorkspaceActive, getResponseWorkspaceSignal, getWorkspaceSignal, workspaceFetch as fetch } from './workspaceLifecycle';
import { readAuthSnapshot, updateAuthSnapshot } from './authSnapshot';

const API_BASE = '/api';
const AI_BALANCE_CACHE_TTL_MS = 60_000;

export interface AuthUserResponse {
  id: string;
  phone: string;
  nickname: string;
  avatar: string;
  cloudSyncEntitled?: boolean;
  cloudStorageBytes?: number;
  cloudStorageMembershipBytes?: number;
  cloudStorageAccountBytes?: number;
  cloudStorageGrants?: Array<{ bytes: number; expiresAt: number | null }>;
  assistantArtifactCloudSyncEntitled?: boolean;
  aiProxyEntitled?: boolean;
  agentEntitled?: boolean;
  aiSearchEntitled?: boolean;
  alapiDoutuEnabled?: boolean;
  marketAccessEntitled?: boolean;
  marketUploadEntitled?: boolean;
  chatShareEntitled?: boolean;
  developerModeEntitled?: boolean;
  retentionLimits?: Record<string, { storage: number; recall: number }>;
}

export interface TopicSourceSummary {
  id: string;
  label: string;
  status: 'ok' | 'degraded' | 'unavailable';
  note?: string;
}

export interface TopicItem {
  id: string;
  title: string;
  subtitle?: string;
  url?: string;
  heat?: string;
  source: string;
  fetchedAt: number;
  status: 'ok' | 'degraded' | 'unavailable';
}

export interface TopicAdaptationCharacterSuggestion {
  name: string;
  description: string;
}

export interface TopicAdaptationResult {
  suggestedName?: string;
  suggestedTopic?: string;
  suggestedStyle?: 'free' | 'debate' | 'brainstorm' | 'roleplay';
  suggestedMemberIds?: string[];
  recommendedCharacters?: TopicAdaptationCharacterSuggestion[];
}

export interface OfficialAiProviderInfo {
  code: string;
  name: string;
  officialProvider: string;
  label: string;
  family: string;
  defaultModel: string;
  imageDefaultModel?: string;
  hidden?: boolean;
  sortOrder?: number;
  defaultForAssignment?: boolean;
  billingMode?: string;
  capabilities?: Record<string, unknown>;
  accessAllowed?: boolean;
  accessTierCode?: string;
}

export interface OfficialAiModelInfo {
  id: string;
  label?: string;
  metadata?: Record<string, unknown> | null;
}

export interface AiMediaTask {
  task_id: string;
  model: string;
  status: 'submitting' | 'running' | 'submission_unknown' | 'billing_pending' | 'succeeded' | 'failed';
  result: unknown;
  chargedAmount: number | null;
  reservedAmount: number;
  createdAt: number;
  updatedAt: number;
}

export interface VipEntitlementInfo {
  description?: string;
  benefitsMarkdown?: string;
  maxCharacters: number | null;
  maxChats: number | null;
  maxGroupMembers: number | null;
  dailyAiGenerationLimit: number | null;
  batchGenerationLimit: number | null;
  officialProviderAccess: string[];
  aiBillingDiscount: number;
  dailyPointGrant: number;
  monthlyPointGrant: number;
  cloudSyncEnabled: boolean;
  cloudStorageBytes: number;
  maxFileSizeBytes: number;
  assistantArtifactCloudSync: boolean;
  aiProxyEnabled: boolean;
  agentEnabled: boolean;
  aiSearchEnabled: boolean;
  marketAccessEnabled: boolean;
  marketUploadEnabled: boolean;
  chatShareEnabled: boolean;
  developerModeEnabled: boolean;
  retentionLimits?: Record<string, { storage: number; recall: number }>;
}

export interface AiSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
  siteIcon?: string;
  publishedAt?: string;
  imageUrls?: string[];
}

export interface AiSearchResponse {
  query: string;
  providerCode: string;
  pointCost: number;
  balanceAfter?: number | null;
  results: AiSearchResultItem[];
}

export interface NetworkResourceResponse {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

export interface NetworkDirectoryResponse {
  rootUrl: string;
  files: Array<{ url: string; path: string; sizeBytes: number }>;
  truncated: boolean;
  transferToken: string;
}

export interface AlapiDoutuResponse {
  keyword: string;
  imageUrl: string;
  pointCost: number;
  balanceAfter?: number | null;
}

export interface ChatRecordSearchResponse {
  query: string;
  source: 'cloud';
  totalCount: number;
  returnedCount: number;
  hasMore: boolean;
  limit: number;
  offset: number;
  sortBy: 'relevance' | 'time_desc' | 'time_asc';
  matches: Array<{
    chatId: string;
    chatName: string;
    chatType: 'group' | 'direct' | 'assistant' | 'ai_direct';
    chatMode?: ConversationMode;
    scenarioId?: string;
    messageId: string;
    timestamp: number;
    senderName: string;
    snippet: string;
    matchedKeywords: string[];
    score: number;
  }>;
}

export interface AiUsageRecordItem {
  id: string;
  usageType?: string | null;
  usageLabel?: string | null;
  sourceType?: string | null;
  model?: string | null;
  amount: number;
  balanceAfter?: number | null;
  chargedAmount?: number | null;
  billingUnit?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  createdAt: number;
}

export interface AiUsageRecordsResponse {
  page: number;
  limit: number;
  total: number;
  items: AiUsageRecordItem[];
}

export interface AiUsageSummaryItem {
  groupKey: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chargedAmount: number;
  lastUsedAt?: number | null;
}

export interface AiUsageSummaryResponse {
  groupBy: 'day' | 'month';
  page: number;
  limit: number;
  total: number;
  totals?: Record<string, unknown>;
  items: AiUsageSummaryItem[];
}

export interface AiProxyKeyItem {
  id: string;
  name: string;
  keyMask: string;
  status: 'active' | 'disabled' | 'revoked' | string;
  allowedModels: string[] | null;
  dailyQuota: number | null;
  monthlyQuota: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastUsedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  usage?: {
    todayChargedAmount?: number;
    monthChargedAmount?: number;
    totalChargedAmount?: number;
    requestCount?: number;
    lastUsedAt?: number | null;
  } | null;
}

export interface AiProxyKeyCreateResponse {
  key: AiProxyKeyItem;
  rawKey: string;
}

export interface AiProxySetupScriptResponse {
  target: 'codex' | 'claude' | 'deepseek';
  platform: 'posix' | 'windows';
  script: string;
}

export interface AiProxyUsageRecordItem {
  id: string;
  keyId: string | null;
  keyName: string | null;
  model: string;
  upstreamModel: string;
  protocol: string | null;
  status: string;
  httpStatus: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chargedAmount: number;
  billingUnit: string | null;
  errorCode: string | null;
  createdAt: number;
}

export interface AiProxyUsageRecordsResponse {
  page: number;
  limit: number;
  total: number;
  items: AiProxyUsageRecordItem[];
}

export interface AiProxyUsageGroupItem {
  groupKey: string;
  requestCount: number;
  successCount: number;
  failedCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chargedAmount: number;
  lastUsedAt?: number | null;
}

export interface AiProxyUsageGroupsResponse {
  groupBy: 'day' | 'month';
  page: number;
  limit: number;
  total: number;
  items: AiProxyUsageGroupItem[];
}

export interface SystemAnnouncementItem {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error' | 'success' | string;
  audienceType?: 'all' | 'users' | string;
  audienceInactiveMonths?: number | null;
  startsAt: number | null;
  endsAt: number | null;
  pinnedEnabled: boolean;
  popupEnabled: boolean;
  sortOrder: number;
  updatedAt: number;
  createdAt: number;
}

export interface BillingPlanItem {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  plan_kind?: string | null;
  billing_type?: string | null;
  price_amount: number | string;
  currency: string;
  duration_days?: number | string | null;
  grant_points?: number | string | null;
  ai_enabled?: boolean | number | string;
  featured?: boolean | number | string;
  sort_order?: number | string | null;
  metadata?: Record<string, unknown> | string | null;
}

export interface BillingMembershipTier {
  code: string;
  name: string;
  rank: number;
  enabled?: boolean;
  description?: string;
  conversionRatio?: number;
  benefitsMarkdown?: string;
}

export interface BillingMembershipConfig {
  title: string;
  subtitle: string;
  description: string;
  benefits: string[];
  fulfillmentNote: string;
  tiers?: BillingMembershipTier[];
  entitlements?: Record<string, VipEntitlementInfo>;
}

export interface SitePublicConfig {
  siteName: string;
  siteTitle: string;
  siteDescription: string;
  faviconUrl: string;
  themeColor: string;
}

export interface CaptchaPublicConfig {
  enabled: boolean;
  provider: 'turnstile' | string;
  siteKey: string;
  smsMock?: boolean;
}

export interface BillingOrderItem {
  id: string;
  order_no?: string;
  orderNo?: string;
  status: string;
  order_type?: string | null;
  orderType?: string | null;
  amount: number | string;
  currency: string;
  payment_channel?: string | null;
  paymentChannel?: string | null;
  paid_at?: number | string | null;
  paidAt?: number | string | null;
  created_at?: number | string;
  createdAt?: number | string;
  plan_code?: string | null;
  planCode?: string | null;
  plan_name?: string | null;
  planName?: string | null;
  plan_kind?: string | null;
  planKind?: string | null;
  grant_points?: number | string | null;
  grantPoints?: number | string | null;
}

export interface BillingSubscriptionItem {
  id: string;
  status: string;
  planCode?: string | null;
  planName?: string | null;
  startedAt?: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  autoRenew?: boolean;
  benefits?: string[];
  features?: string[];
  vipTierCode?: string;
  vipTierName?: string;
  vipTierRank?: number;
}

export interface BillingMembershipResponse {
  vipActive: boolean;
  activeSubscription: BillingSubscriptionItem | null;
  latestSubscription: BillingSubscriptionItem | null;
  recentOrders: BillingOrderItem[];
  vipEntitlement?: {
    tierCode: string;
    entitlement: VipEntitlementInfo;
  };
  dailyAiGenerationUsage?: {
    usageDate: string;
    used: number;
  };
  usage?: {
    characters: number;
    chats: number;
    cloudStorageBytes: number;
  };
  pointClaimStatus?: {
    tierCode: string;
    daily: { period: string; amount: number; claimed: boolean; claimedAt?: number | string | null };
    monthly: { period: string; amount: number; claimed: boolean; claimedAt?: number | string | null };
  };
}

export interface BillingPointClaimResponse {
  claim: {
    id: string;
    kind: 'daily' | 'monthly';
    period: string;
    amount: number;
    balanceAfter: number;
    tierCode: string;
    claimedAt: number;
  };
  pointClaimStatus: NonNullable<BillingMembershipResponse['pointClaimStatus']>;
}

export interface BillingPaymentResponse {
  order: BillingOrderItem;
  status: string;
  channel: string | null;
  message?: string;
  paymentUrl?: string;
  formHtml?: string;
  formAction?: string;
  formFields?: Record<string, string>;
}

export interface CharacterArtifactSyncEntry {
  id: string;
  kind: 'birth_letter' | 'diary' | 'final_letter';
  characterId: string;
  characterName: string;
  dateKey?: string | null;
  sourceKey?: string | null;
  title: string;
  text: string;
  source: 'ai' | 'local';
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  revision?: number;
  generationSnapshot?: {
    promptVersion: 'character-experience-artifacts-v2';
    character: Partial<AICharacter>;
    relatedCharacters: Array<{ id: string; name: string }>;
    generatedAt: number;
  };
}

export type CharacterArtifactSyncKind = CharacterArtifactSyncEntry['kind'];

export interface CharacterArtifactSummaryEntry extends Omit<CharacterArtifactSyncEntry, 'text' | 'generationSnapshot'> {
  deletedAt?: number | null;
  revision?: number;
}

export interface CharacterArtifactQuery {
  kind?: CharacterArtifactSyncKind;
  characterId?: string;
  dateFrom?: string;
  dateTo?: string;
  includeDeleted?: boolean;
}

export type SyncChangeScope =
  | 'characters.summary'
  | `characters.detail:${string}`
  | 'chats.summary'
  | `chats.detail:${string}`
  | `messages.window:${string}`
  | 'world-runtime.window'
  | 'artifacts.summary'
  | `artifacts.summary:${string}`
  | `assistant-artifacts:${string}`
  | 'settings.account';

export interface SyncChangesResponse {
  status: 'modified' | 'not_modified' | 'reset_required';
  scope: SyncChangeScope;
  cursor: string;
  revision: string;
  changes: Array<Record<string, unknown>>;
  hasMore?: boolean;
  code?: string;
  resetReason?: string;
  minAvailableCursor?: string;
  retentionMs?: number;
}

export interface ChatShareState {
  enabled: boolean;
  token: string | null;
  viewerCount: number;
}

export interface PublicChatShareResponse {
  chat: {
    name: string;
    updatedAt: number;
    lastMessageAt: number;
  };
  members: Array<{
    id: string;
    name: string;
    avatar: string;
    personality?: Record<string, number>;
    expertise?: string[];
    speakingStyle?: string;
    background?: string;
    speechProfile?: Record<string, unknown> | null;
    bubbleStyle?: BubbleStyleDefinition | null;
    bubbleStyleId?: string | null;
    isPreset?: boolean;
  }>;
  messages: Message[];
  hasMore: boolean;
}

export class ApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, options?: { code?: string; status?: number }) {
    super(message);
    this.name = 'ApiError';
    this.code = options?.code;
    this.status = options?.status;
  }
}

const AUTH_EXPIRED_CODES = new Set([
  'AUTH_EXPIRED',
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'UNAUTHORIZED',
]);

function shouldExpireAuthSession(status: number, code?: string) {
  return status === 401 || Boolean(code && AUTH_EXPIRED_CODES.has(code.toUpperCase()));
}

class ApiClient {
  private aiBalanceCache = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();
  private aiBalanceInFlight = new Map<string, Promise<Record<string, unknown>>>();
  private authRefreshInFlight: Promise<boolean> | null = null;
  private authRefreshFailure: { reason: 'refresh_token_missing' | 'refresh_rejected' | 'refresh_network_error' | 'refresh_response_invalid'; status?: number; diagnostic?: string } | null = null;

  private getToken(): string | null {
    return readAuthSnapshot().token;
  }

  getAccessTokenExpiresAt(token = this.getToken()): number | null {
    if (!token) return null;
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { exp?: unknown };
      return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const signal = getResponseWorkspaceSignal(response);
    assertWorkspaceActive(signal);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const result = await response.json() as T;
      assertWorkspaceActive(signal);
      return result;
    }
    const text = await response.text().catch(() => '');
    const normalized = text.trimStart().toLowerCase();
    const isHtml = normalized.startsWith('<!doctype') || normalized.startsWith('<html');
    throw new ApiError(
      isHtml ? '接口返回了前端页面，请检查后端服务或开发代理配置' : '接口返回了非 JSON 响应',
      { status: response.status, code: 'INVALID_API_RESPONSE' },
    );
  }

  private async refreshAuthSession(): Promise<boolean> {
    const workspaceSignal = getWorkspaceSignal();
    assertWorkspaceActive(workspaceSignal);
    if (this.authRefreshInFlight) return this.authRefreshInFlight;
    const expected = readAuthSnapshot();
    const refreshToken = expected.refreshToken;
    this.authRefreshFailure = null;
    if (!refreshToken) {
      this.authRefreshFailure = { reason: 'refresh_token_missing', diagnostic: 'refresh token is not present in local storage' };
      return false;
    }
    this.authRefreshInFlight = (async () => {
      try {
        const response = await fetch(backendUrl(`${API_BASE}/auth/refresh`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) {
          // Another tab may have rotated the token while this request was in flight.
          // Re-read storage before treating the session as expired.
          const currentRefreshToken = readAuthSnapshot().refreshToken;
          const rotated = Boolean(currentRefreshToken && currentRefreshToken !== refreshToken && this.getToken());
          if (!rotated) {
            const payload = await response.json().catch(() => ({})) as { code?: unknown };
            assertWorkspaceActive(workspaceSignal);
            const code = typeof payload.code === 'string' && AUTH_EXPIRED_CODES.has(payload.code.toUpperCase()) ? payload.code.toUpperCase() : '';
            this.authRefreshFailure = {
              reason: 'refresh_rejected',
              status: response.status,
              diagnostic: code || `HTTP ${response.status}`,
            };
          }
          return rotated;
        }
        const result = await this.parseJsonResponse<{ token: string; refreshToken: string; user?: AuthUserResponse }>(response);
        assertWorkspaceActive(workspaceSignal);
        // Logout or another login can finish while the refresh body is read.
        if (readAuthSnapshot().refreshToken !== refreshToken) return false;
        if (typeof result.token !== 'string' || !result.token || typeof result.refreshToken !== 'string' || !result.refreshToken) {
          this.authRefreshFailure = { reason: 'refresh_response_invalid', status: response.status, diagnostic: 'refresh response did not contain token fields' };
          return false;
        }
        await updateAuthSnapshot(expected, (current) => {
          assertWorkspaceActive(workspaceSignal);
          if (current.refreshToken !== refreshToken) return current;
          if (current.user && result.user && current.user.id !== result.user.id) {
            throw new ApiError('续期返回的账号不匹配', { code: 'INVALID_API_RESPONSE', status: 502 });
          }
          return { ...current, token: result.token, refreshToken: result.refreshToken, user: result.user ?? current.user };
        });
        assertWorkspaceActive(workspaceSignal);
        return true;
      } catch (error) {
        assertWorkspaceActive(workspaceSignal);
        const currentRefreshToken = readAuthSnapshot().refreshToken;
        const rotated = Boolean(currentRefreshToken && currentRefreshToken !== refreshToken && this.getToken());
        if (!rotated) {
          this.authRefreshFailure = {
            reason: error instanceof ApiError ? 'refresh_response_invalid' : 'refresh_network_error',
            diagnostic: error instanceof ApiError ? 'refresh endpoint returned an invalid response' : 'refresh request could not complete',
          };
        }
        return rotated;
      }
    })().finally(() => {
      this.authRefreshInFlight = null;
    });
    return this.authRefreshInFlight;
  }

  /** Refresh before expiry so normal activity never reaches the expired-token path. */
  async refreshAuthIfNeeded(options: { force?: boolean } = {}): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;
    const expiresAt = this.getAccessTokenExpiresAt(token);
    if (expiresAt === null) return false;
    if (!options.force && expiresAt !== null && expiresAt - Date.now() > 5 * 60_000) return false;
    const refreshed = await this.refreshAuthSession();
    if (!refreshed && this.authRefreshFailure) console.warn('[auth] session refresh failed', this.authRefreshFailure);
    return refreshed;
  }

  getAuthRefreshDelayMs() {
    const expiresAt = this.getAccessTokenExpiresAt();
    if (expiresAt === null) return null;
    return Math.max(0, expiresAt - Date.now() - 5 * 60_000);
  }

  private async isAuthRejection(response: Response): Promise<boolean> {
    if (response.status === 401) return true;
    if (response.ok) return false;
    const error = await response.clone().json().catch(() => null) as { code?: unknown } | null;
    return typeof error?.code === 'string' && shouldExpireAuthSession(response.status, error.code);
  }

  /** Backend session requests, including streaming and multipart responses. */
  async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const workspaceSignal = getWorkspaceSignal();
    assertWorkspaceActive(workspaceSignal);
    const send = () => {
      const token = this.getToken();
      const headers = new Headers(options.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      else headers.delete('Authorization');
      return { token, response: fetch(url, { ...options, headers }) };
    };
    const initial = send();
    let response = await initial.response;
    assertWorkspaceActive(workspaceSignal);
    if (!await this.isAuthRejection(response)) return response;

    // A late 401 can belong to an access token that another request has
    // already renewed. Retry with the current token without renewing again.
    const currentToken = this.getToken();
    assertWorkspaceActive(workspaceSignal);
    const alreadyRefreshed = Boolean(currentToken && currentToken !== initial.token);
    const refreshed = alreadyRefreshed || await this.refreshAuthSession();
    if (refreshed) {
      assertWorkspaceActive(workspaceSignal);
      response = await send().response;
      const rejected = await this.isAuthRejection(response);
      assertWorkspaceActive(workspaceSignal);
      if (!rejected) return response;
    }

    const failure = refreshed ? null : this.authRefreshFailure;
    if (failure && (failure.reason === 'refresh_network_error' || failure.reason === 'refresh_response_invalid'
      || (failure.reason === 'refresh_rejected' && failure.status !== 401 && failure.status !== 403))) {
      console.warn('[auth] session refresh unavailable; retaining login', failure);
      throw new ApiError('登录续期暂时失败，请稍后重试', { code: 'AUTH_REFRESH_UNAVAILABLE', status: 503 });
    }
    assertWorkspaceActive(workspaceSignal);
    dispatchAuthSessionExpired({
      status: response.status,
      path: url,
      refreshStatus: failure?.status,
      reason: failure?.reason || 'access_token_rejected',
      diagnostic: failure?.diagnostic,
    });
    return response;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchWithAuth(backendUrl(`${API_BASE}${path}`), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error: { error?: string; detail?: string; code?: string } = await this.parseJsonResponse<{ error?: string; detail?: string; code?: string }>(response).catch(() => ({ error: '请求失败', code: 'REQUEST_FAILED' }));
      const detail = typeof error.detail === 'string' && error.detail ? ` (${error.detail})` : '';
      throw new ApiError(`${error.error || `HTTP ${response.status}`}${detail}`, { code: error.code, status: response.status });
    }

    return this.parseJsonResponse<T>(response);
  }

  async sendCode(phone: string, purpose: 'login' | 'register' | 'forgot-password' | 'change-phone' = 'login', captchaToken?: string) {
    return this.request<{ success: boolean; mock?: boolean; code?: string }>('POST', '/auth/send-code', { phone, purpose, captchaToken });
  }

  async sendChangePhoneCode(phone: string, captchaToken?: string) {
    return this.request<{ success: boolean; mock?: boolean; code?: string }>('POST', '/auth/change-phone/send-code', { phone, captchaToken });
  }

  async login(phone: string, code: string) {
    return this.request<{ token: string; refreshToken: string; user: AuthUserResponse }>('POST', '/auth/login', { phone, code });
  }

  async passwordLogin(phone: string, password: string) {
    return this.request<{ token: string; refreshToken: string; user: AuthUserResponse }>('POST', '/auth/password-login', { phone, password });
  }

  async logout(refreshToken?: string) {
    return this.request<{ success: boolean }>('POST', '/auth/logout', { refreshToken });
  }

  /** Logout must survive workspace cancellation and the subsequent page navigation. */
  async revokeAuthSession(token: string | null, refreshToken: string | null) {
    const response = await globalThis.fetch(backendUrl(`${API_BASE}/auth/logout`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ refreshToken }),
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new ApiError('退出会话撤销失败', { status: response.status });
  }

  async sendPasswordCode(captchaToken?: string) {
    return this.request<{ success: boolean; mock?: boolean; code?: string }>('POST', '/auth/password/send-code', { captchaToken });
  }

  async changePassword(data: { mode: 'old_password' | 'phone_code'; oldPassword?: string; code?: string; newPassword: string }) {
    return this.request<{ success: boolean }>('PUT', '/auth/password', data);
  }

  async getMe() {
    return this.request<AuthUserResponse>('GET', '/auth/me');
  }

  async updateMe(data: { nickname?: string; avatar?: string }) {
    return this.request<AuthUserResponse>('PUT', '/auth/me', data);
  }

  async changePhone(phone: string, code: string) {
    return this.request<AuthUserResponse>('PUT', '/auth/change-phone', { phone, code });
  }

  async getPlatformPublicConfig() {
    return this.request<{ site: SitePublicConfig; captcha?: CaptchaPublicConfig }>('GET', '/platform/public-config');
  }

  async getLoginCaptchaRequirement(phone: string) {
    return this.request<{ required: boolean }>('GET', `/auth/login-captcha-required?phone=${encodeURIComponent(phone)}`);
  }

  async getSystemAnnouncements() {
    return this.request<{ items: SystemAnnouncementItem[]; serverTime: number }>('GET', '/notifications/announcements');
  }

  async recordSystemAnnouncementReceipts(payload: { announcementIds: string[]; eventType: 'exposure' | 'popup_ack'; anonymousId?: string }) {
    return this.request<{ ok: boolean; accepted: number; serverTime: number }>('POST', '/notifications/announcements/receipts', payload);
  }

  async searchWeb(query: string, options?: { count?: number; freshness?: string; include?: string; exclude?: string; source?: string; resourceId?: string }) {
    return this.request<AiSearchResponse>('POST', '/search/web', {
      query,
      count: options?.count,
      freshness: options?.freshness,
      include: options?.include,
      exclude: options?.exclude,
      source: options?.source,
      resourceId: options?.resourceId,
    });
  }

  async fetchNetworkResource(url: string, mode: 'readable' | 'source' | 'download', timeoutMs = 20_000, transferToken?: string) {
    return this.request<NetworkResourceResponse>('POST', '/network/fetch', { url, mode, timeoutMs, transferToken });
  }

  async listNetworkDirectory(url: string) {
    return this.request<NetworkDirectoryResponse>('POST', '/network/list', { url });
  }

  async searchDoutu(keyword: string, options?: { chatId?: string; messageId?: string }) {
    return this.request<AlapiDoutuResponse>('POST', '/alapi/doutu', { keyword, chatId: options?.chatId, messageId: options?.messageId });
  }

  async searchChatRecords(query: string, options?: { limit?: number; offset?: number; chatTypePreference?: 'group' | 'direct' | 'assistant' | 'any'; sortBy?: 'relevance' | 'time_desc' | 'time_asc'; speakerQuery?: string }) {
    return this.request<ChatRecordSearchResponse>('POST', '/search/chats', {
      query,
      limit: options?.limit,
      offset: options?.offset,
      chatTypePreference: options?.chatTypePreference,
      sortBy: options?.sortBy,
      speakerQuery: options?.speakerQuery,
    });
  }

  async createLocalCaptchaChallenge() {
    return this.request<{ challengeId: string; imageSvg: string; expiresInMs: number }>('POST', '/platform/captcha/local-challenge');
  }

  private getAiBalanceCacheKey(provider?: string) {
    return `${this.getToken() || 'guest'}:${provider || 'default'}`;
  }

  private normalizeAiPublicProvider(provider?: string) {
    if (provider === 'official' || provider === 'official-moacode') return 'official-2';
    if (provider === 'official-deepseek') return 'official-1';
    if (provider === 'official-moacode-team') return 'official-team';
    if (provider === 'official-gpt') return 'official-4';
    return provider;
  }

  async getAiBalance(provider?: string, options: { force?: boolean } = {}) {
    const normalizedProvider = this.normalizeAiPublicProvider(provider);
    const query = normalizedProvider ? `?provider=${encodeURIComponent(normalizedProvider)}` : '';
    const cacheKey = this.getAiBalanceCacheKey(normalizedProvider);
    const now = Date.now();
    if (!options.force) {
      const cached = this.aiBalanceCache.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.value;
      const inFlight = this.aiBalanceInFlight.get(cacheKey);
      if (inFlight) return inFlight;
    }
    const request = this.request<Record<string, unknown>>('GET', `/ai/balance${query}`)
      .then((value) => {
        this.aiBalanceCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + AI_BALANCE_CACHE_TTL_MS,
        });
        return value;
      })
      .finally(() => {
        this.aiBalanceInFlight.delete(cacheKey);
      });
    this.aiBalanceInFlight.set(cacheKey, request);
    return request;
  }

  async getAiUsageRecords(params: { page?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return this.request<AiUsageRecordsResponse>('GET', `/ai/usage/records${suffix ? `?${suffix}` : ''}`);
  }

  async getAiUsageSummary(params: { groupBy: 'day' | 'month'; page?: number; limit?: number }) {
    const query = new URLSearchParams({ groupBy: params.groupBy });
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return this.request<AiUsageSummaryResponse>('GET', `/ai/usage/stats?${query.toString()}`);
  }

  async getBillingPlans() {
    return this.request<{ items: BillingPlanItem[] }>('GET', '/billing/plans');
  }

  async getBillingMembershipConfig() {
    return this.request<BillingMembershipConfig>('GET', '/billing/membership-config');
  }

  async getBillingMembership() {
    return this.request<BillingMembershipResponse>('GET', '/billing/membership');
  }

  async authorizeImageGenerationBatch(count: number) {
    return this.request<{ authorized: true; limit: number | null; requested: number; tierCode: string }>('POST', '/ai/images/batches/authorize', { count });
  }

  async generateAiMedia(input: { model: string; provider?: string; operation?: string; [parameter: string]: unknown }) {
    return this.request<AiMediaTask>('POST', '/ai/media/generations', input);
  }

  async getAiMediaTask(taskId: string) {
    return this.request<AiMediaTask>('GET', `/ai/media/tasks/${encodeURIComponent(taskId)}`);
  }

  async claimBillingVipPoints(kind: 'daily' | 'monthly') {
    return this.request<BillingPointClaimResponse>('POST', `/billing/membership/point-claims/${kind}`);
  }

  async getBillingOrders() {
    return this.request<{ items: BillingOrderItem[] }>('GET', '/billing/orders');
  }

  async createBillingOrder(planCode: string, paymentChannel?: string | null) {
    return this.request<BillingOrderItem>('POST', '/billing/orders', { planCode, paymentChannel });
  }

  async initiateBillingPayment(orderId: string, paymentChannel?: string | null) {
    return this.request<BillingPaymentResponse>('POST', `/billing/orders/${encodeURIComponent(orderId)}/payment`, { paymentChannel });
  }

  async assignAiProviderKey(providerCode: string) {
    return this.request<Record<string, unknown>>('POST', '/ai/keys/assign', { providerCode });
  }

  async getOfficialAiProviders() {
    return this.request<{ items: OfficialAiProviderInfo[] }>('GET', '/ai/providers');
  }

  async getPublicOfficialAiProviders() {
    return this.request<{ items: OfficialAiProviderInfo[] }>('GET', '/ai/providers/public');
  }

  async getOfficialAiModels(provider?: string | null) {
    const suffix = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return this.request<{ provider?: string; items: OfficialAiModelInfo[] }>('GET', `/ai/models${suffix}`);
  }

  async getAiProxyKeys() {
    return this.request<{ items: AiProxyKeyItem[] }>('GET', '/ai-proxy/keys');
  }

  async createAiProxyKey(data: { name?: string; dailyQuota?: number | null; monthlyQuota?: number | null; rpmLimit?: number | null; allowedModels?: string[] | null }) {
    return this.request<AiProxyKeyCreateResponse>('POST', '/ai-proxy/keys', data);
  }

  async updateAiProxyKey(keyId: string, data: Partial<Pick<AiProxyKeyItem, 'name' | 'status' | 'dailyQuota' | 'monthlyQuota' | 'rpmLimit' | 'tpmLimit' | 'allowedModels'>>) {
    return this.request<AiProxyKeyItem>('PATCH', `/ai-proxy/keys/${encodeURIComponent(keyId)}`, data);
  }

  async deleteAiProxyKey(keyId: string) {
    return this.request<{ success: boolean }>('DELETE', `/ai-proxy/keys/${encodeURIComponent(keyId)}`);
  }

  async rotateAiProxyKey(keyId: string) {
    return this.request<AiProxyKeyCreateResponse>('POST', `/ai-proxy/keys/${encodeURIComponent(keyId)}/rotate`);
  }

  async getAiProxyBalance() {
    return this.request<Record<string, unknown>>('GET', '/ai-proxy/balance');
  }

  async getAiProxySetupScript(data: { target: 'codex' | 'claude' | 'deepseek'; platform: 'posix' | 'windows'; apiKey?: string }) {
    return this.request<AiProxySetupScriptResponse>('POST', '/ai-proxy/setup-script', data);
  }

  async getAiProxyUsageSummary() {
    return this.request<Record<string, unknown>>('GET', '/ai-proxy/usage/summary');
  }

  async getAiProxyUsageRecords(params: { keyId?: string | null; page?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.keyId) query.set('keyId', params.keyId);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return this.request<AiProxyUsageRecordsResponse>('GET', `/ai-proxy/usage/records${suffix ? `?${suffix}` : ''}`);
  }

  async getAiProxyUsageGroups(groupBy: 'daily' | 'monthly', params: { keyId?: string | null; page?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.keyId) query.set('keyId', params.keyId);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return this.request<AiProxyUsageGroupsResponse>('GET', `/ai-proxy/usage/${groupBy}${suffix ? `?${suffix}` : ''}`);
  }

  async getCharacters() {
    return this.request<Array<{
      id: string; name: string; avatar: string; personality: Record<string, number>;
      behavior?: object; expertise: string[]; speakingStyle: string; background: string; group?: string | null;
      visualIdentity?: CharacterVisualIdentity | null;
      visualReferenceImages?: CharacterVisualReferenceImage[];
      personalityDrift?: object; emotionalState?: object; soulState?: object; coreProfile?: object;
      speechProfile?: object; voiceConfig?: object; relationships?: object[]; memory?: object; layeredMemories?: object[]; intervention?: object; runtimeTimeline?: Array<{ type: string; text: string; createdAt: number }>;
      modelProfileId?: string | null; modelProfileIds?: Partial<Record<'text' | 'image' | 'audio' | 'document', string | null>>; bubbleStyle?: BubbleStyleDefinition | null; bubbleStyleId?: string | null;
      generationPreferences?: { moments?: 'follow_global' | 'on' | 'off'; diaries?: 'follow_global' | 'on' | 'off'; companionship?: 'follow_global' | 'on' | 'off' };
      isPreset: boolean; deletedAt?: number | null; fieldVersions?: Record<string, number>; createdAt: number; updatedAt: number;
    }>>('GET', '/characters');
  }

  async getCharacterLibraryPage(params: { page?: number; limit?: number; sort?: 'name' | 'createdAt'; direction?: 'asc' | 'desc'; groupFirst?: boolean; group?: string } = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.direction) query.set('direction', params.direction);
    if (params.groupFirst) query.set('groupFirst', '1');
    if (params.group && params.group !== 'all') query.set('group', params.group);
    const suffix = query.toString();
    return this.request<{ items: Array<Record<string, unknown>>; page: number; limit: number; total: number; hasMore: boolean }>('GET', `/characters/library${suffix ? `?${suffix}` : ''}`);
  }

  async getCharacter(id: string) {
    return this.request<Record<string, unknown>>('GET', `/characters/${id}`);
  }

  async createCharacter(data: {
    id?: string;
    operationId?: string;
    name: string; avatar?: string; personality: Record<string, number>;
    behavior?: object; expertise: string[]; speakingStyle: string; background: string; group?: string | null; personalityDrift?: object; emotionalState?: object; soulState?: object; coreProfile?: object;
    visualIdentity?: CharacterVisualIdentity | null;
    visualReferenceImages?: CharacterVisualReferenceImage[];
    speechProfile?: object; voiceConfig?: object; relationships?: object[]; memory?: object; layeredMemories?: object[]; intervention?: object; runtimeTimeline?: Array<{ type: string; text: string; createdAt: number }>;
    modelProfileId?: string | null; modelProfileIds?: Partial<Record<'text' | 'image' | 'audio' | 'document', string | null>>; bubbleStyle?: BubbleStyleDefinition | null; bubbleStyleId?: string | null;
    generationPreferences?: { moments?: 'follow_global' | 'on' | 'off'; diaries?: 'follow_global' | 'on' | 'off'; companionship?: 'follow_global' | 'on' | 'off' };
  }) {
    return this.request<Record<string, unknown>>('POST', '/characters', data);
  }

  async createCharactersBatch(items: Array<{
    name: string; avatar?: string; personality: Record<string, number>;
    behavior?: object; expertise: string[]; speakingStyle: string; background: string; group?: string | null; personalityDrift?: object; emotionalState?: object; soulState?: object; coreProfile?: object;
    visualIdentity?: CharacterVisualIdentity | null;
    visualReferenceImages?: CharacterVisualReferenceImage[];
    speechProfile?: object; voiceConfig?: object; relationships?: object[]; memory?: object; layeredMemories?: object[]; intervention?: object; runtimeTimeline?: Array<{ type: string; text: string; createdAt: number }>;
    modelProfileId?: string | null; modelProfileIds?: Partial<Record<'text' | 'image' | 'audio' | 'document', string | null>>; bubbleStyleId?: string | null;
    generationPreferences?: { moments?: 'follow_global' | 'on' | 'off'; diaries?: 'follow_global' | 'on' | 'off'; companionship?: 'follow_global' | 'on' | 'off' };
  }>) {
    return this.request<{ characters: Record<string, unknown>[] }>('POST', '/characters/batch', { items });
  }

  async updateCharacter(id: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/characters/${id}`, data);
  }

  async replaceCharacterVisualIdentity(id: string, data: {
    visualIdentity?: CharacterVisualIdentity | null;
    visualReferenceImages?: CharacterVisualReferenceImage[];
  }) {
    return this.request<Record<string, unknown>>('PUT', `/characters/${id}`, data);
  }

  async syncCharacterPatch(id: string, data: { operationId: string; clientTimestamp: number; patch: Record<string, unknown> }) {
    return this.request<{ success: boolean; character: Record<string, unknown> }>('PATCH', `/characters/${id}/sync`, data);
  }

  async syncChatPatch(id: string, data: { operationId: string; clientTimestamp: number; patch: Record<string, unknown> }) {
    return this.request<{ success: boolean; chat: Record<string, unknown> }>('PATCH', `/chats/${id}/sync`, data);
  }

  async deleteCharacter(id: string) {
    return this.request<{ success: boolean }>('DELETE', `/characters/${id}`);
  }

  async bulkDeleteCharacters(ids: string[]) {
    return this.request<{ success: boolean; deletedIds: string[] }>('POST', '/characters/bulk-delete', { ids });
  }

  async getDeletedCharacters() {
    return this.request<Array<Record<string, unknown>>>('GET', '/characters/deleted');
  }

  async restoreCharacter(id: string) {
    return this.request<{ success: boolean; character: Record<string, unknown> }>('POST', `/characters/${id}/restore`);
  }

  async bulkRestoreCharacters(ids: string[]) {
    return this.request<{ success: boolean; characters: Record<string, unknown>[] }>('POST', '/characters/bulk-restore', { ids });
  }

  async purgeCharacter(id: string) {
    return this.request<{ success: boolean }>('DELETE', `/characters/${id}/purge`);
  }

  async bulkPurgeCharacters(ids: string[]) {
    return this.request<{ success: boolean; deletedIds: string[] }>('POST', '/characters/bulk-purge', { ids });
  }

  async emptyDeletedCharacters() {
    return this.request<{ success: boolean; deletedIds: string[] }>('DELETE', '/characters/recycle-bin/empty-all');
  }

  async getDeletedCharacterStats() {
    return this.request<{ count: number }>('GET', '/characters/recycle-bin/stats');
  }

  async bulkUpdateCharacters(ids: string[], data: { group?: string | null }) {
    return this.request<{ success: boolean; characters: Record<string, unknown>[] }>('POST', '/characters/bulk-update', { ids, ...data });
  }

  async getChats() {
    return this.request<Array<{
      id: string; type?: string; mode?: string; modeConfig?: object; modeState?: object; sessionKind?: object; scenarioState?: object; channels?: object[]; layoutState?: object; scenarioPackage?: object | null; judgeAgent?: object | null; layeredGrowth?: object; modeStateSummary?: object; memoryLayerSummary?: object; growthSnapshots?: object[]; roleMemorySummaries?: object[]; scenarioMemorySummary?: object | null; topologySummary?: object | null; name: string; topic: string; style: string;
      runtimeEvolutionIntensity?: 'slow' | 'balanced' | 'fast'; memberIds: string[]; speed: number; isActive: boolean;
      allowIntervention: boolean; showRoleActions?: boolean; topicSeed: string; sourceChatId?: string | null; sourceMemberIds?: string[]; memberCharacterSummaries?: Array<Record<string, unknown>>; runtimeSeed?: { notes?: string[]; artifacts?: string[] }; layeredMemories?: object[]; runtimeTimeline?: Array<{ type: string; text: string; createdAt: number }>;
      runtimeEventsV2?: object[]; relationshipLedger?: object[]; relationshipStructure?: object | null; governance?: object; dramaRules?: object; worldState?: object; directorControls?: object;
      deletedAt?: number | null; fieldVersions?: Record<string, number>; latestMessage?: {
        id: string; chatId: string; type: string; senderId: string;
        senderName: string; content: string; metadata?: unknown; emotion: number;
        timestamp: number; isDeleted: boolean;
      } | null; createdAt: number; updatedAt: number; lastMessageAt: number;
    }>>('GET', '/chats');
  }

  async getChat(id: string) {
    return this.request<Record<string, unknown>>('GET', `/chats/${id}`);
  }

  async getChatShareState(id: string) {
    return this.request<ChatShareState>('GET', `/chats/${id}/share`);
  }

  async updateChatShareState(id: string, enabled: boolean) {
    return this.request<ChatShareState>('PATCH', `/chats/${id}/share`, { enabled });
  }

  async getPublicChatShare(token: string, options?: { limit?: number; before?: number }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', String(options.before));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<PublicChatShareResponse>('GET', `/public/chat-shares/${encodeURIComponent(token)}${query}`);
  }

  async getWorldRuntimeChats() {
    return this.request<Array<Record<string, unknown>>>('GET', '/chats/world-runtime');
  }

  async createChat(data: {
    id?: string;
    operationId?: string;
    type?: string; mode?: string; modeConfig?: object; modeState?: object; sessionKind?: object; scenarioState?: object; channels?: object[]; layoutState?: object; scenarioPackage?: object | null; judgeAgent?: object | null; layeredGrowth?: object; modeStateSummary?: object; memoryLayerSummary?: object; growthSnapshots?: object[]; roleMemorySummaries?: object[]; scenarioMemorySummary?: object | null; topologySummary?: object | null; name: string; topic?: string; style?: string; runtimeEvolutionIntensity?: 'slow' | 'balanced' | 'fast'; memberIds: string[];
    speed?: number; isActive?: boolean; allowIntervention?: boolean; showRoleActions?: boolean; topicSeed?: string; sourceChatId?: string | null; sourceMemberIds?: string[]; runtimeSeed?: { notes?: string[]; artifacts?: string[] }; layeredMemories?: object[]; runtimeTimeline?: Array<{ type: string; text: string; createdAt: number }>; messageBranchState?: object | null;
    runtimeEventsV2?: object[]; relationshipLedger?: object[]; relationshipStructure?: object | null; governance?: unknown; dramaRules?: unknown; worldState?: unknown; directorControls?: unknown;
  }) {
    return this.request<Record<string, unknown>>('POST', '/chats', data);
  }

  async updateChat(id: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/chats/${id}`, data);
  }

  async deleteChat(id: string) {
    return this.request<{ success: boolean }>('DELETE', `/chats/${id}`);
  }

  async bulkDeleteChats(ids: string[]) {
    return this.request<{ success: boolean; deletedIds: string[] }>('POST', '/chats/bulk-delete', { ids });
  }

  async getDeletedChats() {
    return this.request<Array<Record<string, unknown>>>('GET', '/chats?deletedOnly=1');
  }

  async restoreChat(id: string) {
    return this.request<{ success: boolean; chat: Record<string, unknown> }>('POST', `/chats/${id}/restore`);
  }

  async bulkRestoreChats(ids: string[]) {
    return this.request<{ success: boolean; chats: Record<string, unknown>[] }>('POST', '/chats/bulk-restore', { ids });
  }

  async purgeChat(id: string) {
    return this.request<{ success: boolean }>('DELETE', `/chats/${id}/purge`);
  }

  async bulkPurgeChats(ids: string[]) {
    return this.request<{ success: boolean; deletedIds: string[] }>('POST', '/chats/bulk-purge', { ids });
  }

  async emptyDeletedChats() {
    return this.request<{ success: boolean; deletedIds: string[] }>('DELETE', '/chats/recycle-bin/empty-all');
  }

  async getSyncChanges(params: { scope: SyncChangeScope; since?: string | number | null }): Promise<SyncChangesResponse> {
    const query = new URLSearchParams({ scope: params.scope });
    if (params.since !== undefined && params.since !== null && String(params.since).trim()) {
      query.set('since', String(params.since));
    }
    const result = await this.request<SyncChangesResponse>('GET', `/sync/changes?${query.toString()}`);
    if (result.status !== 'reset_required' || params.since === undefined || params.since === null || !String(params.since).trim()) return result;
    return this.getSyncChanges({ scope: params.scope });
  }

  async getDeletedChatStats() {
    return this.request<{ group: number; direct: number; aiDirect: number; assistant: number }>('GET', '/chats/recycle-bin/stats');
  }

  async getMessages(chatId: string, options?: { limit?: number; before?: number; after?: number; aroundTimestamp?: number }) {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.before !== undefined) params.set('before', String(options.before));
    if (options?.after !== undefined) params.set('after', String(options.after));
    if (options?.aroundTimestamp !== undefined) params.set('aroundTimestamp', String(options.aroundTimestamp));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<Array<{
      id: string; chatId: string; type: string; senderId: string;
      senderName: string; content: string; metadata?: unknown; emotion: number;
      timestamp: number; isDeleted: boolean;
    }>>('GET', `/chats/${chatId}/messages${query}`);
  }

  async createMessage(chatId: string, data: {
    type: string; senderId: string; senderName: string;
    content: string; emotion?: number; metadata?: unknown; timestamp?: number; clientKey?: string; operationId?: string;
  }) {
    return this.request<Record<string, unknown>>('POST', `/chats/${chatId}/messages`, data);
  }

  async updateMessageMetadata(id: string, metadata: unknown) {
    return this.request<Record<string, unknown>>('PATCH', `/messages/${id}/metadata`, { metadata });
  }

  async createMediaAsset(data: {
    chatId: string; messageId: string; attachmentId: string; kind: 'image' | 'audio' | 'sticker' | 'thumbnail'; dataUrl: string; description?: string; promptText?: string; sourceType?: string; characterId?: string;
  }) {
    return this.request<{ id: string; url: string; mimeType: string; sizeBytes: number; checksum?: string }>('POST', '/media-assets', data);
  }

  async listFiles(params?: { trash?: boolean | 'unreferenced'; category?: string; from?: number; to?: number; limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.trash === true) query.set('trash', 'true');
    if (params?.category && params.category !== 'all') query.set('category', params.category);
    if (params?.from) query.set('from', String(params.from));
    if (params?.to) query.set('to', String(params.to));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.trash === 'unreferenced') query.set('unreferenced', 'true');
    return this.request<{ items: Array<{ id: string; name: string; url: string; mimeType: string; sizeBytes: number; kind: string; category: string; createdAt: number; deletedAt: number | null; chatId: string; messageId: string; attachmentId?: string; checksum?: string; description?: string; promptText?: string; syncStatus?: 'local-only' | 'cloud-only' | 'synced' | 'metadata-only' | 'missing'; characterId?: string; characterName?: string; sourceType?: string }> }>('GET', `/files${query.toString() ? `?${query}` : ''}`);
  }

  async deleteFiles(ids: string[]) {
    return this.request<{ success: boolean; deleted: number }>('DELETE', '/files', { ids });
  }

  async synthesizeSpeech(data: {
    providerCode?: string;
    modelId?: string;
    text: string;
    voice?: string;
    language?: string;
    emotion?: string;
    style?: string;
    speed?: number;
    pitch?: number;
    chatId?: string;
    messageId?: string;
    attachmentId?: string;
  }) {
    return this.request<{
      provider: string;
      mimeType: string;
      audioDataUrl: string;
      cached?: boolean;
      asset?: { id: string; url: string; mimeType: string; sizeBytes: number; checksum?: string };
    }>('POST', '/speech/tts', data);
  }

  async getSpeechPlatforms() {
    return this.request<{ items: Array<{
      capability: 'tts' | 'stt';
      name: string;
      officialName: string;
      providerCode: string;
      available: boolean;
      modelId: string;
      modelName: string;
      providers: Array<{ providerCode: string; displayName: string; official: boolean; available: boolean; modelId: string; modelName: string }>;
      pricing?: { billingUnit: 'character' | 'second'; pricePerUnit: number; currency: 'CNY' | 'point'; billingMultiplier: number; pointValueCny: number; minimumCharge: number } | null;
    }> }>('GET', '/speech/platforms');
  }

  async listSpeechVoices(providerCode?: string, modelId?: string) {
    const query = new URLSearchParams();
    if (providerCode) query.set('providerCode', providerCode);
    if (modelId) query.set('modelId', modelId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.request<{ provider: string; voices: Array<{ id: string; name: string; language?: string; gender?: string; age?: string; resourceId?: string; source?: string; availability?: string; traits?: string[]; styles?: string[] }> }>('GET', `/speech/voices${suffix}`);
  }

  async assignSpeechVoices(data: {
    providerCode?: string;
    modelId?: string;
    usedVoiceIds?: string[];
    candidateLimit?: number;
    profiles: Array<{ key: string; profile: {
      gender?: string; age?: string; language?: string; traits?: string[]; styles?: string[]; emotions?: string[]; energy?: string;
    } }>;
  }) {
    return this.request<{
      provider: string;
      cached: boolean;
      fetchedAt?: number | null;
      assignments: Array<{
        key: string;
        selected: { id: string; name: string; language?: string; gender?: string; age?: string; resourceId?: string; source?: string; availability?: string; traits?: string[]; styles?: string[]; score: number; matchedReasons: string[]; alreadyUsed: boolean } | null;
        candidates: Array<{ id: string; name: string; language?: string; gender?: string; age?: string; resourceId?: string; source?: string; availability?: string; traits?: string[]; styles?: string[]; score: number; matchedReasons: string[]; alreadyUsed: boolean }>;
      }>;
    }>('POST', '/speech/voices/assign', data);
  }

  async transcribeSpeech(data: {
    providerCode?: string;
    modelId?: string;
    audioDataUrl: string;
    fileName?: string;
    language?: string;
    prompt?: string;
  }) {
    return this.request<{ provider: string; text: string; raw?: Record<string, unknown> }>('POST', '/speech/stt', data);
  }

  async listCharacterVisualAssets(characterId: string) {
    return this.request<Array<{
      id: string; characterId: string; url: string; mimeType: string; sizeBytes: number; checksum?: string; label?: string | null;
      source: 'uploaded' | 'generated'; isPrimary: boolean; createdAt: number;
    }>>('GET', `/characters/${characterId}/visual-assets`);
  }

  async createCharacterVisualAsset(characterId: string, data: {
    dataUrl: string; label?: string | null; source?: 'uploaded' | 'generated'; isPrimary?: boolean;
  }) {
    return this.request<{ id: string; assetId?: string; characterId: string; url: string; mimeType: string; sizeBytes: number; checksum?: string; label?: string | null; source: 'uploaded' | 'generated'; isPrimary: boolean; createdAt: number }>('POST', `/characters/${characterId}/visual-assets`, data);
  }

  async updateCharacterVisualAsset(characterId: string, assetId: string, data: { isPrimary?: boolean }) {
    return this.request<{ success: boolean }>('PATCH', `/characters/${characterId}/visual-assets/${assetId}`, data);
  }

  async deleteCharacterVisualAsset(characterId: string, assetId: string) {
    return this.request<{ success: boolean }>('DELETE', `/characters/${characterId}/visual-assets/${assetId}`);
  }

  async clearChatMessages(chatId: string) {
    return this.request<{ success: boolean }>('DELETE', `/chats/${chatId}/messages`);
  }

  async deleteMessage(id: string) {
    return this.request<{ success: boolean }>('DELETE', `/messages/${id}`);
  }

  async getSettings() {
    return this.request<{
      api: { provider: string; apiKey: string; baseUrl: string; model: string };
      aiProfiles?: Array<{ id: string; name: string; type?: 'text' | 'image' | 'audio' | 'document'; isDefault?: boolean; provider: string; apiKey: string; baseUrl: string; model: string; imageCapabilities?: { textToImage?: boolean; referenceImage?: boolean; multiReferenceImage?: boolean; seed?: boolean; negativePrompt?: boolean } }>;
      theme: string; themePreset?: string; themeColor: string; language: string; defaultSpeed: number;
      developerMode?: boolean;
      developerModeEntitled?: boolean;
      autoGenerateCharacterAvatar?: boolean;
      avatarGeneration?: { autoGenerateCharacterAvatar?: boolean; preferNonPhotorealAvatar?: boolean };
      developerUI?: { showMemoryDebug?: boolean; showRelationshipEvents?: boolean; showAffectEvents?: boolean; showConflictEvents?: boolean; showStateEvents?: boolean; showMemoryDistillationEvents?: boolean; showDetailedFactHints?: boolean; showLocalInterceptionHints?: boolean; showSpeechStyle?: boolean; showAdvancedRuntimePanels?: boolean; showDeliberationDebug?: boolean; showPresenceDebug?: boolean; showCompanionshipDebug?: boolean; showMomentDebug?: boolean; showWithdrawnMessageContent?: boolean; enableHumanAppraisal?: boolean; dramaBoost?: boolean };
      memoryUI?: { showDeveloperMemory?: boolean };
      chatDraftDefaults?: { style: string; showRoleActions: boolean; runtimeEvolutionIntensity: 'slow' | 'balanced' | 'fast' };
      customBubbleStyles?: Array<Record<string, unknown>>;
      userBubbleStyleId?: string | null;
      userBubbleStyle?: Record<string, unknown> | null;
      artifactAppearance?: Record<string, unknown> | null;
    }>('GET', '/settings');
  }

  async updateSettings(data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', '/settings', data);
  }

  async getCharacterArtifacts() {
    return this.request<{ items: CharacterArtifactSummaryEntry[]; updatedAt: number }>('GET', '/character-artifacts');
  }

  async getCharacterArtifactSummaries(query: CharacterArtifactQuery = {}) {
    const params = new URLSearchParams();
    if (query.kind) params.set('kind', query.kind);
    if (query.characterId) params.set('characterId', query.characterId);
    if (query.dateFrom) params.set('dateFrom', query.dateFrom);
    if (query.dateTo) params.set('dateTo', query.dateTo);
    if (query.includeDeleted) params.set('includeDeleted', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ items: CharacterArtifactSummaryEntry[]; updatedAt: number }>('GET', `/character-artifacts/summary${suffix}`);
  }

  async getCharacterArtifactDetails(query: CharacterArtifactQuery = {}) {
    const params = new URLSearchParams();
    if (query.kind) params.set('kind', query.kind);
    if (query.characterId) params.set('characterId', query.characterId);
    if (query.dateFrom) params.set('dateFrom', query.dateFrom);
    if (query.dateTo) params.set('dateTo', query.dateTo);
    if (query.includeDeleted) params.set('includeDeleted', 'true');
    params.set('includeText', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ items: CharacterArtifactSyncEntry[]; updatedAt: number }>('GET', `/character-artifacts${suffix}`);
  }

  async getCharacterArtifactItem(id: string) {
    return this.request<{ item: CharacterArtifactSyncEntry }>('GET', `/character-artifacts/items/${encodeURIComponent(id)}`);
  }

  async upsertCharacterArtifactItem(item: CharacterArtifactSyncEntry & { operationId?: string; baseRevision?: number; clientTimestamp?: number }) {
    return this.request<{
      success: boolean;
      accepted?: boolean;
      status?: 'accepted' | 'rejected';
      reason?: 'stale_base' | 'older_update';
      updatedAt: number;
      revision: number;
    }>('PUT', `/character-artifacts/items/${encodeURIComponent(item.id)}`, item);
  }

  async deleteCharacterArtifactItem(id: string, data: { operationId?: string; baseRevision?: number; deletedAt?: number } = {}) {
    return this.request<{
      success: boolean;
      accepted?: boolean;
      status?: 'accepted' | 'rejected';
      reason?: 'stale_base' | 'older_update';
      deletedAt: number;
      revision: number;
    }>('DELETE', `/character-artifacts/items/${encodeURIComponent(id)}`, data);
  }

  async updateCharacterArtifacts(data: { items: CharacterArtifactSyncEntry[]; updatedAt: number }) {
    return this.request<{ success: boolean; updatedAt: number }>('PUT', '/character-artifacts', data);
  }

  async getAssistantArtifactEntitlement() {
    return this.request<{
      entitled: boolean;
      cloudSyncEntitled: boolean;
      assistantArtifactCloudSync: boolean;
      tierCode: string;
    }>('GET', '/assistant-artifacts/entitlement');
  }

  async getAssistantArtifacts(chatId: string) {
    return this.request<{ items: AssistantArtifactItem[]; serverTime: number }>('GET', `/assistant-artifacts/chats/${encodeURIComponent(chatId)}`);
  }

  async upsertAssistantArtifact(item: AssistantArtifactItem) {
    return this.request<{
      accepted: boolean;
      status: 'accepted' | 'rejected';
      reason?: 'stale_base' | 'older_update';
      item: AssistantArtifactItem;
    }>('PUT', `/assistant-artifacts/items/${encodeURIComponent(item.id)}`, item);
  }

  async upsertAssistantArtifacts(chatId: string, items: AssistantArtifactItem[]) {
    return this.request<{
      results: Array<{
        accepted: boolean;
        status: 'accepted' | 'rejected';
        reason?: 'stale_base' | 'older_update';
        item: AssistantArtifactItem;
      }>;
      items: AssistantArtifactItem[];
      serverTime: number;
    }>('PUT', `/assistant-artifacts/chats/${encodeURIComponent(chatId)}/bulk`, { items });
  }

  async getTopicSources() {
    return this.request<{ sources: TopicSourceSummary[] }>('GET', '/topics/sources');
  }

  async getTopics(source: string) {
    return this.request<{ items: TopicItem[]; status: 'ok' | 'degraded' | 'unavailable'; note?: string }>('GET', `/topics?source=${encodeURIComponent(source)}`);
  }

  async adaptTopic(data: { topic: { title: string; subtitle?: string; source: string }; characters: Record<string, unknown>[]; language: 'zh' | 'en' }) {
    return this.request<TopicAdaptationResult>('POST', '/topics/adapt', data);
  }
}

export const api = new ApiClient();
