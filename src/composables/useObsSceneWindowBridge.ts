import type {
  ObsSceneWindowCommand,
  ObsSceneWindowMode,
  ObsSceneWindowState,
} from 'src/types';

import { useBroadcastChannel, watchImmediate } from '@vueuse/core';
import { type Ref, toRaw } from 'vue';

/** The main window's OBS scene state, sent to the scene window. */
export const OBS_SCENE_WINDOW_STATE_CHANNEL = 'obs-scene-window-state';
/** Requests from the scene window, carried out by the main window. */
export const OBS_SCENE_WINDOW_COMMAND_CHANNEL = 'obs-scene-window-command';

interface Options {
  /** The window's mode, from the settings and whether it's collapsed. */
  mode: Ref<ObsSceneWindowMode>;
  onCommand: (command: ObsSceneWindowCommand) => void;
  onTop: Ref<boolean>;
  state: Ref<ObsSceneWindowState>;
}

/**
 * Keeps the OBS scene window (a window of its own, see window-obs-scenes.ts)
 * shown, hidden or closed as set, sends it what to show, and carries out
 * what's picked there. Used once, by the main window's OBS popup, which
 * owns the scene switching.
 * @param options The window's mode and state, and what to do on a request
 */
export function useObsSceneWindowBridge({
  mode,
  onCommand,
  onTop,
  state,
}: Options) {
  const { post } = useBroadcastChannel<
    ObsSceneWindowState,
    ObsSceneWindowState
  >({ name: OBS_SCENE_WINDOW_STATE_CHANNEL });

  const { data: command } = useBroadcastChannel<
    ObsSceneWindowCommand,
    ObsSceneWindowCommand
  >({ name: OBS_SCENE_WINDOW_COMMAND_CHANNEL });

  // structuredClone (BroadcastChannel) can't copy Vue's proxies.
  const publish = () => {
    if (mode.value === 'closed') return;
    post(structuredClone(toRaw(state.value)));
  };

  watchImmediate([mode, onTop], ([newMode, newOnTop]) => {
    globalThis.electronApi?.setObsSceneWindow(newMode, newOnTop);
  });

  watchImmediate(state, publish, { deep: true });

  watchImmediate(command, (newCommand) => {
    if (!newCommand) return;
    // A (re)loaded scene window asks for what to show.
    if (newCommand.type === 'ready') {
      publish();
      return;
    }
    onCommand(newCommand);
  });
}
