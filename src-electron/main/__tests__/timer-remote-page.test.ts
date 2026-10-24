// @vitest-environment happy-dom
import type { TimerData, TimerRemotePart } from 'src/types';

import { getHttpServer } from 'app/test/vitest/mocks/http';
import { http, passthrough } from 'msw';
import { createServer, get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src-electron/main/utils', () => ({ captureElectronError: vi.fn() }));

// Runs the page the server really serves (its markup and script) in a DOM,
// with a fake event stream and fetch, and drives it like a person would.

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {
    this.onmessage = null;
  }
  emit(data: Partial<TimerData>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const parts: TimerRemotePart[] = [
  {
    current: false,
    done: true,
    label: 'Treasures',
    minutes: 10,
    next: false,
    value: 'treasures',
  },
  {
    current: false,
    done: false,
    label: 'Gems',
    minutes: 10,
    next: true,
    value: 'gems',
  },
];

const text = {
  controls: 'Controls',
  hideTimer: 'Hide timer',
  minutes: '{minutes} min.',
  pause: 'Pause',
  pinWrong: 'Wrong PIN',
  resume: 'Resume',
  save: 'Save',
  showTimer: 'Show timer',
  start: 'Start',
  startNext: 'Start next part',
  stop: 'Stop',
};

// happy-dom's own fetch enforces same-origin rules: load the page with http.
const fetchText = (url: string) =>
  new Promise<string>((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

const byId = (id: string) => document.getElementById(id) as HTMLElement;

const loadPage = async () => {
  const remote = await import('../timer-remote');
  const port = await freePort();
  remote.setTimerRemoteText(text);
  await remote.startTimerRemote(port);
  const page = await fetchText(`http://127.0.0.1:${port}/`);
  const script = await fetchText(`http://127.0.0.1:${port}/app.js`);
  document.documentElement.setAttribute(
    'data-text',
    /data-text="([^"]*)"/.exec(page)?.[1]?.replaceAll('&quot;', '"') ?? '{}',
  );
  document.body.innerHTML = /<body>([\s\S]*?)<script/.exec(page)?.[1] ?? '';
  new Function(script)();
  return remote;
};

beforeEach(() => {
  getHttpServer()?.use(
    http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
  );
  localStorage.clear();
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(async () => {
  const { __testables, stopTimerRemote } = await import('../timer-remote');
  stopTimerRemote();
  __testables.reset();
  vi.unstubAllGlobals();
});

describe('timer remote page', () => {
  it('shows no controls unless the server allows them', async () => {
    await loadPage();
    FakeEventSource.last?.emit({
      running: false,
      timerRemoteControlAllowed: false,
      timerRemoteParts: parts,
    });
    await vi.waitFor(() =>
      expect(byId('hideButton').textContent).toBe('Hide timer'),
    );
    expect(byId('controls').hidden).toBe(true);
    expect(byId('controlsButton').hidden).toBe(true);
  });

  it('asks for the PIN once, then shows the controls', async () => {
    await loadPage();
    FakeEventSource.last?.emit({
      running: false,
      timerRemoteControlAllowed: true,
      timerRemoteParts: parts,
    });
    await vi.waitFor(() => expect(byId('controlsButton').hidden).toBe(false));
    expect(byId('panel').hidden).toBe(true);

    byId('controlsButton').click();
    expect(byId('pinForm').hidden).toBe(false);
    (byId('pinInput') as HTMLInputElement).value = '123456';
    byId('pinForm').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(localStorage.getItem('m3TimerRemotePin')).toBe('123456');
    expect(byId('panel').hidden).toBe(false);
    expect(byId('partInfo').textContent).toBe('Gems · 10 min.');
    expect((byId('pauseButton') as HTMLButtonElement).disabled).toBe(true);
    expect(byId('picker').querySelectorAll('option')).toHaveLength(2);
    expect(byId('picker').querySelectorAll('option')[0]?.textContent).toContain(
      '✓',
    );
  });

  it('sends each command with the PIN, and forgets a refused PIN', async () => {
    localStorage.setItem('m3TimerRemotePin', '123456');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ status: 202 } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await loadPage();
    const real = fetchMock.mock.calls.length;
    FakeEventSource.last?.emit({
      paused: false,
      running: true,
      time: '01:00',
      timerCurrentPartLabel: 'Gems',
      timerRemoteControlAllowed: true,
      timerRemoteParts: [
        {
          current: false,
          done: false,
          label: 'Treasures',
          minutes: 10,
          next: true,
          value: 'treasures',
        },
        {
          current: true,
          done: false,
          label: 'Gems',
          minutes: 10,
          next: false,
          value: 'gems',
        },
      ],
    });

    byId('nextButton').click();
    byId('pauseButton').click();
    byId('stopButton').click();
    (byId('picker') as HTMLSelectElement).value = 'gems';
    byId('selectButton').click();

    const sent = fetchMock.mock.calls.slice(real);
    expect(sent.map(([url]) => url)).toEqual([
      '/command',
      '/command',
      '/command',
      '/command',
    ]);
    expect(sent.map(([, init]) => JSON.parse(init.body))).toEqual([
      { action: 'start-next' },
      { action: 'pause' },
      { action: 'stop' },
      { action: 'select', part: 'gems' },
    ]);
    expect(sent[0]?.[1].headers['X-Timer-Remote-Pin']).toBe('123456');
    expect(sent[0]?.[1].method).toBe('POST');

    fetchMock.mockResolvedValue({ status: 401 } as unknown as Response);
    byId('stopButton').click();
    await vi.waitFor(() =>
      expect(localStorage.getItem('m3TimerRemotePin')).toBeNull(),
    );
    expect(byId('message').textContent).toBe('Wrong PIN');
    expect(byId('pinForm').hidden).toBe(false);
  });

  it('blanks the time on this device but keeps the hand alert', async () => {
    await loadPage();
    FakeEventSource.last?.emit({
      handAlertActive: true,
      handAlertNames: ['Ana'],
      paused: false,
      running: true,
      time: '04:59',
      timerCurrentPartLabel: 'Gems',
    });
    await vi.waitFor(() => expect(byId('time').textContent).toBe('04:59'));

    byId('hideButton').click();
    expect(localStorage.getItem('m3TimerRemoteHideTimer')).toBe('1');
    expect(byId('time').textContent).toBe('');
    expect(byId('label').textContent).toBe('');
    expect(byId('hideButton').textContent).toBe('Show timer');
    expect(byId('hand').hidden).toBe(false);
    expect(byId('handNames').textContent).toBe('Ana');

    byId('hideButton').click();
    expect(localStorage.getItem('m3TimerRemoteHideTimer')).toBeNull();
    expect(byId('time').textContent).toBe('04:59');
  });
});
