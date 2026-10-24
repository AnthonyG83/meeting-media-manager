import type * as VueUse from '@vueuse/core';
import type { ObsSceneWindowState } from 'src/types';

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { installQuasarPlugin } from 'app/test/vitest/helpers/install-quasar-plugin';
import { installPinia } from 'app/test/vitest/mocks/pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ObsScenesPage from '../ObsScenesPage.vue';

const { postMock, stateData } = vi.hoisted(() => ({
  postMock: vi.fn(),
  stateData: { value: undefined as ObsSceneWindowState | undefined },
}));

// happy-dom has no BroadcastChannel between windows: feed the page directly.
vi.mock('@vueuse/core', async (importOriginal) => {
  const original = await importOriginal<typeof VueUse>();
  const { ref: vueRef } = await import('vue');
  const data = vueRef<ObsSceneWindowState>();
  Object.defineProperty(stateData, 'value', {
    get: () => data.value,
    set: (v: ObsSceneWindowState) => {
      data.value = v;
    },
  });
  return {
    ...original,
    useBroadcastChannel: ({ name }: { name: string }) =>
      name === 'obs-scene-window-state'
        ? { data, post: vi.fn() }
        : { data: vueRef(), post: postMock },
  };
});

installQuasarPlugin();
installPinia();
enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
});

const baseState = (
  overrides: Partial<ObsSceneWindowState> = {},
): ObsSceneWindowState => ({
  activeSceneId: 'Camera',
  connection: 'connected',
  dark: false,
  hideIcons: false,
  live: null,
  locale: 'en',
  next: null,
  recording: { active: false, pending: false },
  scenes: [
    { id: 'Camera', kind: 'camera', label: 'Stage', missing: false },
    { id: 'Lectern', kind: null, label: 'Lectern', missing: false },
    { id: 'Wide', kind: null, label: 'Stage wide', missing: false },
  ],
  ...overrides,
});

// Quasar renders an icon's name as text in tests: match on the label alone.
const findButton = (text: string) => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  ).find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`No button "${text}"`);
  return button;
};

const findScene = (label: string) => {
  const span = Array.from(
    document.querySelectorAll('.obs-scenes__scene .ellipsis'),
  ).find((el) => el.textContent?.trim() === label);
  const button = span?.closest('button');
  if (!button) throw new Error(`No scene "${label}"`);
  return button;
};

const mountWith = async (state: ObsSceneWindowState) => {
  stateData.value = state;
  const wrapper = mount(ObsScenesPage, { attachTo: document.body });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  postMock.mockClear();
});

describe('ObsScenesPage', () => {
  it('asks the main window for its contents when it opens', async () => {
    await mountWith(baseState());

    expect(postMock).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('shows every scene, the active one filled', async () => {
    await mountWith(baseState({ activeSceneId: 'Lectern' }));

    expect(findScene('Lectern').classList).not.toContain('q-btn--outline');
    expect(findScene('Stage wide').classList).toContain('q-btn--outline');
  });

  it('sends the scene picked to the main window', async () => {
    await mountWith(baseState());

    findScene('Lectern').click();

    expect(postMock).toHaveBeenCalledWith({ scene: 'Lectern', type: 'pick' });
  });

  it('collapses to the action island', async () => {
    await mountWith(baseState());

    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse to the action island"]',
      )
      ?.click();

    expect(postMock).toHaveBeenCalledWith({ type: 'collapse' });
  });

  it('starts and stops recording', async () => {
    await mountWith(baseState());

    findButton('Start Recording').click();

    expect(postMock).toHaveBeenCalledWith({ type: 'toggle-recording' });
  });

  it('has no recording button when the recording controls are off', async () => {
    await mountWith(baseState({ recording: null }));

    expect(document.body.textContent).not.toContain('Start Recording');
  });

  it('shows the media live, how it came up, and the scene after it', async () => {
    await mountWith(
      baseState({
        live: { image: false, label: 'Media only', transition: 'fade' },
        next: { forPrayer: false, label: 'Lectern', sceneId: 'Lectern' },
      }),
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('Media only');
    expect(text).toContain('Fade');
    expect(text).toContain('Media is showing: Lectern goes live when it ends.');
  });

  describe('during the first or last song', () => {
    const songState = () =>
      baseState({
        live: { image: false, label: 'Media only', transition: 'fade' },
        next: { forPrayer: true, label: 'Stage', sceneId: 'Camera' },
      });

    it('says Stage comes next for the prayer', async () => {
      await mountWith(songState());

      expect(document.body.textContent).toContain(
        'When this song ends, back to Stage for the prayer.',
      );
      expect(findScene('Stage').textContent).toContain('Prayer');
    });

    it('asks before another scene replaces Stage', async () => {
      await mountWith(songState());

      findScene('Lectern').click();
      await flushPromises();

      expect(document.body.textContent).toContain('Skip Stage for the prayer?');
      expect(postMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pick' }),
      );

      findButton('Use Lectern').click();
      expect(postMock).toHaveBeenCalledWith({
        scene: 'Lectern',
        skipStageForPrayer: true,
        type: 'pick',
      });
    });

    it('keeps Stage when told to', async () => {
      await mountWith(songState());

      findScene('Lectern').click();
      await flushPromises();
      findButton('Keep Stage').click();

      expect(postMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pick' }),
      );
    });

    it("doesn't ask when Stage itself is picked", async () => {
      await mountWith(songState());

      findScene('Stage').click();

      expect(postMock).toHaveBeenCalledWith({ scene: 'Camera', type: 'pick' });
    });
  });

  it('says when OBS Studio is not connected, and reconnects', async () => {
    await mountWith(baseState({ connection: 'disconnected' }));

    expect(document.body.textContent).toContain("OBS Studio isn't connected");
    findButton('Reconnect').click();

    expect(postMock).toHaveBeenCalledWith({ type: 'reconnect' });
  });

  it('follows the main window to a new state', async () => {
    await mountWith(baseState());

    stateData.value = baseState({ activeSceneId: 'Wide' });
    await flushPromises();

    expect(findScene('Stage wide').classList).not.toContain('q-btn--outline');
  });
});
