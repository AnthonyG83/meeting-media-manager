import type { SettingsValues, TimerRemoteCommand } from 'src/types';

import { i18n } from 'boot/i18n';
import useTimer from 'src/composables/useTimer';
import { errorCatcher } from 'src/helpers/error-catcher';
import { createTemporaryNotification } from 'src/helpers/notifications';
import {
  generateTimerRemotePin,
  isValidTimerRemotePin,
  TIMER_REMOTE_ACTIONS,
  TIMER_REMOTE_PART_PATTERN,
} from 'src/shared/timer-remote';
import { log } from 'src/shared/vanilla';
import { useCurrentStateStore } from 'stores/current-state';

// Starts and stops the timer remote (src-electron/main/timer-remote.ts) to
// match the settings, keeps the main process told of the page's words in M3's
// language and of whether (and with which PIN) the page may control the
// timer, and carries out the commands the page sends.

const t = (key: string, named?: Record<string, unknown>) =>
  (i18n.global.t as (key: string, named?: Record<string, unknown>) => string)(
    key,
    named,
  );

const getPageText = (): Record<string, string> => ({
  controls: t('timer-remote-controls'),
  elapsed: t('elapsed'),
  hideTimer: t('timer-remote-hide-timer'),
  lang: i18n.global.locale.value,
  meetingStartsIn: t('meeting-starts-in'),
  minutes: t('timer-remote-minutes', { minutes: '{minutes}' }),
  parts: t('timer-remote-parts'),
  pause: t('pause'),
  paused: t('paused'),
  pinPrompt: t('timer-remote-pin-prompt'),
  pinWrong: t('timer-remote-pin-wrong'),
  reconnecting: t('timer-remote-reconnecting'),
  remaining: t('remaining'),
  resume: t('resume'),
  save: t('save'),
  sendFailed: t('timer-remote-send-failed'),
  showTimer: t('timer-remote-show-timer'),
  start: t('start'),
  startNext: t('timer-remote-start-next'),
  stop: t('stop'),
  tooManyAttempts: t('timer-remote-too-many-attempts'),
});

export const parseTimerRemotePort = (value: null | string | undefined) => {
  const port = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return null;
  return port;
};

let runningPort: null | number = null;
let syncInProgress: null | Promise<void> = null;

const notifyStartFailed = (error: string | undefined) => {
  createTemporaryNotification({
    group: 'timer-remote',
    icon: 'mmm-error',
    message: t(
      error === 'port-in-use'
        ? 'timer-remote-port-in-use'
        : 'timer-remote-start-failed',
    ),
    type: 'negative',
  });
};

/** Gives control a PIN of its own the first time it is turned on. */
const ensurePin = (settings: SettingsValues) => {
  if (isValidTimerRemotePin(settings.timerRemotePin)) {
    return settings.timerRemotePin;
  }
  const pin = generateTimerRemotePin();
  settings.timerRemotePin = pin;
  return pin;
};

/** Replaces the PIN, which signs out every page that has it. */
export const renewTimerRemotePin = () => {
  const settings = useCurrentStateStore().currentSettings;
  if (!settings) return;
  settings.timerRemotePin = generateTimerRemotePin();
  createTemporaryNotification({
    group: 'timer-remote',
    icon: 'mmm-check',
    message: t('timer-remote-new-pin-done'),
    type: 'positive',
  });
};

const sendControlConfig = (settings: SettingsValues) => {
  const allowControl = !!settings.timerRemoteAllowControl;
  globalThis.electronApi.timerRemoteConfig({
    allowControl,
    pin: allowControl ? ensurePin(settings) : '',
  });
};

const applySettings = async () => {
  const currentState = useCurrentStateStore();
  const settings = currentState.currentSettings;
  const wanted =
    !!settings?.enableTimerDisplay && !!settings?.timerRemoteEnable
      ? parseTimerRemotePort(settings.timerRemotePort)
      : null;

  if (wanted === null) {
    if (runningPort !== null) {
      globalThis.electronApi.stopTimerRemote();
      runningPort = null;
      currentState.setTimerRemoteUrls([]);
      log('Timer remote stopped', 'timer', 'info');
    }
    return;
  }

  globalThis.electronApi.timerRemoteText(getPageText());
  if (settings) sendControlConfig(settings);
  if (runningPort === wanted) return;

  const status = await globalThis.electronApi.startTimerRemote(wanted);
  if (!status.running) {
    runningPort = null;
    currentState.setTimerRemoteUrls([]);
    notifyStartFailed(status.error);
    return;
  }
  runningPort = wanted;
  currentState.setTimerRemoteUrls(status.urls);
  log('Timer remote started', 'timer', 'info', status.urls);
  // Pages opened before the first part is timed need the current state.
  useTimer().updateTimerWindow();
};

const isRemoteControlAllowed = () => {
  const settings = useCurrentStateStore().currentSettings;
  return (
    !!settings?.enableTimerDisplay &&
    !!settings.timerRemoteEnable &&
    !!settings.timerRemoteAllowControl
  );
};

const notifyFromRemote = (messageKey: string, part?: string) => {
  createTemporaryNotification({
    group: 'timer-remote',
    icon: 'mmm-alarm',
    message: t(messageKey, { part }),
    type: 'info',
  });
};

/**
 * Carries out a command from the timer page. The main process already
 * checked it, but it is checked again here: the timer is only driven for a
 * known action, and a part only if it is in today's list.
 */
export const handleTimerRemoteCommand = (command: TimerRemoteCommand) => {
  try {
    if (!isRemoteControlAllowed()) return;
    const action = command?.action;
    if (!TIMER_REMOTE_ACTIONS.includes(action)) return;

    const timer = useTimer();
    log('Timer remote command', 'timer', 'info', {
      action,
      part: command.part,
    });

    if (action === 'start-next') {
      const next = timer.nextPart.value;
      if (!next) return;
      timer.startNextPart();
      notifyFromRemote('timer-remote-command-started', next.label);
    } else if (action === 'select') {
      const part = command.part;
      if (typeof part !== 'string' || !TIMER_REMOTE_PART_PATTERN.test(part)) {
        return;
      }
      const option = timer.meetingPartsOptions.value.find(
        (o) => o.value === part,
      );
      if (!option) return;
      timer.selectPart(option.value);
      notifyFromRemote('timer-remote-command-started', option.label);
    } else if (action === 'pause') {
      if (timer.timerRunning.value && !timer.timerPaused.value) {
        timer.pauseTimer();
      }
    } else if (action === 'resume') {
      if (timer.timerRunning.value && timer.timerPaused.value) {
        timer.resumeTimer();
      }
    } else if (timer.timerRunning.value) {
      timer.stopTimer();
      notifyFromRemote('timer-remote-command-stopped');
    }
  } catch (error) {
    errorCatcher(error, {
      contexts: { fn: { name: 'handleTimerRemoteCommand' } },
    });
  }
};

/** Starts, restarts (new port) or stops the timer remote per the settings. */
export const syncTimerRemote = async () => {
  if (syncInProgress) await syncInProgress;
  syncInProgress = applySettings().catch((error) => {
    errorCatcher(error, { contexts: { fn: { name: 'syncTimerRemote' } } });
  });
  try {
    await syncInProgress;
  } finally {
    syncInProgress = null;
  }
};

export const __testables = {
  reset: () => {
    runningPort = null;
    syncInProgress = null;
  },
};
