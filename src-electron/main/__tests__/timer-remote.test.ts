import { getHttpServer } from 'app/test/vitest/mocks/http';
import { http, passthrough } from 'msw';
import { createServer, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('src-electron/main/utils', () => ({ captureElectronError: vi.fn() }));

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

const get = async (port: number, path: string) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { body: await response.text(), response };
};

/** Reads server-sent events until one carries JSON data. */
const readFirstEvent = async (port: number, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No body');
    let buffer = '';
    const decoder = new TextDecoder();
    while (!buffer.includes('data: ')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer.split('\n').find((l) => l.startsWith('data: '));
    return line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};

/** A request with full control over its headers (fetch refuses some). */
const send = (
  port: number,
  options: { body?: string; headers?: Record<string, string>; method?: string },
  path = '/command',
) =>
  new Promise<{
    body: string;
    headers: Record<string, unknown>;
    status: number;
  }>((resolve, reject) => {
    const req = request(
      {
        headers: options.headers,
        host: '127.0.0.1',
        method: options.method ?? 'POST',
        path,
        port,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () =>
          resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });

const PIN = '123456';
const jsonHeaders = (pin: null | string = PIN) => ({
  'Content-Type': 'application/json',
  ...(pin === null ? {} : { 'X-Timer-Remote-Pin': pin }),
});

// The tests talk to the real local server: let MSW pass those requests on.
beforeEach(() => {
  getHttpServer()?.use(
    http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
  );
});

afterEach(async () => {
  const { __testables, stopTimerRemote } = await import('../timer-remote');
  stopTimerRemote();
  __testables.reset();
});

describe('timer remote', () => {
  it('refuses ports outside the unprivileged range', async () => {
    const { isValidTimerRemotePort, startTimerRemote } =
      await import('../timer-remote');
    expect(isValidTimerRemotePort(80)).toBe(false);
    expect(isValidTimerRemotePort(8787)).toBe(true);
    expect(isValidTimerRemotePort('8787')).toBe(false);
    expect(isValidTimerRemotePort(70_000)).toBe(false);
    expect(await startTimerRemote(80)).toEqual({
      error: 'invalid-port',
      running: false,
      urls: [],
    });
  });

  it('serves the page, its assets and a live event stream', async () => {
    const { setTimerRemoteText, startTimerRemote, updateTimerRemote } =
      await import('../timer-remote');
    const port = await freePort();
    setTimerRemoteText({
      lang: 'fr',
      meetingStartsIn: 'La réunion commence dans',
    });

    const status = await startTimerRemote(port);
    expect(status.running).toBe(true);

    const page = await get(port, '/');
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get('content-type')).toContain('text/html');
    expect(page.response.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(page.body).toContain('lang="fr"');
    expect(page.body).toContain('La réunion commence dans');
    expect(page.body).toContain('/app.js');

    expect((await get(port, '/app.js')).response.status).toBe(200);
    expect((await get(port, '/app.css')).response.status).toBe(200);
    expect((await get(port, '/nope')).response.status).toBe(404);

    updateTimerRemote({
      mode: 'countdown',
      paused: false,
      running: true,
      time: '04:59',
      timerCurrentPartLabel: 'Public Talk',
    });
    // A page connecting later still gets the latest state straight away.
    const event = await readFirstEvent(port);
    expect(event).toMatchObject({ running: true, time: '04:59' });
  });

  it('keeps hidden elements hidden, the hand alert included', async () => {
    const { startTimerRemote } = await import('../timer-remote');
    const port = await freePort();
    await startTimerRemote(port);

    const page = await get(port, '/');
    expect(page.body).toMatch(/<div id="hand" class="hand" hidden>/);
    // .hand sets display: flex, which beats the browser's own [hidden] rule.
    const css = (await get(port, '/app.css')).body;
    expect(css).toMatch(/\.hand \{[^}]*display: flex/);
    expect(css).toMatch(/\[hidden\] \{ display: none !important; \}/);
  });

  it('reports a port already in use', async () => {
    const { startTimerRemote } = await import('../timer-remote');
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(port, resolve);
    });
    try {
      expect(await startTimerRemote(port)).toEqual({
        error: 'port-in-use',
        running: false,
        urls: [],
      });
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  it('stops serving and forgets the last state', async () => {
    const { startTimerRemote, stopTimerRemote, updateTimerRemote } =
      await import('../timer-remote');
    const port = await freePort();
    await startTimerRemote(port);
    updateTimerRemote({
      mode: 'countup',
      paused: false,
      running: false,
      time: '',
    });
    stopTimerRemote();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

describe('timer remote control', () => {
  const start = async (allowControl = true) => {
    const remote = await import('../timer-remote');
    const sink = vi.fn();
    remote.setTimerRemoteCommandSink(sink);
    const port = await freePort();
    await remote.startTimerRemote(port);
    remote.setTimerRemoteConfig({ allowControl, pin: PIN });
    return { port, remote, sink };
  };
  const command = (action: string, part?: string) =>
    JSON.stringify(part === undefined ? { action } : { action, part });

  it('refuses commands while control is off', async () => {
    const { port, sink } = await start(false);
    const result = await send(port, {
      body: command('stop'),
      headers: jsonHeaders(),
    });
    expect(result.status).toBe(403);
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps control off for a missing or malformed PIN', async () => {
    const { port, remote, sink } = await start();
    for (const pin of ['', '12345', '1234567', 'abcdef', 123_456, undefined]) {
      remote.setTimerRemoteConfig({ allowControl: true, pin });
      const result = await send(port, {
        body: command('stop'),
        headers: jsonHeaders(String(pin ?? '')),
      });
      expect(result.status).toBe(403);
    }
    remote.setTimerRemoteConfig({ allowControl: 'yes', pin: PIN });
    expect(
      (await send(port, { body: command('stop'), headers: jsonHeaders() }))
        .status,
    ).toBe(403);
    expect(sink).not.toHaveBeenCalled();
  });

  it('turns a good command into an IPC message', async () => {
    const { port, sink } = await start();
    const result = await send(port, {
      body: command('select', 'ayfm-2'),
      headers: jsonHeaders(),
    });
    expect(result.status).toBe(202);
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      action: 'select',
      part: 'ayfm-2',
    });

    for (const action of ['start-next', 'pause', 'resume', 'stop']) {
      expect(
        (await send(port, { body: command(action), headers: jsonHeaders() }))
          .status,
      ).toBe(202);
    }
    expect(sink).toHaveBeenCalledTimes(5);
  });

  it('refuses the wrong PIN and says nothing about the right one', async () => {
    const { port, sink } = await start();
    for (const pin of ['654321', '12345', PIN + '0', null]) {
      const result = await send(port, {
        body: command('stop'),
        headers: jsonHeaders(pin),
      });
      expect(result.status).toBe(401);
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it('answers 429 after too many wrong PINs, even to the right one', async () => {
    const { port, sink } = await start();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await send(port, {
            body: command('stop'),
            headers: jsonHeaders('000000'),
          })
        ).status,
      ).toBe(401);
    }
    const limited = await send(port, {
      body: command('stop'),
      headers: jsonHeaders(),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(sink).not.toHaveBeenCalled();
  });

  it('refuses a page from another origin', async () => {
    const { port, sink } = await start();
    for (const origin of ['http://evil.example', 'null', 'not a url']) {
      const result = await send(port, {
        body: command('stop'),
        headers: { ...jsonHeaders(), Origin: origin },
      });
      expect(result.status).toBe(403);
    }
    const same = await send(port, {
      body: command('stop'),
      headers: { ...jsonHeaders(), Origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(202);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that is not JSON, or too large', async () => {
    const { port, sink } = await start();
    expect(
      (
        await send(port, {
          body: command('stop'),
          headers: { ...jsonHeaders(), 'Content-Type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await send(port, {
          body: JSON.stringify({ action: 'stop', pad: 'x'.repeat(2000) }),
          headers: jsonHeaders(),
        })
      ).status,
    ).toBe(413);
    expect(sink).not.toHaveBeenCalled();
  });

  it('refuses unknown actions and malformed parts', async () => {
    const { port, sink } = await start();
    const bodies = [
      command('reboot'),
      command('select', 'Ayfm 2'),
      command('select', '../../etc'),
      command('select', 'a'.repeat(41)),
      JSON.stringify({ action: 'select', part: 5 }),
      JSON.stringify(['stop']),
      'not json',
      '',
    ];
    for (const body of bodies) {
      const result = await send(port, { body, headers: jsonHeaders() });
      expect(result.status).toBe(400);
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it('never answers with CORS headers, and only POSTs to /command', async () => {
    const { port } = await start();
    const preflight = await send(
      port,
      {
        headers: {
          'Access-Control-Request-Headers': 'x-timer-remote-pin',
          'Access-Control-Request-Method': 'POST',
          Origin: 'http://evil.example',
        },
        method: 'OPTIONS',
      },
      '/command',
    );
    expect(preflight.status).toBe(405);
    expect(Object.keys(preflight.headers).join()).not.toMatch(
      /access-control/i,
    );

    const wrongPath = await send(
      port,
      { body: command('stop'), headers: jsonHeaders() },
      '/events',
    );
    expect(wrongPath.status).toBe(405);
    expect((await send(port, { method: 'GET' }, '/command')).status).toBe(404);
  });

  it('tells pages whether they may control, and the renderer cannot override it', async () => {
    const { port, remote } = await start(false);
    remote.updateTimerRemote({
      mode: 'countdown',
      paused: false,
      running: false,
      time: '',
      timerRemoteControlAllowed: true,
    });
    expect(await readFirstEvent(port)).toMatchObject({
      timerRemoteControlAllowed: false,
    });

    remote.setTimerRemoteConfig({ allowControl: true, pin: PIN });
    expect(await readFirstEvent(port)).toMatchObject({
      timerRemoteControlAllowed: true,
    });
    expect(JSON.stringify(await readFirstEvent(port))).not.toContain(PIN);
  });

  it('takes control away when the remote is stopped', async () => {
    const { port, remote, sink } = await start();
    remote.stopTimerRemote();
    await remote.startTimerRemote(port);
    const result = await send(port, {
      body: command('stop'),
      headers: jsonHeaders(),
    });
    expect(result.status).toBe(403);
    expect(sink).not.toHaveBeenCalled();
  });

  it('keeps control through a restart on a new port', async () => {
    const { remote, sink } = await start();
    const port = await freePort();
    await remote.startTimerRemote(port);
    const result = await send(port, {
      body: command('stop'),
      headers: jsonHeaders(),
    });
    expect(result.status).toBe(202);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('still serves the page and the stream as before', async () => {
    const { port } = await start();
    const page = await get(port, '/');
    expect(page.response.status).toBe(200);
    expect(page.body).toContain('id="controls"');
    expect(page.response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    const script = await get(port, '/app.js');
    expect(script.response.status).toBe(200);
    // The page's script is plain text to the server: make sure it parses.
    expect(() => new Function(script.body)).not.toThrow();
  });
});
