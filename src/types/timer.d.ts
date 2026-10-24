import type { MediaSectionIdentifier } from './media';

export type BuiltInMeetingPart =
  | 'abbreviated-wt'
  | 'ayfm-1'
  | 'ayfm-2'
  | 'ayfm-3'
  | 'ayfm-4'
  | 'ayfm-5'
  | 'bible-reading'
  | 'cbs'
  | 'co-final-talk'
  | 'co-service-talk'
  | 'concluding-comments'
  | 'gems'
  | 'introduction'
  | 'lac-1'
  | 'lac-2'
  | 'lac-3'
  | 'public-talk'
  | 'song-and-optional-prayer'
  | 'treasures'
  | 'wt';

export type CustomMeetingPart = `custom-${string}`;

export interface CustomTimerPart {
  duration: number;
  id: CustomMeetingPart;
  label: string;
}

export type MeetingPart = BuiltInMeetingPart | CustomMeetingPart;

/** One entry of the timer's list of parts for the selected day. */
export interface MeetingPartOption {
  icon?: string;
  label: string;
  section?: 'custom-timer-parts' | MediaSectionIdentifier;
  value: MeetingPart;
  /** The section's parts don't add up to the time allotted to it. */
  warning?: boolean;
}

export interface MeetingPartTimings {
  endTime: null | number;
  startTime: null | number;
}

export type TimerCountdownDisplay =
  'analog' | 'analog-clock' | 'analog-digital' | 'digital';

// Timer data from main dialog
export interface TimerData {
  aheadBehindMinutes?: null | number;
  /** Show the hand alert (someone raised their hand, or switched on by hand). */
  handAlertActive?: boolean;
  /** Who raised their hand in Zoom, when known. */
  handAlertNames?: string[];
  /** The main window's UI language, for formatting the time of day. */
  locale?: string;
  meetingStartTime?: string;
  mode: 'countdown' | 'countup';
  mwDay?: null | string;
  mwStartTime?: null | string;
  paused: boolean;
  running: boolean;
  time: string;
  timerBackgroundColor?: string;
  timerCountdownDisplay?: TimerCountdownDisplay;
  timerCountdownTargetSeconds?: number;
  timerCountdownWarningIndicator?: boolean;
  /** The part being timed, in the main window's language. */
  timerCurrentPartLabel?: string;
  timerElapsedSeconds?: number;
  timerEnableMeetingCountdown?: boolean;
  timerHourFormat?: '12h' | '24h';
  timerMeetingCountdownMinutes?: number;
  timerOvertimeAnimation?: boolean;
  timerOvertimeBackgroundColor?: string;
  timerOvertimeIndicator?: boolean;
  timerOvertimeShowAmountOnly?: boolean;
  timerOvertimeTextColor?: string;
  /**
   * The part's planned length, only when adaptive timing shortened it: the
   * target below is then the shortened length.
   */
  timerPartPlannedSeconds?: number;
  /** The length of the part being timed, in both timer modes. */
  timerPartTargetSeconds?: number;
  /** Set by the main process: the page may send commands (with the PIN). */
  timerRemoteControlAllowed?: boolean;
  /** The day's parts, for the remote's part list (the remote only). */
  timerRemoteParts?: TimerRemotePart[];
  timerTextColor?: string;
  timerTextSize?: string;
  timerTimeOfDayDisplay?: TimerTimeOfDayDisplay;
  weDay?: null | string;
  weStartTime?: null | string;
}

/** How many Apply Yourself and Living as Christians parts a meeting has. */
export interface TimerPartCounts {
  ayfm: number;
  lac: number;
}

/** One part in the timer remote's list. */
export interface TimerRemotePart {
  current: boolean;
  /** The part has been timed. */
  done: boolean;
  label: string;
  /** The planned length. */
  minutes: number;
  /** The part "Start" would time next. */
  next: boolean;
  value: string;
}

export type TimerTimeOfDayDisplay = 'analog' | 'analog-digital' | 'digital';
