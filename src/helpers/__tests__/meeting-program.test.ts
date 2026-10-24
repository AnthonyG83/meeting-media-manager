import { describe, expect, it } from 'vitest';

import { parseMidweekProgram } from '../meeting-program';

// The workbook's pages as WOL serves them, trimmed to their structure
const fixtureFiles = import.meta.glob<string>(
  './fixtures/meeting-program/*.html',
  { eager: true, import: 'default', query: '?raw' },
);

const fixture = (name: string): string => {
  const html = fixtureFiles[`./fixtures/meeting-program/${name}.html`];
  if (!html) throw new Error(`Missing fixture ${name}`);
  return html;
};

const parse = (name: string) => {
  const program = parseMidweekProgram(fixture(name));
  if (!program) throw new Error(`Fixture ${name} did not parse`);
  return program;
};

const OCT_19_DURATIONS = {
  'ayfm-1': 3,
  'ayfm-2': 2,
  'ayfm-3': 2,
  'ayfm-4': 4,
  'ayfm-5': 0,
  'bible-reading': 4,
  cbs: 30,
  'concluding-comments': 3,
  gems: 10,
  introduction: 1,
  'lac-1': 15,
  'lac-2': 0,
  'lac-3': 0,
  treasures: 10,
};

/** A week with the given Apply Yourself and Living as Christians lengths. */
const buildProgram = (ayfm: number[], living = [15]): string =>
  [
    '<h3 class="dc-icon--music">Song 1 | Opening Comments (1 min.)</h3>',
    '<div class="dc-icon--gem"><h2>A</h2></div>',
    '<h3>1. A</h3><p>(10 min.)</p>',
    '<h3>2. B</h3><p>(10 min.)</p>',
    '<h3>3. C</h3><p>(4 min.)</p>',
    '<div class="dc-icon--wheat"><h2>B</h2></div>',
    ...ayfm.map((m, i) => `<h3>${i + 4}. P</h3><p>(${m} min.)</p>`),
    '<div class="dc-icon--sheep"><h2>C</h2></div>',
    ...living.map(
      (m, i) => `<h3>${ayfm.length + i + 4}. L</h3><p>(${m} min.)</p>`,
    ),
    `<h3>${ayfm.length + living.length + 4}. Bible study</h3><p>(30 min.)</p>`,
    '<h3>Concluding Comments (3 min.) | <span class="dc-icon--music">Song 2</span></h3>',
  ].join('\n');

describe('parseMidweekProgram', () => {
  it('reads the week of October 19: 4 Apply Yourself parts and 1 Living as Christians part', () => {
    expect(parse('oct-19-2026.en')).toEqual({
      counts: { ayfm: 4, lac: 1 },
      durations: OCT_19_DURATIONS,
      noCounsel: [],
      titles: {
        'ayfm-1': 'Starting a Conversation',
        'ayfm-2': 'Starting a Conversation',
        'ayfm-3': 'Starting a Conversation',
        'ayfm-4': 'Talk',
        'lac-1': '“Share What You Have With Others”',
      },
    });
  });

  it.each([
    ['es', 'Spanish'],
    ['ar', 'Arabic, with Arabic-Indic digits'],
    ['zh-hans', 'Chinese, with full-width brackets and a full-width stop'],
    ['my', 'Burmese, with Burmese digits'],
    ['ja', 'Japanese'],
  ])('gives the same numbers in %s (%s)', (language) => {
    const program = parse(`oct-19-2026.${language}`);
    expect(program.counts).toEqual({ ayfm: 4, lac: 1 });
    expect(program.durations).toEqual(OCT_19_DURATIONS);
    expect(program.noCounsel).toEqual([]);
    expect(Object.keys(program.titles).sort()).toEqual([
      'ayfm-1',
      'ayfm-2',
      'ayfm-3',
      'ayfm-4',
      'lac-1',
    ]);
  });

  it('keeps the titles in the workbook language, without the part number', () => {
    expect(parse('oct-19-2026.es').titles['ayfm-1']).toBe(
      'Empiece conversaciones',
    );
    expect(parse('oct-19-2026.ar').titles['ayfm-4']).toBe('خطاب');
    expect(parse('oct-19-2026.zh-hans').titles['ayfm-1']).toBe('初次交谈');
    expect(parse('oct-19-2026.my').titles['ayfm-4']).toBe('ဟောပြောချက်');
    expect(parse('oct-19-2026.ja').titles['lac-1']).toBe(
      '「持っている物を分け合う」',
    );
  });

  it('reads two Living as Christians parts before the Bible study (week of September 14)', () => {
    const program = parse('sep-14-2026.en');
    expect(program.counts).toEqual({ ayfm: 4, lac: 2 });
    expect(program.durations).toMatchObject({
      'ayfm-1': 2,
      'ayfm-2': 2,
      'ayfm-3': 3,
      'ayfm-4': 4,
      cbs: 30,
      'lac-1': 6,
      'lac-2': 9,
      'lac-3': 0,
    });
    expect(program.noCounsel).toEqual([]);
  });

  it('finds no counsel after the closing "What Would You Say?" (week of September 21)', () => {
    const program = parse('sep-21-2026.en');
    expect(program.counts).toEqual({ ayfm: 3, lac: 1 });
    expect(program.durations).toMatchObject({
      'ayfm-1': 3,
      'ayfm-2': 4,
      'ayfm-3': 6,
      'ayfm-4': 0,
      'lac-1': 15,
    });
    expect(program.noCounsel).toEqual(['ayfm-3']);
    expect(program.titles['ayfm-3']).toBe('What Would You Say?');
  });

  it('reads a plain week with three Apply Yourself parts (week of September 7)', () => {
    const program = parse('sep-07-2026.en');
    expect(program.counts).toEqual({ ayfm: 3, lac: 1 });
    expect(program.durations).toMatchObject({
      'ayfm-1': 3,
      'ayfm-2': 4,
      'ayfm-3': 5,
      'bible-reading': 4,
      cbs: 30,
      gems: 10,
      'lac-1': 15,
      treasures: 10,
    });
    expect(program.noCounsel).toEqual([]);
  });

  it('marks as many of the last parts as are missing counsel', () => {
    expect(parseMidweekProgram(buildProgram([5, 5, 3]))?.noCounsel).toEqual([
      'ayfm-3',
    ]);
    expect(parseMidweekProgram(buildProgram([8, 7]))?.noCounsel).toEqual([
      'ayfm-1',
      'ayfm-2',
    ]);
    expect(parseMidweekProgram(buildProgram([4, 4, 4]))?.noCounsel).toEqual([]);
  });

  it('does not depend on the unit word', () => {
    const html = fixture('oct-19-2026.en').replaceAll(
      /\((\d+) min\.\)/g,
      '($1 zzz)',
    );
    expect(parseMidweekProgram(html)?.durations).toEqual(OCT_19_DURATIONS);
  });

  it('returns null for pages that are not a workbook week', () => {
    expect(parseMidweekProgram('')).toBeNull();
    expect(parseMidweekProgram('garbage')).toBeNull();
    expect(parseMidweekProgram('<h3>1. Hello</h3><p>(3 min.)</p>')).toBeNull();
    expect(
      parseMidweekProgram('<html><body>Not found</body></html>'),
    ).toBeNull();
  });

  it('returns null rather than guess when something is off', () => {
    const html = fixture('oct-19-2026.en');
    // a part without a length
    expect(
      parseMidweekProgram(html.replace('<p>(2 min.)</p>', '<p></p>')),
    ).toBeNull();
    // a section marker missing
    expect(
      parseMidweekProgram(html.replace('dc-icon--wheat', 'dc-icon--other')),
    ).toBeNull();
    // parts that are not numbered one after the other
    expect(
      parseMidweekProgram(html.replace('<strong>5. ', '<strong>9. ')),
    ).toBeNull();
    // not three Treasures parts
    expect(
      parseMidweekProgram(
        html.replace(
          '<h3><strong>3. Bible Reading</strong></h3>\n<p>(4 min.)</p>\n',
          '',
        ),
      ),
    ).toBeNull();
    // an absurd length
    expect(
      parseMidweekProgram(html.replace('<p>(3 min.)</p>', '<p>(300 min.)</p>')),
    ).toBeNull();
  });

  it('returns null when there are more parts than a meeting can hold', () => {
    expect(parseMidweekProgram(buildProgram([2, 2, 2, 2, 2]))).not.toBeNull();
    expect(parseMidweekProgram(buildProgram([2, 2, 2, 2, 2, 2]))).toBeNull();
    expect(
      parseMidweekProgram(buildProgram([4, 4, 4], [5, 5, 5])),
    ).not.toBeNull();
    expect(
      parseMidweekProgram(buildProgram([4, 4, 4], [5, 5, 5, 5])),
    ).toBeNull();
  });
});
