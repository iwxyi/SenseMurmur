import { ApiError } from './api';
import type { SitePublicConfig } from './api';
import { backendUrl } from './backendUrl';

const ADMIN_BASE = '/api/admin';
const ADMIN_TOKEN_KEY = 'pneumata-admin-token';
const ADMIN_LOGIN_EVENT = 'pneumata-admin-auth-required';
const READ_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

export type AdminUser = {
  id: string;
  email: string;
  username?: string;
  displayName: string;
  status: string;
  mfaEnabled?: boolean;
  lastLoginAt?: number | null;
  lastLoginIp?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  roleCodes: string[];
  permissions: string[];
};

export type AdminLoginRecord = {
  id: string;
  result: string;
  ip: string | null;
  userAgent: string | null;
  details?: Record<string, unknown>;
  createdAt: number;
};

export type AdminUserLoginRecord = {
  id: string;
  phone: string;
  userId: string | null;
  method: string;
  result: string;
  requestIp: string | null;
  resetAt: number | null;
  createdAt: number;
};

export type AdminRole = {
  id: string;
  code: string;
  name: string;
  description?: string;
  isSystem?: boolean;
  permissions?: Array<Record<string, unknown>>;
};

export type AdminManagedUser = AdminUser & {
  roles?: AdminRole[];
};

export type AdminSystemAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error' | 'success' | string;
  status: 'draft' | 'active' | 'archived' | string;
  audienceType: 'all' | 'users' | string;
  audienceUserIds: string[];
  audienceInactiveMonths: number | null;
  startsAt: number | null;
  endsAt: number | null;
  pinnedEnabled: boolean;
  popupEnabled: boolean;
  sortOrder: number;
  exposureUsers?: number;
  exposureCount?: number;
  popupAckUsers?: number;
  popupAckCount?: number;
  createdAt: number;
  updatedAt: number;
};

export type AdminSystemAnnouncementPayload = {
  title: string;
  body: string;
  severity: string;
  status: string;
  audienceType: string;
  audienceUserIds: string[];
  audienceInactiveMonths: number | null;
  startsAt: number | null;
  endsAt: number | null;
  pinnedEnabled: boolean;
  popupEnabled: boolean;
  sortOrder: number;
};

export type AdminNotificationJobPayload = {
  channel: 'email' | 'sms';
  recipient: string;
  userId?: string | null;
  scheduledAt?: number | null;
  subject?: string;
  body?: string;
  code?: string;
  purpose?: string;
};

export type AdminUsageSessionItem = {
  id: string;
  userId: string | null;
  userLabel: string;
  anonymous: boolean;
  startedAt: number;
  lastHeartbeatAt: number;
  endedAt: number | null;
  durationMs: number;
  heartbeatCount: number;
  status: 'online' | 'timeout' | 'ended' | string;
  entryPath: string;
  lastPath: string;
};

export type AdminUsageMaintenanceStatus = {
  generatedAt: number;
  rawSessionCount: number;
  dailyStatCount: number;
  onlineSessionCount: number;
  latestSummaryDate: string | null;
  latestSummarizedAt: number | null;
  oldestSessionStartedAt: number | null;
  rawSessionRetentionDays: number;
  maintenanceIntervalMs: number;
};

class AdminApiClient {
  getToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  }

  setToken(token: string | null) {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  }

  notifyAuthRequired() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(ADMIN_LOGIN_EVENT, {
      detail: { from: `${window.location.pathname}${window.location.search}${window.location.hash}` },
    }));
  }

  private getHeaders() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>;
    }
    const text = await response.text().catch(() => '');
    const normalized = text.trimStart().toLowerCase();
    const isHtml = normalized.startsWith('<!doctype') || normalized.startsWith('<html');
    throw new ApiError(
      isHtml ? '后台接口返回了前端页面，请检查后端服务或开发代理配置' : '后台接口返回了非 JSON 响应',
      { status: response.status, code: 'INVALID_ADMIN_API_RESPONSE' },
    );
  }

  private async parseErrorResponse(response: Response): Promise<{ error: string; code?: string }> {
    try {
      const error = await this.parseJsonResponse<{ error?: string; code?: string; detail?: string }>(response);
      const detailText = typeof error.detail === 'string' ? error.detail.trim() : '';
      const normalizedDetail = detailText.trimStart().toLowerCase();
      const detail = detailText && !normalizedDetail.startsWith('<!doctype') && !normalizedDetail.startsWith('<html') && !normalizedDetail.includes('<title>')
        ? `（${detailText.length > 180 ? `${detailText.slice(0, 180)}...` : detailText}）`
        : '';
      return {
        error: `${error.error || `HTTP ${response.status}`}${detail}`,
        code: error.code,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        return { error: `${error.message}（HTTP ${response.status}）`, code: error.code };
      }
      return { error: `后台请求失败（HTTP ${response.status}）` };
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    const canRetry = method.toUpperCase() === 'GET';
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetch(backendUrl(`${ADMIN_BASE}${path}`), {
          method,
          headers: this.getHeaders(),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (requestError) {
        if (canRetry && attempt < READ_RETRY_DELAYS_MS.length) {
          await waitForRetry(READ_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        console.error('Admin API network error', { method, path, error: requestError });
        throw new ApiError('无法连接后台接口，请检查后端服务或开发代理配置', { code: 'ADMIN_API_NETWORK_ERROR' });
      }
      if (canRetry && response.status === 503 && attempt < READ_RETRY_DELAYS_MS.length) {
        await waitForRetry(READ_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
    if (!response.ok) {
      const error = await this.parseErrorResponse(response);
      console.error('Admin API request failed', {
        method,
        path,
        status: response.status,
        error: error.error,
        code: error.code,
      });
      if (response.status === 401) {
        this.setToken(null);
        this.notifyAuthRequired();
      }
      throw new ApiError(error.error, { status: response.status, code: error.code });
    }
    return this.parseJsonResponse<T>(response);
  }

  private buildQuery(params: Record<string, string | number | undefined>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const encoded = query.toString();
    return encoded ? `?${encoded}` : '';
  }

  login(login: string, password: string) {
    return this.request<{ token: string; admin: AdminUser }>('POST', '/auth/login', { login, password });
  }

  me() {
    return this.request<AdminUser>('GET', '/auth/me');
  }

  getAdminProfile() {
    return this.request<{ admin: AdminUser }>('GET', '/auth/profile');
  }

  updateAdminProfile(payload: { email: string; username?: string; displayName: string; currentPassword?: string }) {
    return this.request<{ admin: AdminUser }>('PUT', '/auth/profile', payload);
  }

  updateAdminPassword(payload: { currentPassword: string; newPassword: string }) {
    return this.request<{ ok: boolean; updatedAt: number }>('PUT', '/auth/password', payload);
  }

  getAdminLoginRecords(params?: { limit?: number }) {
    return this.request<{ items: AdminLoginRecord[]; limit: number }>('GET', `/auth/login-records${this.buildQuery({ limit: params?.limit })}`);
  }

  getAdminRoles() {
    return this.request<{ items: AdminRole[] }>('GET', '/admins/roles');
  }

  getAdminUsers(params?: { search?: string; limit?: number }) {
    return this.request<{ items: AdminManagedUser[]; roles: AdminRole[] }>('GET', `/admins${this.buildQuery({ search: params?.search, limit: params?.limit })}`);
  }

  getManagedAdminUser(adminUserId: string) {
    return this.request<{ admin: AdminManagedUser; loginRecords: AdminLoginRecord[]; roles: AdminRole[] }>('GET', `/admins/${encodeURIComponent(adminUserId)}`);
  }

  getUserLoginRecords(userId: string, params?: { result?: 'success' | 'failure'; method?: string; limit?: number }) {
    return this.request<{ items: AdminUserLoginRecord[]; limit: number }>('GET', `/users/${encodeURIComponent(userId)}/login-records${this.buildQuery(params || {})}`);
  }

  resetUserLoginFailures(userId: string) {
    return this.request<{ ok: boolean; resetCount: number }>('POST', `/users/${encodeURIComponent(userId)}/login-failures/reset`);
  }

  createManagedAdminUser(payload: { email: string; username?: string; displayName: string; password: string; status: string; roleCodes: string[] }) {
    return this.request<{ admin: AdminManagedUser }>('POST', '/admins', payload);
  }

  updateManagedAdminUser(adminUserId: string, payload: { email: string; username?: string; displayName: string; status: string; roleCodes: string[] }) {
    return this.request<{ admin: AdminManagedUser }>('PUT', `/admins/${encodeURIComponent(adminUserId)}`, payload);
  }

  resetManagedAdminPassword(adminUserId: string, payload: { password: string }) {
    return this.request<{ ok: boolean; updatedAt: number }>('POST', `/admins/${encodeURIComponent(adminUserId)}/password`, payload);
  }

  getDashboardStats() {
    return this.request<{
      metrics: Record<string, number>;
      operations?: Record<string, unknown>;
      recentOrders: Array<Record<string, unknown>>;
      recentReviews: Array<Record<string, unknown>>;
      recentAudits: Array<Record<string, unknown>>;
    }>('GET', '/dashboard/stats');
  }

  getUsageSessions(params?: { page?: number; limit?: number; search?: string }) {
    return this.request<{ items: AdminUsageSessionItem[]; page: number; limit: number; total: number; serverTime: number; heartbeatTimeoutMs: number }>('GET', `/usage/sessions${this.buildQuery({ page: params?.page, limit: params?.limit, search: params?.search })}`);
  }

  getUsageMaintenanceStatus() {
    return this.request<AdminUsageMaintenanceStatus>('GET', '/usage/maintenance');
  }

  runUsageMaintenance() {
    return this.request<{ result: Record<string, unknown>; status: AdminUsageMaintenanceStatus }>('POST', '/usage/maintenance/run', {});
  }

  getUsers(search = '') {
    return this.request<{ items: Array<{ id: string; phone: string; nickname: string; avatar: string; created_at: number; updated_at: number }> }>('GET', `/users${this.buildQuery({ search })}`);
  }

  getUser(userId: string) {
    return this.request<Record<string, unknown>>('GET', `/users/${encodeURIComponent(userId)}`);
  }

  updateUserAccountEntitlement(userId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/users/${encodeURIComponent(userId)}/account-entitlement`, payload);
  }

  getAiProviders() {
    return this.request<{ items: Array<Record<string, unknown>>; runtime: Array<Record<string, unknown>> }>('GET', '/ai/providers');
  }

  getAiOpsSummary() {
    return this.request<Record<string, unknown>>('GET', '/ai/ops-summary');
  }



  getPlatformGlobalConfig() {
    return this.request<{ ai: Record<string, unknown>; site: SitePublicConfig }>('GET', '/platform/global-config');
  }

  updatePlatformGlobalConfig(payload: Record<string, unknown>) {
    return this.request<{ ai: Record<string, unknown>; site: SitePublicConfig }>('PUT', '/platform/global-config', payload);
  }

  exportAdminConfig() {
    return this.request<Record<string, unknown>>('GET', '/config/export');
  }

  importAdminConfig(payload: Record<string, unknown>) {
    return this.request<{ version: number; results: Array<Record<string, unknown>> }>('POST', '/config/import', payload);
  }

  getPlatformIntegrations() {
    return this.request<{ items: Array<Record<string, unknown>>; requestOrigin?: string }>('GET', '/platform/integrations');
  }

  getPlatformTtsVoices(providerCode: string) {
    return this.request<{ provider: string; voices: Array<{ id: string; name: string; language?: string; gender?: string; styles?: string[] }> }>('GET', `/platform/integrations/tts/${encodeURIComponent(providerCode)}/voices`);
  }

  updatePlatformIntegration(category: string, providerCode: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/platform/integrations/${encodeURIComponent(category)}/${encodeURIComponent(providerCode)}`, payload);
  }

  testPlatformIntegration(category: string, providerCode: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/platform/integrations/${encodeURIComponent(category)}/${encodeURIComponent(providerCode)}/test`, payload);
  }

  getPlatformIntegrationBalance(category: string, providerCode: string) {
    if (category === 'search') {
      return this.request<Record<string, unknown>>('GET', `/platform/search/${encodeURIComponent(providerCode)}/balance`);
    }
    return this.request<Record<string, unknown>>('GET', `/platform/integrations/${encodeURIComponent(category)}/${encodeURIComponent(providerCode)}/balance`);
  }

  getAiProviderConfig(providerCode: string) {
    return this.request<Record<string, unknown>>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/config`);
  }

  getAiProviderAccountBalance(providerCode: string) {
    return this.request<Record<string, unknown>>('POST', `/ai/providers/${encodeURIComponent(providerCode)}/account-balance`);
  }

  getAiProviderPublicModels(providerCode: string, params?: { search?: string; page?: number; limit?: number; all?: boolean }) {
    return this.request<{ items: Array<Record<string, unknown>>; page: number; limit: number; total: number }>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/public-models${this.buildQuery({ search: params?.search, page: params?.page, limit: params?.limit, all: params?.all ? 'true' : undefined })}`);
  }

  updateAiProviderConfig(providerCode: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/ai/providers/${encodeURIComponent(providerCode)}/config`, payload);
  }

  refreshAceCatalog() {
    return this.request<{ count: number }>('POST', '/ai/providers/acedata/catalog/refresh');
  }

  getAceConnection() {
    return this.request<{ status: string; apiBaseUrl: string; apiKeyConfigured: boolean }>('GET', '/ai/providers/acedata/connection');
  }

  setAceModelEnabled(model: string, enabled: boolean) {
    return this.request<{ modelName: string; enabled: boolean }>('PUT', `/ai/providers/acedata/models/${encodeURIComponent(model)}/enabled`, { enabled });
  }

  setAceModelsEnabled(models: string[], enabled: boolean) {
    return this.request<{ models: string[]; enabled: boolean }>('PUT', '/ai/providers/acedata/models/enabled', { models, enabled });
  }

  updateAceConnection(payload: { status: string; apiBaseUrl: string; apiKey?: string }) {
    return this.request<{ status: string; apiBaseUrl: string; apiKeyConfigured: boolean }>('PUT', '/ai/providers/acedata/connection', payload);
  }

  getAiProviderKeys(providerCode: string, params?: { typeId?: string; keyword?: string }) {
    return this.request<{ items: Array<Record<string, unknown>>; raw?: Record<string, unknown> }>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/keys${this.buildQuery({ typeId: params?.typeId, keyword: params?.keyword })}`);
  }

  createAiProviderKey(providerCode: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/ai/providers/${encodeURIComponent(providerCode)}/keys`, payload);
  }

  updateAiProviderKey(providerCode: string, externalKeyId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/ai/providers/${encodeURIComponent(providerCode)}/keys/${encodeURIComponent(externalKeyId)}`, payload);
  }

  transferAiProviderKeyPoints(providerCode: string, externalKeyId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/ai/providers/${encodeURIComponent(providerCode)}/keys/${encodeURIComponent(externalKeyId)}/points`, payload);
  }

  getAiProviderUserBalances(providerCode: string, params?: { search?: string; page?: number; limit?: number }) {
    return this.request<{ items: Array<Record<string, unknown>>; page: number; limit: number; total: number }>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/user-balances${this.buildQuery({ search: params?.search, page: params?.page, limit: params?.limit })}`);
  }

  getAiProviderUserUsage(providerCode: string, userId: string, params?: { invocationPage?: number; invocationLimit?: number; ledgerPage?: number; ledgerLimit?: number }) {
    return this.request<{
      user: Record<string, unknown>;
      invocations: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      invocationsPage?: Record<string, unknown>;
      quotaLedger: Array<Record<string, unknown>>;
      quotaLedgerPage?: Record<string, unknown>;
      monthly?: Array<Record<string, unknown>>;
    }>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/users/${encodeURIComponent(userId)}/usage${this.buildQuery({
      invocationPage: params?.invocationPage,
      invocationLimit: params?.invocationLimit,
      ledgerPage: params?.ledgerPage,
      ledgerLimit: params?.ledgerLimit,
    })}`);
  }

  getAiUserUsage(userId: string, params?: { invocationPage?: number; invocationLimit?: number; ledgerPage?: number; ledgerLimit?: number }) {
    return this.request<{
      user: Record<string, unknown>;
      invocations: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
      invocationsPage?: Record<string, unknown>;
      quotaLedger: Array<Record<string, unknown>>;
      quotaLedgerPage?: Record<string, unknown>;
      monthly?: Array<Record<string, unknown>>;
    }>('GET', `/ai/users/${encodeURIComponent(userId)}/usage${this.buildQuery({
      invocationPage: params?.invocationPage,
      invocationLimit: params?.invocationLimit,
      ledgerPage: params?.ledgerPage,
      ledgerLimit: params?.ledgerLimit,
    })}`);
  }

  getAiProviderUsageStats(providerCode: string, params?: {
    userId?: string;
    groupBy?: string;
    from?: number;
    to?: number;
    usageType?: string;
    model?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    return this.request<{
      providerCode: string;
      groupBy: string;
      page: number;
      limit: number;
      total: number;
      totals: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    }>('GET', `/ai/providers/${encodeURIComponent(providerCode)}/usage-stats${this.buildQuery({
      userId: params?.userId,
      groupBy: params?.groupBy,
      from: params?.from,
      to: params?.to,
      usageType: params?.usageType,
      model: params?.model,
      status: params?.status,
      search: params?.search,
      page: params?.page,
      limit: params?.limit,
    })}`);
  }

  getAiUserUsageStats(userId: string, params?: {
    groupBy?: string;
    from?: number;
    to?: number;
    usageType?: string;
    model?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    return this.request<{
      providerCode: string;
      groupBy: string;
      page: number;
      limit: number;
      total: number;
      totals: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    }>('GET', `/ai/users/${encodeURIComponent(userId)}/usage-stats${this.buildQuery({
      groupBy: params?.groupBy,
      from: params?.from,
      to: params?.to,
      usageType: params?.usageType,
      model: params?.model,
      status: params?.status,
      search: params?.search,
      page: params?.page,
      limit: params?.limit,
    })}`);
  }

  transferAiProviderUserPoints(providerCode: string, userId: string, payload: { amount: number; reason?: string }) {
    return this.request<Record<string, unknown>>('POST', `/ai/providers/${encodeURIComponent(providerCode)}/users/${encodeURIComponent(userId)}/points`, payload);
  }

  transferAiUserPoints(userId: string, payload: { amount: number; reason?: string }) {
    return this.request<Record<string, unknown>>('POST', `/ai/users/${encodeURIComponent(userId)}/points`, payload);
  }

  getAiEntitlement(userId: string) {
    return this.request<{ entitlement: Record<string, unknown> | null; keys: Array<Record<string, unknown>>; quotaLedger?: Array<Record<string, unknown>> }>('GET', `/ai/entitlements${this.buildQuery({ userId })}`);
  }

  getAiBalance(userId: string) {
    return this.request<Record<string, unknown>>('GET', `/ai/entitlements/${encodeURIComponent(userId)}/balance`);
  }

  updateAiEntitlement(userId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/ai/entitlements/${encodeURIComponent(userId)}`, payload);
  }

  createAiUserKey(userId: string, providerCode = 'api2d') {
    return this.request<Record<string, unknown>>('POST', `/ai/entitlements/${encodeURIComponent(userId)}/keys/auto`, { providerCode });
  }

  setAiUserKey(userId: string, payload: { providerCode?: string; apiKey: string; externalKeyId?: string; isPrimary?: boolean }) {
    return this.request<Record<string, unknown>>('POST', `/ai/entitlements/${encodeURIComponent(userId)}/keys/manual`, payload);
  }

  updateAiUserKeySecret(userId: string, providerKeyId: string, payload: { apiKey: string; externalKeyId?: string }) {
    return this.request<Record<string, unknown>>('PUT', `/ai/entitlements/${encodeURIComponent(userId)}/keys/${encodeURIComponent(providerKeyId)}/secret`, payload);
  }

  updateAiUserKeyStatus(userId: string, providerKeyId: string, payload: { enabled?: boolean; status?: string }) {
    return this.request<Record<string, unknown>>('PUT', `/ai/entitlements/${encodeURIComponent(userId)}/keys/${encodeURIComponent(providerKeyId)}/status`, payload);
  }

  updateAiUserKeyLimits(userId: string, providerKeyId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/ai/entitlements/${encodeURIComponent(userId)}/keys/${encodeURIComponent(providerKeyId)}/limits`, payload);
  }

  transferAiUserKeyPoints(userId: string, providerKeyId: string, payload: { amount: number; reason?: string }) {
    return this.request<Record<string, unknown>>('POST', `/ai/entitlements/${encodeURIComponent(userId)}/keys/${encodeURIComponent(providerKeyId)}/points`, payload);
  }

  getAiUserKeyUsage(userId: string, providerKeyId: string) {
    return this.request<{ invocations: Array<Record<string, unknown>>; quotaLedger: Array<Record<string, unknown>> }>('GET', `/ai/entitlements/${encodeURIComponent(userId)}/keys/${encodeURIComponent(providerKeyId)}/usage`);
  }

  getAuditLogs(params?: { action?: string; result?: string }) {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/audit${this.buildQuery({ action: params?.action, result: params?.result })}`);
  }

  getNotificationTemplates() {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', '/notifications/templates');
  }

  getSystemAnnouncements() {
    return this.request<{ items: AdminSystemAnnouncement[] }>('GET', '/notifications/announcements');
  }

  createSystemAnnouncement(payload: AdminSystemAnnouncementPayload) {
    return this.request<{ item: AdminSystemAnnouncement }>('POST', '/notifications/announcements', payload);
  }

  updateSystemAnnouncement(announcementId: string, payload: AdminSystemAnnouncementPayload) {
    return this.request<{ item: AdminSystemAnnouncement }>('PUT', `/notifications/announcements/${encodeURIComponent(announcementId)}`, payload);
  }

  deleteSystemAnnouncement(announcementId: string) {
    return this.request<{ ok: boolean }>('DELETE', `/notifications/announcements/${encodeURIComponent(announcementId)}`);
  }

  createNotificationJob(payload: AdminNotificationJobPayload) {
    return this.request<{ item: Record<string, unknown> }>('POST', '/notifications/jobs', payload);
  }

  getNotificationJobs(params?: { status?: string; channel?: string }) {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/notifications/jobs${this.buildQuery({ status: params?.status, channel: params?.channel })}`);
  }

  getNotificationJobSummary() {
    return this.request<Record<string, unknown>>('GET', '/notifications/jobs/summary');
  }

  deliverNotificationJobs(payload?: { limit?: number }) {
    return this.request<Record<string, unknown>>('POST', '/notifications/jobs/deliver', payload || {});
  }

  deliverNotificationJob(jobId: string) {
    return this.request<Record<string, unknown>>('POST', `/notifications/jobs/${encodeURIComponent(jobId)}/deliver`, {});
  }

  requeueNotificationJob(jobId: string) {
    return this.request<Record<string, unknown>>('POST', `/notifications/jobs/${encodeURIComponent(jobId)}/requeue`, {});
  }

  getSmsSendRecords(params?: { status?: string; providerCode?: string; search?: string; page?: number; limit?: number }) {
    return this.request<{ items: Array<Record<string, unknown>>; page: number; limit: number; total: number }>('GET', `/notifications/sms-send-records${this.buildQuery({
      status: params?.status,
      providerCode: params?.providerCode,
      search: params?.search,
      page: params?.page,
      limit: params?.limit,
    })}`);
  }

  getEmailSendRecords(params?: { status?: string; providerCode?: string; search?: string; page?: number; limit?: number }) {
    return this.request<{ items: Array<Record<string, unknown>>; page: number; limit: number; total: number }>('GET', `/notifications/email-send-records${this.buildQuery({
      status: params?.status,
      providerCode: params?.providerCode,
      search: params?.search,
      page: params?.page,
      limit: params?.limit,
    })}`);
  }

  getOrders(params?: { status?: string; userId?: string }) {
    return this.request<{ items: Array<Record<string, unknown>>; summary?: Record<string, number> }>('GET', `/billing/orders${this.buildQuery({ status: params?.status, userId: params?.userId })}`);
  }

  getOrderDetail(orderId: string) {
    return this.request<Record<string, unknown>>('GET', `/billing/orders/${encodeURIComponent(orderId)}`);
  }

  getBillingPlans() {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', '/billing/plans');
  }

  getBillingMembershipConfig() {
    return this.request<Record<string, unknown>>('GET', '/billing/membership-config');
  }

  updateBillingMembershipConfig(payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', '/billing/membership-config', payload);
  }

  createBillingPlan(payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', '/billing/plans', payload);
  }

  updateBillingPlan(planId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/billing/plans/${encodeURIComponent(planId)}`, payload);
  }

  deleteBillingPlan(planId: string) {
    return this.request<Record<string, unknown>>('DELETE', `/billing/plans/${encodeURIComponent(planId)}`);
  }

  markOrderPaid(orderId: string, payload?: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/billing/orders/${encodeURIComponent(orderId)}/pay`, payload || {});
  }

  syncOrderPayment(orderId: string) {
    return this.request<Record<string, unknown>>('POST', `/billing/orders/${encodeURIComponent(orderId)}/sync-payment`, {});
  }

  cancelOrder(orderId: string, payload?: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/billing/orders/${encodeURIComponent(orderId)}/cancel`, payload || {});
  }

  deleteOrder(orderId: string) {
    return this.request<Record<string, unknown>>('DELETE', `/billing/orders/${encodeURIComponent(orderId)}`);
  }

  refundOrder(orderId: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', `/billing/orders/${encodeURIComponent(orderId)}/refund`, payload);
  }

  syncOrderRefund(orderId: string, refundId: string) {
    return this.request<Record<string, unknown>>('POST', `/billing/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}/sync`, {});
  }

  closeExpiredOrders(payload?: { olderThanMinutes?: number; limit?: number }) {
    return this.request<Record<string, unknown>>('POST', '/billing/orders/close-expired', payload || {});
  }

  getShareReviewCases(params?: { status?: string; ownerUserId?: string }) {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/moderation/shares${this.buildQuery({ status: params?.status, ownerUserId: params?.ownerUserId })}`);
  }

  claimShareReviewCase(caseId: string) {
    return this.request<Record<string, unknown>>('POST', `/moderation/shares/${encodeURIComponent(caseId)}/claim`, {});
  }

  decideShareReviewCase(caseId: string, decision: 'approved' | 'rejected' | 'escalated', reason: string) {
    return this.request<Record<string, unknown>>('POST', `/moderation/shares/${encodeURIComponent(caseId)}/decision`, { decision, reason });
  }

  getMarketItems(params?: { status?: string; kind?: string; ownerUserId?: string; sort?: string; order?: string; limit?: number }) {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/market/items${this.buildQuery({
      status: params?.status,
      kind: params?.kind,
      ownerUserId: params?.ownerUserId,
      sort: params?.sort,
      order: params?.order,
      limit: params?.limit,
    })}`);
  }

  getMarketItem(itemId: string) {
    return this.request<{ item: Record<string, unknown> }>('GET', `/market/items/${encodeURIComponent(itemId)}`);
  }

  decideMarketItem(itemId: string, payload: { status: 'approved' | 'rejected' | 'archived'; reviewNote?: string }) {
    return this.request<{ item: Record<string, unknown> }>('POST', `/market/items/${encodeURIComponent(itemId)}/decision`, payload);
  }

  createDefaultMarketItems() {
    return this.request<{ items: Array<Record<string, unknown>>; createdCount: number; updatedCount: number }>('POST', '/market/defaults', {});
  }

  getUserRestrictions(userId: string) {
    return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/risk/users/${encodeURIComponent(userId)}/restrictions`);
  }

  upsertUserRestriction(userId: string, restrictionType: string, payload: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', `/risk/users/${encodeURIComponent(userId)}/restrictions/${encodeURIComponent(restrictionType)}`, payload);
  }

  getCloudStorageOverview() { return this.request<{ items: Array<Record<string, unknown>> }>('GET', '/files/overview'); }
  getCloudStorageUserFiles(userId: string) { return this.request<{ items: Array<Record<string, unknown>> }>('GET', `/files/users/${encodeURIComponent(userId)}/files`); }
  deleteCloudStorageFile(id: string) { return this.request<{ success: boolean }>('DELETE', `/files/files/${encodeURIComponent(id)}`); }
}

export const adminApi = new AdminApiClient();
export { ADMIN_LOGIN_EVENT, ADMIN_TOKEN_KEY };
