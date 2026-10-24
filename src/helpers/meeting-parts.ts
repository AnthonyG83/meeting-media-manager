import type { MeetingPart } from 'src/types';

import { isCoWeek, isMwMeetingDay, isWeMeetingDay } from 'src/helpers/date';

/** How many Apply Yourself and Living as Christians parts a meeting usually has. */
export const defaultPartCounts = { ayfm: 3, lac: 2 } as const;

/** Minutes allotted to the whole Apply Yourself section, counsel included. */
export const AYFM_SECTION_MINUTES = 15;
/** Minutes allotted to the Living as Christians parts before the study. */
export const LAC_SECTION_MINUTES = 15;
/** Minutes of counsel after each student part (Bible reading, Apply Yourself). */
export const COUNSEL_MINUTES = 1;

/**
 * Minutes between the Spiritual Gems and the Bible reading, so the students
 * can move to an auxiliary class. It is always reserved, whether or not the
 * congregation has one.
 */
export const AUX_CLASS_CHANGEOVER_MINUTES = 1;

/**
 * Minutes after the start of either meeting at which the final song begins.
 * The adaptive timer works towards it, and the default parts add up to it.
 */
export const FINAL_SONG_OFFSET_MINUTES = 100;

export const MAX_AYFM_PARTS = 5;
export const MAX_LAC_PARTS = 3;

// Three Apply Yourself parts with a minute of counsel each (15 - 3 = 12
// minutes shared out) and two Living as Christians parts (15 minutes shared
// out), matching defaultPartCounts.
export const defaultPartDurations: Record<MeetingPart, number> = {
  'abbreviated-wt': 30,
  'ayfm-1': 4,
  'ayfm-2': 4,
  'ayfm-3': 4,
  'ayfm-4': 0,
  'ayfm-5': 0,
  'bible-reading': 4,
  cbs: 30,
  'co-final-talk': 30,
  'co-service-talk': 30,
  'concluding-comments': 3,
  gems: 10,
  introduction: 1,
  'lac-1': 8,
  'lac-2': 7,
  'lac-3': 0,
  'public-talk': 30,
  'song-and-optional-prayer': 5,
  treasures: 10,
  wt: 60,
};

/**
 * Shares a section's minutes out evenly over its parts: the minutes allotted
 * to the parts themselves (counsel not included), as whole minutes, the
 * first parts getting the remainder. Parts beyond `count` get 0.
 */
export const distributeSectionMinutes = (
  prefix: 'ayfm' | 'lac',
  count: number,
  totalMinutes: number,
): Partial<Record<MeetingPart, number>> => {
  const maxParts = prefix === 'ayfm' ? MAX_AYFM_PARTS : MAX_LAC_PARTS;
  const activeParts = Math.min(Math.max(1, Math.floor(count)), maxParts);
  const base = Math.floor(totalMinutes / activeParts);
  const remainder = totalMinutes % activeParts;
  const durations: Partial<Record<MeetingPart, number>> = {};
  for (let i = 1; i <= maxParts; i++) {
    const key = `${prefix}-${i}` as MeetingPart;
    if (i <= activeParts) {
      durations[key] = base + (i <= remainder ? 1 : 0);
    } else {
      durations[key] = 0;
    }
  }
  return durations;
};

/**
 * The minutes the parts of a section may share, counsel excluded. Apply
 * Yourself parts without counsel (see `noCounselCount`) leave their minute
 * to the section's parts.
 */
export const getSectionPartMinutes = (
  prefix: 'ayfm' | 'lac',
  count: number,
  noCounselCount = 0,
) => {
  if (prefix === 'lac') return LAC_SECTION_MINUTES;
  const counselCount = Math.max(0, count - Math.max(0, noCounselCount));
  return AYFM_SECTION_MINUTES - counselCount * COUNSEL_MINUTES;
};

/**
 * Whether the chairman's counsel follows a part. Student parts get counsel,
 * unless the workbook says otherwise (`noCounsel`): the closing discussion
 * of an Apply Yourself section, such as "What Would You Say?", has none.
 */
export const hasCounselAfterPart = (
  part: MeetingPart,
  duration: number,
  noCounsel: readonly MeetingPart[] = [],
): boolean =>
  (part === 'bible-reading' || part.startsWith('ayfm-')) &&
  duration > 0 &&
  !noCounsel.includes(part);

/**
 * The minutes between the end of a part and the start of the next one: the
 * counsel that follows a student part, or the changeover to the auxiliary
 * class after the Spiritual Gems. Every caller that adds up the length of
 * the meeting goes through here, so they all count the same gaps.
 */
export const getGapAfterPart = (
  part: MeetingPart,
  duration: number,
  noCounsel: readonly MeetingPart[] = [],
): number => {
  if (part === 'gems' && duration > 0) return AUX_CLASS_CHANGEOVER_MINUTES;
  return hasCounselAfterPart(part, duration, noCounsel) ? COUNSEL_MINUTES : 0;
};

export const getMeetingPartSequence = (
  date: Date | undefined,
): MeetingPart[] => {
  if (!date) return [];

  if (isWeMeetingDay(date)) {
    const isCo = isCoWeek(date);
    return isCo
      ? [
          'song-and-optional-prayer',
          'public-talk',
          'song-and-optional-prayer',
          'abbreviated-wt',
          'co-final-talk',
          'song-and-optional-prayer',
        ]
      : [
          'song-and-optional-prayer',
          'public-talk',
          'song-and-optional-prayer',
          'wt',
          'song-and-optional-prayer',
        ];
  }

  if (isMwMeetingDay(date)) {
    return [
      'song-and-optional-prayer',
      'introduction',
      'treasures',
      'gems',
      'bible-reading',
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      'ayfm-4',
      'ayfm-5',
      'song-and-optional-prayer',
      'lac-1',
      'lac-2',
      'lac-3',
      ...(isCoWeek(date)
        ? (['concluding-comments', 'co-service-talk'] as MeetingPart[])
        : (['cbs', 'concluding-comments'] as MeetingPart[])),
      'song-and-optional-prayer',
    ];
  }

  return [];
};

export const getMeetingPartOffsetMinutes = (
  partIndex: number,
  sequence: MeetingPart[],
  partDurations: Partial<Record<MeetingPart, number>>,
  noCounsel: readonly MeetingPart[] = [],
): number => {
  let offset = 0;
  for (let i = 0; i < partIndex; i++) {
    const prevPart = sequence[i];
    if (!prevPart) continue;
    const dur = partDurations[prevPart] ?? 0;
    offset += dur + getGapAfterPart(prevPart, dur, noCounsel);
  }
  return offset;
};

/**
 * Parts that absorb an overrun, in proportion to their planned lengths: the
 * Living as Christians parts and the Congregation Bible Study at the
 * midweek meeting, the Watchtower Study at the weekend meeting.
 */
export const ADAPTIVE_PRIMARY_PARTS: readonly MeetingPart[] = [
  'lac-1',
  'lac-2',
  'lac-3',
  'cbs',
  'wt',
  'abbreviated-wt',
];

/**
 * Parts that only absorb what is left of an overrun once no primary part is
 * left to come: the chairman's concluding comments. Every other part (the
 * talks, Treasures, Gems, the student parts, the introduction, the songs) is
 * never shortened.
 */
export const ADAPTIVE_LAST_RESORT_PARTS: readonly MeetingPart[] = [
  'concluding-comments',
];

/** A part is never shortened below this. */
export const ADAPTIVE_MIN_PART_SECONDS = 60;
/** Overruns smaller than this are ignored. */
const ADAPTIVE_TOLERANCE_SECONDS = 15;
/** More behind than this is a wrong start time or clock, not an overrun. */
const ADAPTIVE_MAX_DEVIATION_SECONDS = 30 * 60;
const ADAPTIVE_ROUNDING_SECONDS = 5;

export interface AdaptedPartInput {
  /** The final song's start (the meeting's start + 100 minutes), in ms. */
  deadline: number;
  /** Minutes of custom parts on this day that have not been started. */
  extraPlannedMinutes?: number;
  noCounsel?: readonly MeetingPart[];
  /** When the part starts, in ms: for a preview, its projected start. */
  now: number;
  part: MeetingPart;
  /** The day's planned lengths in minutes, the user's changes included. */
  partDurations: Partial<Record<MeetingPart, number>>;
  sequence: readonly MeetingPart[];
}

/**
 * How long a part may take for the meeting to still end on time, in seconds,
 * or null when it keeps its planned length (nothing to shorten, the part is
 * never shortened, or the meeting is too far behind for it to be a real
 * overrun). Parts are only ever shortened: what the meeting gained is not
 * given back.
 *
 * The deadline is the final song at meetingStart + 100 minutes. What is
 * still required, from this part up to that song, is compared with the time
 * left; the shortfall comes out of the primary parts to come in proportion
 * to their lengths, or, with none left, out of the concluding comments.
 */
export const getAdaptedPartSeconds = ({
  deadline,
  extraPlannedMinutes = 0,
  noCounsel = [],
  now,
  part,
  partDurations,
  sequence,
}: AdaptedPartInput): null | number => {
  const isPrimary = ADAPTIVE_PRIMARY_PARTS.includes(part);
  if (!isPrimary && !ADAPTIVE_LAST_RESORT_PARTS.includes(part)) return null;

  const index = sequence.indexOf(part);
  const finalSongIndex = sequence.lastIndexOf('song-and-optional-prayer');
  if (index === -1 || index >= finalSongIndex) return null;

  let requiredMinutes = extraPlannedMinutes;
  let primaryMinutes = 0;
  for (let i = index; i < finalSongIndex; i++) {
    const next = sequence[i];
    if (!next) continue;
    const minutes = partDurations[next] ?? 0;
    requiredMinutes += minutes + getGapAfterPart(next, minutes, noCounsel);
    if (ADAPTIVE_PRIMARY_PARTS.includes(next)) primaryMinutes += minutes;
  }

  const deviation = (deadline - now) / 1000 - requiredMinutes * 60;
  if (
    deviation >= -ADAPTIVE_TOLERANCE_SECONDS ||
    deviation < -ADAPTIVE_MAX_DEVIATION_SECONDS
  ) {
    return null;
  }

  const plannedSeconds = (partDurations[part] ?? 0) * 60;
  if (plannedSeconds <= 0) return null;

  let shortfall: number;
  if (isPrimary) {
    shortfall = (deviation * plannedSeconds) / (primaryMinutes * 60);
  } else if (primaryMinutes > 0) {
    // The primary parts to come take it first
    return null;
  } else {
    shortfall = deviation;
  }

  const adapted =
    Math.round((plannedSeconds + shortfall) / ADAPTIVE_ROUNDING_SECONDS) *
    ADAPTIVE_ROUNDING_SECONDS;
  const seconds = Math.min(
    plannedSeconds,
    Math.max(ADAPTIVE_MIN_PART_SECONDS, adapted),
  );
  return seconds < plannedSeconds ? seconds : null;
};

/**
 * Both MW and WE meetings are scheduled to run 1h45m: WE = 5m song+prayer +
 * 30m public talk + 5m song + 60m WT study + 5m song+prayer (105m exactly);
 * MW = 5m song+prayer + 25m Treasures + 15m Apply Yourself + 55m Living as
 * Christians (concluding prayer's own length isn't fixed/known in advance,
 * so 105m is the scheduled ceiling, not a derived sum). Used as the
 * fallback "scheduled end" estimate for the meeting quick-actions feature -
 * intentionally a flat constant rather than summing part durations, since
 * the granular defaults below don't reconcile exactly to 105m for MW.
 */
export const MEETING_SCHEDULED_DURATION_MINUTES = 105;

export const getTotalMeetingDurationMinutes = (
  date: Date | undefined,
): number => {
  const sequence = getMeetingPartSequence(date);
  if (!sequence.length) return 0;

  let total = 0;
  for (const part of sequence) {
    const dur = defaultPartDurations[part] ?? 0;
    total += dur + getGapAfterPart(part, dur);
  }
  return total;
};
