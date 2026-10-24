import type { ObsSceneWindowMode } from 'src/types';

import { type BrowserWindow, type Rectangle, screen } from 'electron';
import { PLATFORM } from 'src-electron/constants';
import { quitStatus } from 'src-electron/main/session';
import { captureElectronError } from 'src-electron/main/utils';
import { createWindow } from 'src-electron/main/window/window-base';
import { log } from 'src/shared/vanilla';

// The scene window: M³'s OBS Studio scene buttons and recording controls in a
// small window of their own, meant to sit next to OBS Studio. It can't be
// closed on its own, only collapsed (hidden) to the action island, and
// closes with M³'s main window. Its contents come from the main window over
// a BroadcastChannel (see useObsSceneWindowBridge): this module only shows,
// hides and closes it.

const DEFAULT_SIZE = { height: 540, width: 360 };

// The window is moved by its title bar (it has no frame): less than this
// much of the title bar on a screen counts as lost.
const MIN_VISIBLE_PX = 48;
const TITLE_BAR_PX = 36;

export const obsScenesWindowInfo: {
  /** Set while M³ closes it itself (main window closing, setting off). */
  allowClose: boolean;
  alwaysOnTop: boolean;
  mode: ObsSceneWindowMode;
  /** Its page has been shown once (ready-to-show). */
  ready: boolean;
  window: BrowserWindow | null;
} = {
  allowClose: false,
  alwaysOnTop: true,
  mode: 'closed',
  ready: false,
  window: null,
};

const isUsable = (win: BrowserWindow | null): win is BrowserWindow =>
  !!win && !win.isDestroyed();

const overlap = (a: Rectangle, b: Rectangle) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Whether enough of a window's title bar is on a screen to grab and move it.
 * @param bounds The window's bounds
 * @param workAreas The screens' work areas
 * @returns Whether the window can be reached
 */
export const isReachable = (bounds: Rectangle, workAreas: Rectangle[]) => {
  const titleBar = { ...bounds, height: TITLE_BAR_PX };
  return workAreas.some(
    (area) => overlap(titleBar, area) >= MIN_VISIBLE_PX * TITLE_BAR_PX,
  );
};

/**
 * Brings the window back onto the primary screen (bottom right) when a
 * screen was unplugged or changed, so a window that can't be closed and
 * reopened is never lost off-screen.
 */
export const keepObsScenesWindowOnScreen = () => {
  const win = obsScenesWindowInfo.window;
  if (!isUsable(win)) return;
  try {
    const bounds = win.getBounds();
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    if (isReachable(bounds, workAreas)) return;

    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    win.setBounds({
      height,
      width,
      x: area.x + area.width - width,
      y: area.y + area.height - height,
    });
    log('Scene window moved back onto a screen', 'obs', 'log', { bounds });
  } catch (error) {
    captureElectronError(error, {
      contexts: { fn: { name: 'keepObsScenesWindowOnScreen' } },
    });
  }
};

const applyMode = (win: BrowserWindow) => {
  win.setAlwaysOnTop(obsScenesWindowInfo.alwaysOnTop, 'floating');
  if (obsScenesWindowInfo.mode === 'shown') {
    if (!win.isVisible()) win.showInactive();
  } else if (win.isVisible()) {
    win.hide();
  }
};

const createObsScenesWindow = () => {
  const win = createWindow('obs-scenes', {
    alwaysOnTop: obsScenesWindowInfo.alwaysOnTop,
    closable: false,
    frame: false,
    fullscreenable: false,
    height: DEFAULT_SIZE.height,
    maximizable: false,
    minHeight: 160,
    minimizable: false,
    minWidth: 220,
    roundedCorners: PLATFORM === 'darwin',
    title: 'Scenes - M³',
    width: DEFAULT_SIZE.width,
  });
  obsScenesWindowInfo.window = win;
  obsScenesWindowInfo.ready = false;

  win.once('ready-to-show', () => {
    obsScenesWindowInfo.ready = true;
    keepObsScenesWindowOnScreen();
    applyMode(win);
  });

  // Only M³ closes it: with the main window, or when the setting is off.
  win.on('close', (e) => {
    if (obsScenesWindowInfo.allowClose || quitStatus.isAppQuitting) return;
    e.preventDefault();
  });

  win.on('closed', () => {
    obsScenesWindowInfo.window = null;
    obsScenesWindowInfo.allowClose = false;
    obsScenesWindowInfo.ready = false;
    screen.off('display-removed', keepObsScenesWindowOnScreen);
    screen.off('display-metrics-changed', keepObsScenesWindowOnScreen);
  });

  // A crashed page reloads, and asks the main window for its contents again.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitStatus.isAppQuitting) return;
    log('Scene window page gone, reloading', 'obs', 'warn', details);
    if (isUsable(win)) win.webContents.reload();
  });

  screen.on('display-removed', keepObsScenesWindowOnScreen);
  screen.on('display-metrics-changed', keepObsScenesWindowOnScreen);

  return win;
};

/**
 * Closes the scene window: the only way it closes.
 */
export const closeObsScenesWindow = () => {
  const win = obsScenesWindowInfo.window;
  if (!isUsable(win)) return;
  obsScenesWindowInfo.allowClose = true;
  win.setClosable(true);
  win.close();
};

/**
 * Opens, shows, hides or closes the scene window.
 * @param mode Closed (setting off), hidden (collapsed) or shown
 * @param alwaysOnTop Whether it stays above other windows
 */
export const setObsScenesWindow = (mode: unknown, alwaysOnTop: unknown) => {
  if (mode !== 'closed' && mode !== 'hidden' && mode !== 'shown') return;
  obsScenesWindowInfo.mode = mode;
  obsScenesWindowInfo.alwaysOnTop = alwaysOnTop !== false;

  if (mode === 'closed') {
    closeObsScenesWindow();
    return;
  }

  const existing = obsScenesWindowInfo.window;
  if (!isUsable(existing)) {
    // Shown once its page is ready (see ready-to-show).
    createObsScenesWindow();
    return;
  }
  if (obsScenesWindowInfo.ready) applyMode(existing);
};
