import type { IpcMainEvent } from 'electron';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Covers the openExternal channel's links: the "update available" banner's
// Update button must open the releases this build updates from, not
// package.json's `repository`.

const { ipcMainOn, isSelfMock, openExternalMock } = vi.hoisted(() => ({
  ipcMainOn: vi.fn(),
  isSelfMock: vi.fn(() => true),
  openExternalMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: ipcMainOn },
  shell: { openExternal: openExternalMock },
}));

vi.mock('src-electron/constants', () => ({
  UPDATES_REPOSITORY: 'https://github.com/test-owner/test-updates-repo',
}));

vi.mock('src-electron/main/utils', () => ({
  captureElectronError: vi.fn(),
  isSelf: isSelfMock,
}));

vi.mock('src-electron/main/window/window-base', () => ({
  logToWindow: vi.fn(),
}));

vi.mock('src-electron/main/window/window-main', () => ({
  mainWindowInfo: { mainWindow: null },
}));

// Everything else ipc.ts imports is only used inside other channels' handlers.
vi.mock('src-electron/main/dev-menu', () => ({}));
vi.mock('src-electron/main/disk-space', () => ({}));
vi.mock('src-electron/main/downloads', () => ({}));
vi.mock('src-electron/main/ffmpeg', () => ({}));
vi.mock('src-electron/main/fs', () => ({}));
vi.mock('src-electron/main/heic', () => ({}));
vi.mock('src-electron/main/open-folder', () => ({}));
vi.mock('src-electron/main/pdf', () => ({}));
vi.mock('src-electron/main/screen', () => ({}));
vi.mock('src-electron/main/secrets', () => ({}));
vi.mock('src-electron/main/session', () => ({}));
vi.mock('src-electron/main/shortcuts', () => ({}));
vi.mock('src-electron/main/sqlite', () => ({}));
vi.mock('src-electron/main/timer-remote', () => ({
  setTimerRemoteCommandSink: vi.fn(),
}));
vi.mock('src-electron/main/updater', () => ({}));
vi.mock('src-electron/main/waf-challenge', () => ({}));
vi.mock('src-electron/main/window/window-media', () => ({}));
vi.mock('src-electron/main/window/window-timer', () => ({}));
vi.mock('src-electron/main/window/window-website', () => ({
  askForMediaAccess: vi.fn(),
}));
vi.mock('src-electron/main/zoom-helper-manager', () => ({}));
vi.mock('src-electron/main/zoom-helper-process', () => ({}));
vi.mock('src-electron/main/zoom-test-participants', () => ({}));

type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;

// ipc.ts registers its listeners once, on import - capture them before
// beforeEach's clearAllMocks wipes ipcMainOn's recorded calls.
const listeners = new Map<string, Listener>();

beforeAll(async () => {
  await import('../ipc');
  for (const [channel, listener] of ipcMainOn.mock.calls) {
    listeners.set(channel, listener);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  isSelfMock.mockReturnValue(true);
});

const sendOpenExternal = (website: string) => {
  const listener = listeners.get('openExternal');
  if (!listener) throw new Error('No listener registered for openExternal');
  listener(
    { senderFrame: { url: 'file:///index.html' } } as IpcMainEvent,
    website,
  );
};

describe('openExternal', () => {
  it('opens the latest release of the repository the app updates from', () => {
    sendOpenExternal('latestRelease');
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/test-owner/test-updates-repo/releases/latest',
    );
  });
});
