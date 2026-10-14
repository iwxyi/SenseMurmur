import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  pending: false,
  settings: { developerMode: false, developerUI: { autoApplyCodeUpdates: false } },
  effects: [] as Array<() => void | (() => void)>,
  updateSW: vi.fn(),
  registerSW: vi.fn(),
  updateRef: { current: null as null | ((reload: boolean) => void) },
}));

// Capture effects so update events and settings changes can be exercised without a DOM.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => [harness.pending, (value: boolean) => { harness.pending = value; }],
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
  useRef: () => harness.updateRef,
}));
vi.mock('../../stores/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: typeof harness.settings) => unknown) => selector(harness.settings),
}));
vi.mock('virtual:pwa-register', () => ({ registerSW: harness.registerSW }));

import DevUpdatePrompt from './DevUpdatePrompt';
import PwaUpdatePrompt from './PwaUpdatePrompt';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_APP_UPDATE_MODE', 'auto');
  harness.pending = false;
  harness.settings = { developerMode: false, developerUI: { autoApplyCodeUpdates: false } };
  harness.effects = [];
  harness.updateRef.current = null;
  harness.updateSW.mockReset();
  harness.registerSW.mockReset().mockReturnValue(harness.updateSW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('development code updates', () => {
  it('detects updates with the legacy auto environment setting but waits for approval', async () => {
    vi.stubEnv('DEV', true);
    const reload = vi.fn();
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: { reload } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 1 }) })
      .mockResolvedValue({ ok: true, json: async () => ({ version: 2 }) }));

    DevUpdatePrompt();
    const cleanup = harness.effects[0]();
    await vi.advanceTimersByTimeAsync(2500);
    expect(harness.pending).toBe(true);

    harness.effects = [];
    const prompt = DevUpdatePrompt();
    harness.effects[1]();
    expect(prompt?.props.open).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    harness.settings = { developerMode: true, developerUI: { autoApplyCodeUpdates: true } };
    harness.effects = [];
    DevUpdatePrompt();
    harness.effects[1]();
    expect(reload).toHaveBeenCalledOnce();
    if (typeof cleanup === 'function') cleanup();
  });

  it('requires developer mode even when automatic updates are saved as enabled', () => {
    vi.stubEnv('DEV', true);
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    harness.pending = true;
    harness.settings.developerUI.autoApplyCodeUpdates = true;
    const prompt = DevUpdatePrompt();
    harness.effects[1]();
    expect(prompt?.props.open).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('PWA code updates', () => {
  it.each([false, true])('applies pending updates only when the setting is enabled (%s)', (enabled) => {
    vi.stubEnv('DEV', false);
    harness.settings = { developerMode: true, developerUI: { autoApplyCodeUpdates: enabled } };
    PwaUpdatePrompt();
    harness.effects[0]();
    const options = harness.registerSW.mock.calls[0][0] as { onNeedRefresh: () => void };
    options.onNeedRefresh();
    expect(harness.pending).toBe(true);

    harness.effects = [];
    const prompt = PwaUpdatePrompt();
    harness.effects[1]();
    expect(prompt?.props.open).toBe(!enabled);
    expect(harness.updateSW).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(harness.updateSW).toHaveBeenCalledWith(true);
    else {
      harness.settings.developerUI.autoApplyCodeUpdates = true;
      harness.effects = [];
      PwaUpdatePrompt();
      harness.effects[1]();
      expect(harness.updateSW).toHaveBeenCalledWith(true);
    }
  });
});
