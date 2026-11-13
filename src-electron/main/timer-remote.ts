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
// Two layouts: the classic one (a large time, with a hand overlay when
// someone raises their hand) and, when the profile turns it on, the focus
// layout: a progress ring around the time, and a panel listing the raised
// hands beside it. The words come from the renderer in M3's language.
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

const HAND_PATH =
  'M22 58c-5 0-9-3-11-7L4 36c-1-3 1-6 4-6s4 2 5 4l4 8V12c0-2 2-4 4-4s4 2 4 4v18h2V7c0-2 2-4 4-4s4 2 4 4v23h2V10c0-2 2-4 4-4s4 2 4 4v20h2V17c0-2 2-4 4-4s4 2 4 4v27c0 8-6 14-14 14H22z';

// A two-second, 32x32 silent H.264 clip (1.5 KB), played hidden by the page
// when the Wake Lock API isn't available. Browsers only expose Wake Lock to
// secure pages, and the timer remote is served over plain HTTP on the LAN, so
// on a tablet the video is what holds the screen awake.
const AWAKE_VIDEO = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMxbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlx0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHUbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABf21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAT9zdGJsAAAAt3N0c2QAAAAAAAAAAQAAAKdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALWF2Y0MBQsAe/+EAFmdCwB7ZCWwEQAAAAwBAAAADAQPFi5IBAARoy4yyAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAF3AAAArQAAAAGHN0dHMAAAAAAAAAAQAAAAQAACAAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAQAAAABAAAAJHN0c3oAAAAAAAAAAAAAAAQAAAKWAAAACgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA2EAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAAK8bWRhdAAAAn4GBf//etxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjNNIDA0ODBjYjAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9YWJyIG1idHJlZT0xIGJpdHJhdGU9NiByYXRldG9sPTEuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABBliIQGf///D0UAAU9/J114AAAABkGaOA15YAAAAAZBmlQDXlgAAAAGQZpgGvLA',
  'base64',
);

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
<video id="awake" class="awake" aria-hidden="true" loop muted playsinline preload="none"></video>
<main id="display" class="display">
  <div id="clock" class="clock" hidden></div>
  <div class="face">
    <div id="label" class="label"></div>
    <div id="dial" class="dial">
      <svg class="dial__ring" aria-hidden="true" focusable="false" viewBox="-10 -10 120 120">
        <circle class="dial__track" cx="50" cy="50" fill="none" r="46"/>
        <circle id="ringProgress" class="dial__progress" cx="50" cy="50" fill="none" pathLength="100" r="46"/>
      </svg>
      <div class="dial__inner">
        <div id="eyebrow" class="eyebrow"></div>
        <div id="time" class="time"><span id="timeSign" class="time__sign"></span><span id="timeValue">--:--</span></div>
      </div>
    </div>
    <div id="caption" class="caption"></div>
    <aside id="hands" class="hands" hidden>
      <div id="handBanner" class="hand-banner" role="status" hidden>
        <svg class="hand-banner__icon" aria-hidden="true" focusable="false" viewBox="0 0 64 64"><path d="${HAND_PATH}"/></svg>
        <span id="handBannerText" class="hand-banner__text"></span>
      </div>
      <div class="hands__header">
        <svg class="hands__icon" aria-hidden="true" focusable="false" viewBox="0 0 64 64"><path d="${HAND_PATH}"/></svg>
        <span id="handsTitle" class="hands__title"></span>
        <span id="handCount" class="hands__count" hidden></span>
      </div>
      <ol id="handList" class="hands__list"></ol>
      <div id="handMore" class="hands__more" hidden></div>
    </aside>
  </div>
  <div id="hand" class="hand" hidden>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 64 64"><path d="${HAND_PATH}"/></svg>
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
      <div class="row">
        <select id="picker" class="control grow"></select>
      </div>
      <div class="row">
        <button id="selectButton" type="button" class="control start"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span id="selectLabel"></span></button>
        <button id="pauseButton" type="button" class="control"><svg id="pauseIcon" class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg><svg id="resumeIcon" class="icon" hidden viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span id="pauseLabel"></span></button>
        <button id="stopButton" type="button" class="control stop"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg><span id="stopLabel"></span></button>
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
/* The silent clip that holds the screen awake where Wake Lock isn't available.
   Chromium only takes its video wake lock for muted videos that are in view,
   so it covers the page at 1% opacity, where it can't be seen. */
.awake { height: 100%; inset: 0; left: 0; object-fit: cover; opacity: .01; pointer-events: none; position: fixed; top: 0; width: 100%; z-index: 1; }
.display { box-sizing: border-box; display: flex; flex-direction: column; height: 100%; position: relative; transition: background-color 700ms ease, color 700ms ease; }
/* The clock takes the room the controls leave, so the two never overlap. */
.face { align-items: center; box-sizing: border-box; display: flex; flex: 1; flex-direction: column; justify-content: center; min-height: 0; overflow: hidden; padding: 56px 16px 0; position: relative; transition: padding 300ms ease; }
.face > * + * { margin-top: 2vh; }
.label { font-size: 4vw; font-size: clamp(1rem, 4vw, 3rem); font-weight: 600; letter-spacing: 0.04em; max-width: 94vw; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.label:empty { display: none; }
.time { font-size: 24vw; font-size: min(26vw, 40vh); font-variant-numeric: tabular-nums; font-weight: 700; line-height: 1; white-space: nowrap; }
.time__sign { color: var(--ring, #ff453a); }
.time__sign:empty { display: none; }
.caption { font-size: 3vw; font-size: clamp(0.9rem, 3vw, 2rem); opacity: 0.7; }
.caption:empty { display: none; }
.blink { animation: blink 2s infinite; }
@keyframes blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.7; } }
.hand { align-items: center; display: flex; flex-direction: column; bottom: 0; justify-content: center; left: 0; pointer-events: none; position: absolute; right: 0; top: 0; }
.hand > * + * { margin-top: 1vh; }
.hand svg { animation: pulse 1.2s ease-in-out infinite; fill: #ffd60a; filter: drop-shadow(0 0 1.5vh rgba(0,0,0,.6)); height: 40vmin; height: min(45vh, 45vw); width: 40vmin; width: min(45vh, 45vw); }
.hand-names { background: rgba(0,0,0,.6); border-radius: 999px; color: #ffd60a; font-size: 4vh; font-size: clamp(1rem, 4vh, 3rem); font-weight: bold; max-width: 90vw; overflow: hidden; padding: .3em 1em; text-overflow: ellipsis; white-space: nowrap; }
.hand-names:empty { display: none; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .75; transform: scale(.94); } }
.status { background: rgba(255,255,255,.12); border-radius: 999px; top: 2vh; font-size: 1rem; font-size: clamp(0.8rem, 2.5vw, 1.2rem); left: 50%; padding: .4em 1.2em; position: absolute; transform: translateX(-50%); }
/* Top left: the focus layout's clock takes the top right corner. */
.tools { display: flex; left: 12px; position: absolute; top: 12px; z-index: 2; }
.tools > * + * { margin-left: 8px; }
.tool { background: rgba(255,255,255,.12); border: 0; border-radius: 999px; color: inherit; font: inherit; font-size: 0.9rem; min-height: 40px; padding: 0 1em; }
.controls { background: rgba(0,0,0,.6); box-sizing: border-box; color: #fff; display: flex; flex: none; flex-direction: column; padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom)); position: relative; }
.controls > * + *, .panel > * + *, .pin-form > * + * { margin-top: 12px; }
.with-controls .time { font-size: 22vw; font-size: min(24vw, 28vh); }
/* The time of day has more characters ("10:45:00 AM"): smaller, so it still fits */
.time.clock { font-size: 13vw; font-size: min(13vw, 26vh); }
.panel, .pin-form { display: flex; flex-direction: column; }
.row { display: flex; }
.row > * + * { margin-left: 12px; }
.control { background: rgba(255,255,255,.18); border: 0; border-radius: 12px; color: #fff; flex: 1; font: inherit; font-size: 1.25rem; font-size: clamp(1rem, 3.5vw, 1.5rem); font-weight: 600; min-height: 56px; padding: 0 1em; }
.control .icon { fill: currentColor; height: 1.1em; margin-right: .4em; vertical-align: -0.15em; width: 1.1em; }
.control .icon[hidden] { display: none; }
.control.start { background: #1f8f45; }
.control.stop { background: #c62828; }
.control.grow { flex: 3; min-width: 0; }
.control:disabled { opacity: .4; }
.pin-form input { background: #fff; border: 0; border-radius: 12px; box-sizing: border-box; color: #000; flex: 3; font: inherit; font-size: 1.5rem; letter-spacing: .3em; min-height: 56px; min-width: 0; padding: 0 1em; text-align: center; }
.message { color: #ffd60a; font-size: 1rem; text-align: center; }

/* ---- Focus layout: a progress ring, and the raised hands beside it ---- */
.clock { display: none; font-size: clamp(0.8rem, 2.4vh, 1.3rem); font-variant-numeric: tabular-nums; opacity: .7; position: absolute; right: 2.4vw; top: 2.2vh; }
.display.focus .clock { display: block; }
.display.focus .face { padding: 56px 4vw 4vh; }
.dial { display: block; position: relative; }
.dial__inner { align-items: center; display: flex; flex-direction: column; gap: 1.2vh; }
/* The ring fills 92 of the viewBox's 120 units, leaving the glow around it
   room to fade out instead of being cut off square at the SVG's edge. */
.dial__ring { display: none; height: 120%; inset: -10%; position: absolute; transform: rotate(-90deg); width: 120%; }
.dial__track { stroke: rgba(255,255,255,.10); stroke-width: 5; }
.dial__progress { filter: drop-shadow(0 0 1.2vh var(--ring, #2ee6d6)); stroke: var(--ring, #2ee6d6); stroke-linecap: round; stroke-width: 5; transition: stroke 500ms ease, stroke-dasharray 200ms linear; }
.eyebrow { color: var(--ring, #ff453a); display: none; font-size: clamp(0.75rem, 2vh, 1.3rem); font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
.display.focus.is-active .eyebrow { display: block; }
.display.focus.is-active .dial { aspect-ratio: 1; display: grid; place-items: center; width: min(58vh, 100%); }
.display.focus.is-active .dial__ring { display: block; }
.display.focus.is-active .time { font-size: min(11vh, 17vw); }
.display.focus.is-active .caption { display: none; }
.display.focus .label { font-size: clamp(1.1rem, 4.6vh, 2.6rem); font-weight: 800; letter-spacing: 0; opacity: 1; text-transform: none; }
.display.focus.has-hands .face { padding-right: calc(30vw + 6vw); }
.hands { bottom: 3vh; display: flex; flex-direction: column; gap: 1.6vh; overflow: hidden; position: absolute; right: 2.4vw; top: 7vh; width: 30vw; }
.hand-banner { align-items: center; background: rgba(255,214,10,.08); border: 2px solid #ffd60a; border-radius: 14px; box-shadow: 0 0 3vh rgba(255,214,10,.35), inset 0 0 3vh rgba(255,214,10,.12); color: #ffd60a; display: flex; gap: 1.2vw; justify-content: center; padding: 1.6vh 1vw; }
.hand-banner__icon { fill: currentColor; flex: none; height: 4.4vh; width: 4.4vh; }
.hand-banner__text { font-size: clamp(.9rem, 3vh, 2rem); font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.hand-banner.flash { animation: banner-flash .55s steps(1, end) infinite; }
@keyframes banner-flash { 0%, 45% { opacity: 1; } 46%, 100% { opacity: .3; } }
.hands__header { align-items: center; display: flex; gap: .8vw; }
.hands__icon { fill: currentColor; flex: none; height: 3.4vh; width: 3.4vh; }
.hands__title { flex: 1; font-size: clamp(.9rem, 2.6vh, 1.6rem); font-weight: 700; }
.hands__count { align-items: center; background: #ffd60a; border-radius: 999px; color: #101820; display: flex; font-size: clamp(.8rem, 2vh, 1.2rem); font-weight: 800; height: 3.6vh; justify-content: center; min-width: 3.6vh; padding: 0 .5em; }
.hands__list { display: flex; flex-direction: column; gap: 1.2vh; list-style: none; margin: 0; overflow: hidden; padding: 0; }
.hands__row { align-items: center; background: rgba(255,255,255,.06); border: 1px solid transparent; border-radius: 12px; display: flex; gap: 1.2vw; min-height: 8.4vh; padding: 0 1.2vw; }
.hands__row--first { background: rgba(46,230,214,.10); border-color: #2ee6d6; }
.hands__index { border-right: 1px solid rgba(255,255,255,.14); color: #4fd1c5; flex: none; font-size: clamp(.8rem, 2.2vh, 1.3rem); font-weight: 800; letter-spacing: .08em; min-width: 2.4em; padding-right: 1.2vw; text-align: center; }
.hands__name { font-size: clamp(1rem, 3vh, 2rem); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hands__more { color: rgba(255,255,255,.55); font-size: clamp(.8rem, 2.2vh, 1.3rem); font-weight: 700; text-align: center; }
/* The controls take the bottom of the screen: the ring shrinks to fit above them. */
.display.focus.with-controls.is-active .dial { width: min(42vh, 100%); }
.display.focus.with-controls.is-active .time { font-size: min(8.5vh, 13vw); }
@media (orientation: portrait) {
  .display.focus.is-active .dial { width: min(44vh, 100%); }
  .display.focus.has-hands .face { padding: 56px 4vw 48vh; }
  .hands { gap: 1.2vh; bottom: 2vh; height: 44vh; left: 2.4vw; right: 2.4vw; top: auto; width: auto; }
  .hand-banner { padding: 1vh 1vw; }
  .hand-banner__icon { height: 3.6vh; width: 3.6vh; }
  .hands__row { min-height: 5.2vh; }
  .hands__name { font-size: clamp(.9rem, 2.2vh, 1.6rem); }
  .display.focus.with-controls.is-active .dial { width: min(30vh, 100%); }
  .display.focus.with-controls.is-active .time { font-size: min(6.5vh, 10.5vw); }
  .display.focus.has-hands.with-controls .face { padding-bottom: 2vh; }
  .display.with-controls .hands { flex: 0 1 auto; height: auto; max-height: 40%; min-height: 0; position: static; width: 100%; }
}
`;

// Plain script (no build step): the same display rules as the timer window.
const PAGE_JS = String.raw`(function () {
  'use strict';
  var FLASH_MS = 3000;
  var MAX_HANDS = 4;
  var data = null;
  var connected = false;
  var flashUntil = 0;
  var previousNames = null;
  var renderedNamesKey = null;
  var el = {
    caption: document.getElementById('caption'),
    clock: document.getElementById('clock'),
    controls: document.getElementById('controls'),
    controlsButton: document.getElementById('controlsButton'),
    display: document.getElementById('display'),
    eyebrow: document.getElementById('eyebrow'),
    hand: document.getElementById('hand'),
    handBanner: document.getElementById('handBanner'),
    handBannerText: document.getElementById('handBannerText'),
    handCount: document.getElementById('handCount'),
    handList: document.getElementById('handList'),
    handMore: document.getElementById('handMore'),
    handNames: document.getElementById('handNames'),
    hands: document.getElementById('hands'),
    handsTitle: document.getElementById('handsTitle'),
    hideButton: document.getElementById('hideButton'),
    label: document.getElementById('label'),
    message: document.getElementById('message'),
    panel: document.getElementById('panel'),
    pauseButton: document.getElementById('pauseButton'),
    pauseIcon: document.getElementById('pauseIcon'),
    pauseLabel: document.getElementById('pauseLabel'),
    picker: document.getElementById('picker'),
    pinForm: document.getElementById('pinForm'),
    pinInput: document.getElementById('pinInput'),
    pinLabel: document.getElementById('pinLabel'),
    pinSave: document.getElementById('pinSave'),
    resumeIcon: document.getElementById('resumeIcon'),
    ring: document.getElementById('ringProgress'),
    selectButton: document.getElementById('selectButton'),
    selectLabel: document.getElementById('selectLabel'),
    sign: document.getElementById('timeSign'),
    status: document.getElementById('status'),
    stopButton: document.getElementById('stopButton'),
    stopLabel: document.getElementById('stopLabel'),
    time: document.getElementById('time'),
    value: document.getElementById('timeValue')
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
  function formatCountdown(total) {
    var safe = Math.max(0, Math.floor(total));
    return pad(Math.floor(safe / 60)) + ':' + pad(safe % 60);
  }
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
  function partTargetSeconds() {
    return (data && (data.timerCountdownTargetSeconds || data.timerPartTargetSeconds)) || 0;
  }
  function ringColor(overtime, remaining, total) {
    if (overtime) return (data && data.timerOvertimeTextColor) || '#ff453a';
    if (total > 0 && remaining > 0 && remaining <= 60) return '#ffd60a';
    return '#2ee6d6';
  }
  function setClass(node, className) {
    if (node.className !== className) node.className = className;
  }
  function renderHandRows(names) {
    var visible = names.slice(0, MAX_HANDS);
    var html = '';
    for (var i = 0; i < visible.length; i++) {
      html += '<li class="hands__row' + (i === 0 ? ' hands__row--first' : '') + '">' +
        '<span class="hands__index">' + pad(i + 1) + '</span>' +
        '<span class="hands__name"></span></li>';
    }
    el.handList.innerHTML = html;
    var nameEls = el.handList.querySelectorAll('.hands__name');
    for (var j = 0; j < nameEls.length; j++) nameEls[j].textContent = visible[j];
  }
  function renderHands(now, names, handsOn) {
    if (!(data && data.timerRemoteFocusLayout)) {
      el.hands.hidden = true;
      el.hand.hidden = !handsOn;
      el.handNames.textContent = handsOn && names.length ? names.join(' ' + String.fromCharCode(183) + ' ') : '';
      return;
    }

    el.hand.hidden = true;
    var isNewHand = previousNames !== null && names.some(function (name) { return previousNames.indexOf(name) === -1; });
    if (isNewHand) flashUntil = now.getTime() + FLASH_MS;
    previousNames = names.slice();

    el.hands.hidden = !handsOn;
    if (!handsOn) return;

    el.handBannerText.textContent = text.handRaised || 'Hand raised';
    el.handsTitle.textContent = text.raisedHands || 'Raised hands';
    var flashing = names.length === 0 || now.getTime() < flashUntil;
    el.handBanner.hidden = !flashing;
    if (flashing) {
      if (el.handBanner.className.indexOf('flash') === -1) el.handBanner.className = 'hand-banner flash';
    } else if (el.handBanner.className !== 'hand-banner') {
      el.handBanner.className = 'hand-banner';
    }

    var key = names.join('\n');
    if (key !== renderedNamesKey) {
      renderHandRows(names);
      renderedNamesKey = key;
    }
    el.handCount.hidden = names.length === 0;
    el.handCount.textContent = names.length > 0 ? String(names.length) : '';
    el.handMore.hidden = names.length <= MAX_HANDS;
    el.handMore.textContent = names.length > MAX_HANDS ? '+' + (names.length - MAX_HANDS) : '';
  }
  function render() {
    var now = new Date();
    var focus = !!(data && data.timerRemoteFocusLayout);
    var running = !!(data && data.running);
    // First, so the label below can name the part chosen in the picker
    renderControls(running);
    var hidden = timerHidden();
    var withControls = !el.controls.hidden;
    var countdown = running ? null : meetingCountdown(now);
    var active = running || countdown !== null;
    var names = (data && data.handAlertNames) || [];
    var handsOn = !!(data && data.handAlertActive);
    var showHands = focus && (handsOn || names.length > 0);
    var overtime = running && typeof data.time === 'string' && data.time.charAt(0) === '-';
    var target = partTargetSeconds();
    var remaining = target - ((data && data.timerElapsedSeconds) || 0);
    var ringTotal = running ? target : (data && data.timerMeetingCountdownMinutes ? data.timerMeetingCountdownMinutes * 60 : 0);
    var ringRemaining = running ? remaining : (countdown || 0);
    var useOvertime = overtime && data.timerOvertimeIndicator;

    setClass(el.display, 'display' + (focus ? ' focus' : '') + (active && !hidden ? ' is-active' : '') + (showHands ? ' has-hands' : '') + (withControls ? ' with-controls' : ''));
    if (hidden) {
      // This device doesn't want to see the timer: nothing of it, colors included.
      el.display.style.backgroundColor = '#000';
      el.display.style.color = '#fff';
    } else {
      el.display.style.backgroundColor = (useOvertime ? data.timerOvertimeBackgroundColor : data && data.timerBackgroundColor) || '#000';
      el.display.style.color = (useOvertime ? data.timerOvertimeTextColor : data && data.timerTextColor) || '#fff';
    }
    el.display.style.setProperty('--ring', ringColor(overtime, ringRemaining, ringTotal));

    el.clock.hidden = hidden || !(focus && active);
    el.clock.textContent = formatTime(now);

    if (hidden) {
      el.label.textContent = '';
      el.sign.textContent = '';
      el.value.textContent = '';
      el.caption.textContent = '';
      el.eyebrow.textContent = '';
    } else if (running) {
      var shown = data.time || '';
      var sign = '';
      // The focus layout reads overtime as a positive amount of extra time,
      // with the sign in its own (red) span, as in the design.
      if (overtime && focus) {
        sign = '+';
        shown = target > 0 ? formatCountdown(-remaining) : shown.replace('-', '');
      }
      el.label.textContent = data.timerCurrentPartLabel || '';
      el.sign.textContent = sign;
      el.value.textContent = shown;
      el.caption.textContent = data.paused ? (text.paused || '') : (data.mode === 'countup' ? (text.elapsed || '') : (text.remaining || ''));
      el.eyebrow.textContent = data.paused ? (text.paused || '') : overtime ? (text.overtime || '') : (data.mode === 'countup' ? (text.elapsed || '') : (text.remaining || ''));
    } else if (countdown !== null) {
      el.label.textContent = text.meetingStartsIn || '';
      el.sign.textContent = '';
      el.value.textContent = formatCountdown(countdown);
      el.caption.textContent = '';
      el.eyebrow.textContent = '';
    } else {
      // The part Start will time, while the controls are open
      el.label.textContent = el.panel.hidden || el.controls.hidden ? '' : selectedPartName();
      el.sign.textContent = '';
      el.value.textContent = formatTime(now);
      el.caption.textContent = '';
      el.eyebrow.textContent = '';
    }

    var blink = !hidden && running && (data.paused || (overtime && data.timerOvertimeAnimation));
    var showsClock = !hidden && !active;
    setClass(el.time, 'time' + (blink ? ' blink' : '') + (showsClock ? ' clock' : ''));

    var progress = 0;
    if (overtime) progress = 1;
    else if (ringTotal > 0) progress = Math.max(0, Math.min(1, ringRemaining / ringTotal));
    el.ring.style.opacity = !hidden && (ringTotal > 0 || overtime) ? '1' : '0';
    el.ring.style.strokeDasharray = (progress * 100) + ' 100';

    renderHands(now, names, handsOn);

    el.status.hidden = connected;
    el.status.textContent = connected ? '' : (text.reconnecting || 'Reconnecting...');
    el.hideButton.textContent = hidden ? (text.showTimer || '') : (text.hideTimer || '');
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
  function toggleHidden(element, hidden) {
    if (hidden) element.setAttribute('hidden', '');
    else element.removeAttribute('hidden');
  }
  function selectedPartName() {
    var parts = (data && data.timerRemoteParts) || [];
    var value = el.picker.value;
    var part = parts.filter(function (p) { return p.value === value; })[0];
    return part ? part.label || '' : '';
  }
  function renderPicker(parts) {
    var key = parts.map(function (p) { return [p.value, p.label, p.done, p.current].join('|'); }).join('\n');
    if (key === pickerKey) return;
    pickerKey = key;
    // A part started or ended: offer the next one to start (else the running one)
    var next = parts.filter(function (p) { return p.next; })[0] || parts.filter(function (p) { return p.current; })[0];
    var chosen = next ? next.value : el.picker.value;
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
    var paused = !!(data && data.paused);
    el.pauseLabel.textContent = paused ? (text.resume || '') : (text.pause || '');
    // SVG elements have no hidden property: set the attribute itself
    toggleHidden(el.pauseIcon, paused);
    toggleHidden(el.resumeIcon, !paused);
    el.pauseButton.disabled = !running;
    el.stopLabel.textContent = text.stop || '';
    el.stopButton.disabled = !running;
    el.selectLabel.textContent = text.start || '';
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
    postCommand(JSON.stringify(body), pin, function (status) {
      if (status === 202) { showMessage(''); return; }
      if (status === 401) {
        // Forget the PIN: it was changed in M3, or typed wrong.
        store(PIN_KEY, null);
        pinFormOpen = true;
        showMessage(text.pinWrong);
      } else if (status === 429) {
        showMessage(text.tooManyAttempts);
      } else {
        showMessage(text.sendFailed);
      }
      render();
    }, function () { showMessage(text.sendFailed); });
  }
  // fetch() where there is one; older iPads (before iOS 10.3) only have XHR.
  function postCommand(body, pin, onStatus, onError) {
    if (window.fetch) {
      fetch('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timer-Remote-Pin': pin },
        body: body
      }).then(function (response) { onStatus(response.status); }).catch(onError);
      return;
    }
    var request = new XMLHttpRequest();
    request.open('POST', '/command');
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('X-Timer-Remote-Pin', pin);
    request.onload = function () { onStatus(request.status); };
    request.onerror = onError;
    request.send(body);
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

  // Keep the lectern's screen awake while the page is open. Browsers only
  // expose the Wake Lock API to secure pages, and the tablet opens this page
  // over plain HTTP on the LAN; there, a silent looping video holds the screen
  // on, the technique browsers have long used for exactly this.
  var awakeLock = null;
  var awakeVideo = document.getElementById('awake');
  var awakeVideoStarted = false;

  function playAwakeVideo() {
    if (!awakeVideo || !awakeVideoStarted || !awakeVideo.paused) return;
    var playing = awakeVideo.play();
    if (playing && playing.catch) playing.catch(function () {});
  }

  function startAwakeVideo() {
    if (!awakeVideo || awakeVideoStarted) return;
    awakeVideoStarted = true;
    awakeVideo.src = '/awake.mp4';
    playAwakeVideo();
  }

  function keepAwake() {
    if (document.visibilityState !== 'visible') return;
    if (!navigator.wakeLock) {
      startAwakeVideo();
      return;
    }
    if (awakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      awakeLock = lock;
      lock.addEventListener('release', function () {
        if (awakeLock === lock) awakeLock = null;
      });
    }).catch(function () {
      startAwakeVideo();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    keepAwake();
    playAwakeVideo();
  });
  document.addEventListener('pointerdown', playAwakeVideo, { passive: true });
  keepAwake();
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
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  if (url === '/awake.mp4') {
    res
      .writeHead(200, {
        ...headers,
        'Content-Length': AWAKE_VIDEO.length,
        'Content-Type': 'video/mp4',
      })
      .end(AWAKE_VIDEO);
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
