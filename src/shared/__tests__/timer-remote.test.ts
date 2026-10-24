import { describe, expect, it } from 'vitest';

import {
  generateTimerRemotePin,
  isValidTimerRemotePin,
  TIMER_REMOTE_PART_PATTERN,
} from '../timer-remote';

describe('timer remote PIN', () => {
  it('accepts exactly 6 numbers', () => {
    expect(isValidTimerRemotePin('123456')).toBe(true);
    expect(isValidTimerRemotePin('000000')).toBe(true);
    for (const pin of [
      '12345',
      '1234567',
      'abcdef',
      '12 456',
      '',
      null,
      123_456,
    ]) {
      expect(isValidTimerRemotePin(pin)).toBe(false);
    }
  });

  it('generates valid PINs, leading zeros included', () => {
    const pins = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pin = generateTimerRemotePin();
      expect(isValidTimerRemotePin(pin)).toBe(true);
      pins.add(pin);
    }
    // Random: 200 draws from a million don't all land on the same few.
    expect(pins.size).toBeGreaterThan(190);
  });
});

describe('timer remote part ids', () => {
  it('matches the timer part ids and nothing odd', () => {
    for (const part of ['public-talk', 'ayfm-1', 'custom-1a2b']) {
      expect(TIMER_REMOTE_PART_PATTERN.test(part)).toBe(true);
    }
    for (const part of ['', 'A', 'a b', 'a/b', 'a'.repeat(41), 'a\n']) {
      expect(TIMER_REMOTE_PART_PATTERN.test(part)).toBe(false);
    }
  });
});
