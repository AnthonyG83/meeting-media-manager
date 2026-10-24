import type { MeetingPart } from 'src/types';

import { describe, expect, it } from 'vitest';

import {
  AUX_CLASS_CHANGEOVER_MINUTES,
  defaultPartCounts,
  defaultPartDurations,
  distributeSectionMinutes,
  FINAL_SONG_OFFSET_MINUTES,
  getAdaptedPartSeconds,
  getGapAfterPart,
  getMeetingPartOffsetMinutes,
  getSectionPartMinutes,
  hasCounselAfterPart,
} from '../meeting-parts';

describe('distributeSectionMinutes', () => {
  it('shares the minutes out evenly, the first parts taking the remainder', () => {
    expect(distributeSectionMinutes('ayfm', 3, 12)).toEqual({
      'ayfm-1': 4,
      'ayfm-2': 4,
      'ayfm-3': 4,
      'ayfm-4': 0,
      'ayfm-5': 0,
    });
    expect(distributeSectionMinutes('lac', 2, 15)).toEqual({
      'lac-1': 8,
      'lac-2': 7,
      'lac-3': 0,
    });
  });

  it('keeps the count within the section', () => {
    expect(distributeSectionMinutes('lac', 9, 15)).toEqual({
      'lac-1': 5,
      'lac-2': 5,
      'lac-3': 5,
    });
    expect(distributeSectionMinutes('ayfm', 0, 14)).toEqual({
      'ayfm-1': 14,
      'ayfm-2': 0,
      'ayfm-3': 0,
      'ayfm-4': 0,
      'ayfm-5': 0,
    });
  });
});

describe('getSectionPartMinutes', () => {
  it('takes a minute of counsel per Apply Yourself part off the section', () => {
    expect(getSectionPartMinutes('ayfm', 1)).toBe(14);
    expect(getSectionPartMinutes('ayfm', 3)).toBe(12);
  });

  it('gives the Living as Christians parts the whole section', () => {
    expect(getSectionPartMinutes('lac', 1)).toBe(15);
    expect(getSectionPartMinutes('lac', 3)).toBe(15);
  });
});

describe('defaultPartDurations', () => {
  it('match the default part counts', () => {
    const ayfm = distributeSectionMinutes(
      'ayfm',
      defaultPartCounts.ayfm,
      getSectionPartMinutes('ayfm', defaultPartCounts.ayfm),
    );
    const lac = distributeSectionMinutes(
      'lac',
      defaultPartCounts.lac,
      getSectionPartMinutes('lac', defaultPartCounts.lac),
    );
    expect(defaultPartDurations).toMatchObject({ ...ayfm, ...lac });
  });
});

describe('getMeetingPartOffsetMinutes', () => {
  it('adds counsel after student parts that have a duration, and skips 0-minute parts', () => {
    const sequence = [
      'bible-reading',
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      'song-and-optional-prayer',
    ] as const;
    const durations = {
      'ayfm-1': 3,
      'ayfm-2': 0,
      'ayfm-3': 5,
      'bible-reading': 4,
      'song-and-optional-prayer': 5,
    };
    // 4 + 1 counsel, 3 + 1 counsel, 0 (no counsel), 5 + 1 counsel
    expect(getMeetingPartOffsetMinutes(4, [...sequence], durations)).toBe(15);
    expect(hasCounselAfterPart('ayfm-2', 0)).toBe(false);
    expect(hasCounselAfterPart('ayfm-2', 2)).toBe(true);
  });
});

describe('parts without counsel', () => {
  it('leaves the minute of counsel to the parts of the section', () => {
    expect(getSectionPartMinutes('ayfm', 3)).toBe(12);
    expect(getSectionPartMinutes('ayfm', 3, 1)).toBe(13);
    expect(getSectionPartMinutes('ayfm', 3, 3)).toBe(15);
    expect(getSectionPartMinutes('ayfm', 3, 9)).toBe(15);
    expect(getSectionPartMinutes('lac', 2, 1)).toBe(15);
  });

  it('gives no counsel after a part in the noCounsel list', () => {
    expect(hasCounselAfterPart('ayfm-3', 6, ['ayfm-3'])).toBe(false);
    expect(hasCounselAfterPart('ayfm-2', 6, ['ayfm-3'])).toBe(true);
    expect(hasCounselAfterPart('bible-reading', 4, ['ayfm-3'])).toBe(true);
    expect(getGapAfterPart('ayfm-3', 6, ['ayfm-3'])).toBe(0);
    expect(getGapAfterPart('ayfm-2', 6, ['ayfm-3'])).toBe(1);
    expect(getGapAfterPart('lac-1', 15)).toBe(0);
  });

  it('leaves out their counsel in the offsets', () => {
    const sequence = [
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      'song-and-optional-prayer',
    ] as const;
    const durations = { 'ayfm-1': 3, 'ayfm-2': 4, 'ayfm-3': 6 };
    expect(getMeetingPartOffsetMinutes(3, [...sequence], durations)).toBe(16);
    expect(
      getMeetingPartOffsetMinutes(3, [...sequence], durations, ['ayfm-3']),
    ).toBe(15);
  });
});

const SONG = 'song-and-optional-prayer';

const midweekSequence: MeetingPart[] = [
  SONG,
  'introduction',
  'treasures',
  'gems',
  'bible-reading',
  'ayfm-1',
  'ayfm-2',
  'ayfm-3',
  'ayfm-4',
  'ayfm-5',
  SONG,
  'lac-1',
  'lac-2',
  'lac-3',
  'cbs',
  'concluding-comments',
  SONG,
];

const coMidweekSequence: MeetingPart[] = [
  ...midweekSequence.slice(0, 14),
  'concluding-comments',
  'co-service-talk',
  SONG,
];

const weekendSequence: MeetingPart[] = [SONG, 'public-talk', SONG, 'wt', SONG];

const coWeekendSequence: MeetingPart[] = [
  SONG,
  'public-talk',
  SONG,
  'abbreviated-wt',
  'co-final-talk',
  SONG,
];

describe('the changeover to the auxiliary class', () => {
  it('follows the Spiritual Gems, and only when they are on the program', () => {
    expect(AUX_CLASS_CHANGEOVER_MINUTES).toBe(1);
    expect(getGapAfterPart('gems', 10)).toBe(1);
    expect(getGapAfterPart('gems', 0)).toBe(0);
    expect(getGapAfterPart('treasures', 10)).toBe(0);
  });

  it('moves the parts from the Bible reading onward 1 minute later', () => {
    const offset = (part: MeetingPart) =>
      getMeetingPartOffsetMinutes(
        midweekSequence.indexOf(part),
        midweekSequence,
        defaultPartDurations,
      );
    expect(offset('gems')).toBe(16);
    expect(offset('bible-reading')).toBe(27);
    expect(offset('ayfm-1')).toBe(32);
    expect(offset('lac-1')).toBe(52);
    expect(offset('cbs')).toBe(67);
  });
});

describe('the default parts', () => {
  const minutesBeforeFinalSong = (sequence: MeetingPart[]) =>
    getMeetingPartOffsetMinutes(
      sequence.lastIndexOf(SONG),
      sequence,
      defaultPartDurations,
    );

  it('add up to the final song at 100 minutes, with no slack', () => {
    expect(FINAL_SONG_OFFSET_MINUTES).toBe(100);
    expect(minutesBeforeFinalSong(midweekSequence)).toBe(100);
    expect(minutesBeforeFinalSong(coMidweekSequence)).toBe(100);
    expect(minutesBeforeFinalSong(weekendSequence)).toBe(100);
    expect(minutesBeforeFinalSong(coWeekendSequence)).toBe(100);
  });
});

describe('getAdaptedPartSeconds', () => {
  const MINUTE = 60_000;
  const meetingStart = new Date(2026, 9, 13, 19, 0, 0).getTime();
  const deadline = meetingStart + FINAL_SONG_OFFSET_MINUTES * MINUTE;

  /** What `part` gets when it starts `lateMinutes` behind its planned start. */
  const adapt = (
    part: MeetingPart,
    lateMinutes: number,
    {
      durations = defaultPartDurations,
      extraPlannedMinutes = 0,
      sequence = midweekSequence,
    }: {
      durations?: Partial<Record<MeetingPart, number>>;
      extraPlannedMinutes?: number;
      sequence?: MeetingPart[];
    } = {},
  ) => {
    const plannedStart =
      meetingStart +
      getMeetingPartOffsetMinutes(
        sequence.indexOf(part),
        sequence,
        defaultPartDurations,
      ) *
        MINUTE;
    return getAdaptedPartSeconds({
      deadline,
      extraPlannedMinutes,
      now: plannedStart + lateMinutes * MINUTE,
      part,
      partDurations: durations,
      sequence,
    });
  };

  /**
   * The meeting from `from` on, each part running exactly the time it was
   * given: how long each of the `parts` gets, starting `lateMinutes` behind.
   */
  const runThrough = (
    parts: MeetingPart[],
    lateMinutes: number,
    options: Parameters<typeof adapt>[2] = {},
  ) => {
    let late = lateMinutes;
    const given: Partial<Record<MeetingPart, number>> = {};
    for (const part of parts) {
      const plannedSeconds =
        ((options.durations ?? defaultPartDurations)[part] ?? 0) * 60;
      const seconds = adapt(part, late, options) ?? plannedSeconds;
      given[part] = seconds;
      late += (seconds - plannedSeconds) / 60;
    }
    return given;
  };

  it('keeps every part as planned when the meeting is on time or ahead', () => {
    for (const part of [...midweekSequence, ...coMidweekSequence]) {
      expect(adapt(part, 0)).toBeNull();
      expect(adapt(part, -5)).toBeNull();
    }
    for (const part of [...weekendSequence, ...coWeekendSequence]) {
      expect(adapt(part, 0, { sequence: weekendSequence })).toBeNull();
    }
    expect(adapt('wt', 0, { sequence: weekendSequence })).toBeNull();
    expect(
      adapt('abbreviated-wt', 0, { sequence: coWeekendSequence }),
    ).toBeNull();
  });

  it('ignores an overrun of 15 seconds or less', () => {
    expect(adapt('cbs', 0.25)).toBeNull();
    expect(adapt('cbs', 0.5)).not.toBeNull();
  });

  it('shares what Treasures overran out of the Living as Christians parts and the study, in proportion', () => {
    expect(adapt('treasures', 3)).toBeNull();
    expect(adapt('gems', 3)).toBeNull();
    expect(adapt('lac-3', 3)).toBeNull();
    // 3 minutes over 8 + 7 + 30 = 45 minutes of parts: 6.67 % off each
    expect(adapt('lac-1', 3)).toBe(450);
    expect(runThrough(['lac-1', 'lac-2', 'cbs'], 3)).toEqual({
      cbs: 1680,
      'lac-1': 450,
      'lac-2': 390,
    });
  });

  it('never shortens the intro, Treasures, Gems, the Bible reading or the student parts', () => {
    for (const part of [
      'introduction',
      'treasures',
      'gems',
      'bible-reading',
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      SONG,
    ] as const) {
      expect(adapt(part, 10)).toBeNull();
    }
  });

  it('takes the changeover running over out of the Living as Christians parts', () => {
    expect(adapt('bible-reading', 1)).toBeNull();
    expect(runThrough(['lac-1', 'lac-2', 'cbs'], 1)).toEqual({
      cbs: 1760,
      'lac-1': 470,
      'lac-2': 410,
    });
  });

  it('leaves the concluding comments alone while a part to absorb the overrun is to come', () => {
    const reordered: MeetingPart[] = [
      SONG,
      'concluding-comments',
      'lac-1',
      'lac-2',
      SONG,
    ];
    const now = meetingStart + 95 * MINUTE;
    expect(
      getAdaptedPartSeconds({
        deadline,
        now,
        part: 'concluding-comments',
        partDurations: defaultPartDurations,
        sequence: reordered,
      }),
    ).toBeNull();
  });

  it('shortens the concluding comments last, to what is left, down to a minute', () => {
    expect(adapt('concluding-comments', 2)).toBe(60);
    expect(adapt('concluding-comments', 1.5)).toBe(90);
    expect(adapt('concluding-comments', 5)).toBe(60);
    expect(adapt('concluding-comments', 0)).toBeNull();
  });

  it('gives the weekend overrun to the Watchtower Study, never to the talk', () => {
    const sequence = weekendSequence;
    expect(adapt('public-talk', 5, { sequence })).toBeNull();
    // 5 song + 30 talk + 5 song + 55 study = 1:40
    expect(adapt('wt', 5, { sequence })).toBe(55 * 60);
    expect(adapt('abbreviated-wt', 5, { sequence: coWeekendSequence })).toBe(
      25 * 60,
    );
  });

  it('never shortens the circuit overseer talks, so the rest of the meeting does', () => {
    expect(
      adapt('co-final-talk', 5, { sequence: coWeekendSequence }),
    ).toBeNull();
    expect(
      adapt('co-service-talk', 5, { sequence: coMidweekSequence }),
    ).toBeNull();
    // 3 minutes over the two Living as Christians parts (8 + 7)
    const options = { sequence: coMidweekSequence };
    expect(runThrough(['lac-1', 'lac-2'], 3, options)).toEqual({
      'lac-1': 385,
      'lac-2': 335,
    });
    // The talk still has its 30 minutes to come: only the comments give way
    expect(adapt('concluding-comments', 2, options)).toBe(60);
  });

  it('takes the time of a part added to the day out of the Living as Christians parts', () => {
    // Not started, 10 minutes more to fit: the three parts give 10 in all
    expect(adapt('treasures', 0, { extraPlannedMinutes: 10 })).toBeNull();
    const added = runThrough(['lac-1', 'lac-2', 'cbs'], 0, {
      extraPlannedMinutes: 10,
    });
    expect(added).toEqual({ cbs: 1400, 'lac-1': 375, 'lac-2': 325 });
    // Once it has run, its time is already on the clock: the same result
    expect(runThrough(['lac-1', 'lac-2', 'cbs'], 10)).toEqual(added);
  });

  it('takes the extra time of longer concluding comments out of the Living as Christians parts', () => {
    const durations = { ...defaultPartDurations, 'concluding-comments': 6 };
    const given = runThrough(
      ['lac-1', 'lac-2', 'cbs', 'concluding-comments'],
      0,
      { durations },
    );
    // 3 minutes lost in all, shared by the three parts: the comments keep their 6
    expect(given).toEqual({
      cbs: 1680,
      'concluding-comments': 360,
      'lac-1': 450,
      'lac-2': 390,
    });
  });

  it('may cut the study below half its length when far behind', () => {
    expect(adapt('cbs', 20)).toBe(600);
  });

  it('keeps a minute at least', () => {
    expect(adapt('cbs', 30)).toBe(60);
  });

  it('does not adapt more than 30 minutes behind', () => {
    expect(adapt('cbs', 29)).toBe(60);
    expect(adapt('cbs', 31)).toBeNull();
    expect(adapt('lac-1', 40)).toBeNull();
  });

  it('adapts nothing for a part that is not on the program or has no length', () => {
    expect(adapt('cbs', 5, { sequence: coMidweekSequence })).toBeNull();
    expect(adapt('lac-3', 5)).toBeNull();
  });
});
