import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import AppSnackbar from './AppSnackbar';
import { useSettingsStore } from '../../stores/useSettingsStore';

const DEV_UPDATE_POLL_INTERVAL_MS = 2500;

async function fetchDevUpdateVersion(signal: AbortSignal) {
  const response = await fetch('/__pneumata_dev_updates', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) return null;
  const payload = await response.json() as { version?: unknown };
  return typeof payload.version === 'number' ? payload.version : null;
}

export default function DevUpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const autoApplyUpdates = useSettingsStore((state) => state.developerMode && state.developerUI.autoApplyCodeUpdates);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    let disposed = false;
    let baselineVersion: number | null = null;
    let pollTimer: number | null = null;
    let controller: AbortController | null = null;

    const schedulePoll = () => {
      if (disposed) return;
      pollTimer = window.setTimeout(() => void poll(), DEV_UPDATE_POLL_INTERVAL_MS);
    };

    const poll = async () => {
      controller = new AbortController();
      const activeController = controller;
      try {
        const version = await fetchDevUpdateVersion(activeController.signal);
        if (disposed || version === null) return;
        if (baselineVersion === null) {
          baselineVersion = version;
        } else if (version !== baselineVersion) {
          setNeedRefresh(true);
          baselineVersion = version;
        }
      } catch (error) {
        if (!activeController.signal.aborted && import.meta.env.DEV) {
          console.warn('Failed to check for development updates:', error);
        }
      } finally {
        if (controller === activeController) controller = null;
        schedulePoll();
      }
    };

    void poll();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    if (needRefresh && autoApplyUpdates) window.location.reload();
  }, [needRefresh, autoApplyUpdates]);

  if (!import.meta.env.DEV) return null;

  return (
    <AppSnackbar
      open={needRefresh && !autoApplyUpdates}
      message="开发代码已更新，刷新后生效"
      severity="info"
      autoHideDuration={null}
      onClose={() => setNeedRefresh(false)}
      offset="none"
      action={
        <Button color="inherit" size="small" onClick={() => window.location.reload()}>
          刷新
        </Button>
      }
    />
  );
}
