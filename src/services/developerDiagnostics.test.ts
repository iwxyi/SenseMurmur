import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/useSettingsStore', () => ({ useSettingsStore: { getState: () => ({ developerMode: true }) } }));

import { getDeveloperDiagnostics, logDeveloperDiagnostic } from './developerDiagnostics';

describe('scroll developer diagnostics', () => {
  const values = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });

  beforeEach(() => {
    values.clear();
    setItem.mockClear();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('does not write console or persistent buffers for per-frame viewport notifications', () => {
    for (let index = 0; index < 60; index += 1) {
      logDeveloperDiagnostic('chat-scroll:position-reported', { offsetTop: index }, 'debug', 'chat-scroll');
      logDeveloperDiagnostic('chat-scroll:position-report-skipped', {}, 'debug', 'chat-scroll');
      logDeveloperDiagnostic('chat-scroll:anchor-restored', {}, 'debug', 'chat-scroll');
    }
    expect(console.debug).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(getDeveloperDiagnostics()).toEqual([]);
  });

  it('retains actual anchor restore failures as warnings with a shared scroll name', () => {
    logDeveloperDiagnostic('chat-scroll:anchor-restore-miss', { reason: 'target-missing' }, 'warn', 'chat-scroll');
    expect(console.warn).toHaveBeenCalledOnce();
    expect(getDeveloperDiagnostics()).toEqual([expect.objectContaining({
      location: 'chat-scroll:anchor-restore-miss', level: 'warn', payload: { reason: 'target-missing' },
    })]);
  });

  it('never suppresses warnings even at routine locations', () => {
    logDeveloperDiagnostic('chat-scroll:position-reported', { reason: 'unexpected-position' }, 'warn', 'chat-scroll');
    expect(console.warn).toHaveBeenCalledOnce();
    expect(getDeveloperDiagnostics()).toHaveLength(1);
  });
});
