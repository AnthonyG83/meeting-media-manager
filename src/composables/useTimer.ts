import type {
  CustomTimerPart,
  DateInfo,
  MeetingPart,
  MeetingPartOption,
  MeetingPartTimings,
  TimerData,
  TimerPartCounts,
  TimerRemotePart,
} from 'src/types';

import {
  useBroadcastChannel,
  useIntervalFn,
  watchImmediate,
} from '@vueuse/core';
import { i18n } from 'boot/i18n';
import { storeToRefs } from 'pinia';
import {
  isCoWeek,
  isMeetingDay,
  isMwMeetingDay,
  isWeMeetingDay,
} from 'src/helpers/date';
import { errorCatcher } from 'src/helpers/error-catcher';
import { getJwIconFromKeyword } from 'src/helpers/fonts';
import {
  defaultPartCounts,
  defaultPartDurations,
  distributeSectionMinutes,
  FINAL_SONG_OFFSET_MINUTES,
  getAdaptedPartSeconds,
  getMeetingPartOffsetMinutes,
  getMeetingPartSequence,
  getSectionPartMinutes,
  MAX_AYFM_PARTS,
  MAX_LAC_PARTS,
} from 'src/helpers/meeting-parts';
import { useCurrentStateStore } from 'stores/current-state';
import { useHandAlertStore } from 'stores/hand-alert';
import { computed, effectScope, ref, watch } from 'vue';

// FE-8 (full-audit-2026-09-04.md): both wall-clock diffs below could
// otherwise go negative on a backward system-clock jump (DST fallback, NTP
// correction, manual time change) - garbling formattedTime (negative
// minutes/seconds in count-up mode, remaining time appearing to jump
// upward in countdown mode) or pushing timerStartTime into the future.
// Clamping to 0 means the display holds rather than skipping ahead once
// real time catches back up to the last anchor - exported as pure
// functions so they're testable without instantiating the full composable
// (broadcast channel, i18n, Pinia store, useIntervalFn).
export const computeElapsedSeconds = (now: number, startTime: number): number =>
  Math.max(0, Math.floor((now - startTime) / 1000));

export const computePauseDuration = (now: number, pausedTime: number): number =>
  Math.max(0, now - pausedTime);

/** A part's duration as the user typed it: whole, non-negative minutes. */
export const normalizePartDuration = (duration: unknown): number => {
  const minutes = Math.round(Number(duration));
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  return minutes;
};

/**
 * Whether a section's parts add up to the minutes allotted to it (the
 * warning shown next to each of its parts when they don't).
 */
export const getSectionDurationWarning = (
  prefix: 'ayfm' | 'lac',
  count: number,
  partDurations: Partial<Record<MeetingPart, number>>,
  noCounsel: readonly MeetingPart[] = [],
): boolean => {
  let total = 0;
  let withoutCounsel = 0;
  for (let i = 1; i <= count; i++) {
    const part = `${prefix}-${i}` as MeetingPart;
    total += partDurations[part] ?? 0;
    // A part without counsel leaves its minute to the parts
    if (noCounsel.includes(part)) withoutCounsel++;
  }
  return total !== getSectionPartMinutes(prefix, count, withoutCounsel);
};

export const formatMinutesSeconds = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

/** The Treasures from God's Word talk, Spiritual Gems and Bible reading. */
const TREASURES_PART_COUNT = 3;

const isCustomPart = (part: MeetingPart): part is `custom-${string}` =>
  part.startsWith('custom-');

const t = (key: string, named?: Record<string, unknown>) =>
  (i18n.global.t as (key: string, named?: Record<string, unknown>) => string)(
    key,
    named ?? {},
  );

/**
 * Where the timer keeps what belongs to one day: the part counts, the
 * durations the user changed, the recorded timings and the custom parts.
 * These live on the day itself (persisted with the jw store's lookup
 * period), so switching between days or restarting M³ never mixes one
 * meeting's timings into another's.
 */
type TimerDayState = Pick<
  DateInfo,
  | 'timerPartCounts'
  | 'timerPartDurations'
  | 'timerParts'
  | 'timerPartTimings'
  | 'timerProgramCounts'
  | 'timerProgramDurations'
  | 'timerProgramNoCounsel'
  | 'timerProgramTitles'
>;

const createCustomPartId = (): `custom-${string}` =>
  `custom-${Math.random().toString(36).slice(2, 10)}`; // NOSONAR: id of a user-added timer part within one day, not a secret

const getCustomEndTimeCountdownTarget = (
  date: Date,
  configuredMeetingStartTime: null | string | undefined,
  customEndTime: string,
  maxDurationSeconds: number,
) => {
  if (!configuredMeetingStartTime) return 0;

  const [startHour, startMinute] = configuredMeetingStartTime.split(':');
  if (!startHour || !startMinute) return 0;

  const meetingStartTime = new Date(date);
  meetingStartTime.setHours(
    Number.parseInt(startHour),
    Number.parseInt(startMinute),
    0,
    0,
  );

  const parts = customEndTime.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const endTime = new Date(meetingStartTime);
  endTime.setHours(h, m, 0, 0);
  const now = new Date();
  const remaining = Math.max(0, endTime.getTime() - now.getTime()) / 1000;
  const remainingWholeSeconds = Math.floor(remaining);
  return Math.min(remainingWholeSeconds, maxDurationSeconds);
};

const getTimedEndCountdownTarget = (
  date: Date,
  configuredMeetingStartTime: null | string | undefined,
  customEndTime: string,
  adaptiveDefaultEndTime: string,
  maxDurationSeconds: number,
) => {
  if (!customEndTime || customEndTime === adaptiveDefaultEndTime) {
    return maxDurationSeconds;
  }

  return getCustomEndTimeCountdownTarget(
    date,
    configuredMeetingStartTime,
    customEndTime,
    maxDurationSeconds,
  );
};

const toHoursMinutes = (timestamp: number) => {
  const date = new Date(timestamp);
  return (
    date.getHours().toString().padStart(2, '0') +
    ':' +
    date.getMinutes().toString().padStart(2, '0')
  );
};

const createTimer = () => {
  const currentState = useCurrentStateStore();
  const { currentSettings, selectedDateObject } = storeToRefs(currentState);

  // Only used while no day is selected (which the calendar page never
  // allows for long): the timer still works, it just doesn't persist.
  const fallbackDayState = ref<TimerDayState>({});
  const dayState = computed<TimerDayState>(
    () => selectedDateObject.value ?? fallbackDayState.value,
  );
  const selectedDate = computed(() => selectedDateObject.value?.date);

  const timerRunning = ref(false);
  const timerPaused = ref(false);
  const timerStartTime = ref<null | number>(null);
  const timerPausedTime = ref<null | number>(null);
  const elapsedSeconds = ref(0);
  const countdownTarget = ref<number>(0);
  const timerMode = computed(
    () => currentSettings.value?.timerMode ?? 'countup',
  );
  const currentPart = ref<MeetingPart>('public-talk');
  // The length the running part was shortened to when it started (adaptive
  // timing), fixed for as long as it runs.
  const runningAdaptedSeconds = ref<null | number>(null);
  const wtCustomEndTime = ref<string>('');
  const cbsCustomEndTime = ref('');

  // --- Part counts (per day) --------------------------------------------------

  // What the midweek workbook says about this day (see
  // importMidweekProgram in jw-media.ts), unless the profile opted out. It is
  // kept apart from the day's own changes, which always win over it.
  const useProgramTimings = computed(
    () => currentSettings.value?.timerImportProgramTimings !== false,
  );
  const programCounts = computed(() =>
    useProgramTimings.value ? dayState.value.timerProgramCounts : undefined,
  );
  const programDurations = computed(() =>
    useProgramTimings.value ? dayState.value.timerProgramDurations : undefined,
  );

  const getPartCounts = (): TimerPartCounts =>
    dayState.value.timerPartCounts ??
    (programCounts.value && { ...programCounts.value }) ?? {
      ...defaultPartCounts,
    };

  /**
   * What the workbook says about a section is only true for the number of
   * parts it lists: with another number of parts, the parts are not the
   * workbook's any more.
   */
  const matchesProgramCount = (prefix: 'ayfm' | 'lac', count: number) =>
    programCounts.value?.[prefix] === count;

  /** The Apply Yourself parts the workbook gives no counsel after. */
  const getNoCounsel = (ayfmCount = getPartCounts().ayfm): MeetingPart[] =>
    matchesProgramCount('ayfm', ayfmCount)
      ? (dayState.value.timerProgramNoCounsel ?? [])
      : [];

  const noCounsel = computed(() => getNoCounsel());

  const setPartCount = (prefix: 'ayfm' | 'lac', count: number) => {
    const maxParts = prefix === 'ayfm' ? MAX_AYFM_PARTS : MAX_LAC_PARTS;
    const safeCount = Math.min(Math.max(1, Math.floor(count)), maxParts);
    const counts = { ...getPartCounts(), [prefix]: safeCount };
    dayState.value.timerPartCounts = counts;
    // A new number of parts is a fresh start for the section: share its
    // minutes out evenly, then let the user adjust each part freely.
    const distributed = distributeSectionMinutes(
      prefix,
      safeCount,
      getSectionPartMinutes(
        prefix,
        safeCount,
        prefix === 'ayfm' ? getNoCounsel(safeCount).length : 0,
      ),
    );
    dayState.value.timerPartDurations = {
      ...dayState.value.timerPartDurations,
      ...distributed,
    };
    refreshCountdownTarget();
  };

  const ayfmPartsCount = computed<number>({
    get: () => getPartCounts().ayfm,
    set: (count) => setPartCount('ayfm', count),
  });

  const lacPartsCount = computed<number>({
    get: () => getPartCounts().lac,
    set: (count) => setPartCount('lac', count),
  });

  // --- Custom parts (per day) -------------------------------------------------

  const customTimerParts = computed<CustomTimerPart[]>(
    () => dayState.value.timerParts ?? [],
  );

  /**
   * Days without a meeting start with one custom part per custom media
   * section (or a single part), so the timer is usable right away.
   */
  const ensureNonMeetingTimerParts = () => {
    if (isMeetingDay(selectedDate.value) || !selectedDateObject.value) return;
    if (selectedDateObject.value.timerParts?.length) return;

    const sectionParts = (selectedDateObject.value.mediaSections ?? [])
      .filter(
        (section) => !!section.config?.label || !!section.config?.uniqueId,
      )
      .map((section, index) => ({
        duration: 5,
        id: createCustomPartId(),
        label: section.config?.label || `${t('meeting-part')} ${index + 1}`, // NOSONAR: empty label uses the default name
      }));

    selectedDateObject.value.timerParts = sectionParts.length
      ? sectionParts
      : [
          {
            duration: 5,
            id: createCustomPartId(),
            label: `${t('meeting-part')} 1`,
          },
        ];
  };

  const addCustomTimerPart = () => {
    const nextIndex = customTimerParts.value.length + 1;
    const newPart: CustomTimerPart = {
      duration: 5,
      id: createCustomPartId(),
      label: `${t('meeting-part')} ${nextIndex}`,
    };
    dayState.value.timerParts = [...customTimerParts.value, newPart];
    if (!isMeetingDay(selectedDate.value) && !isCustomPart(currentPart.value)) {
      currentPart.value = newPart.id;
    }
    return newPart;
  };

  const updateCustomTimerPart = (
    partId: MeetingPart,
    changes: Partial<Pick<CustomTimerPart, 'duration' | 'label'>>,
  ) => {
    const part = customTimerParts.value.find((p) => p.id === partId);
    if (!part) return;
    if (changes.label !== undefined) part.label = changes.label;
    if (changes.duration !== undefined) {
      part.duration = normalizePartDuration(changes.duration);
      refreshCountdownTarget();
    }
  };

  const moveCustomTimerPart = (fromIndex: number, toIndex: number) => {
    const parts = dayState.value.timerParts;
    if (
      !parts ||
      toIndex < 0 ||
      toIndex >= parts.length ||
      fromIndex === toIndex
    )
      return;

    const [movedPart] = parts.splice(fromIndex, 1);
    if (!movedPart) return;
    parts.splice(toIndex, 0, movedPart);
  };

  const removeCustomTimerPart = (partId: MeetingPart) => {
    const parts = dayState.value.timerParts;
    if (!parts) return;
    // A day without a meeting needs at least one part to time.
    if (!isMeetingDay(selectedDate.value) && parts.length <= 1) return;

    dayState.value.timerParts = parts.filter((part) => part.id !== partId);

    if (currentPart.value === partId) {
      currentPart.value =
        dayState.value.timerParts[0]?.id ??
        meetingPartsOptions.value[0]?.value ??
        currentPart.value;
    }
  };

  // --- Durations (per day) ----------------------------------------------------

  /**
   * Every part's planned length in minutes: the defaults, the workbook's
   * lengths over them, the day's own changes over those, and the custom
   * parts' lengths. 0 means the part is skipped (no planned length).
   */
  const partDurations = computed<Record<MeetingPart, number>>(() => {
    const durations: Record<MeetingPart, number> = { ...defaultPartDurations };
    for (const changes of [
      programDurations.value,
      dayState.value.timerPartDurations,
    ]) {
      for (const [part, minutes] of Object.entries(changes ?? {})) {
        if (typeof minutes === 'number') {
          durations[part as MeetingPart] = minutes;
        }
      }
    }
    for (const part of customTimerParts.value) {
      durations[part.id] = normalizePartDuration(part.duration);
    }
    return durations;
  });

  const setPartDuration = (part: MeetingPart, duration: number) => {
    const minutes = normalizePartDuration(duration);
    if (isCustomPart(part)) {
      updateCustomTimerPart(part, { duration: minutes });
      return;
    }
    dayState.value.timerPartDurations = {
      ...dayState.value.timerPartDurations,
      [part]: minutes,
    };
    // A length typed in by hand wins over the one worked out at the start
    if (part === currentPart.value) runningAdaptedSeconds.value = null;
    refreshCountdownTarget();
  };

  const adjustPartDuration = (part: MeetingPart, delta: number) => {
    setPartDuration(part, (partDurations.value[part] ?? 0) + delta);
  };

  const getPartDurationSeconds = (part: MeetingPart) =>
    (partDurations.value[part] ?? 0) * 60;

  /** The day has lengths from the workbook to go back to. */
  const hasProgramTimings = computed(() => !!programDurations.value);

  /** The day's part counts or lengths differ from what the workbook says. */
  const hasProgramOverrides = computed(
    () =>
      !!dayState.value.timerPartCounts || !!dayState.value.timerPartDurations,
  );

  const resetToProgramTimings = () => {
    dayState.value.timerPartCounts = undefined;
    dayState.value.timerPartDurations = undefined;
    refreshCountdownTarget();
  };

  // --- Timings (per day) ------------------------------------------------------

  const partTimings = computed<
    Partial<Record<MeetingPart, MeetingPartTimings>>
  >(() => dayState.value.timerPartTimings ?? {});

  // The day the running part belongs to: when the user moves to another day
  // while a part is running, its end time still goes on the day it started.
  let runningDayState: null | TimerDayState = null;

  const setPartTiming = (
    part: MeetingPart,
    changes: Partial<MeetingPartTimings>,
    target: TimerDayState = dayState.value,
  ) => {
    const current = target.timerPartTimings?.[part] ?? {
      endTime: null,
      startTime: null,
    };
    target.timerPartTimings = {
      ...target.timerPartTimings,
      [part]: { ...current, ...changes },
    };
  };

  const resetPartTiming = (part: MeetingPart) => {
    if (!dayState.value.timerPartTimings) return;
    dayState.value.timerPartTimings = Object.fromEntries(
      Object.entries(dayState.value.timerPartTimings).filter(
        ([key]) => key !== part,
      ),
    );
  };

  const resetAllPartTimings = () => {
    dayState.value.timerPartTimings = {};
  };

  const hasAnyPartTimings = computed(() =>
    Object.values(partTimings.value).some(
      (timing) => !!timing?.startTime || !!timing?.endTime,
    ),
  );

  // --- The list of parts ------------------------------------------------------

  const getTimeString = (timestamp: null | number, seconds = false): string => {
    if (!timestamp) return '';
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      hour12: currentSettings.value?.timerHourFormat === '12h',
      minute: '2-digit',
      second: seconds ? '2-digit' : undefined,
    };
    try {
      return new Date(timestamp).toLocaleTimeString(
        i18n.global.locale.value,
        options,
      );
    } catch {
      try {
        return new Date(timestamp).toLocaleTimeString([], options);
      } catch {
        return '';
      }
    }
  };

  const customPartOptions = computed<MeetingPartOption[]>(() =>
    customTimerParts.value.map((part) => ({
      label: `${part.label} (${normalizePartDuration(part.duration)} min.)`,
      section: 'custom-timer-parts',
      value: part.id,
    })),
  );

  const weekendPartOptions = (date: Date): MeetingPartOption[] => {
    const options: MeetingPartOption[] = [
      {
        icon: getJwIconFromKeyword('public-talk'),
        label: t('public-talk'),
        section: 'pt',
        value: 'public-talk',
      },
      {
        icon: getJwIconFromKeyword('wt'),
        label: t('wt'),
        section: 'wt',
        value: 'wt',
      },
    ];

    if (isCoWeek(date)) {
      options.push({
        icon: getJwIconFromKeyword('co-final-talk'),
        label: t('co-final-talk'),
        section: 'co',
        value: 'co-final-talk',
      });
    }

    return options;
  };

  /**
   * "4. Starting a Conversation (3 min.)", with the workbook's own number and
   * title, when the workbook's page was read for this day.
   */
  const getWorkbookPartLabel = (
    prefix: 'ayfm' | 'lac',
    index: number,
  ): string | undefined => {
    const part = `${prefix}-${index}` as MeetingPart;
    const title = useProgramTimings.value
      ? dayState.value.timerProgramTitles?.[part]
      : undefined;
    const program = programCounts.value;
    if (
      !title ||
      !program ||
      !matchesProgramCount(prefix, getPartCounts()[prefix])
    ) {
      return undefined;
    }
    // Numbered through the whole meeting: 3 Treasures parts, then the
    // Apply Yourself parts, then the Living as Christians parts
    const number =
      TREASURES_PART_COUNT + (prefix === 'ayfm' ? 0 : program.ayfm) + index;
    return t('workbook-part', {
      duration: partDurations.value[part] ?? 0,
      part: number,
      title,
    });
  };

  const midweekPartOptions = (date: Date): MeetingPartOption[] => {
    const isCo = isCoWeek(date);
    const options: MeetingPartOption[] = [
      {
        icon: getJwIconFromKeyword('introduction'),
        label: t('introduction'),
        value: 'introduction',
      },
      {
        icon: getJwIconFromKeyword('treasures'),
        label: t('treasures-talk'),
        section: 'tgw',
        value: 'treasures',
      },
      {
        icon: getJwIconFromKeyword('gems'),
        label: t('gems'),
        section: 'tgw',
        value: 'gems',
      },
      {
        icon: getJwIconFromKeyword('bible-reading'),
        label: t('bible-reading'),
        section: 'tgw',
        value: 'bible-reading',
      },
    ];

    const ayfmWarning = getSectionDurationWarning(
      'ayfm',
      ayfmPartsCount.value,
      partDurations.value,
      noCounsel.value,
    );
    for (let i = 1; i <= ayfmPartsCount.value; i++) {
      const part = `ayfm-${i}` as MeetingPart;
      options.push({
        icon: getJwIconFromKeyword('ayfm-part'),
        label:
          getWorkbookPartLabel('ayfm', i) ??
          t('ayfm-part', {
            duration: partDurations.value[part] ?? 0,
            part: i,
          }),
        section: 'ayfm',
        value: part,
        warning: ayfmWarning,
      });
    }

    const lacWarning = getSectionDurationWarning(
      'lac',
      lacPartsCount.value,
      partDurations.value,
    );
    for (let i = 1; i <= lacPartsCount.value; i++) {
      const part = `lac-${i}` as MeetingPart;
      options.push({
        icon: getJwIconFromKeyword('lac-part'),
        label:
          getWorkbookPartLabel('lac', i) ??
          t('lac-part', {
            duration: partDurations.value[part] ?? 0,
            part: i,
          }),
        section: 'lac',
        value: part,
        warning: lacWarning,
      });
    }

    if (isCo) {
      options.push({
        icon: getJwIconFromKeyword('co-service-talk'),
        label: t('co-service-talk'),
        section: 'co',
        value: 'co-service-talk',
      });
    } else {
      options.push({
        icon: getJwIconFromKeyword('cbs'),
        label: t('cbs'),
        section: 'lac',
        value: 'cbs',
      });
    }
    options.push({
      icon: getJwIconFromKeyword('concluding-comments'),
      label: t('concluding-comments'),
      value: 'concluding-comments',
    });
    return options;
  };

  const meetingPartsOptions = computed<MeetingPartOption[]>(() => {
    const date = selectedDate.value;
    if (date && isWeMeetingDay(date)) {
      return [...weekendPartOptions(date), ...customPartOptions.value];
    }
    if (date && isMwMeetingDay(date)) {
      return [...midweekPartOptions(date), ...customPartOptions.value];
    }
    // No meeting: only the custom parts, which need no section header.
    return customPartOptions.value.map((option) => ({
      label: option.label,
      value: option.value,
    }));
  });

  const currentPartOption = computed(() =>
    meetingPartsOptions.value.find(
      (option) => option.value === currentPart.value,
    ),
  );

  const currentPartLabel = computed(() => currentPartOption.value?.label ?? '');

  const notStarted = (option: MeetingPartOption) =>
    !partTimings.value[option.value]?.startTime;

  /**
   * The part to time next: the first one after the current part that hasn't
   * been started, else the first unstarted part anywhere in the list.
   */
  const nextPart = computed<MeetingPartOption | null>(() => {
    const options = meetingPartsOptions.value;
    const currentIndex = options.findIndex(
      (option) => option.value === currentPart.value,
    );
    return (
      options.slice(currentIndex + 1).find((option) => notStarted(option)) ??
      options.find((option) => notStarted(option)) ??
      null
    );
  });

  // --- Countdown targets ------------------------------------------------------

  const getWeekendCountdownTarget = (date: Date) => {
    if (currentPart.value !== 'wt') {
      return getEffectivePartSeconds(currentPart.value);
    }

    const wtPart = isCoWeek(date) ? 'abbreviated-wt' : 'wt';
    const wtMaxDuration = getEffectivePartSeconds(
      'wt',
      getPartDurationSeconds(wtPart),
    );
    return getTimedEndCountdownTarget(
      date,
      currentSettings.value?.weStartTime,
      wtCustomEndTime.value,
      wtAdaptiveDefaultEndTime.value,
      wtMaxDuration,
    );
  };

  const getMidweekCountdownTarget = (date: Date) => {
    if (currentPart.value !== 'cbs') {
      return getEffectivePartSeconds(currentPart.value);
    }

    const cbsMaxDuration = getEffectivePartSeconds('cbs');
    return getTimedEndCountdownTarget(
      date,
      currentSettings.value?.mwStartTime,
      cbsCustomEndTime.value,
      cbsAdaptiveDefaultEndTime.value,
      cbsMaxDuration,
    );
  };

  /**
   * How long a part may take: the length adaptive timing worked out when it
   * started, if it did, else its planned length.
   */
  const getEffectivePartSeconds = (
    part: MeetingPart,
    plannedSeconds = getPartDurationSeconds(part),
  ) =>
    part === currentPart.value && runningAdaptedSeconds.value !== null
      ? runningAdaptedSeconds.value
      : plannedSeconds;

  const calculateCountdownTarget = () => {
    const date = selectedDate.value;
    if (!date || timerMode.value === 'countup') return 0;
    if (isWeMeetingDay(date)) return getWeekendCountdownTarget(date);
    if (isMwMeetingDay(date)) return getMidweekCountdownTarget(date);
    return getPartDurationSeconds(currentPart.value);
  };

  // --- Running the timer ------------------------------------------------------

  const startTimer = () => {
    if (!isMeetingDay(selectedDate.value)) {
      ensureNonMeetingTimerParts();
      const firstCustomPart = customTimerParts.value[0];
      if (!isCustomPart(currentPart.value) && firstCustomPart) {
        currentPart.value = firstCustomPart.id;
      }
    }

    // Worked out once, as the part starts, and not moved while it runs
    runningAdaptedSeconds.value = getAdaptedSeconds(
      currentPart.value,
      Date.now(),
      getUnstartedCustomMinutes(currentPart.value),
    );

    if (timerMode.value === 'countdown') {
      countdownTarget.value = calculateCountdownTarget();
    }

    timerRunning.value = true;
    timerPaused.value = false;
    timerStartTime.value = Date.now() - elapsedSeconds.value * 1000;
    timerPausedTime.value = null;

    // Log the start time for the current part
    runningDayState = dayState.value;
    setPartTiming(currentPart.value, { startTime: Date.now() });

    resumeInterval();
    updateTimerWindow();
  };

  /** Times a part: stops the running one first, if any. */
  const selectPart = (part: MeetingPart) => {
    if (timerRunning.value) stopTimer();
    currentPart.value = part;
    startTimer();
  };

  const startNextPart = () => {
    const part = nextPart.value;
    if (!part) return;
    selectPart(part.value);
  };

  const pauseTimer = () => {
    timerPaused.value = true;
    timerPausedTime.value = Date.now();
    pauseInterval();
    updateTimerWindow();
  };

  const refreshCountdownTarget = () => {
    if (timerMode.value !== 'countdown') return;

    countdownTarget.value = calculateCountdownTarget();
    updateTimerWindow();
  };

  const resumeTimer = () => {
    const pauseDuration = computePauseDuration(
      Date.now(),
      timerPausedTime.value ?? 0,
    );
    if (timerStartTime.value !== null) {
      timerStartTime.value += pauseDuration;
    }
    timerPaused.value = false;
    timerPausedTime.value = null;
    resumeInterval();
    updateTimerWindow();
  };

  const stopTimer = () => {
    pauseInterval();
    timerRunning.value = false;
    timerPaused.value = false;
    elapsedSeconds.value = 0;
    timerStartTime.value = null;
    timerPausedTime.value = null;
    countdownTarget.value = 0;
    runningAdaptedSeconds.value = null;

    // Log the end time for the current part
    setPartTiming(
      currentPart.value,
      { endTime: Date.now() },
      runningDayState ?? dayState.value,
    );
    runningDayState = null;

    updateTimerWindow();
  };

  const togglePause = () => {
    if (!timerRunning.value) return;
    if (timerPaused.value) {
      resumeTimer();
    } else {
      pauseTimer();
    }
  };

  const formattedTime = computed(() => {
    const isCountup = timerMode.value === 'countup';
    let isOvertime: boolean;
    let totalSeconds: number;

    if (isCountup) {
      // 0 means no limit defined
      const partMaxSeconds = getEffectivePartSeconds(currentPart.value);
      isOvertime = partMaxSeconds > 0 && elapsedSeconds.value > partMaxSeconds;

      if (isOvertime && currentSettings.value?.timerOvertimeShowAmountOnly) {
        totalSeconds = elapsedSeconds.value - partMaxSeconds;
      } else {
        totalSeconds = elapsedSeconds.value;
      }
    } else {
      const remaining = countdownTarget.value - elapsedSeconds.value;
      isOvertime = remaining < 0;
      totalSeconds = Math.abs(remaining);
    }

    const sign = isOvertime ? '-' : '';
    return `${sign}${formatMinutesSeconds(totalSeconds)}`;
  });

  const getDuration = (
    timings: MeetingPartTimings | null | undefined,
    duration?: number,
  ): string => {
    if (timings?.startTime && timings?.endTime) {
      return formatMinutesSeconds((timings.endTime - timings.startTime) / 1000);
    }
    if (duration) {
      // If no actual start/end time, use the planned duration
      return formatMinutesSeconds(duration * 60);
    }
    return '';
  };

  // Timer logic
  const { pause: pauseInterval, resume: resumeInterval } = useIntervalFn(
    () => {
      if (timerRunning.value && !timerPaused.value) {
        const now = Date.now();
        const startTime = timerStartTime.value;
        if (startTime) {
          elapsedSeconds.value = computeElapsedSeconds(now, startTime);
          updateTimerWindow(); // Update the timer window with new time
        }
      }
    },
    500,
    { immediate: false },
  );

  // Broadcast channel for timer data
  const { post: postTimerData } = useBroadcastChannel<TimerData, TimerData>({
    name: 'timer-display-data',
  });

  const safePostTimerData = (timerData: TimerData) => {
    try {
      postTimerData(timerData);
    } catch (error) {
      errorCatcher(error, {
        contexts: { fn: { name: 'postTimerData' } },
      });
    }
  };

  const getRemoteParts = (): TimerRemotePart[] => {
    const nextValue = nextPart.value?.value;
    return meetingPartsOptions.value.map((option) => {
      const current = timerRunning.value && option.value === currentPart.value;
      return {
        current,
        done: !current && !!partTimings.value[option.value]?.endTime,
        label: option.label,
        minutes: partDurations.value[option.value] ?? 0,
        next: option.value === nextValue,
        value: option.value,
      };
    });
  };

  const updateTimerWindow = () => {
    // Send timer data to the timer window via broadcast channel
    const handAlert = useHandAlertStore();
    const timerData: TimerData = {
      aheadBehindMinutes: aheadBehindMinutes.value,
      handAlertActive: handAlert.active,
      handAlertNames: [...handAlert.raisedHands],
      locale: i18n.global.locale.value,
      mode: timerMode.value,
      mwDay: currentSettings.value?.mwDay,
      mwStartTime: currentSettings.value?.mwStartTime,
      paused: timerPaused.value,
      running: timerRunning.value,
      time: timerRunning.value ? formattedTime.value : '',
      timerBackgroundColor: currentSettings.value?.timerBackgroundColor,
      timerCountdownDisplay: currentSettings.value?.timerCountdownDisplay,
      timerCountdownTargetSeconds: countdownTarget.value,
      timerCountdownWarningIndicator:
        currentSettings.value?.timerCountdownWarningIndicator,
      timerCurrentPartLabel: timerRunning.value ? currentPartLabel.value : '',
      timerElapsedSeconds: elapsedSeconds.value,
      timerEnableMeetingCountdown:
        currentSettings.value?.timerEnableMeetingCountdown,
      timerHourFormat: currentSettings.value?.timerHourFormat,
      timerMeetingCountdownMinutes:
        currentSettings.value?.timerMeetingCountdownMinutes,
      timerOvertimeAnimation: currentSettings.value?.timerOvertimeAnimation,
      timerOvertimeBackgroundColor:
        currentSettings.value?.timerOvertimeBackgroundColor,
      timerOvertimeIndicator: currentSettings.value?.timerOvertimeIndicator,
      timerOvertimeShowAmountOnly:
        currentSettings.value?.timerOvertimeShowAmountOnly,
      timerOvertimeTextColor: currentSettings.value?.timerOvertimeTextColor,
      timerPartPlannedSeconds:
        timerRunning.value && runningAdaptedSeconds.value !== null
          ? getPlannedPartSeconds(currentPart.value)
          : undefined,
      timerPartTargetSeconds: getEffectivePartSeconds(currentPart.value),
      timerTextColor: currentSettings.value?.timerTextColor,
      timerTextSize: currentSettings.value?.timerTextSize,
      timerTimeOfDayDisplay: currentSettings.value?.timerTimeOfDayDisplay,
      weDay: currentSettings.value?.weDay,
      weStartTime: currentSettings.value?.weStartTime,
    };

    safePostTimerData(timerData);
    if (currentSettings.value?.timerRemoteEnable) {
      try {
        // Only the remote shows (and picks from) the day's list of parts.
        globalThis.electronApi.timerRemoteUpdate({
          ...timerData,
          timerRemoteParts: getRemoteParts(),
        });
      } catch (error) {
        errorCatcher(error, {
          contexts: { fn: { name: 'timerRemoteUpdate' } },
        });
      }
    }
  };

  const { toggleTimerWindow } = globalThis.electronApi;

  const handleTimerWindowVisibility = (visible: boolean) => {
    toggleTimerWindow(visible);
    currentState.setTimerWindowVisible(visible);
    if (visible) {
      // Broadcast the actual current state rather than a hardcoded idle
      // snapshot - showing/hiding the timer window while a timer is already
      // running previously flashed the plain clock for one tick before the
      // next 500ms update self-corrected it.
      updateTimerWindow();
    }
  };

  // --- Planned start times and ahead/behind --------------------------------------

  const sequence = computed(() => getMeetingPartSequence(selectedDate.value));

  const meetingStartTime = computed(() => {
    const date = selectedDate.value;
    if (!date || (!isWeMeetingDay(date) && !isMwMeetingDay(date))) return null;
    const startTimeStr = isMwMeetingDay(date)
      ? currentSettings.value?.mwStartTime
      : currentSettings.value?.weStartTime;
    if (!startTimeStr) return null;
    const parts = startTimeStr.split(':');
    const hour = Number(parts[0]);
    const min = Number(parts[1]);
    const start = new Date(date);
    start.setHours(hour, min, 0, 0);
    return start;
  });

  const getCustomPartOffsetMinutes = (
    parts: CustomTimerPart[],
    startIndex: number,
    endIndex: number,
  ) => {
    let offsetMinutes = 0;
    for (let i = startIndex; i < endIndex; i++) {
      offsetMinutes += normalizePartDuration(parts[i]?.duration);
    }
    return offsetMinutes;
  };

  /**
   * A custom part's planned start, worked out from the first custom part
   * that was actually started (there's no schedule to go by otherwise).
   */
  const getCustomPlannedStartTime = (part: MeetingPart) => {
    const parts = customTimerParts.value;
    const index = parts.findIndex((customPart) => customPart.id === part);
    if (index === -1) return null;

    const anchorIndex = parts.findIndex(
      (customPart) => partTimings.value[customPart.id]?.startTime,
    );
    const anchorPart = parts[anchorIndex];
    const anchorStartTime = anchorPart
      ? partTimings.value[anchorPart.id]?.startTime
      : null;
    if (!anchorPart || !anchorStartTime) return null;

    const offsetStart = Math.min(index, anchorIndex);
    const offsetEnd = Math.max(index, anchorIndex);
    const offsetMinutes = getCustomPartOffsetMinutes(
      parts,
      offsetStart,
      offsetEnd,
    );

    if (index >= anchorIndex) {
      return anchorStartTime + offsetMinutes * 60 * 1000;
    }
    return anchorStartTime - offsetMinutes * 60 * 1000;
  };

  // Get planned start time for a meeting part
  const getPlannedStartTime = (part: MeetingPart): null | number => {
    if (isCustomPart(part)) return getCustomPlannedStartTime(part);

    const meetingStart = meetingStartTime.value?.getTime();
    if (!meetingStart) return null;

    const index = sequence.value.indexOf(part);
    if (index === -1) return null;

    const offsetMinutes = getMeetingPartOffsetMinutes(
      index,
      sequence.value,
      partDurations.value,
      noCounsel.value,
    );
    return meetingStart + offsetMinutes * 60 * 1000;
  };

  /**
   * How far the meeting is behind (positive) or ahead of (negative) its
   * schedule, in minutes, judged by when the current part actually started.
   */
  const aheadBehindMinutes = computed<null | number>(() => {
    if (!currentSettings.value?.timerEnableMeetingAheadBehind) return null;

    const actualStartTime = partTimings.value[currentPart.value]?.startTime;
    if (!actualStartTime) return null;

    const plannedStartTime = getPlannedStartTime(currentPart.value);
    if (!plannedStartTime) return null;

    return (actualStartTime - plannedStartTime) / (1000 * 60);
  });

  const cbsAdaptiveDefaultEndTime = computed(() => {
    const startTime = getPlannedStartTime('cbs');
    if (!startTime) return '';
    return toHoursMinutes(startTime + getPartDurationSeconds('cbs') * 1000);
  });

  const wtAdaptiveDefaultEndTime = computed(() => {
    const date = selectedDate.value;
    const isCo = date ? isCoWeek(date) : false;
    const wtPart = isCo ? 'abbreviated-wt' : 'wt';
    const startTime = getPlannedStartTime(wtPart);
    if (!startTime) return '';
    return toHoursMinutes(startTime + getPartDurationSeconds(wtPart) * 1000);
  });

  // --- Adaptive timing ----------------------------------------------------------

  const MINUTE_MS = 60 * 1000;

  // Re-evaluates the preview as time goes by, even while nothing else changes
  const adaptiveClock = ref(Date.now());
  useIntervalFn(() => {
    adaptiveClock.value = Date.now();
  }, 15 * 1000);

  /** The sequence's own name for a part: CO weeks time the short study as "wt". */
  const getSequencePart = (part: MeetingPart): MeetingPart =>
    part === 'wt' && isCoWeek(selectedDate.value) ? 'abbreviated-wt' : part;

  /** A part's planned length in seconds, under the name the sequence knows it by. */
  const getPlannedPartSeconds = (part: MeetingPart) =>
    getPartDurationSeconds(getSequencePart(part));

  /** The user set an end time for the part, which wins over adaptive timing. */
  const hasCustomEndTime = (part: MeetingPart) => {
    if (part === 'cbs') {
      return (
        !!cbsCustomEndTime.value &&
        cbsCustomEndTime.value !== cbsAdaptiveDefaultEndTime.value
      );
    }
    if (part === 'wt' || part === 'abbreviated-wt') {
      return (
        !!wtCustomEndTime.value &&
        wtCustomEndTime.value !== wtAdaptiveDefaultEndTime.value
      );
    }
    return false;
  };

  /** Minutes of custom parts still to run, which the meeting has to fit. */
  const getUnstartedCustomMinutes = (excluding?: MeetingPart) =>
    customTimerParts.value
      .filter(
        (part) =>
          part.id !== excluding && !partTimings.value[part.id]?.startTime,
      )
      .reduce((total, part) => total + normalizePartDuration(part.duration), 0);

  /** The length a part gets if it starts at `now`, or null to keep its own. */
  const getAdaptedSeconds = (
    part: MeetingPart,
    now: number,
    extraPlannedMinutes: number,
  ): null | number => {
    const meetingStart = meetingStartTime.value?.getTime();
    if (
      !currentSettings.value?.timerAdaptiveShorten ||
      !meetingStart ||
      hasCustomEndTime(part)
    ) {
      return null;
    }
    return getAdaptedPartSeconds({
      deadline: meetingStart + FINAL_SONG_OFFSET_MINUTES * MINUTE_MS,
      extraPlannedMinutes,
      noCounsel: noCounsel.value,
      now,
      part: getSequencePart(part),
      partDurations: partDurations.value,
      sequence: sequence.value,
    });
  };

  /** The part the list shows for a name in the sequence (see getSequencePart). */
  const getListedPart = (part: MeetingPart): MeetingPart =>
    part === 'abbreviated-wt' ? 'wt' : part;

  /**
   * Where the meeting stands, for the preview: the last part of the program
   * to have started, and when it is projected to end. Null before any part
   * started, as there is then nothing to be behind.
   */
  const getPreviewReference = (now: number) => {
    for (let index = sequence.value.length - 1; index >= 0; index--) {
      const part = sequence.value[index] as MeetingPart;
      const timing = partTimings.value[getListedPart(part)];
      if (!timing?.startTime) continue;

      const isRunning =
        timerRunning.value && getListedPart(part) === currentPart.value;
      const plannedEnd =
        timing.startTime +
        (isRunning && runningAdaptedSeconds.value !== null
          ? runningAdaptedSeconds.value
          : (partDurations.value[part] ?? 0) * 60) *
          1000;
      // A running part ends when it does, no earlier than now
      const end = isRunning
        ? Math.max(now, plannedEnd)
        : (timing.endTime ?? Math.max(now, plannedEnd));
      return { end, index, part };
    }
    return null;
  };

  /**
   * The shortened length of each adaptable part that has not finished,
   * worked out as if it started when the parts before it run to plan. The
   * running part shows what it started with. Parts not listed keep their
   * planned length.
   */
  const adaptedPartSeconds = computed<Partial<Record<MeetingPart, number>>>(
    () => {
      const adapted: Partial<Record<MeetingPart, number>> = {};
      if (!currentSettings.value?.timerAdaptiveShorten) return adapted;

      // The clock is read to be called again as time passes
      const now = Math.max(adaptiveClock.value, Date.now());
      const reference = getPreviewReference(now);
      if (!reference) return adapted;

      if (timerRunning.value && runningAdaptedSeconds.value !== null) {
        adapted[currentPart.value] = runningAdaptedSeconds.value;
      }

      const referenceOffset = getMeetingPartOffsetMinutes(
        reference.index,
        sequence.value,
        partDurations.value,
        noCounsel.value,
      );
      const referenceMinutes = partDurations.value[reference.part] ?? 0;

      // What the parts before shorten gives the ones after an earlier start
      let savedSeconds = 0;
      for (const option of meetingPartsOptions.value) {
        const part = option.value;
        if (isCustomPart(part) || !notStarted(option)) continue;

        const index = sequence.value.indexOf(getSequencePart(part));
        if (index <= reference.index) continue;

        // Starts when the parts before it have run their (shortened) lengths
        const minutesAfterReference =
          getMeetingPartOffsetMinutes(
            index,
            sequence.value,
            partDurations.value,
            noCounsel.value,
          ) -
          referenceOffset -
          referenceMinutes;
        const startsAt =
          reference.end +
          minutesAfterReference * MINUTE_MS -
          savedSeconds * 1000;

        const seconds = getAdaptedSeconds(
          part,
          startsAt,
          getUnstartedCustomMinutes(),
        );
        if (seconds === null) continue;
        adapted[part] = seconds;
        savedSeconds += getPlannedPartSeconds(part) - seconds;
      }
      return adapted;
    },
  );

  const endTimeRule =
    (minOffsetMinutes: number, maxOffsetMinutes: number) => (val: string) => {
      const parts = val.split(':');
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      const meetingStart = meetingStartTime.value?.getTime() || 0; // NOSONAR: NaN falls back too
      const endTime = new Date(meetingStart);
      endTime.setHours(h, m, 0, 0);
      const minTime = meetingStart + minOffsetMinutes * 60 * 1000;
      const maxTime = meetingStart + maxOffsetMinutes * 60 * 1000;
      return (
        (endTime.getTime() >= minTime && endTime.getTime() <= maxTime) ||
        t('time-must-be-between', {
          maxTime: toHoursMinutes(maxTime),
          minTime: toHoursMinutes(minTime),
        })
      );
    };

  const cbsEndTimeRules = [
    (val: string) => !!val || t('required'),
    endTimeRule(68, 97),
  ];
  const wtEndTimeRules = [
    (val: string) => !!val || t('required'),
    endTimeRule(36, 100),
  ];

  // --- Keeping up with the selected day ------------------------------------------

  // A new day means a new list of parts: a running timer belongs to the
  // previous day, so it's stopped (its end time recorded on that day).
  watch(selectedDate, (date, previousDate) => {
    if (date?.getTime() === previousDate?.getTime()) return;
    if (timerRunning.value) stopTimer();
  });

  watchImmediate(selectedDateObject, () => {
    ensureNonMeetingTimerParts();
    cbsCustomEndTime.value = cbsAdaptiveDefaultEndTime.value;
    wtCustomEndTime.value = wtAdaptiveDefaultEndTime.value;

    const options = meetingPartsOptions.value;
    const stillListed = options.some(
      (option) => option.value === currentPart.value,
    );
    if (!stillListed && options[0]) {
      currentPart.value = options[0].value;
    }
  });

  watch(timerMode, () => {
    if (timerRunning.value) stopTimer();
  });

  return {
    adaptedPartSeconds,
    addCustomTimerPart,
    adjustPartDuration,
    aheadBehindMinutes,
    ayfmPartsCount,
    cbsCustomEndTime,
    cbsEndTimeRules,
    currentPart,
    currentPartLabel,
    currentPartOption,
    customTimerParts,
    elapsedSeconds,
    formattedTime,
    getDuration,
    getPlannedPartSeconds,
    getPlannedStartTime,
    getTimeString,
    handleTimerWindowVisibility,
    hasAnyPartTimings,
    hasProgramOverrides,
    hasProgramTimings,
    lacPartsCount,
    meetingPartsOptions,
    moveCustomTimerPart,
    nextPart,
    partDurations,
    partTimings,
    pauseTimer,
    refreshCountdownTarget,
    removeCustomTimerPart,
    resetAllPartTimings,
    resetPartTiming,
    resetToProgramTimings,
    resumeTimer,
    selectPart,
    setPartDuration,
    startNextPart,
    startTimer,
    stopTimer,
    timerMode,
    timerPaused,
    timerPausedTime,
    timerRunning,
    timerStartTime,
    togglePause,
    updateCustomTimerPart,
    updateTimerWindow,
    wtCustomEndTime,
    wtEndTimeRules,
  };
};

export type Timer = ReturnType<typeof createTimer>;

let timer: null | Timer = null;

/**
 * The meeting timer, shared by everything that shows or drives it (the
 * action island popup and its hover controls, the docked panel): one timer,
 * created on first use and kept for the life of the main window, so a part
 * started from one place can be paused or stopped from another.
 */
const useTimer = (): Timer => {
  if (!timer) {
    const scope = effectScope(true);
    timer = scope.run(createTimer) ?? null;
    if (!timer) throw new Error('The meeting timer could not be created');
  }
  return timer;
};

/** Test-only: forgets the shared timer so the next useTimer() starts afresh. */
export const __resetTimerForTests = () => {
  timer = null;
};

export default useTimer;
