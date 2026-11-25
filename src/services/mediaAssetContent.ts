import { api } from './api';
import { backendUrl } from './backendUrl';
import { workspaceFetch } from './workspaceLifecycle';

export function fetchMediaAssetContent(url: string, kind: 'image' | 'video' | 'audio', signal: AbortSignal) {
  if (!url.startsWith('/uploads/media/')) return workspaceFetch(url, { signal });
  const query = new URLSearchParams({ url });
  if (kind !== 'image') query.set('kind', kind);
  return api.fetchWithAuth(backendUrl(`/api/media-assets/content?${query}`), { signal });
}
