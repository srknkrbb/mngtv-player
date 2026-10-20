// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./playlist-service', () => ({
  PlaylistService: { lastRefreshMs: 1_000_000 },
}));

vi.mock('./storage-service', () => ({
  StorageService: {
    getPlaylists: vi.fn(() => [
      { id: 'a', name: 'tv1', url: 'https://tvpool.example:8444', source: 'xtream', xtream: { username: 'tv1', password: 'pw' } },
      { id: 'b', name: 'm3u', url: 'https://other.example/list.m3u', source: 'url' },
    ]),
  },
}));

import { MngtvSync, MngtvTelemetry } from './mngtv';

function response(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

describe('mngtv sync', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ilk okuma referans olur; ozet degisince yenileme tetiklenir', async () => {
    const onChanged = vi.fn(async () => undefined);
    const sync = new MngtvSync(onChanged);
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'aaa', epg: 'e1' }));
    await sync.poll();
    expect(fetchMock).toHaveBeenCalledWith('https://tvpool.example:8444/mngtv/version.json', expect.objectContaining({ cache: 'no-store' }));
    expect(onChanged).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'aaa', epg: 'e1' }));
    await sync.poll();
    expect(onChanged).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'bbb', epg: 'e1' }));
    await sync.poll();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // yeniden acilista localStorage referansi korunur
    const again = new MngtvSync(onChanged);
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'bbb', epg: 'e2' }));
    await again.poll();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('ilk karsilastirmada onbellek sunucudan eskiyse yeniler', async () => {
    const onChanged = vi.fn(async () => undefined);
    const sync = new MngtvSync(onChanged);
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'aaa', epg: 'e1', generated: 2_000 }));
    await sync.poll();
    expect(onChanged).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(response(200, { playlist: 'aaa', epg: 'e1', generated: 3_000 }));
    await sync.poll();
    expect(onChanged).toHaveBeenCalledTimes(1); // ozet ayni: uretim zamani tek basina yeniletmez
  });

  it('404 donen sunucu bir sure sorulmaz; yalniz Xtream hesaplari sorulur', async () => {
    const sync = new MngtvSync(() => undefined);
    fetchMock.mockResolvedValueOnce(response(404, {}));
    await sync.poll();
    await sync.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://tvpool.example:8444/'))).toBe(true);
  });
});

describe('mngtv telemetry', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('olaylari hesaba gore gruplar, Xtream disi kanali atlar', async () => {
    const tel = new MngtvTelemetry();
    const ch = { url: 'https://tvpool.example:8444/live/tv1/pw/101.ts', name: 'Bein Sport 1' };
    tel.record('play', ch);
    tel.record('stall', ch, { ms: 20000, detail: 'stall 1/3' });
    tel.record('error', { url: 'http://m3u.example/x.m3u8', name: 'M3U' });
    fetchMock.mockResolvedValueOnce(response(200, { ok: true }));
    await tel.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tvpool.example:8444/mngtv/telemetry');
    const body = JSON.parse(String(init.body)) as { user: string; pass: string; client: string; events: Array<{ ev: string; ch: string; ms: number }> };
    expect(body.user).toBe('tv1');
    expect(body.pass).toBe('pw');
    expect(body.client).toMatch(/^mngtv\//);
    expect(body.events.map(e => e.ev)).toEqual(['play', 'stall']);
    expect(body.events[1].ch).toBe('101');
    expect(body.events[1].ms).toBe(20000);
  });

  it('401/404 sonrasi o sunucuya gondermez', async () => {
    const tel = new MngtvTelemetry();
    const ch = { url: 'https://tvpool.example:8444/live/tv1/pw/101.ts', name: 'x' };
    tel.record('play', ch);
    fetchMock.mockResolvedValueOnce(response(404, {}));
    await tel.flush();
    tel.record('play', ch);
    await tel.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
