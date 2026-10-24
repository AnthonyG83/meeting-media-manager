import type {
  TimerData,
  TimerRemoteAction,
  TimerRemoteCommand,
  TimerRemoteConfig,
  TimerRemoteStatus,
} from 'src/types';

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { networkInterfaces } from 'node:os';
import { captureElectronError } from 'src-electron/main/utils';
import {
  isValidTimerRemotePin,
  TIMER_REMOTE_ACTIONS,
  TIMER_REMOTE_PART_PATTERN,
} from 'src/shared/timer-remote';
import { log } from 'src/shared/vanilla';

// The timer remote: a small web page, served on the local network, that
// mirrors the meeting timer in real time. Meant for a tablet at the lectern,
// so the speaker sees the remaining time without it being on the
// congregation's screen or in a Zoom share.
//
// The renderer pushes every timer broadcast here (timerRemoteUpdate); the
// page holds a server-sent events stream open and redraws on each one. It
// computes the clock and the pre-meeting countdown itself, the same way the
// timer window does, so an idle timer costs no traffic.
//
// The page can also start, pause, resume and stop the timer, but only when
// that is turned on in the settings, and only with the PIN (POST /command).
// It is plain HTTP on the local network: the PIN keeps a phone on the same
// Wi-Fi from driving the timer, it doesn't hide anything from someone who
// can read the network's traffic.

const MIN_PORT = 1024;
const MAX_PORT = 65_535;
const KEEPALIVE_MS = 20_000;
const MAX_COMMAND_BODY_BYTES = 1024;
const COMMAND_BODY_TIMEOUT_MS = 10_000;
const MAX_WRONG_PINS = 5;
const WRONG_PIN_WINDOW_MS = 60_000;
const MAX_TRACKED_ADDRESSES = 500;

let server: null | Server = null;
let serverPort = 0;
let latestData: null | TimerData = null;
const clients = new Set<ServerResponse>();
let controlConfig: TimerRemoteConfig = { allowControl: false, pin: '' };
let commandSink: ((command: TimerRemoteCommand) => void) | null = null;
const wrongPins = new Map<string, number[]>();
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

export const isValidTimerRemotePort = (port: unknown): port is number =>
  typeof port === 'number' &&
  Number.isInteger(port) &&
  port >= MIN_PORT &&
  port <= MAX_PORT;

/** The addresses the page can be opened at from other devices. */
export const getTimerRemoteUrls = (port: number): string[] => {
  const urls: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4') continue;
      urls.push(`http://${address.address}:${port}/`);
    }
  }
  return urls;
};

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Timer - M³</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main id="display" class="display">
  <div id="label" class="label"></div>
  <div id="time" class="time">--:--</div>
  <div id="caption" class="caption"></div>
  <div id="hand" class="hand" hidden>
    <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M22 58c-5 0-9-3-11-7L4 36c-1-3 1-6 4-6s4 2 5 4l4 8V12c0-2 2-4 4-4s4 2 4 4v18h2V7c0-2 2-4 4-4s4 2 4 4v23h2V10c0-2 2-4 4-4s4 2 4 4v20h2V17c0-2 2-4 4-4s4 2 4 4v27c0 8-6 14-14 14H22z"/></svg>
    <div id="handNames" class="hand-names"></div>
  </div>
  <div id="status" class="status" hidden></div>
  <div class="tools">
    <button id="controlsButton" type="button" class="tool" hidden></button>
    <button id="hideButton" type="button" class="tool"></button>
  </div>
  <section id="controls" class="controls" hidden>
    <form id="pinForm" class="pin-form" hidden>
      <label id="pinLabel" for="pinInput"></label>
      <div class="row">
        <input id="pinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off">
        <button id="pinSave" type="submit" class="control"></button>
      </div>
    </form>
    <div id="panel" class="panel" hidden>
      <div id="partInfo" class="part-info"></div>
      <div class="row">
        <button id="nextButton" type="button" class="control primary"></button>
        <button id="pauseButton" type="button" class="control"></button>
        <button id="stopButton" type="button" class="control"></button>
      </div>
      <div class="row">
        <select id="picker" class="control grow"></select>
        <button id="selectButton" type="button" class="control"></button>
      </div>
    </div>
    <div id="message" class="message" role="status" hidden></div>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`;

const PAGE_CSS = `
html, body { height: 100%; margin: 0; }
/* The classes below set display, which would otherwise beat the hidden attribute. */
[hidden] { display: none !important; }
body { background: #000; color: #fff; font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-user-select: none; user-select: none; overflow: hidden; }
.display { align-items: center; display: flex; flex-direction: column; gap: 2vh; height: 100%; justify-content: center; position: relative; transition: background-color 700ms ease, color 700ms ease; }
.label { font-size: clamp(1rem, 4vw, 3rem); font-weight: 600; letter-spacing: 0.04em; max-width: 94vw; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.label:empty { display: none; }
.time { font-size: clamp(3rem, 26vw, 40vh); font-variant-numeric: tabular-nums; font-weight: 700; line-height: 1; white-space: nowrap; }
.caption { font-size: clamp(0.9rem, 3vw, 2rem); opacity: 0.7; }
.caption:empty { display: none; }
.blink { animation: blink 2s infinite; }
@keyframes blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.7; } }
.hand { align-items: center; display: flex; flex-direction: column; gap: 1vh; inset: 0; justify-content: center; pointer-events: none; position: absolute; }
.hand svg { animation: pulse 1.2s ease-in-out infinite; fill: #ffd60a; filter: drop-shadow(0 0 1.5vh rgba(0,0,0,.6)); height: min(45vh, 45vw); width: min(45vh, 45vw); }
.hand-names { background: rgba(0,0,0,.6); border-radius: 999px; color: #ffd60a; font-size: clamp(1rem, 4vh, 3rem); font-weight: bold; max-width: 90vw; overflow: hidden; padding: .3em 1em; text-overflow: ellipsis; white-space: nowrap; }
.hand-names:empty { display: none; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .75; transform: scale(.94); } }
.status { background: rgba(255,255,255,.12); border-radius: 999px; top: 2vh; font-size: clamp(0.8rem, 2.5vw, 1.2rem); left: 50%; padding: .4em 1.2em; position: absolute; transform: translateX(-50%); }
.tools { display: flex; gap: 8px; position: absolute; right: 12px; top: 12px; }
.tool { background: rgba(255,255,255,.12); border: 0; border-radius: 999px; color: inherit; font: inherit; font-size: 0.9rem; min-height: 40px; padding: 0 1em; }
.controls { background: rgba(0,0,0,.6); bottom: 0; box-sizing: border-box; color: #fff; display: flex; flex-direction: column; gap: 12px; left: 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); position: absolute; right: 0; }
.panel, .pin-form { display: flex; flex-direction: column; gap: 12px; }
.part-info { font-size: clamp(1rem, 3.5vw, 1.6rem); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; gap: 12px; }
.control { background: rgba(255,255,255,.18); border: 0; border-radius: 12px; color: #fff; flex: 1; font: inherit; font-size: clamp(1rem, 3.5vw, 1.5rem); font-weight: 600; min-height: 56px; padding: 0 1em; }
.control.primary { background: #0a84ff; }
.control.grow { flex: 3; min-width: 0; }
.control:disabled { opacity: .4; }
.pin-form input { background: #fff; border: 0; border-radius: 12px; box-sizing: border-box; color: #000; flex: 3; font: inherit; font-size: 1.5rem; letter-spacing: .3em; min-height: 56px; min-width: 0; padding: 0 1em; text-align: center; }
.message { color: #ffd60a; font-size: 1rem; text-align: center; }
`;

// Plain script (no build step): the same display rules as the timer window.
const PAGE_JS = String.raw`(function () {
  'use strict';
  var data = null;
  var connected = false;
  var el = {
    display: document.getElementById('display'),
    label: document.getElementById('label'),
    time: document.getElementById('time'),
    caption: document.getElementById('caption'),
    hand: document.getElementById('hand'),
    handNames: document.getElementById('handNames'),
    status: document.getElementById('status'),
    controlsButton: document.getElementById('controlsButton'),
    hideButton: document.getElementById('hideButton'),
    controls: document.getElementById('controls'),
    pinForm: document.getElementById('pinForm'),
    pinLabel: document.getElementById('pinLabel'),
    pinInput: document.getElementById('pinInput'),
    pinSave: document.getElementById('pinSave'),
    panel: document.getElementById('panel'),
    partInfo: document.getElementById('partInfo'),
    nextButton: document.getElementById('nextButton'),
    pauseButton: document.getElementById('pauseButton'),
    stopButton: document.getElementById('stopButton'),
    picker: document.getElementById('picker'),
    selectButton: document.getElementById('selectButton'),
    message: document.getElementById('message')
  };
  var PIN_KEY = 'm3TimerRemotePin';
  var HIDE_KEY = 'm3TimerRemoteHideTimer';
  var pinFormOpen = false;
  var pickerKey = '';
  var text = {};
  try { text = JSON.parse(document.documentElement.getAttribute('data-text') || '{}'); } catch (e) { text = {}; }

  // Per device, kept in this browser only: the PIN and the hidden timer.
  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: nothing is remembered */ }
  }
  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function timerHidden() { return stored(HIDE_KEY) === '1'; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function formatCountdown(total) { return pad(Math.floor(total / 60)) + ':' + pad(total % 60); }
  function formatTime(date) {
    var options = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !!(data && data.timerHourFormat === '12h') };
    try { return date.toLocaleTimeString((data && data.locale) || [], options); } catch (e) { return date.toLocaleTimeString([], options); }
  }
  function parseTime(str, base) {
    var parts = String(str).split(':');
    var d = new Date(base);
    var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return d;
    d.setHours(h, m, 0, 0);
    return d;
  }
  function meetingCountdown(now) {
    if (!data || !data.timerEnableMeetingCountdown || !data.timerMeetingCountdownMinutes) return null;
    var today = now.getDay() === 0 ? 6 : now.getDay() - 1;
    var start = null;
    if (parseInt(data.mwDay || '-1', 10) === today && data.mwStartTime) start = data.mwStartTime;
    else if (parseInt(data.weDay || '-1', 10) === today && data.weStartTime) start = data.weStartTime;
    if (!start) return null;
    var meeting = parseTime(start, now);
    var minutesUntil = (meeting.getTime() - now.getTime()) / 60000;
    if (minutesUntil <= 0 || minutesUntil > data.timerMeetingCountdownMinutes) return null;
    return Math.max(0, Math.floor((meeting.getTime() - now.getTime()) / 1000));
  }
  function render() {
    var now = new Date();
    var running = !!(data && data.running);
    var overtime = running && typeof data.time === 'string' && data.time.charAt(0) === '-';
    var useOvertime = overtime && data.timerOvertimeIndicator;
    el.display.style.backgroundColor = (useOvertime ? data.timerOvertimeBackgroundColor : data && data.timerBackgroundColor) || '#000';
    el.display.style.color = (useOvertime ? data.timerOvertimeTextColor : data && data.timerTextColor) || '#fff';
    var blink = running && (data.paused || (overtime && data.timerOvertimeAnimation));
    var hidden = timerHidden();
    if (hidden) {
      // This device doesn't want to see the timer: nothing of it, colors included.
      el.display.style.backgroundColor = '#000';
      el.display.style.color = '#fff';
      blink = false;
    }
    el.time.className = 'time' + (blink ? ' blink' : '');
    if (hidden) {
      el.label.textContent = '';
      el.time.textContent = '';
      el.caption.textContent = '';
    } else if (running) {
      el.label.textContent = data.timerCurrentPartLabel || '';
      el.time.textContent = data.time || '';
      el.caption.textContent = data.paused ? (text.paused || '') : (data.mode === 'countup' ? (text.elapsed || '') : (text.remaining || ''));
      if (data.timerPartPlannedSeconds && text.adaptedFrom) {
        el.caption.textContent += ' \u00B7 ' + text.adaptedFrom.replace('{time}', formatCountdown(data.timerPartPlannedSeconds));
      }
    } else {
      var countdown = meetingCountdown(now);
      if (countdown !== null) {
        el.label.textContent = text.meetingStartsIn || '';
        el.time.textContent = formatCountdown(countdown);
        el.caption.textContent = '';
      } else {
        el.label.textContent = '';
        el.time.textContent = formatTime(now);
        el.caption.textContent = '';
      }
    }
    var hand = !!(data && data.handAlertActive);
    el.hand.hidden = !hand;
    el.handNames.textContent = hand && data.handAlertNames ? data.handAlertNames.join(' \u00B7 ') : '';
    el.status.hidden = connected;
    el.status.textContent = connected ? '' : (text.reconnecting || 'Reconnecting\u2026');
    el.hideButton.textContent = hidden ? (text.showTimer || '') : (text.hideTimer || '');
    renderControls(running);
  }

  function minutesText(minutes) {
    return (text.minutes || '{minutes}').replace('{minutes}', String(minutes));
  }
  function partName(part) {
    if (!part) return '';
    var label = part.label || '';
    // Some labels already carry their length.
    return part.minutes && label.indexOf(String(part.minutes)) < 0
      ? label + ' \u00B7 ' + minutesText(part.minutes)
      : label;
  }
  function renderPicker(parts) {
    var key = parts.map(function (p) { return [p.value, p.label, p.done, p.current].join('|'); }).join('\n');
    if (key === pickerKey) return;
    pickerKey = key;
    var chosen = el.picker.value;
    el.picker.textContent = '';
    parts.forEach(function (part) {
      var option = document.createElement('option');
      option.value = part.value;
      option.textContent = (part.current ? '\u25B6 ' : part.done ? '\u2713 ' : '') + partName(part);
      el.picker.appendChild(option);
    });
    if (chosen) el.picker.value = chosen;
  }
  function renderControls(running) {
    var allowed = !!(data && data.timerRemoteControlAllowed);
    var hasPin = !!stored(PIN_KEY);
    el.controlsButton.hidden = !(allowed && !hasPin && !pinFormOpen);
    el.controlsButton.textContent = text.controls || '';
    el.controls.hidden = !(allowed && (hasPin || pinFormOpen));
    if (el.controls.hidden) return;
    el.pinForm.hidden = hasPin;
    el.panel.hidden = !hasPin;
    el.pinLabel.textContent = text.pinPrompt || '';
    el.pinSave.textContent = text.save || '';
    if (!hasPin) return;
    var parts = (data && data.timerRemoteParts) || [];
    var shown = parts.filter(function (p) { return p.current; })[0] || parts.filter(function (p) { return p.next; })[0];
    el.partInfo.textContent = partName(shown);
    el.nextButton.textContent = text.startNext || '';
    el.nextButton.disabled = !parts.some(function (p) { return p.next; });
    el.pauseButton.textContent = (data && data.paused) ? (text.resume || '') : (text.pause || '');
    el.pauseButton.disabled = !running;
    el.stopButton.textContent = text.stop || '';
    el.stopButton.disabled = !running;
    el.selectButton.textContent = text.start || '';
    el.selectButton.disabled = !parts.length;
    renderPicker(parts);
  }
  function showMessage(message) {
    el.message.textContent = message || '';
    el.message.hidden = !message;
  }
  function send(action, part) {
    var pin = stored(PIN_KEY);
    if (!pin) { pinFormOpen = true; render(); return; }
    var body = { action: action };
    if (part) body.part = part;
    fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Timer-Remote-Pin': pin },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (response.status === 202) { showMessage(''); return; }
      if (response.status === 401) {
        // Forget the PIN: it was changed in M3, or typed wrong.
        store(PIN_KEY, null);
        pinFormOpen = true;
        showMessage(text.pinWrong);
      } else if (response.status === 429) {
        showMessage(text.tooManyAttempts);
      } else {
        showMessage(text.sendFailed);
      }
      render();
    }).catch(function () { showMessage(text.sendFailed); });
  }
  el.hideButton.addEventListener('click', function () {
    store(HIDE_KEY, timerHidden() ? null : '1');
    render();
  });
  el.controlsButton.addEventListener('click', function () {
    pinFormOpen = true;
    render();
    el.pinInput.focus();
  });
  el.pinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var pin = el.pinInput.value.replace(/\s/g, '');
    el.pinInput.value = '';
    if (!/^[0-9]{6}$/.test(pin)) { showMessage(text.pinWrong); return; }
    store(PIN_KEY, pin);
    pinFormOpen = false;
    showMessage('');
    render();
  });
  el.nextButton.addEventListener('click', function () { send('start-next'); });
  el.pauseButton.addEventListener('click', function () { send(data && data.paused ? 'resume' : 'pause'); });
  el.stopButton.addEventListener('click', function () { send('stop'); });
  el.selectButton.addEventListener('click', function () { if (el.picker.value) send('select', el.picker.value); });
  function connect() {
    var source = new EventSource('/events');
    source.onopen = function () { connected = true; render(); };
    source.onmessage = function (event) {
      try { data = JSON.parse(event.data); } catch (e) { return; }
      render();
    };
    source.onerror = function () {
      connected = false;
      render();
      source.close();
      setTimeout(connect, 2000);
    };
  }
  setInterval(render, 500);
  render();
  connect();
})();`;

const sendJsonEvent = (client: ServerResponse, data: TimerData) => {
  // Whether the page may send commands is the server's word, not the renderer's.
  const payload = {
    ...data,
    timerRemoteControlAllowed: controlConfig.allowControl,
  };
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const htmlWithText = (text: Record<string, string>) =>
  PAGE_HTML.replace(
    '<html lang="en">',
    `<html lang="${escapeAttribute(text.lang ?? 'en')}" data-text="${escapeAttribute(JSON.stringify(text))}">`,
  );

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

let pageText: Record<string, string> = {};

/** The page's few words, in M3's language (sent by the renderer). */
export const setTimerRemoteText = (text: unknown) => {
  if (!text || typeof text !== 'object') return;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(text)) {
    if (typeof value === 'string' && value.length <= 200) safe[key] = value;
  }
  pageText = safe;
};

const broadcast = () => {
  if (!latestData) return;
  for (const client of clients) {
    try {
      sendJsonEvent(client, latestData);
    } catch {
      clients.delete(client);
    }
  }
};

export const updateTimerRemote = (data: unknown) => {
  if (!data || typeof data !== 'object') return;
  latestData = data as TimerData;
  broadcast();
};

/**
 * Whether the page may control the timer, and the PIN for it (sent by the
 * renderer). Anything but a boolean and a well-formed PIN leaves control off.
 */
export const setTimerRemoteConfig = (config: unknown) => {
  const candidate = (config ?? {}) as Partial<TimerRemoteConfig>;
  controlConfig =
    candidate.allowControl === true && isValidTimerRemotePin(candidate.pin)
      ? { allowControl: true, pin: candidate.pin }
      : { allowControl: false, pin: '' };
  wrongPins.clear();
  // Pages already open show or hide their controls right away.
  broadcast();
};

/** Where the main process sends a checked command (M3's main window). */
export const setTimerRemoteCommandSink = (
  sink: ((command: TimerRemoteCommand) => void) | null,
) => {
  commandSink = sink;
};

const hashPin = (pin: string) => createHash('sha256').update(pin).digest();

const pinMatches = (given: unknown) =>
  typeof given === 'string' &&
  given.length <= 64 &&
  timingSafeEqual(hashPin(given), hashPin(controlConfig.pin));

const getRecentWrongPins = (address: string, now: number) => {
  const recent = (wrongPins.get(address) ?? []).filter(
    (time) => now - time < WRONG_PIN_WINDOW_MS,
  );
  if (recent.length > 0) {
    wrongPins.set(address, recent);
  } else {
    wrongPins.delete(address);
  }
  return recent;
};

const recordWrongPin = (address: string, now: number) => {
  // A flood of addresses can't grow the table without bound.
  if (wrongPins.size >= MAX_TRACKED_ADDRESSES) {
    for (const known of wrongPins.keys()) getRecentWrongPins(known, now);
    if (wrongPins.size >= MAX_TRACKED_ADDRESSES) wrongPins.clear();
  }
  wrongPins.set(address, [...getRecentWrongPins(address, now), now]);
};

/** A page opened from another site can't be trusted to speak for the user. */
const originMatchesHost = (req: IncomingMessage) => {
  const { host, origin } = req.headers;
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
};

/** The body of a command, or null when it is longer than allowed. */
const readCommandBody = (req: IncomingMessage) =>
  new Promise<null | string>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (body: null | string) => {
      clearTimeout(timeout);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(body);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_COMMAND_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(null);
    const timeout = setTimeout(onError, COMMAND_BODY_TIMEOUT_MS);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });

const parseCommand = (body: string): null | TimerRemoteCommand => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { action, part } = parsed as Record<string, unknown>;
  if (!TIMER_REMOTE_ACTIONS.includes(action as TimerRemoteAction)) return null;
  if (part === undefined) return { action: action as TimerRemoteAction };
  if (typeof part !== 'string' || !TIMER_REMOTE_PART_PATTERN.test(part)) {
    return null;
  }
  return { action: action as TimerRemoteAction, part };
};

const replyError = (
  res: ServerResponse,
  headers: Record<string, string>,
  status: number,
  error: string,
  extraHeaders: Record<string, string> = {},
) => {
  res
    .writeHead(status, {
      ...headers,
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    })
    .end(JSON.stringify({ error }));
};

/**
 * POST /command. The checks run cheapest first, and the body of a request
 * that hasn't proved itself with the PIN is never read.
 */
const handleCommand = async (
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
) => {
  if (!controlConfig.allowControl || !commandSink) {
    replyError(res, headers, 403, 'control-disabled');
    return;
  }
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    replyError(res, headers, 415, 'unsupported-content-type');
    return;
  }
  const length = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(length) || length > MAX_COMMAND_BODY_BYTES) {
    replyError(res, headers, 413, 'too-large', { Connection: 'close' });
    return;
  }
  if (!originMatchesHost(req)) {
    replyError(res, headers, 403, 'cross-origin');
    return;
  }

  const address = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  if (getRecentWrongPins(address, now).length >= MAX_WRONG_PINS) {
    replyError(res, headers, 429, 'too-many-attempts', {
      'Retry-After': String(Math.ceil(WRONG_PIN_WINDOW_MS / 1000)),
    });
    return;
  }
  if (!pinMatches(req.headers['x-timer-remote-pin'])) {
    recordWrongPin(address, now);
    log('[timerRemote] Command refused: wrong PIN', 'timer', 'warn', {
      address,
    });
    replyError(res, headers, 401, 'wrong-pin');
    return;
  }

  const body = await readCommandBody(req);
  if (body === null) {
    replyError(res, headers, 413, 'too-large', { Connection: 'close' });
    return;
  }
  const command = parseCommand(body);
  if (!command) {
    replyError(res, headers, 400, 'bad-command');
    return;
  }

  log('[timerRemote] Command', 'timer', 'log', command);
  commandSink(command);
  res.writeHead(202, headers).end();
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  // The page sends commands to its own address only. It is never answered
  // with CORS headers (nor to OPTIONS), so a page from another site can't
  // send the PIN header from a browser on the network.
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  if (method === 'POST' && url === '/command') {
    await handleCommand(req, res, headers);
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
    return;
  }
  if (url === '/' || url === '/index.html') {
    res
      .writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
      })
      .end(htmlWithText(pageText));
    return;
  }
  if (url === '/app.css') {
    res
      .writeHead(200, { ...headers, 'Content-Type': 'text/css; charset=utf-8' })
      .end(PAGE_CSS);
    return;
  }
  if (url === '/app.js') {
    res
      .writeHead(200, {
        ...headers,
        'Content-Type': 'text/javascript; charset=utf-8',
      })
      .end(PAGE_JS);
    return;
  }
  if (url === '/events') {
    res.writeHead(200, {
      ...headers,
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    res.write(': connected\n\n');
    clients.add(res);
    if (latestData) sendJsonEvent(res, latestData);
    res.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404, headers).end();
};

export const startTimerRemote = (port: unknown): Promise<TimerRemoteStatus> => {
  if (!isValidTimerRemotePort(port)) {
    return Promise.resolve({ error: 'invalid-port', running: false, urls: [] });
  }
  if (server && serverPort === port) {
    return Promise.resolve({
      running: true,
      urls: getTimerRemoteUrls(port),
    });
  }
  closeServer();

  return new Promise((resolve) => {
    const httpServer = createServer((req, res) => {
      handleRequest(req, res).catch((error: unknown) => {
        captureElectronError(error, {
          contexts: { fn: { name: 'timerRemoteRequest' } },
        });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    httpServer.requestTimeout = COMMAND_BODY_TIMEOUT_MS;
    httpServer.once('error', (error: NodeJS.ErrnoException) => {
      log('[timerRemote] Could not start', 'timer', 'error', error);
      if (server === httpServer) server = null;
      resolve({
        error: error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed',
        running: false,
        urls: [],
      });
    });
    httpServer.listen(port, () => {
      server = httpServer;
      serverPort = port;
      keepaliveTimer = setInterval(() => {
        for (const client of clients) {
          try {
            client.write(': keepalive\n\n');
          } catch {
            clients.delete(client);
          }
        }
      }, KEEPALIVE_MS);
      log('[timerRemote] Listening', 'timer', 'log', { port });
      resolve({ running: true, urls: getTimerRemoteUrls(port) });
    });
  });
};

const closeServer = () => {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = undefined;
  for (const client of clients) {
    try {
      client.end();
    } catch {
      // The client is already gone.
    }
  }
  clients.clear();
  if (server) {
    server.close();
    log('[timerRemote] Stopped', 'timer', 'log');
  }
  server = null;
  serverPort = 0;
  latestData = null;
};

/** Stops serving, and takes control away until the renderer allows it again. */
export const stopTimerRemote = () => {
  closeServer();
  controlConfig = { allowControl: false, pin: '' };
  wrongPins.clear();
};

export const __testables = {
  getClientCount: () => clients.size,
  getServerPort: () => serverPort,
  reset: () => {
    controlConfig = { allowControl: false, pin: '' };
    commandSink = null;
    wrongPins.clear();
  },
};
