import type { DateInfo, MeetingPart } from 'src/types';

import { createPinia, setActivePinia } from 'pinia';
import { defaultSettings } from 'src/constants/settings';
import { formatDate } from 'src/utils/date';
import { useCongregationSettingsStore } from 'stores/congregation-settings';
import { useCurrentStateStore } from 'stores/current-state';
import { useJwStore } from 'stores/jw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import useTimer, { __resetTimerForTests } from '../useTimer';

vi.mock('boot/i18n', () => ({
  i18n: {
    global: {
      locale: { value: 'en' },
      t: (key: string, named?: Record<string, unknown>) =>
        named && 'part' in named
          ? `${key} ${named.part}${named.title ? ` ${named.title}` : ''} (${named.duration})`
          : key,
    },
  },
}));

// 2026-10-13 is a Tuesday (midweek meeting), 2026-10-11 a Sunday (weekend
// meeting) and 2026-10-14 a Wednesday (no meeting).
const MIDWEEK = new Date(2026, 9, 13, 12, 0, 0);
const WEEKEND = new Date(2026, 9, 11, 12, 0, 0);
const NO_MEETING = new Date(2026, 9, 14, 12, 0, 0);

const createDay = (date: Date): DateInfo => ({
  date,
  mediaSections: [],
  status: 'complete',
});

const selectDay = async (date: Date) => {
  useCurrentStateStore().selectedDate = formatDate(date, 'YYYY/MM/DD');
  await nextTick();
};

const day = (date: Date) =>
  useJwStore().lookupPeriod['cong']?.find(
    (d) => d.date.getTime() === date.getTime(),
  );

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(MIDWEEK);
  setActivePinia(createPinia());
  __resetTimerForTests();

  useCongregationSettingsStore().congregations['cong'] = {
    ...defaultSettings,
    enableTimerDisplay: true,
    mwDay: '1',
    mwStartTime: '19:00',
    timerEnableMeetingAheadBehind: true,
    weDay: '6',
    weStartTime: '10:00',
  };
  const currentState = useCurrentStateStore();
  currentState.currentCongregation = 'cong';
  useJwStore().lookupPeriod['cong'] = [
    createDay(WEEKEND),
    createDay(MIDWEEK),
    createDay(NO_MEETING),
  ];
  await selectDay(MIDWEEK);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTimer part durations', () => {
  it('starts a midweek meeting with the default part counts and durations', () => {
    const timer = useTimer();
    expect(timer.ayfmPartsCount.value).toBe(3);
    expect(timer.lacPartsCount.value).toBe(2);
    const values = timer.meetingPartsOptions.value.map((o) => o.value);
    expect(values).toEqual([
      'introduction',
      'treasures',
      'gems',
      'bible-reading',
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      'lac-1',
      'lac-2',
      'cbs',
      'concluding-comments',
    ]);
    expect(timer.meetingPartsOptions.value.some((o) => o.warning)).toBe(false);
  });

  it('keeps whatever duration the user sets, 0 included, and only warns', () => {
    const timer = useTimer();

    timer.setPartDuration('lac-1', 20);
    timer.setPartDuration('ayfm-2', 0);
    timer.adjustPartDuration('ayfm-3', 1);

    expect(timer.partDurations.value['lac-1']).toBe(20);
    expect(timer.partDurations.value['lac-2']).toBe(7);
    expect(timer.partDurations.value['ayfm-2']).toBe(0);
    expect(timer.partDurations.value['ayfm-3']).toBe(5);
    expect(day(MIDWEEK)?.timerPartDurations).toEqual({
      'ayfm-2': 0,
      'ayfm-3': 5,
      'lac-1': 20,
    });

    const lac1 = timer.meetingPartsOptions.value.find(
      (o) => o.value === 'lac-1',
    );
    const ayfm2 = timer.meetingPartsOptions.value.find(
      (o) => o.value === 'ayfm-2',
    );
    expect(lac1?.warning).toBe(true);
    expect(ayfm2?.warning).toBe(true);
    expect(ayfm2?.label).toBe('ayfm-part 2 (0)');
  });

  it('never goes below 0', () => {
    const timer = useTimer();
    timer.setPartDuration('ayfm-1', 0);
    timer.adjustPartDuration('ayfm-1', -1);
    expect(timer.partDurations.value['ayfm-1']).toBe(0);
  });

  it('shares a section out again when its number of parts changes', () => {
    const timer = useTimer();

    timer.ayfmPartsCount.value = 2;
    timer.lacPartsCount.value = 1;

    expect(timer.partDurations.value).toMatchObject({
      'ayfm-1': 7,
      'ayfm-2': 6,
      'ayfm-3': 0,
      'lac-1': 15,
      'lac-2': 0,
    });
    expect(day(MIDWEEK)?.timerPartCounts).toEqual({ ayfm: 2, lac: 1 });
    const values = timer.meetingPartsOptions.value.map((o) => o.value);
    expect(values).toContain('ayfm-2');
    expect(values).not.toContain('ayfm-3');
    expect(values).not.toContain('lac-2');
  });

  it('keeps each day its own durations and counts', async () => {
    const timer = useTimer();
    timer.setPartDuration('public-talk', 30);
    timer.lacPartsCount.value = 3;

    await selectDay(WEEKEND);
    timer.setPartDuration('public-talk', 25);
    expect(timer.partDurations.value['public-talk']).toBe(25);

    await selectDay(MIDWEEK);
    expect(timer.partDurations.value['public-talk']).toBe(30);
    expect(timer.lacPartsCount.value).toBe(3);
  });
});

// The workbook's week of 2026-09-21: 3 Apply Yourself parts of 3, 4 and 6
// minutes, the last one a discussion without counsel, and 1 Living as
// Christians part of 15 minutes.
const programOf = (): Partial<DateInfo> => ({
  timerProgramCounts: { ayfm: 3, lac: 1 },
  timerProgramDurations: {
    'ayfm-1': 3,
    'ayfm-2': 4,
    'ayfm-3': 6,
    'ayfm-4': 0,
    'ayfm-5': 0,
    cbs: 30,
    'lac-1': 15,
    'lac-2': 0,
    'lac-3': 0,
  },
  timerProgramNoCounsel: ['ayfm-3'],
  timerProgramTitles: {
    'ayfm-1': 'Starting a Conversation',
    'ayfm-2': 'Following Up',
    'ayfm-3': 'What Would You Say?',
    'lac-1': 'Remaining Neutral',
  },
});

describe('useTimer workbook timings', () => {
  beforeEach(() => {
    Object.assign(day(MIDWEEK) as DateInfo, programOf());
  });

  it('uses the workbook counts and lengths until the user changes them', () => {
    const timer = useTimer();
    expect(timer.ayfmPartsCount.value).toBe(3);
    expect(timer.lacPartsCount.value).toBe(1);
    expect(timer.partDurations.value).toMatchObject({
      'ayfm-1': 3,
      'ayfm-2': 4,
      'ayfm-3': 6,
      'lac-1': 15,
      'lac-2': 0,
    });
    // The workbook's values are not the user's changes
    expect(day(MIDWEEK)?.timerPartDurations).toBeUndefined();

    timer.setPartDuration('ayfm-1', 5);
    expect(timer.partDurations.value['ayfm-1']).toBe(5);
    expect(timer.partDurations.value['ayfm-2']).toBe(4);
  });

  it('does not warn when a discussion without counsel fills the section', () => {
    const timer = useTimer();
    expect(timer.meetingPartsOptions.value.some((o) => o.warning)).toBe(false);

    timer.setPartDuration('ayfm-3', 5);
    const ayfm = timer.meetingPartsOptions.value.filter(
      (o) => o.section === 'ayfm',
    );
    expect(ayfm.every((o) => o.warning)).toBe(true);
  });

  it('plans no counsel after the last part, in the start times that follow', () => {
    const timer = useTimer();
    // 5 song + 1 intro + 10 + 10 + 1 changeover + 4 reading + 1 counsel
    // + (3 + 1) + (4 + 1) + 6 (no counsel) + 5 middle song = 52 minutes
    // before the first LAC part
    expect(timer.getPlannedStartTime('lac-1')).toBe(
      new Date(2026, 9, 13, 19, 52, 0).getTime(),
    );
  });

  it('labels the parts with the workbook titles, numbered through the meeting', () => {
    const timer = useTimer();
    const labels = Object.fromEntries(
      timer.meetingPartsOptions.value.map((o) => [o.value, o.label]),
    );
    expect(labels['ayfm-1']).toBe(
      'workbook-part 4 Starting a Conversation (3)',
    );
    expect(labels['ayfm-3']).toBe('workbook-part 6 What Would You Say? (6)');
    expect(labels['lac-1']).toBe('workbook-part 7 Remaining Neutral (15)');
  });

  it('goes back to the default labels when the number of parts changes', () => {
    const timer = useTimer();
    timer.ayfmPartsCount.value = 2;
    const ayfm1 = timer.meetingPartsOptions.value.find(
      (o) => o.value === 'ayfm-1',
    );
    expect(ayfm1?.label).toBe('ayfm-part 1 (7)');
    // and the counsel the workbook left out is counted again
    expect(timer.meetingPartsOptions.value.some((o) => o.warning)).toBe(false);
  });

  it('shares a section out with the workbook counsel when its count is set back', () => {
    const timer = useTimer();
    timer.ayfmPartsCount.value = 2;
    timer.ayfmPartsCount.value = 3;
    // Back to the workbook's count, so its discussion has no counsel again
    expect(timer.partDurations.value).toMatchObject({
      'ayfm-1': 5,
      'ayfm-2': 4,
      'ayfm-3': 4,
    });
    expect(timer.meetingPartsOptions.value.some((o) => o.warning)).toBe(false);
  });

  it('resets the day to the workbook', () => {
    const timer = useTimer();
    expect(timer.hasProgramTimings.value).toBe(true);
    expect(timer.hasProgramOverrides.value).toBe(false);

    timer.setPartDuration('lac-1', 12);
    timer.lacPartsCount.value = 2;
    expect(timer.hasProgramOverrides.value).toBe(true);

    timer.resetToProgramTimings();
    expect(timer.hasProgramOverrides.value).toBe(false);
    expect(timer.lacPartsCount.value).toBe(1);
    expect(timer.partDurations.value['lac-1']).toBe(15);
  });

  it('ignores the workbook when the setting is off', () => {
    useCongregationSettingsStore().congregations['cong'] = {
      ...useCongregationSettingsStore().congregations['cong'],
      timerImportProgramTimings: false,
    } as never;
    const timer = useTimer();
    expect(timer.hasProgramTimings.value).toBe(false);
    expect(timer.ayfmPartsCount.value).toBe(3);
    expect(timer.lacPartsCount.value).toBe(2);
    expect(timer.partDurations.value['ayfm-3']).toBe(4);
  });

  it('has nothing to reset on a day without workbook data', async () => {
    const timer = useTimer();
    await selectDay(WEEKEND);
    expect(timer.hasProgramTimings.value).toBe(false);
  });
});

describe('useTimer timings', () => {
  it('records when a part was started and stopped, on its day', () => {
    const timer = useTimer();

    timer.selectPart('treasures');
    expect(timer.timerRunning.value).toBe(true);
    expect(timer.currentPart.value).toBe('treasures');
    expect(day(MIDWEEK)?.timerPartTimings?.treasures?.startTime).toBe(
      MIDWEEK.getTime(),
    );

    vi.advanceTimersByTime(90_000);
    expect(timer.formattedTime.value).toBe('01:30');

    timer.stopTimer();
    expect(timer.timerRunning.value).toBe(false);
    expect(day(MIDWEEK)?.timerPartTimings?.treasures).toEqual({
      endTime: MIDWEEK.getTime() + 90_000,
      startTime: MIDWEEK.getTime(),
    });
  });

  it('moves straight from one part to the next', () => {
    const timer = useTimer();
    timer.selectPart('introduction');
    vi.advanceTimersByTime(60_000);

    expect(timer.nextPart.value?.value).toBe('treasures');
    timer.startNextPart();

    expect(timer.currentPart.value).toBe('treasures');
    expect(timer.partTimings.value.introduction?.endTime).toBe(
      MIDWEEK.getTime() + 60_000,
    );
    expect(timer.partTimings.value.treasures?.startTime).toBe(
      MIDWEEK.getTime() + 60_000,
    );
  });

  it('stops a running part when the user moves to another day, recording it on the day it started', async () => {
    const timer = useTimer();
    timer.selectPart('gems');
    vi.advanceTimersByTime(30_000);

    await selectDay(WEEKEND);

    expect(timer.timerRunning.value).toBe(false);
    expect(day(MIDWEEK)?.timerPartTimings?.gems?.endTime).toBe(
      MIDWEEK.getTime() + 30_000,
    );
    expect(day(WEEKEND)?.timerPartTimings).toBeUndefined();
    expect(timer.partTimings.value.gems).toBeUndefined();

    await selectDay(MIDWEEK);
    expect(timer.partTimings.value.gems?.startTime).toBe(MIDWEEK.getTime());
  });

  it('clears one part or every part of the day', () => {
    const timer = useTimer();
    timer.selectPart('introduction');
    timer.stopTimer();
    timer.selectPart('treasures');
    timer.stopTimer();
    expect(timer.hasAnyPartTimings.value).toBe(true);

    timer.resetPartTiming('introduction');
    expect(timer.partTimings.value.introduction).toBeUndefined();
    expect(timer.partTimings.value.treasures).toBeDefined();

    timer.resetAllPartTimings();
    expect(timer.hasAnyPartTimings.value).toBe(false);
  });

  it('judges ahead/behind by the planned start of the current part', () => {
    const timer = useTimer();
    // Introduction is planned 5 minutes after the 19:00 start (opening song).
    vi.setSystemTime(new Date(2026, 9, 13, 19, 7, 0));
    timer.selectPart('introduction');
    expect(timer.aheadBehindMinutes.value).toBe(2);
  });
});

describe('useTimer custom parts', () => {
  it('adds custom parts to a meeting day, after the regular parts', () => {
    const timer = useTimer();
    const part = timer.addCustomTimerPart();

    const options = timer.meetingPartsOptions.value;
    expect(options.at(-1)).toMatchObject({
      section: 'custom-timer-parts',
      value: part.id,
    });
    expect(timer.partDurations.value[part.id]).toBe(5);

    timer.updateCustomTimerPart(part.id, { duration: 12, label: 'GB update' });
    expect(timer.partDurations.value[part.id]).toBe(12);
    expect(options.at(-1)?.label).toBe('meeting-part 1 (5 min.)');
    expect(timer.meetingPartsOptions.value.at(-1)?.label).toBe(
      'GB update (12 min.)',
    );
    expect(day(MIDWEEK)?.timerParts).toHaveLength(1);
  });

  it('seeds a day without a meeting with one custom part and keeps at least one', async () => {
    const timer = useTimer();
    await selectDay(NO_MEETING);

    expect(timer.customTimerParts.value).toHaveLength(1);
    const only = timer.customTimerParts.value[0];
    expect(timer.currentPart.value).toBe(only?.id);
    expect(timer.meetingPartsOptions.value[0]?.section).toBeUndefined();

    timer.removeCustomTimerPart(only?.id ?? 'custom-x');
    expect(timer.customTimerParts.value).toHaveLength(1);
  });

  it('works out ahead/behind for custom parts from the first one started', async () => {
    const timer = useTimer();
    await selectDay(NO_MEETING);
    const first = timer.customTimerParts.value[0];
    const second = timer.addCustomTimerPart();
    timer.updateCustomTimerPart(first?.id ?? 'custom-x', { duration: 10 });

    timer.selectPart(first?.id ?? 'custom-x');
    vi.advanceTimersByTime(12 * 60_000);
    timer.selectPart(second.id);

    expect(timer.aheadBehindMinutes.value).toBe(2);
  });
});

describe('the changeover to the auxiliary class', () => {
  it('moves the planned start times from the Bible reading onward 1 minute later', () => {
    const timer = useTimer();
    const at = (part: MeetingPart) =>
      new Date(timer.getPlannedStartTime(part) ?? 0).toTimeString().slice(0, 5);
    // 5 song + 1 intro + 10 Treasures
    expect(at('gems')).toBe('19:16');
    // + 10 Gems + 1 changeover
    expect(at('bible-reading')).toBe('19:27');
    expect(at('lac-1')).toBe('19:52');
    expect(at('cbs')).toBe('20:07');
  });

  it('ends the study at 20:37, where the concluding comments begin, and allows it', () => {
    const timer = useTimer();
    expect(timer.cbsCustomEndTime.value).toBe('20:37');
    expect(timer.cbsEndTimeRules[1]?.('20:37')).toBe(true);
    expect(timer.cbsEndTimeRules[1]?.('20:38')).not.toBe(true);
    expect(timer.cbsEndTimeRules[1]?.('20:08')).toBe(true);
    expect(timer.cbsEndTimeRules[1]?.('20:07')).not.toBe(true);
  });

  it('plans the weekend meeting to end its study at the final song', async () => {
    await selectDay(WEEKEND);
    const timer = useTimer();
    expect(timer.wtCustomEndTime.value).toBe('11:40');
    expect(timer.wtEndTimeRules[1]?.('11:40')).toBe(true);
  });
});

describe('useTimer adaptive timing', () => {
  const setSettings = (changes: Record<string, unknown>) => {
    Object.assign(useCongregationSettingsStore().congregations['cong'] ?? {}, {
      timerMode: 'countdown',
      ...changes,
    });
  };

  /** Treasures starts 3 minutes late and takes its 10 minutes. */
  const runLateTreasures = (timer: ReturnType<typeof useTimer>) => {
    vi.setSystemTime(new Date(2026, 9, 13, 19, 9, 0));
    timer.selectPart('treasures');
    vi.advanceTimersByTime(10 * 60_000);
    timer.stopTimer();
  };

  it('previews nothing while the setting is off, and keeps the planned lengths', () => {
    setSettings({ timerAdaptiveShorten: false });
    const timer = useTimer();
    runLateTreasures(timer);

    expect(timer.adaptedPartSeconds.value).toEqual({});
    vi.setSystemTime(new Date(2026, 9, 13, 19, 55, 0));
    timer.selectPart('lac-1');
    expect(timer.formattedTime.value).toBe('08:00');
  });

  it('previews the shortened Living as Christians parts and study before they start', () => {
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();
    expect(timer.adaptedPartSeconds.value).toEqual({});

    runLateTreasures(timer);

    // 3 minutes behind, spread over lac-1 + lac-2 + cbs, each part starting
    // where the shortened ones before it leave off
    expect(timer.adaptedPartSeconds.value).toEqual({
      cbs: 1680,
      'lac-1': 450,
      'lac-2': 390,
    });
  });

  it('fixes the length when the part starts and does not move it while it runs', () => {
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();
    runLateTreasures(timer);

    vi.setSystemTime(new Date(2026, 9, 13, 19, 55, 0));
    timer.selectPart('lac-1');
    expect(timer.formattedTime.value).toBe('07:30');
    expect(timer.adaptedPartSeconds.value['lac-1']).toBe(450);

    // Running on past its time changes nothing already decided
    vi.advanceTimersByTime(60_000);
    expect(timer.formattedTime.value).toBe('06:30');
    expect(timer.adaptedPartSeconds.value['lac-1']).toBe(450);
  });

  it('lets a length typed in while the part runs win', () => {
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();
    runLateTreasures(timer);
    vi.setSystemTime(new Date(2026, 9, 13, 19, 55, 0));
    timer.selectPart('lac-1');

    timer.setPartDuration('lac-1', 9);
    expect(timer.formattedTime.value).toBe('09:00');
  });

  it('leaves a study with an end time set by hand alone', () => {
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();
    timer.cbsCustomEndTime.value = '20:30';
    runLateTreasures(timer);

    expect(timer.adaptedPartSeconds.value.cbs).toBeUndefined();
    expect(timer.adaptedPartSeconds.value['lac-1']).toBeDefined();
  });

  it('takes a part added to the day out of the Living as Christians parts', () => {
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();
    vi.setSystemTime(new Date(2026, 9, 13, 19, 6, 0));
    timer.selectPart('treasures');
    vi.advanceTimersByTime(10 * 60_000);
    timer.stopTimer();
    expect(timer.adaptedPartSeconds.value).toEqual({});

    const added = timer.addCustomTimerPart();
    timer.updateCustomTimerPart(added.id, { duration: 10 });
    expect(timer.adaptedPartSeconds.value['lac-1']).toBe(375);
    expect(timer.adaptedPartSeconds.value.cbs).toBe(1400);
  });

  it('gives the weekend overrun to the Watchtower Study', async () => {
    await selectDay(WEEKEND);
    setSettings({ timerAdaptiveShorten: true });
    const timer = useTimer();

    vi.setSystemTime(new Date(2026, 9, 11, 10, 5, 0));
    timer.selectPart('public-talk');
    vi.advanceTimersByTime(35 * 60_000);
    timer.stopTimer();

    expect(timer.adaptedPartSeconds.value).toEqual({ wt: 3300 });
  });
});
