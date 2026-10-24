import type * as VueUse from '@vueuse/core';
import type {
  DateInfo,
  ObsSceneWindowCommand,
  ObsSceneWindowState,
} from 'src/types';

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { installQuasarPlugin } from 'app/test/vitest/helpers/install-quasar-plugin';
import { installPinia } from 'app/test/vitest/mocks/pinia';
import { defaultSettings } from 'src/constants/settings';
import { useAppSettingsStore } from 'stores/app-settings';
import { useCongregationSettingsStore } from 'stores/congregation-settings';
import { useCurrentStateStore } from 'stores/current-state';
import { useJwStore } from 'stores/jw';
import { useObsStateStore } from 'stores/obs-state';
import { useRecordingStore } from 'stores/recording-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DialogObsPopup from '../DialogObsPopup.vue';

const { callMock, errorCatcherMock, fakeObsWebSocket } = vi.hoisted(() => {
  const call = vi.fn();
  return {
    callMock: call,
    errorCatcherMock: vi.fn(),
    fakeObsWebSocket: { call, off: vi.fn(), on: vi.fn() },
  };
});

const obsGetRecordingStateMock = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(async () => false),
);

// Forwards to the fake socket, so tests see the scene asked for there too.
const obsSetProgramSceneMock = vi.hoisted(() =>
  vi.fn<
    (sceneArgs: Record<string, string>, transition?: unknown) => Promise<void>
  >(async (sceneArgs) => {
    await callMock('SetCurrentProgramScene', sceneArgs);
  }),
);

const obsStartRecordingMock = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(async () => true),
);

// The scene window's channels (see useObsSceneWindowBridge): what the popup
// sends it, and what it sends back.
const sceneWindow = vi.hoisted(() => ({
  command: undefined as unknown as { value: ObsSceneWindowCommand | undefined },
  postState: vi.fn<(state: ObsSceneWindowState) => void>(),
}));

vi.mock('@vueuse/core', async (importOriginal) => {
  const original = await importOriginal<typeof VueUse>();
  const { ref: vueRef } = await import('vue');
  sceneWindow.command = vueRef<ObsSceneWindowCommand>();
  return {
    ...original,
    useBroadcastChannel: ({ name }: { name: string }) =>
      name === 'obs-scene-window-command'
        ? { data: sceneWindow.command, post: vi.fn() }
        : { data: vueRef(), post: sceneWindow.postState },
  };
});

const obsGetRecordingDirectoryMock = vi.hoisted(() =>
  vi.fn<() => Promise<null | string>>(async () => null),
);

vi.mock('src/helpers/error-catcher', () => ({
  errorCatcher: errorCatcherMock,
}));

vi.mock('src/helpers/obs', () => ({
  obsConnect: vi.fn(),
  obsGetRecordingDirectory: obsGetRecordingDirectoryMock,
  obsGetRecordingState: obsGetRecordingStateMock,
  obsSetProgramScene: obsSetProgramSceneMock,
  obsStartRecording: obsStartRecordingMock,
  obsStopRecording: vi.fn(),
}));

vi.mock('src/utils/obs', () => ({
  initObsWebSocket: vi.fn(async () => undefined),
  obsWebSocketInfo: {
    obsWebSocket: fakeObsWebSocket,
  },
}));

installQuasarPlugin();
// createTestingPinia stubs actions by default (they become no-op spies) -
// sceneExists (an action) needs to actually run for the scene-switch tests.
installPinia({ stubActions: false });

// Unmount every popup after its test: a still-mounted QMenu's transition
// timer could otherwise fire after this file's DOM is torn down and fail
// the run with "document is not defined" (seen once in CI).
enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  obsGetRecordingDirectoryMock.mockResolvedValue(null);
  obsGetRecordingStateMock.mockResolvedValue(false);
});

const CONGREGATION_ID = 'test-cong';

// Only the scene-highlighting logic under test reads these settings; the
// rest of the object just needs to satisfy SettingsValues.
const setupObsSettings = (overrides: Partial<typeof defaultSettings> = {}) => {
  const congregationSettingsStore = useCongregationSettingsStore();
  congregationSettingsStore.congregations = {
    [CONGREGATION_ID]: {
      ...defaultSettings,
      obsCameraScene: 'Camera',
      obsEnable: true,
      obsImageScene: null,
      obsMediaScene: 'Media',
      obsSwitchSceneAfterMedia: false,
      ...overrides,
    },
  };

  const currentState = useCurrentStateStore();
  currentState.currentCongregation = CONGREGATION_ID;

  return useObsStateStore();
};

/** Finds the scene q-btn whose label matches `text` and reports whether it's
 * rendered as the active (filled, non-outline) button. QMenu teleports its
 * content straight to document.body, outside the mounted wrapper's tree, so
 * this queries the DOM directly rather than going through `wrapper.find`. */
const isActiveSceneButton = (text: string) => {
  // The button's icon is rendered as an <i> sibling whose own text content
  // is the (non-visible) icon ligature name, so matching on the button's
  // full textContent would also have to account for that. The scene label
  // itself always lives in its own `.ellipsis` div, so match on that instead.
  const label = Array.from(document.querySelectorAll('button .ellipsis')).find(
    (el) => el.textContent?.trim() === text,
  );
  const button = label?.closest('button');
  if (!button) throw new Error(`No scene button found with text "${text}"`);
  return !button.classList.contains('q-btn--outline');
};

describe('DialogObsPopup - active scene highlighting', () => {
  it('follows the live OBS scene when "switch scene after media" is off', async () => {
    const obsState = setupObsSettings({ obsSwitchSceneAfterMedia: false });
    // Simulate OBS having switched to the media scene (e.g. because the
    // user clicked the "Media only" button, which changes OBS's actual
    // program scene via the websocket).
    obsState.currentScene = 'Media';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await Promise.resolve();

    expect(isActiveSceneButton('Media only')).toBe(true);
    expect(isActiveSceneButton('Stage')).toBe(false);
  });

  it('moves the highlight back to Stage once OBS reports the camera scene again', async () => {
    const obsState = setupObsSettings({ obsSwitchSceneAfterMedia: false });
    obsState.currentScene = 'Camera';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await Promise.resolve();

    expect(isActiveSceneButton('Stage')).toBe(true);
    expect(isActiveSceneButton('Media only')).toBe(false);
  });
});

/** Clicks the scene q-btn whose label matches `text` (see isActiveSceneButton
 * for why this queries the DOM directly rather than going through
 * `wrapper.find`). */
const clickSceneButton = (text: string) => {
  const label = Array.from(document.querySelectorAll('button .ellipsis')).find(
    (el) => el.textContent?.trim() === text,
  );
  const button = label?.closest('button');
  if (!button) throw new Error(`No scene button found with text "${text}"`);
  (button as HTMLButtonElement).click();
};

describe('DialogObsPopup - scene switch error handling', () => {
  it('reports a rejected SetCurrentProgramScene call instead of letting it become an unhandled rejection', async () => {
    const obsState = setupObsSettings({ obsSwitchSceneAfterMedia: false });
    obsState.obsConnectionState = 'connected';
    obsState.scenes = [{ sceneName: 'Camera' }, { sceneName: 'Media' }];

    const rejection = new Error('OBS is not ready to perform the request.');
    callMock.mockRejectedValueOnce(rejection);

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await Promise.resolve();

    clickSceneButton('Stage');
    await flushPromises();

    expect(callMock).toHaveBeenCalledWith('SetCurrentProgramScene', {
      sceneName: 'Camera',
    });
    // Regression check: setObsScene's call to obsWebSocket.call(...) must be
    // awaited so its own try/catch can route a rejection through
    // errorCatcher, rather than it escaping as an unhandled promise
    // rejection (MMM-V2-3G0).
    expect(errorCatcherMock).toHaveBeenCalledWith(
      rejection,
      expect.objectContaining({
        contexts: {
          fn: expect.objectContaining({
            desiredScene: 'Camera',
            name: 'setObsScene',
          }),
        },
      }),
    );
  });
});

// FE-15 (full-audit-2026-09-05.md): isRecording was only ever reconciled
// against OBS's actual state once, on the first successful connection - a
// later disconnect/reconnect cycle (e.g. OBS crashing mid-meeting, then
// FE-6's auto-reconnect succeeding) never re-queried the real state, so a
// stale isRecording could keep showing "recording" (or not) after OBS came
// back with a different actual state.
describe('DialogObsPopup - recording-state resync on reconnect', () => {
  it('re-queries the real recording state on every transition to connected, not just the first', async () => {
    // The watcher's object-literal getter source makes Vue re-run its
    // callback on every dependency re-evaluation (a new object reference
    // each time), not just on a genuine value change - so obsGetRecordingState
    // can legitimately be called more than once per transition. Rather than
    // asserting an exact call count, have every call consistently reflect
    // the current "real OBS" truth via a plain closure variable, so the
    // assertion holds regardless of how many times it fires.
    let obsIsActuallyRecording = false;
    obsGetRecordingStateMock.mockImplementation(
      async () => obsIsActuallyRecording,
    );

    const obsState = setupObsSettings({ obsEnableRecordingControls: true });
    obsState.obsConnectionState = 'connected';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await flushPromises();

    const recording = useRecordingStore();
    expect(recording.isRecording).toBe(false);

    // OBS crashes/closes, then FE-6's auto-reconnect succeeds - this time
    // OBS itself was actually recording (e.g. started from a different
    // control surface while M³ was disconnected).
    obsState.obsConnectionState = 'disconnected';
    await flushPromises();
    obsIsActuallyRecording = true;
    obsState.obsConnectionState = 'connected';
    await flushPromises();

    expect(recording.isRecording).toBe(true);
  });
});

describe('DialogObsPopup - status line', () => {
  it('says OBS is connected', async () => {
    const obsState = setupObsSettings();
    obsState.obsConnectionState = 'connected';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await flushPromises();

    const status = document.querySelector('.action-popup__status');
    expect(status?.textContent).toContain('OBS Studio: Connected');
    expect(status?.querySelector('.text-positive')).not.toBeNull();
  });

  it('warns when the scene list could not be loaded', async () => {
    const obsState = setupObsSettings();
    obsState.obsConnectionState = 'connected';
    obsState.obsSceneListError = true;

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await flushPromises();

    const status = document.querySelector('.action-popup__status');
    expect(status?.textContent).toContain("OBS Studio: Couldn't load scenes");
    expect(status?.querySelector('.text-warning')).not.toBeNull();
  });
});

describe('DialogObsPopup - recording footer', () => {
  it('has no footer when recording controls are off', async () => {
    const obsState = setupObsSettings({ obsEnableRecordingControls: false });
    obsState.obsConnectionState = 'connected';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await flushPromises();

    expect(document.querySelector('.action-popup__footer')).toBeNull();
  });

  it('puts start/stop recording first and the recording folder under it', async () => {
    obsGetRecordingDirectoryMock.mockResolvedValue('C:/Recordings');
    const openFolderSpy = vi
      .spyOn(globalThis.electronApi, 'openFolder')
      .mockResolvedValue('');
    const obsState = setupObsSettings({ obsEnableRecordingControls: true });
    obsState.obsConnectionState = 'connected';

    mount(DialogObsPopup, {
      props: { modelValue: true },
    });
    await flushPromises();

    const footer = document.querySelector('.action-popup__footer');
    expect(footer?.firstElementChild?.textContent).toContain('Start Recording');

    const folderButton = footer?.querySelector<HTMLButtonElement>(
      '.action-popup__footer-row button',
    );
    expect(folderButton?.textContent).toContain('Open recording folder');
    folderButton?.click();
    expect(openFolderSpy).toHaveBeenCalledWith('C:/Recordings');

    openFolderSpy.mockRestore();
  });
});

// Like in Settings (obsImageScene depends on obsMediaScene), the image scene
// only applies along with a media scene: clearing the media scene (e.g. to
// let Zoom share the media instead) must stop OBS Studio showing images too.
describe('DialogObsPopup - image scene', () => {
  const showImage = async () => {
    useCurrentStateStore().mediaPlaying.url = 'file:///media/picture.jpg';
    globalThis.dispatchEvent(
      new CustomEvent('obsSceneEvent', { detail: { scene: 'media' } }),
    );
    await flushPromises();
  };

  const setupConnected = (overrides: Partial<typeof defaultSettings>) => {
    const obsState = setupObsSettings(overrides);
    obsState.obsConnectionState = 'connected';
    obsState.scenes = [
      { sceneName: 'Camera' },
      { sceneName: 'Media' },
      { sceneName: 'Images' },
    ];
    mount(DialogObsPopup, { props: { modelValue: true } });
  };

  it('switches to the image scene for an image when a media scene is set', async () => {
    setupConnected({ obsImageScene: 'Images', obsMediaScene: 'Media' });
    await showImage();

    expect(callMock).toHaveBeenCalledWith('SetCurrentProgramScene', {
      sceneName: 'Images',
    });
  });

  it("doesn't switch to the image scene without a media scene", async () => {
    setupConnected({ obsImageScene: 'Images', obsMediaScene: null });
    await showImage();

    expect(callMock).not.toHaveBeenCalledWith(
      'SetCurrentProgramScene',
      expect.anything(),
    );
  });
});

const sendSceneEvent = async (scene: 'camera' | 'media') => {
  globalThis.dispatchEvent(
    new CustomEvent('obsSceneEvent', { detail: { scene } }),
  );
  await flushPromises();
};

const playMedia = async (url: string, uniqueId = 'item') => {
  const currentState = useCurrentStateStore();
  currentState.mediaPlaying.url = url;
  currentState.mediaPlaying.uniqueId = uniqueId;
  await sendSceneEvent('media');
};

const stopMedia = async () => {
  const currentState = useCurrentStateStore();
  currentState.mediaPlaying.url = '';
  currentState.mediaPlaying.uniqueId = '';
  await sendSceneEvent('camera');
};

const mountConnected = (overrides: Partial<typeof defaultSettings>) => {
  const obsState = setupObsSettings(overrides);
  obsState.obsConnectionState = 'connected';
  obsState.scenes = [
    { sceneName: 'Camera' },
    { sceneName: 'Media' },
    { sceneName: 'Lectern' },
  ];
  mount(DialogObsPopup, { props: { modelValue: true } });
  return obsState;
};

describe('DialogObsPopup - media transitions', () => {
  it('cuts to an image and back', async () => {
    mountConnected({ obsMediaTransitions: true });

    await playMedia('file:///media/picture.jpg');
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Media' },
      'cut',
    );

    await stopMedia();
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Camera' },
      'cut',
    );
  });

  it('fades to a video and back', async () => {
    mountConnected({ obsMediaTransitions: true });

    await playMedia('file:///media/video.mp4');
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Media' },
      'fade',
    );

    await stopMedia();
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Camera' },
      'fade',
    );
  });

  it("keeps OBS's own transition when the setting is off", async () => {
    mountConnected({ obsMediaTransitions: false });

    await playMedia('file:///media/video.mp4');
    await stopMedia();

    expect(obsSetProgramSceneMock).toHaveBeenNthCalledWith(
      1,
      { sceneName: 'Media' },
      null,
    );
    expect(obsSetProgramSceneMock).toHaveBeenNthCalledWith(
      2,
      { sceneName: 'Camera' },
      null,
    );
  });

  it("keeps OBS's own transition for a scene picked by hand", async () => {
    mountConnected({ obsMediaTransitions: true });
    await flushPromises();

    clickSceneButton('Lectern');
    await flushPromises();

    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Lectern' },
      null,
    );
  });
});

describe('DialogObsPopup - Stage for the prayer after the first and last song', () => {
  const SONG = 'file:///media/song.mp4';

  const setupMeeting = (overrides: Partial<typeof defaultSettings> = {}) => {
    const currentState = useCurrentStateStore();
    currentState.selectedDate = '2026-10-21';
    const song = (uniqueId: string) => ({
      tag: { type: 'song', value: uniqueId },
      uniqueId,
    });
    useJwStore().lookupPeriod[CONGREGATION_ID] = [
      {
        date: new Date('2026-10-21T00:00:00'),
        mediaSections: [
          { config: { uniqueId: 'opening' }, items: [song('first-song')] },
          {
            config: { uniqueId: 'middle' },
            items: [{ uniqueId: 'video' }, song('middle-song')],
          },
          { config: { uniqueId: 'closing' }, items: [song('last-song')] },
        ],
        status: 'complete',
      } as unknown as DateInfo,
    ];

    const obsState = mountConnected({
      obsRememberPreviouslyUsedScene: true,
      obsStageAfterFirstLastSong: true,
      obsSwitchSceneAfterMedia: true,
      ...overrides,
    });
    // The scene in use before the song, which M³ would otherwise go back to.
    obsState.previousScene = 'Lectern';
    return obsState;
  };

  const findDialogButton = (text: string) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.modal-confirm button'),
    ).find((el) => el.textContent?.includes(text));
    if (!button) throw new Error(`No dialog button with text "${text}"`);
    return button;
  };

  it.each(['first-song', 'last-song'])(
    'goes back to Stage after %s, not to the scene used before',
    async (songId) => {
      setupMeeting();

      await playMedia(SONG, songId);
      await stopMedia();

      expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
        { sceneName: 'Camera' },
        null,
      );
    },
  );

  it('goes back to the scene used before after a middle song', async () => {
    setupMeeting();

    await playMedia(SONG, 'middle-song');
    await stopMedia();

    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Lectern' },
      null,
    );
  });

  it('goes back to the scene used before when the setting is off', async () => {
    setupMeeting({ obsStageAfterFirstLastSong: false });

    await playMedia(SONG, 'first-song');
    await stopMedia();

    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Lectern' },
      null,
    );
  });

  it('shows Stage as the scene coming up while the song plays', async () => {
    setupMeeting();

    await playMedia(SONG, 'first-song');

    expect(isActiveSceneButton('Stage')).toBe(true);
    expect(isActiveSceneButton('Lectern')).toBe(false);
  });

  it('asks before another scene replaces Stage, and keeps Stage when told to', async () => {
    const obsState = setupMeeting();
    await playMedia(SONG, 'first-song');

    clickSceneButton('Lectern');
    await flushPromises();

    expect(document.body.textContent).toContain('Skip Stage for the prayer?');
    findDialogButton('Keep Stage').click();
    await flushPromises();
    expect(obsState.stageForPrayerSkipped).toBe(false);

    await stopMedia();
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Camera' },
      null,
    );
  });

  it('uses the scene picked instead of Stage once confirmed', async () => {
    setupMeeting();
    await playMedia(SONG, 'first-song');

    clickSceneButton('Lectern');
    await flushPromises();
    findDialogButton('Use Lectern').click();
    await flushPromises();

    await stopMedia();
    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Lectern' },
      null,
    );
  });

  it("doesn't ask when Stage itself is picked", async () => {
    setupMeeting();
    await playMedia(SONG, 'first-song');

    clickSceneButton('Stage');
    await flushPromises();

    expect(document.body.textContent).not.toContain(
      'Skip Stage for the prayer?',
    );
  });
});

describe('DialogObsPopup - scene window', () => {
  // The stores and the channel outlive each test: start from a clean slate.
  beforeEach(() => {
    sceneWindow.command.value = undefined;
    useObsStateStore().$reset();
    useAppSettingsStore().obsSceneWindowCollapsed = false;
    const { mediaPlaying } = useCurrentStateStore();
    mediaPlaying.url = '';
    mediaPlaying.uniqueId = '';
  });

  const setObsSceneWindowSpy = () =>
    vi.spyOn(globalThis.electronApi, 'setObsSceneWindow');

  const lastState = () => sceneWindow.postState.mock.calls.at(-1)?.[0];

  const sendCommand = async (command: ObsSceneWindowCommand) => {
    sceneWindow.command.value = command;
    await flushPromises();
  };

  it('stays closed while the setting is off', async () => {
    const spy = setObsSceneWindowSpy();
    mountConnected({ obsSceneWindow: false });
    await flushPromises();

    expect(spy).toHaveBeenLastCalledWith('closed', true);
    expect(sceneWindow.postState).not.toHaveBeenCalled();
  });

  it('shows, on top, and hides once collapsed', async () => {
    const spy = setObsSceneWindowSpy();
    mountConnected({ obsSceneWindow: true, obsSceneWindowOnTop: true });
    await flushPromises();
    expect(spy).toHaveBeenLastCalledWith('shown', true);

    await sendCommand({ type: 'collapse' });

    expect(useAppSettingsStore().obsSceneWindowCollapsed).toBe(true);
    expect(spy).toHaveBeenLastCalledWith('hidden', true);
  });

  it('sends the scenes, with the active one', async () => {
    mountConnected({ obsSceneWindow: true });
    await flushPromises();

    expect(lastState()).toMatchObject({
      connection: 'connected',
      live: null,
      scenes: [
        { id: 'Camera', kind: 'camera', label: 'Stage', missing: false },
        { id: 'Media', kind: 'media', label: 'Media only', missing: false },
        { id: 'Lectern', kind: null, label: 'Lectern', missing: false },
      ],
    });
  });

  it('sends it all again when the window (re)loads', async () => {
    mountConnected({ obsSceneWindow: true });
    await flushPromises();
    sceneWindow.postState.mockClear();

    await sendCommand({ type: 'ready' });

    expect(sceneWindow.postState).toHaveBeenCalledOnce();
  });

  it('switches to the scene picked there', async () => {
    mountConnected({ obsSceneWindow: true });
    await flushPromises();

    await sendCommand({ scene: 'Lectern', type: 'pick' });

    expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
      { sceneName: 'Lectern' },
      null,
    );
  });

  it('starts recording from there', async () => {
    mountConnected({ obsEnableRecordingControls: true, obsSceneWindow: true });
    await flushPromises();

    await sendCommand({ type: 'toggle-recording' });

    expect(obsStartRecordingMock).toHaveBeenCalled();
  });

  describe('during the first song', () => {
    const setupSong = async () => {
      const currentState = useCurrentStateStore();
      currentState.selectedDate = '2026-10-21';
      useJwStore().lookupPeriod[CONGREGATION_ID] = [
        {
          date: new Date('2026-10-21T00:00:00'),
          mediaSections: [
            {
              config: { uniqueId: 'opening' },
              items: [{ tag: { type: 'song', value: '1' }, uniqueId: 'song' }],
            },
          ],
          status: 'complete',
        } as unknown as DateInfo,
      ];
      const obsState = mountConnected({
        obsMediaTransitions: true,
        obsRememberPreviouslyUsedScene: true,
        obsSceneWindow: true,
        obsStageAfterFirstLastSong: true,
        obsSwitchSceneAfterMedia: true,
      });
      obsState.previousScene = 'Lectern';
      await playMedia('file:///media/song.mp4', 'song');
      return obsState;
    };

    it('sends the media live and Stage next, for the prayer', async () => {
      await setupSong();

      expect(lastState()).toMatchObject({
        activeSceneId: 'Camera',
        live: { image: false, label: 'Media only', transition: 'fade' },
        next: { forPrayer: true, label: 'Stage', sceneId: 'Camera' },
      });
    });

    it('uses the scene picked there instead of Stage once confirmed there', async () => {
      await setupSong();

      await sendCommand({
        scene: 'Lectern',
        skipStageForPrayer: true,
        type: 'pick',
      });
      await stopMedia();

      expect(obsSetProgramSceneMock).toHaveBeenLastCalledWith(
        { sceneName: 'Lectern' },
        'fade',
      );
    });
  });
});
