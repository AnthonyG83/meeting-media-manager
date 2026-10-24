export type ObsConnectionState =
  'connected' | 'connecting' | 'disconnected' | 'notConnected';
/** The transition M³ uses to show or hide media (obsMediaTransitions). */
export type ObsMediaTransition = 'cut' | 'fade';
export type ObsSceneType = 'camera' | 'media';

/** A request from the scene window, carried out by the main window. */
export type ObsSceneWindowCommand =
  | { scene: string; skipStageForPrayer?: boolean; type: 'pick' }
  | { type: 'collapse' }
  | { type: 'ready' }
  | { type: 'reconnect' }
  | { type: 'toggle-recording' };

/**
 * The scene window (obsSceneWindow): closed (setting off), hidden (collapsed
 * to the action island) or shown.
 */
export type ObsSceneWindowMode = 'closed' | 'hidden' | 'shown';

export interface ObsSceneWindowScene {
  /** The scene's name or UUID, as M³'s settings refer to it. */
  id: string;
  /** Which of M³'s scenes it is, for its icon; null for the others. */
  kind: 'camera' | 'image' | 'media' | null;
  label: string;
  /** Configured in M³ but not found in OBS Studio. */
  missing: boolean;
}

/** What the scene window shows, sent by the main window. */
export interface ObsSceneWindowState {
  /** The scene button shown as active (OBS's scene, or the one coming up). */
  activeSceneId: null | string;
  connection: ObsConnectionState;
  /** M³'s dark mode, so both windows look alike. */
  dark: boolean;
  hideIcons: boolean;
  /** Media is showing: what, and how it came up. */
  live: {
    image: boolean;
    /** The media or image scene's name, as M³ shows it. */
    label: string;
    transition: null | ObsMediaTransition;
  } | null;
  /** M³'s language, for the window's own texts. */
  locale: string;
  /** While media is showing: the scene that comes up when it ends. */
  next: null | {
    /** The meeting's first or last song: Stage, for the prayer. */
    forPrayer: boolean;
    label: string;
    sceneId: string;
  };
  /** Null when M³'s recording controls are off. */
  recording: null | { active: boolean; pending: boolean };
  scenes: ObsSceneWindowScene[];
}
