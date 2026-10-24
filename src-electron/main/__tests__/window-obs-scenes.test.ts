import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

const { createWindowMock, quitStatus, screenMock } = vi.hoisted(() => ({
  createWindowMock: vi.fn(),
  quitStatus: { isAppQuitting: false },
  screenMock: {
    getAllDisplays: vi.fn(() => [
      { workArea: { height: 1040, width: 1920, x: 0, y: 0 } },
    ]),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { height: 1040, width: 1920, x: 0, y: 0 },
    })),
    off: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('electron', () => ({ screen: screenMock }));
vi.mock('src-electron/constants', () => ({ PLATFORM: 'win32' }));
vi.mock('src-electron/main/session', () => ({ quitStatus }));
vi.mock('src-electron/main/utils', () => ({ captureElectronError: vi.fn() }));
vi.mock('src-electron/main/window/window-base', () => ({
  createWindow: createWindowMock,
}));
vi.mock('src/shared/vanilla', () => ({ log: vi.fn() }));

const makeWindow = () => {
  const handlers: Record<string, Handler[]> = {};
  const contentHandlers: Record<string, Handler[]> = {};
  let visible = false;
  let bounds = { height: 540, width: 360, x: 1200, y: 500 };
  const win = {
    close: vi.fn(() => {
      const event = { preventDefault: vi.fn() };
      handlers.close?.forEach((h) => h(event));
      if (!event.preventDefault.mock.calls.length) {
        handlers.closed?.forEach((h) => h());
      }
      return event;
    }),
    emit: (name: string, ...args: unknown[]) =>
      handlers[name]?.forEach((h) => h(...args)),
    getBounds: vi.fn(() => bounds),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: () => false,
    isVisible: () => visible,
    on: (name: string, h: Handler) => {
      (handlers[name] ??= []).push(h);
    },
    once: (name: string, h: Handler) => {
      (handlers[name] ??= []).push(h);
    },
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn((b: typeof bounds) => {
      bounds = b;
    }),
    setClosable: vi.fn(),
    showInactive: vi.fn(() => {
      visible = true;
    }),
    webContents: {
      emit: (name: string, ...args: unknown[]) =>
        contentHandlers[name]?.forEach((h) => h(...args)),
      on: (name: string, h: Handler) => {
        (contentHandlers[name] ??= []).push(h);
      },
      reload: vi.fn(),
    },
  };
  return win;
};

type FakeWindow = ReturnType<typeof makeWindow>;

const load = async () => {
  vi.resetModules();
  return import('../window/window-obs-scenes');
};

let win: FakeWindow;

beforeEach(() => {
  vi.clearAllMocks();
  quitStatus.isAppQuitting = false;
  win = makeWindow();
  createWindowMock.mockReturnValue(win);
});

describe('setObsScenesWindow', () => {
  it('creates the window and shows it, on top, once its page is ready', async () => {
    const { setObsScenesWindow } = await load();

    setObsScenesWindow('shown', true);
    expect(createWindowMock).toHaveBeenCalledWith(
      'obs-scenes',
      expect.objectContaining({ closable: false, frame: false }),
    );
    expect(win.showInactive).not.toHaveBeenCalled();

    win.emit('ready-to-show');
    expect(win.showInactive).toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
  });

  it('hides when collapsed and shows again when expanded', async () => {
    const { setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);
    win.emit('ready-to-show');

    setObsScenesWindow('hidden', true);
    expect(win.hide).toHaveBeenCalled();
    expect(win.isVisible()).toBe(false);

    setObsScenesWindow('shown', false);
    expect(win.isVisible()).toBe(true);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
    expect(createWindowMock).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when created collapsed', async () => {
    const { setObsScenesWindow } = await load();

    setObsScenesWindow('hidden', true);
    win.emit('ready-to-show');

    expect(win.showInactive).not.toHaveBeenCalled();
  });

  it('ignores a malformed mode', async () => {
    const { setObsScenesWindow } = await load();

    setObsScenesWindow('maximized', true);

    expect(createWindowMock).not.toHaveBeenCalled();
  });
});

describe('closing the scene window', () => {
  it("can't be closed on its own", async () => {
    const { obsScenesWindowInfo, setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);

    const event = win.close();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(obsScenesWindowInfo.window).toBe(win);
  });

  it('closes when M³ closes it', async () => {
    const { closeObsScenesWindow, obsScenesWindowInfo, setObsScenesWindow } =
      await load();
    setObsScenesWindow('shown', true);

    closeObsScenesWindow();

    expect(win.setClosable).toHaveBeenCalledWith(true);
    expect(obsScenesWindowInfo.window).toBeNull();
    expect(obsScenesWindowInfo.allowClose).toBe(false);
  });

  it('closes when the setting is turned off', async () => {
    const { obsScenesWindowInfo, setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);

    setObsScenesWindow('closed', true);

    expect(obsScenesWindowInfo.window).toBeNull();
  });

  it('closes while the app quits', async () => {
    const { obsScenesWindowInfo, setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);
    quitStatus.isAppQuitting = true;

    const event = win.close();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(obsScenesWindowInfo.window).toBeNull();
  });
});

describe('keeping the scene window reachable', () => {
  it('reloads its page after a crash', async () => {
    const { setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });

    expect(win.webContents.reload).toHaveBeenCalled();
  });

  it('moves back onto the primary screen once its screen is gone', async () => {
    const { keepObsScenesWindowOnScreen, setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);
    win.setBounds({ height: 540, width: 360, x: 2500, y: 300 });

    keepObsScenesWindowOnScreen();

    expect(win.getBounds()).toEqual({
      height: 540,
      width: 360,
      x: 1920 - 360,
      y: 1040 - 540,
    });
  });

  it('stays put while it is on a screen', async () => {
    const { keepObsScenesWindowOnScreen, setObsScenesWindow } = await load();
    setObsScenesWindow('shown', true);
    win.setBounds.mockClear();

    keepObsScenesWindowOnScreen();

    expect(win.setBounds).not.toHaveBeenCalled();
  });

  it('counts a window barely on a screen as lost', async () => {
    const { isReachable } = await load();
    const screenArea = { height: 1040, width: 1920, x: 0, y: 0 };

    expect(
      isReachable({ height: 540, width: 360, x: 1900, y: 100 }, [screenArea]),
    ).toBe(false);
    expect(
      isReachable({ height: 540, width: 360, x: 1800, y: 100 }, [screenArea]),
    ).toBe(true);
  });
});
