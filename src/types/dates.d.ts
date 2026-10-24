import type { MediaItem, MediaSection } from './media';
import type {
  CustomTimerPart,
  MeetingPart,
  MeetingPartTimings,
  TimerPartCounts,
} from './timer';

export interface DateInfo {
  date: Date;
  mediaSections: MediaSectionWithConfig[];
  status: 'complete' | 'error' | null;
  /** The meeting timer's number of Apply Yourself and Living as Christians parts. */
  timerPartCounts?: TimerPartCounts;
  /** The meeting timer's part durations the user changed, in minutes. */
  timerPartDurations?: Partial<Record<MeetingPart, number>>;
  /** The meeting timer's custom parts. */
  timerParts?: CustomTimerPart[];
  /** When each part was actually started and stopped with the meeting timer. */
  timerPartTimings?: Partial<Record<MeetingPart, MeetingPartTimings>>;
  /** The midweek workbook's number of Apply Yourself and Living as Christians parts. */
  timerProgramCounts?: TimerPartCounts;
  /** The midweek workbook's part lengths, in minutes. */
  timerProgramDurations?: Partial<Record<MeetingPart, number>>;
  /** The Apply Yourself parts the workbook gives no counsel after. */
  timerProgramNoCounsel?: MeetingPart[];
  /** The midweek workbook's titles of the Apply Yourself and Living as Christians parts. */
  timerProgramTitles?: Partial<Record<MeetingPart, string>>;
}

export interface MediaSectionWithConfig {
  config: MediaSection;
  items?: MediaItem[];
}
