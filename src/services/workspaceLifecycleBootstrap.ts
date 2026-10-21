import { initializeWorkspaceLifecycle } from './workspaceLifecycle';

initializeWorkspaceLifecycle((path = '/login') => {
  const url = new URL(window.location.href);
  if (import.meta.env.VITE_APP_ROUTER === 'hash') {
    url.hash = path;
  } else {
    url.pathname = `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;
    url.search = '';
    url.hash = '';
  }
  const sameDocument = url.pathname === window.location.pathname && url.search === window.location.search;
  window.location.replace(url.href);
  if (sameDocument) window.location.reload();
});
