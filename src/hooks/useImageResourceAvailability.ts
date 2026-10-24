import { useEffect, useState } from 'react';

export type ImageResourceAvailability = 'idle' | 'loading' | 'ready' | 'unavailable';

// Keep only URLs, never decoded Image objects. Tab remounts should not hide
// backgrounds that have already loaded; bound the cache for long sessions.
const MAX_READY_URLS = 128;
const readyUrls = new Set<string>();

/**
 * Checks a remote image before it is used as CSS background. Unlike an <img>,
 * CSS backgrounds have no error event, so failed media would otherwise leave
 * an indistinct empty surface.
 */
export function useImageResourceAvailability(url?: string | null): ImageResourceAvailability {
  const normalizedUrl = url?.trim() || '';
  const [result, setResult] = useState<{ url: string; status: ImageResourceAvailability }>(() => ({
    url: normalizedUrl,
    status: normalizedUrl ? 'loading' : 'idle',
  }));

  useEffect(() => {
    if (!normalizedUrl || readyUrls.has(normalizedUrl)) return undefined;
    let active = true;
    const image = new Image();
    image.onload = () => {
      readyUrls.add(normalizedUrl);
      if (readyUrls.size > MAX_READY_URLS) {
        const oldestUrl = readyUrls.values().next().value;
        if (oldestUrl !== undefined) readyUrls.delete(oldestUrl);
      }
      if (active) setResult({ url: normalizedUrl, status: 'ready' });
    };
    image.onerror = () => { if (active) setResult({ url: normalizedUrl, status: 'unavailable' }); };
    image.src = normalizedUrl;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [normalizedUrl]);

  if (!normalizedUrl) return 'idle';
  if (readyUrls.has(normalizedUrl)) return 'ready';
  return result.url === normalizedUrl ? result.status : 'loading';
}
