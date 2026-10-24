import type { MeetingPart, TimerPartCounts } from 'src/types';

import {
  AYFM_SECTION_MINUTES,
  MAX_AYFM_PARTS,
  MAX_LAC_PARTS,
} from 'src/helpers/meeting-parts';

/** What the midweek workbook says about the length of each part of a week. */
export interface MidweekProgram {
  /** The Apply Yourself and Living as Christians parts (CBS excluded). */
  counts: TimerPartCounts;
  /** Minutes per part. Apply Yourself and Living as Christians parts beyond `counts` are 0. */
  durations: Partial<Record<MeetingPart, number>>;
  /** The Apply Yourself parts the chairman gives no counsel after. */
  noCounsel: MeetingPart[];
  /** The workbook's titles of the Apply Yourself and Living as Christians parts. */
  titles: Partial<Record<MeetingPart, string>>;
}

interface HeadingToken {
  /** Everything between this heading and the next token, as text. */
  following: string;
  isMusic: boolean;
  kind: 'heading';
  /** The heading's own text, tags removed. */
  text: string;
}

interface ProgramPart {
  minutes: number;
  title: string;
}

type SectionId = 'gem' | 'sheep' | 'wheat';

interface SectionToken {
  kind: 'section';
  section: SectionId;
}

const MIN_PART_MINUTES = 1;
const MAX_PART_MINUTES = 60;
const TREASURES_PARTS = ['treasures', 'gems', 'bible-reading'] as const;

// Section wrappers carry the icon class (`dc-icon--gem|wheat|sheep`), which
// is the same in every language, unlike the section titles. Parts are <h3>s.
const TOKEN_REGEX =
  /<h3\b([^>]*)>([\s\S]*?)<\/h3>|<[^<>]*\bclass=["'][^"']*\bdc-icon--(gem|wheat|sheep)\b[^"']*["'][^<>]*>/g;
// "(10 min.)", "（10分钟）", "(‏١٠ دق)‏", "(၁၀ မိ.)": the first digits after an
// opening bracket, whatever the script. The unit word is never looked at.
const MINUTES_REGEX = /[(（][\s\p{Cf}]*(\p{Nd}+)/u;
// "4. ", "٤-‏ ", "4．", "၄။ ": the part number at the start of a heading.
const LEADING_NUMBER_REGEX = /^[\s\p{Cf}]*(\p{Nd}+)/u;
const NUMBER_SEPARATOR_REGEX = /^[\s\p{Cf}]*[.．。။\-:、)]?[\s\p{Cf}]*/u;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const decodeEntities = (text: string) =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(
        entity.slice(isHex ? 2 : 1),
        isHex ? 16 : 10,
      );
      return Number.isNaN(codePoint) || codePoint > 0x10_ff_ff
        ? match
        : String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });

const htmlToText = (html: string) =>
  decodeEntities(html.replaceAll(/<[^>]*>/g, ' ')).replaceAll(/\s+/g, ' ');

/**
 * The value of a decimal digit of any script. Unicode lays decimal digits
 * out in runs of ten starting at zero, so a digit's value is its distance
 * from the start of its run, modulo ten.
 */
const getDigitValue = (digit: string): number => {
  const codePoint = digit.codePointAt(0) ?? 0;
  let runStart = codePoint;
  while (runStart > 0 && /\p{Nd}/u.test(String.fromCodePoint(runStart - 1))) {
    runStart--;
  }
  return (codePoint - runStart) % 10;
};

const parseLocalNumber = (digits: string): number => {
  let value = 0;
  for (const digit of digits) value = value * 10 + getDigitValue(digit);
  return value;
};

const findMinutes = (text: string): null | number => {
  const match = MINUTES_REGEX.exec(text);
  return match?.[1] ? parseLocalNumber(match[1]) : null;
};

const tokenize = (html: string): (HeadingToken | SectionToken)[] => {
  const matches = [...html.matchAll(TOKEN_REGEX)];
  return matches.map((match, index) => {
    const section = match[3] as SectionId | undefined;
    if (section) return { kind: 'section', section };
    const nextStart = matches[index + 1]?.index ?? html.length;
    const end = (match.index ?? 0) + match[0].length;
    return {
      following: htmlToText(html.slice(end, nextStart)),
      isMusic:
        /dc-icon--music/.test(match[1] ?? '') ||
        /dc-icon--music/.test(match[2] ?? ''),
      kind: 'heading',
      text: htmlToText(match[2] ?? '').trim(),
    };
  });
};

interface ParsedSections {
  concluding: null | number;
  introduction: null | number;
  parts: Record<SectionId, ProgramPart[]>;
}

/** Sorts the headings into the three sections. `null` when the page is not what we expect. */
const collectParts = (
  tokens: (HeadingToken | SectionToken)[],
): null | ParsedSections => {
  const result: ParsedSections = {
    concluding: null,
    introduction: null,
    parts: { gem: [], sheep: [], wheat: [] },
  };
  const seen = new Set<SectionId>();
  let section: null | SectionId = null;
  let expectedNumber = 1;

  for (const token of tokens) {
    if (token.kind === 'section') {
      section = token.section;
      seen.add(section);
      continue;
    }

    const leading = token.isMusic
      ? null
      : LEADING_NUMBER_REGEX.exec(token.text);
    if (leading?.[1]) {
      // A numbered part: the numbers run 1, 2, 3... through the three sections
      if (!section || parseLocalNumber(leading[1]) !== expectedNumber)
        return null;
      expectedNumber++;
      const minutes = findMinutes(token.following);
      if (minutes === null) return null;
      const title = token.text
        .slice(leading[0].length)
        .replace(NUMBER_SEPARATOR_REGEX, '')
        .trim();
      result.parts[section].push({ minutes, title });
      continue;
    }

    // "Song | Opening Comments (1 min.)" before the first section and
    // "Concluding Comments (3 min.) | Song" at the end of the last one
    if (token.isMusic && !section) {
      result.introduction = findMinutes(token.text);
    } else if (section === 'sheep') {
      const minutes = findMinutes(token.text);
      if (minutes !== null) result.concluding = minutes;
    }
  }

  return seen.size === 3 ? result : null;
};

const isPlausible = (minutes: number) =>
  minutes >= MIN_PART_MINUTES && minutes <= MAX_PART_MINUTES;

const getNoCounsel = (ayfm: ProgramPart[]): MeetingPart[] => {
  // The section's minutes cover the parts and the counsel after each student
  // part. A discussion such as "What Would You Say?" has no counsel, which
  // shows in the totals; in every week seen, it is the last part.
  const partMinutes = ayfm.reduce((total, part) => total + part.minutes, 0);
  const counselCount = Math.min(
    Math.max(AYFM_SECTION_MINUTES - partMinutes, 0),
    ayfm.length,
  );
  const withoutCounsel = ayfm.length - counselCount;
  return ayfm
    .map((_, index) => `ayfm-${index + 1}` as MeetingPart)
    .slice(ayfm.length - withoutCounsel);
};

/**
 * Reads the length of every part of a midweek meeting from the workbook's
 * HTML for that week (WOL's finder page, in any language). The sections are
 * told apart by their icon class, and part numbers and lengths are read as
 * digits of any script, so neither the language nor the unit word matters.
 * Returns `null` rather than guessing when the page is not what we expect.
 */
export const parseMidweekProgram = (html: string): MidweekProgram | null => {
  if (!html) return null;

  const sections = collectParts(tokenize(html));
  if (!sections) return null;

  const treasures = sections.parts.gem;
  const ayfm = sections.parts.wheat;
  const living = sections.parts.sheep;
  // The last numbered part of the last section is the congregation Bible study
  const cbs = living.at(-1);
  const lac = living.slice(0, -1);

  if (treasures.length !== TREASURES_PARTS.length || !cbs) return null;
  if (ayfm.length < 1 || ayfm.length > MAX_AYFM_PARTS) return null;
  if (lac.length < 1 || lac.length > MAX_LAC_PARTS) return null;

  const allParts = [...treasures, ...ayfm, ...living];
  if (!allParts.every((part) => isPlausible(part.minutes))) return null;

  const durations: Partial<Record<MeetingPart, number>> = {};
  const titles: Partial<Record<MeetingPart, string>> = {};
  for (const [index, part] of TREASURES_PARTS.entries()) {
    durations[part] = treasures[index]?.minutes ?? 0;
  }
  for (let i = 1; i <= MAX_AYFM_PARTS; i++) {
    const part = ayfm[i - 1];
    const key = `ayfm-${i}` as MeetingPart;
    durations[key] = part?.minutes ?? 0;
    if (part?.title) titles[key] = part.title;
  }
  for (let i = 1; i <= MAX_LAC_PARTS; i++) {
    const part = lac[i - 1];
    const key = `lac-${i}` as MeetingPart;
    durations[key] = part?.minutes ?? 0;
    if (part?.title) titles[key] = part.title;
  }
  durations.cbs = cbs.minutes;
  if (sections.introduction !== null && isPlausible(sections.introduction)) {
    durations.introduction = sections.introduction;
  }
  if (sections.concluding !== null && isPlausible(sections.concluding)) {
    durations['concluding-comments'] = sections.concluding;
  }

  return {
    counts: { ayfm: ayfm.length, lac: lac.length },
    durations,
    noCounsel: getNoCounsel(ayfm),
    titles,
  };
};
