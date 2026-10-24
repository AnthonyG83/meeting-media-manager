import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings } from 'src/constants/settings';
import { useCongregationSettingsStore } from 'stores/congregation-settings';
import { useCurrentStateStore } from 'stores/current-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testables,
  handleTimerRemoteCommand,
  parseTimerRemotePort,
  renewTimerRemotePin,
  syncTimerRemote,
} from '../timer-remote';

const { createTemporaryNotification, electronApi, timer, updateTimerWindow } =
  vi.hoisted(() => ({
    createTemporaryNotification: vi.fn(),
    electronApi: {
      startTimerRemote: vi.fn(),
      stopTimerRemote: vi.fn(),
      timerRemoteConfig: vi.fn(),
      timerRemoteText: vi.fn(),
    },
    timer: {
      meetingPartsOptions: {
        value: [
          { label: 'Treasures', value: 'treasures' },
          { label: 'Gems', value: 'gems' },
        ],
      },
      nextPart: {
        value: { label: 'Treasures', value: 'treasures' } as null | object,
      },
      pauseTimer: vi.fn(),
      resumeTimer: vi.fn(),
      selectPart: vi.fn(),
      startNextPart: vi.fn(),
      stopTimer: vi.fn(),
      timerPaused: { value: false },
      timerRunning: { value: false },
    },
    updateTimerWindow: vi.fn(),
  }));

vi.mock('boot/i18n', () => ({
  i18n: { global: { locale: { value: 'en' }, t: (key: string) => key } },
}));
vi.mock('src/helpers/notifications', () => ({ createTemporaryNotification }));
vi.mock('src/composables/useTimer', () => ({
  default: () => ({ ...timer, updateTimerWindow }),
}));

const configure = (changes: Partial<typeof defaultSettings>) => {
  useCongregationSettingsStore().congregations['cong'] = {
    ...defaultSettings,
    enableTimerDisplay: true,
    ...changes,
  };
  useCurrentStateStore().currentCongregation = 'cong';
};

beforeEach(() => {
  setActivePinia(createPinia());
  __testables.reset();
  vi.stubGlobal('electronApi', {
    ...globalThis.electronApi,
    ...electronApi,
  });
  electronApi.startTimerRemote.mockReset();
  electronApi.stopTimerRemote.mockReset();
  electronApi.timerRemoteText.mockReset();
  electronApi.timerRemoteConfig.mockReset();
  for (const fn of [
    timer.pauseTimer,
    timer.resumeTimer,
    timer.selectPart,
    timer.startNextPart,
    timer.stopTimer,
  ]) {
    fn.mockReset();
  }
  timer.timerRunning.value = false;
  timer.timerPaused.value = false;
  timer.nextPart.value = { label: 'Treasures', value: 'treasures' };
  createTemporaryNotification.mockReset();
  updateTimerWindow.mockReset();
});

describe('parseTimerRemotePort', () => {
  it('accepts unprivileged ports only', () => {
    expect(parseTimerRemotePort('8787')).toBe(8787);
    expect(parseTimerRemotePort(' 9000 ')).toBe(9000);
    expect(parseTimerRemotePort('80')).toBeNull();
    expect(parseTimerRemotePort('abc')).toBeNull();
    expect(parseTimerRemotePort(null)).toBeNull();
  });
});

describe('syncTimerRemote', () => {
  it('does nothing while the remote is off', async () => {
    configure({ timerRemoteEnable: false });
    await syncTimerRemote();
    expect(electronApi.startTimerRemote).not.toHaveBeenCalled();
    expect(electronApi.stopTimerRemote).not.toHaveBeenCalled();
  });

  it('starts the remote, publishes its addresses and pushes the current state', async () => {
    configure({ timerRemoteEnable: true, timerRemotePort: '8787' });
    electronApi.startTimerRemote.mockResolvedValue({
      running: true,
      urls: ['http://192.168.1.10:8787/'],
    });

    await syncTimerRemote();

    expect(electronApi.timerRemoteText).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'en',
        meetingStartsIn: 'meeting-starts-in',
      }),
    );
    expect(electronApi.startTimerRemote).toHaveBeenCalledWith(8787);
    expect(useCurrentStateStore().timerRemoteUrls).toEqual([
      'http://192.168.1.10:8787/',
    ]);
    expect(updateTimerWindow).toHaveBeenCalled();

    // Same settings again: nothing to restart.
    await syncTimerRemote();
    expect(electronApi.startTimerRemote).toHaveBeenCalledTimes(1);
  });

  it('restarts on a new port and stops when turned off', async () => {
    configure({ timerRemoteEnable: true, timerRemotePort: '8787' });
    electronApi.startTimerRemote.mockResolvedValue({ running: true, urls: [] });
    await syncTimerRemote();

    configure({ timerRemoteEnable: true, timerRemotePort: '9000' });
    await syncTimerRemote();
    expect(electronApi.startTimerRemote).toHaveBeenLastCalledWith(9000);

    configure({ timerRemoteEnable: false });
    await syncTimerRemote();
    expect(electronApi.stopTimerRemote).toHaveBeenCalledTimes(1);
    expect(useCurrentStateStore().timerRemoteUrls).toEqual([]);
  });

  it('tells the user when the port is taken', async () => {
    configure({ timerRemoteEnable: true, timerRemotePort: '8787' });
    electronApi.startTimerRemote.mockResolvedValue({
      error: 'port-in-use',
      running: false,
      urls: [],
    });
    await syncTimerRemote();
    expect(createTemporaryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'timer-remote-port-in-use' }),
    );
  });
});

describe('timer remote control settings', () => {
  const startWith = async (changes: Partial<typeof defaultSettings>) => {
    configure({ timerRemoteEnable: true, ...changes });
    electronApi.startTimerRemote.mockResolvedValue({ running: true, urls: [] });
    await syncTimerRemote();
  };

  it('keeps control off, with no PIN, by default', async () => {
    await startWith({});
    expect(electronApi.timerRemoteConfig).toHaveBeenCalledWith({
      allowControl: false,
      pin: '',
    });
    expect(useCurrentStateStore().currentSettings?.timerRemotePin).toBe('');
  });

  it('makes a 6-digit PIN the first time control is allowed, then keeps it', async () => {
    await startWith({ timerRemoteAllowControl: true });
    const pin = useCurrentStateStore().currentSettings?.timerRemotePin;
    expect(pin).toMatch(/^\d{6}$/);
    expect(electronApi.timerRemoteConfig).toHaveBeenLastCalledWith({
      allowControl: true,
      pin,
    });

    await syncTimerRemote();
    expect(useCurrentStateStore().currentSettings?.timerRemotePin).toBe(pin);
  });

  it('replaces a malformed PIN, and keeps a good one the user chose', async () => {
    await startWith({ timerRemoteAllowControl: true, timerRemotePin: '12' });
    expect(useCurrentStateStore().currentSettings?.timerRemotePin).toMatch(
      /^\d{6}$/,
    );

    await startWith({
      timerRemoteAllowControl: true,
      timerRemotePin: '246810',
    });
    expect(electronApi.timerRemoteConfig).toHaveBeenLastCalledWith({
      allowControl: true,
      pin: '246810',
    });
  });

  it('renews the PIN on request', async () => {
    await startWith({
      timerRemoteAllowControl: true,
      timerRemotePin: '246810',
    });
    renewTimerRemotePin();
    expect(useCurrentStateStore().currentSettings?.timerRemotePin).toMatch(
      /^\d{6}$/,
    );
    expect(createTemporaryNotification).toHaveBeenCalled();
  });
});

describe('handleTimerRemoteCommand', () => {
  const allow = (changes: Partial<typeof defaultSettings> = {}) =>
    configure({
      timerRemoteAllowControl: true,
      timerRemoteEnable: true,
      ...changes,
    });

  it('ignores every command while control is off', () => {
    configure({ timerRemoteAllowControl: false, timerRemoteEnable: true });
    timer.timerRunning.value = true;
    handleTimerRemoteCommand({ action: 'stop' });
    handleTimerRemoteCommand({ action: 'start-next' });
    expect(timer.stopTimer).not.toHaveBeenCalled();
    expect(timer.startNextPart).not.toHaveBeenCalled();
  });

  it('starts the next part and tells the operator', () => {
    allow();
    handleTimerRemoteCommand({ action: 'start-next' });
    expect(timer.startNextPart).toHaveBeenCalledOnce();
    expect(createTemporaryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'timer-remote-command-started' }),
    );
  });

  it('has nothing to start when every part is done', () => {
    allow();
    timer.nextPart.value = null;
    handleTimerRemoteCommand({ action: 'start-next' });
    expect(timer.startNextPart).not.toHaveBeenCalled();
    expect(createTemporaryNotification).not.toHaveBeenCalled();
  });

  it('times a part from the list, and ignores any other', () => {
    allow();
    handleTimerRemoteCommand({ action: 'select', part: 'gems' });
    expect(timer.selectPart).toHaveBeenCalledExactlyOnceWith('gems');

    for (const part of ['ayfm-9', 'GEMS', '../x', undefined]) {
      handleTimerRemoteCommand({ action: 'select', part });
    }
    expect(timer.selectPart).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes only a running timer', () => {
    allow();
    handleTimerRemoteCommand({ action: 'pause' });
    handleTimerRemoteCommand({ action: 'resume' });
    expect(timer.pauseTimer).not.toHaveBeenCalled();
    expect(timer.resumeTimer).not.toHaveBeenCalled();

    timer.timerRunning.value = true;
    handleTimerRemoteCommand({ action: 'resume' });
    expect(timer.resumeTimer).not.toHaveBeenCalled();
    handleTimerRemoteCommand({ action: 'pause' });
    expect(timer.pauseTimer).toHaveBeenCalledOnce();

    timer.timerPaused.value = true;
    handleTimerRemoteCommand({ action: 'pause' });
    expect(timer.pauseTimer).toHaveBeenCalledTimes(1);
    handleTimerRemoteCommand({ action: 'resume' });
    expect(timer.resumeTimer).toHaveBeenCalledOnce();
  });

  it('stops only a running timer', () => {
    allow();
    handleTimerRemoteCommand({ action: 'stop' });
    expect(timer.stopTimer).not.toHaveBeenCalled();

    timer.timerRunning.value = true;
    handleTimerRemoteCommand({ action: 'stop' });
    expect(timer.stopTimer).toHaveBeenCalledOnce();
    expect(createTemporaryNotification).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'timer-remote-command-stopped' }),
    );
  });

  it('ignores an unknown action', () => {
    allow();
    timer.timerRunning.value = true;
    handleTimerRemoteCommand({ action: 'reboot' } as never);
    handleTimerRemoteCommand(undefined as never);
    expect(timer.stopTimer).not.toHaveBeenCalled();
  });
});
