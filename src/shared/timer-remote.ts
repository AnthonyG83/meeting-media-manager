// What the timer remote's page (served by Electron main) and M3's renderer
// agree on: the commands the page may send, and the PIN that guards them.

export const TIMER_REMOTE_PIN_LENGTH = 6;

/** The commands a timer remote page may send. */
export const TIMER_REMOTE_ACTIONS = [
  'pause',
  'resume',
  'select',
  'start-next',
  'stop',
] as const;

/** A part id, as the timer names them (e.g. `ayfm-1`, `public-talk`). */
export const TIMER_REMOTE_PART_PATTERN = /^[a-z0-9-]{1,40}$/;

const PIN_PATTERN = new RegExp(`^\\d{${TIMER_REMOTE_PIN_LENGTH}}$`);

export const isValidTimerRemotePin = (pin: unknown): pin is string =>
  typeof pin === 'string' && PIN_PATTERN.test(pin);

/** A random PIN of digits only, without the bias of a plain modulo. */
export const generateTimerRemotePin = () => {
  const range = 10 ** TIMER_REMOTE_PIN_LENGTH;
  const limit = Math.floor(0x1_00_00_00_00 / range) * range;
  const buffer = new Uint32Array(1);
  let value = limit;
  while (value >= limit) {
    globalThis.crypto.getRandomValues(buffer);
    value = buffer[0] ?? limit;
  }
  return String(value % range).padStart(TIMER_REMOTE_PIN_LENGTH, '0');
};
