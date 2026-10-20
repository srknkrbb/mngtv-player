// mngtv sunucu entegrasyonu (B asamasi).
//  - Surum/ozet: {sunucu}/mngtv/version.json 60 sn'de bir okunur; 'playlist' ya da 'epg'
//    ozeti degisince liste+EPG yenilenir (sabit yenileme araligina gerek kalmaz).
//  - Telemetri: oynatici olaylari (baslama, donma, yeniden yukleme, hata) toplanip
//    {sunucu}/mngtv/telemetry'ye Xtream kimligiyle gonderilir; sunucudaki yayin sagligi
//    bunu ek sinyal olarak kullanir. Yalniz Xtream hesaplari icin calisir; sunucu bu
//    uc noktalari vermiyorsa (404) sessizce kapanir.
import { CONFIG } from '../config';
import { StorageService } from './storage-service';
import { PlaylistService } from './playlist-service';
import { createLogger } from '../utils/logger';
import { normalizeXtreamBaseUrl, xtreamCredentialsFromLiveUrl, type XtreamCredentials } from '../utils/xtream-url';

const log = createLogger('mngtv');

export type MngtvEvent = 'play' | 'startup' | 'stall' | 'reload' | 'exhausted' | 'error' | 'stop' | 'gone';

interface QueuedEvent {
  t: number;
  ev: MngtvEvent;
  ch: string;
  name: string;
  ms?: number;
  detail?: string;
  base: string;      // hangi sunucuya gidecek
  user: string;
  pass: string;
}

interface VersionDoc {
  playlist?: string;
  epg?: string;
  generated?: number;   // epoch saniye
  app?: { version?: string; min?: string };
}

const VERSION_KEY = 'mngtv_version';
const CLIENT = `mngtv/${CONFIG.VERSION}`;

/** Sunucunun /mngtv/scores.json kaydi: "Ev - Deplasman" -> skor. */
export interface MatchScore {
  score: string;              // "2 - 0" (bos: henuz yok)
  status: string;             // "FT", "63'", "Scheduled"
  state: 'pre' | 'in' | 'post' | string;
}

const scoreTable = new Map<string, MatchScore>();

/** Mac anahtari ("A - B") icin skor; yoksa null. */
export function matchScore(key: string): MatchScore | null {
  return scoreTable.get(key) ?? null;
}

export function setScoresForTest(entries: Record<string, MatchScore>): void {
  scoreTable.clear();
  for (const [k, v] of Object.entries(entries)) scoreTable.set(k, v);
}

function enabledXtreamBases(): string[] {
  const out = new Set<string>();
  for (const p of StorageService.getPlaylists()) {
    if (p.source !== 'xtream' || !p.xtream || p.enabled === false) continue;
    try {
      out.add(normalizeXtreamBaseUrl(p.url));
    } catch {
      /* gecersiz url */
    }
  }
  return [...out];
}

export class MngtvSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disabledUntil = new Map<string, number>();
  private inFlight = false;

  constructor(
    private readonly onChanged: () => Promise<void> | void,
    private readonly onScores?: () => void,
  ) {}

  start(): void {
    this.stop();
    if (!CONFIG.MNGTV.SYNC.ENABLED) return;
    this.timer = setInterval(() => void this.poll(), CONFIG.MNGTV.SYNC.POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private stored(): Record<string, { playlist?: string; epg?: string }> {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_PREFIX + VERSION_KEY);
      return raw ? JSON.parse(raw) as Record<string, { playlist?: string; epg?: string }> : {};
    } catch {
      return {};
    }
  }

  private remember(all: Record<string, { playlist?: string; epg?: string }>): void {
    try {
      localStorage.setItem(CONFIG.STORAGE_PREFIX + VERSION_KEY, JSON.stringify(all));
    } catch {
      /* depolama yok: her acilista ilk okuma referans olur */
    }
  }

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      const known = this.stored();
      let changed = false;
      for (const base of enabledXtreamBases()) {
        if ((this.disabledUntil.get(base) ?? 0) > now) continue;
        const doc = await this.fetchVersion(base);
        if (!doc) continue;
        await this.fetchScores(base);
        const prev = known[base];
        known[base] = { playlist: doc.playlist, epg: doc.epg };
        if (prev) {
          if (prev.playlist !== doc.playlist || prev.epg !== doc.epg) {
            log.info('Server list changed; refreshing', 'event=mngtv.version.changed',
              `playlist=${String(prev.playlist)}>${String(doc.playlist)}`, `epg=${String(prev.epg)}>${String(doc.epg)}`);
            changed = true;
          }
        } else {
          // Ilk karsilastirma: onbellekteki liste sunucunun son uretiminden eskiyse yenile
          // (uygulama kapaliyken sunucu degismis olabilir).
          const last = PlaylistService.lastRefreshMs;
          if (doc.generated && last !== null && doc.generated * 1000 > last) {
            log.info('Cached list older than server; refreshing', 'event=mngtv.version.stale');
            changed = true;
          }
        }
      }
      this.remember(known);
      if (changed) await this.onChanged();
    } catch (err) {
      log.warn('Version poll failed', 'event=mngtv.version.failed', err);
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchScores(base: string): Promise<void> {
    try {
      const res = await fetch(`${base}/mngtv/scores.json`, { cache: 'no-store' });
      if (!res.ok) return;
      const doc = await res.json() as { scores?: Record<string, MatchScore> };
      if (!doc?.scores || typeof doc.scores !== 'object') return;
      scoreTable.clear();
      for (const [k, v] of Object.entries(doc.scores)) {
        if (v && typeof v === 'object') scoreTable.set(k, { score: String(v.score ?? ''), status: String(v.status ?? ''), state: String(v.state ?? '') });
      }
      this.onScores?.();
    } catch {
      /* skor yoksa gorunum skorsuz calisir */
    }
  }

  private async fetchVersion(base: string): Promise<VersionDoc | null> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), CONFIG.MNGTV.SYNC.TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${base}/mngtv/version.json`, { cache: 'no-store', signal: controller?.signal });
      if (res.status === 404 || res.status === 444) {
        this.disabledUntil.set(base, Date.now() + CONFIG.MNGTV.SYNC.BACKOFF_MS);
        return null;
      }
      if (!res.ok) return null;
      const doc = await res.json() as VersionDoc;
      return typeof doc === 'object' && doc ? doc : null;
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}

export class MngtvTelemetry {
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private disabledUntil = new Map<string, number>();
  private sending = false;

  start(): void {
    this.stop();
    if (!CONFIG.MNGTV.TELEMETRY.ENABLED) return;
    this.timer = setInterval(() => void this.flush(), CONFIG.MNGTV.TELEMETRY.FLUSH_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Kanal URL'si Xtream canli biciminde degilse (M3U vb.) olay atlanir. */
  record(ev: MngtvEvent, channel: { url: string; name: string } | null, extra: { ms?: number; detail?: string } = {}): void {
    if (!CONFIG.MNGTV.TELEMETRY.ENABLED || !channel) return;
    const parts = xtreamCredentialsFromLiveUrl(channel.url);
    if (!parts) return;
    const c: XtreamCredentials = parts.credentials;
    const base = normalizeXtreamBaseUrl(c.baseUrl);
    if ((this.disabledUntil.get(base) ?? 0) > Date.now()) return;
    this.queue.push({
      t: Date.now(), ev, ch: parts.streamId, name: channel.name, ms: extra.ms, detail: extra.detail,
      base, user: c.username, pass: c.password,
    });
    if (this.queue.length > CONFIG.MNGTV.TELEMETRY.MAX_QUEUE) this.queue.splice(0, this.queue.length - CONFIG.MNGTV.TELEMETRY.MAX_QUEUE);
    if (this.queue.length >= CONFIG.MNGTV.TELEMETRY.BATCH || ev === 'exhausted') void this.flush();
  }

  async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      const batch = this.queue.splice(0, CONFIG.MNGTV.TELEMETRY.BATCH);
      // Ayni sunucu + hesap bir istek
      const groups = new Map<string, QueuedEvent[]>();
      for (const e of batch) {
        const key = `${e.base}|${e.user}`;
        const list = groups.get(key) ?? [];
        list.push(e);
        groups.set(key, list);
      }
      for (const list of groups.values()) {
        const { base, user, pass } = list[0];
        const body = JSON.stringify({
          user, pass, client: CLIENT,
          events: list.map(e => ({ t: e.t, ev: e.ev, ch: e.ch, name: e.name, ms: e.ms ?? 0, detail: e.detail ?? '' })),
        });
        try {
          const res = await fetch(`${base}/mngtv/telemetry`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store',
          });
          if (res.status === 404 || res.status === 444 || res.status === 401) {
            this.disabledUntil.set(base, Date.now() + CONFIG.MNGTV.TELEMETRY.BACKOFF_MS);
            log.warn('Telemetry endpoint unavailable; pausing', 'event=mngtv.telemetry.disabled', `status=${String(res.status)}`);
          }
        } catch (err) {
          log.warn('Telemetry send failed', 'event=mngtv.telemetry.failed', err);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}

export const mngtvTelemetry = new MngtvTelemetry();
