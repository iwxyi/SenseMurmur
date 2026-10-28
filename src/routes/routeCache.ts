import type { Location, NavigationType } from 'react-router-dom';

export interface CachedRoute {
  id: string;
  location: Location;
  navigationType: NavigationType;
}

export interface RouteCacheState {
  accountScope: string;
  location: Location;
  activeId: string;
  entries: CachedRoute[];
}

function routeUrl(location: Pick<Location, 'pathname' | 'search' | 'hash'>) {
  const params = new URLSearchParams(location.search);
  params.delete('restoreDraft');
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
}

export function createRouteCache(location: Location, navigationType: NavigationType, accountScope: string): RouteCacheState {
  return { accountScope, location, activeId: location.key, entries: [{ id: location.key, location, navigationType }] };
}

export function advanceRouteCache(
  current: RouteCacheState,
  location: Location,
  navigationType: NavigationType,
  accountScope: string,
): RouteCacheState {
  if (current.accountScope !== accountScope) return createRouteCache(location, navigationType, accountScope);
  if (current.location === location) return current;

  const targetUrl = routeUrl(location);
  const existing = current.entries.find((entry) => entry.location.key === location.key)
    ?? current.entries.find((entry) => routeUrl(entry.location) === targetUrl)
    ?? (navigationType === 'REPLACE'
      ? current.entries.find((entry) => entry.id === current.activeId && entry.location.pathname === location.pathname)
      : undefined);
  const nextEntry: CachedRoute = existing
    ? { ...existing, location, navigationType }
    : { id: location.key, location, navigationType };
  const entries = existing
    ? current.entries.map((entry) => entry.id === existing.id ? nextEntry : entry)
    : [...current.entries, nextEntry].slice(-16);
  return { accountScope, location, activeId: nextEntry.id, entries };
}
