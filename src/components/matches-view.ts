// mngtv: Gunun Maclari gorunumu (C asamasi). Sunucunun "GUNUN MACLARI" gruplarindaki
// kanallari (her mac x yayin kanali) zamana gore listeler; EPG'den CANLI / yaklasan /
// bitti durumunu cikarir. Secim = kanali oynat. Sunucuda grup yoksa bos durum gosterir.
import type { Action, Channel, Programme } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { formatTime } from '../utils/time';
import { t } from '../i18n';
import { liveBadge } from './live-badge';

export type MatchStatus = 'live' | 'upcoming' | 'ended';

export interface MatchRow {
  channel: Channel;
  index: number;        // PlaylistService.channels icindeki sira (oynatma icin)
  title: string;        // "(14:00) " oneki atilmis kanal adi
  start: Date | null;
  end: Date | null;
  status: MatchStatus;
  programme: Programme | null;
  world: boolean;       // DUNYA grubu
}

const TIME_PREFIX = /^\((\d{1,2})[:.](\d{2})\)\s*/;
// Sunucu biten mac icin gun sonuna kadar "... (sona erdi)" dolgu programi yazar; bu CANLI degil BITTI'dir.
const ENDED_TITLE = /\(sona erdi\)|\(ended\)|\(bitti\)/i;
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export function isMatchGroup(group: string): boolean {
  return CONFIG.MNGTV.MATCHES.GROUP_RE.test(group || '');
}

/** Saf: kanal listesi + EPG -> satirlar (zamana gore). Testlenebilir. */
export function buildMatchRows(
  channels: readonly Channel[],
  programmesOf: (channel: Channel) => Programme[] | null,
  now: number,
): MatchRow[] {
  const rows: MatchRow[] = [];
  channels.forEach((channel, index) => {
    if (!isMatchGroup(channel.group)) return;
    const m = TIME_PREFIX.exec(channel.name);
    const title = m ? channel.name.slice(m[0].length) : channel.name;
    let start: Date | null = null;
    let end: Date | null = null;
    let programme: Programme | null = null;
    const list = programmesOf(channel) ?? [];
    // Kanalin suanki ya da bir sonraki programi (mac); gecmis program yalnizca baska yoksa
    const current = list.find(p => p.start.getTime() <= now && p.stop.getTime() > now);
    const next = list.filter(p => p.start.getTime() > now).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
    const last = list.filter(p => p.stop.getTime() <= now).sort((a, b) => b.stop.getTime() - a.stop.getTime())[0];
    programme = current ?? next ?? last ?? null;
    const endedFiller = !!programme && ENDED_TITLE.test(programme.title);
    if (programme && !endedFiller) {
      start = programme.start;
      end = programme.stop;
    } else if (m) {
      // Ad onekindeki saat sunucunun saat dilimindedir (Turkiye, +03:00); mutlak zamana cevrilir,
      // gosterim uygulamanin saat dilimi ayariyla yapilir.
      const off = CONFIG.MNGTV.MATCHES.NAME_TZ_OFFSET_MIN * 60000;
      const day = new Date(now + off);
      start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]), Number(m[2])) - off);
      end = new Date(start.getTime() + DEFAULT_DURATION_MS);
    }
    const status: MatchStatus = endedFiller
      ? 'ended'
      : !start || !end
      ? 'upcoming'
      : start.getTime() <= now && end.getTime() > now
        ? 'live'
        : start.getTime() > now ? 'upcoming' : 'ended';
    rows.push({ channel, index, title, start, end, status, programme, world: /DUNYA|WORLD/i.test(channel.group) });
  });
  const order: Record<MatchStatus, number> = { live: 0, upcoming: 1, ended: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status]
    || (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0)
    || Number(a.world) - Number(b.world)
    || a.index - b.index);
  return rows;
}

export class MatchesView {
  private nav: SpatialNav;
  readonly focusScope: FocusScope;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(
    private container: HTMLElement,
    private onPlay: (index: number) => void,
    private onBack: () => void,
  ) {
    this.focusScope = Focus.register({
      id: 'view.matches',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.container.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    this.nav = new SpatialNav(container, undefined, { scope: this.focusScope });
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
    });
  }

  open(): void {
    this.active = true;
    this.render();
    this.focusFirst();
    if (this.timer === null) this.timer = setInterval(() => { if (this.active) this.render(); }, CONFIG.MNGTV.MATCHES.REFRESH_MS);
  }

  deactivate(): void {
    this.active = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Liste/EPG yenilenince (gorunum acikken) yeniden ciz. */
  refresh(): void {
    if (this.active) this.render();
  }

  handleAction(action: Action): boolean {
    if (action === 'back') {
      this.onBack();
      return true;
    }
    if (action === 'select' && this.nav.focused) {
      this.activate(this.nav.focused);
      return true;
    }
    if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      return this.nav.move(action);
    }
    return false;
  }

  rows(now = Date.now()): MatchRow[] {
    return buildMatchRows(
      PlaylistService.channels,
      (channel) => {
        const id = EpgService.findChannelId(channel);
        return id ? EpgService.programmes[id] ?? null : null;
      },
      now,
    );
  }

  private render(): void {
    const focusedKey = this.nav.focused?.dataset.key ?? null;
    const now = Date.now();
    const rows = this.rows(now);
    const live = rows.filter(r => r.status === 'live');
    const upcoming = rows.filter(r => r.status === 'upcoming');
    const ended = rows.filter(r => r.status === 'ended');
    morph(this.container, html`
      <div class="matches-view">
        <header class="matches-hero">
          <h1>${t('matches.title')}</h1>
          <p>${rows.length ? t('matches.summary', { count: rows.length, live: live.length }) : ''}</p>
        </header>
        ${rows.length
          ? html`
            <div class="matches-list">
              ${this.section('matches.now', live)}
              ${this.section('matches.upcoming', upcoming)}
              ${this.section('matches.ended', ended)}
            </div>`
          : html`
            <div class="matches-empty">
              <p>${t('matches.empty')}</p>
              <p class="matches-empty-hint">${t('matches.emptyHint')}</p>
            </div>`}
      </div>
    `);
    if (focusedKey) {
      const again = this.container.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`);
      if (again && this.nav.focused !== again) this.nav.focus(again);
    }
  }

  private section(labelKey: 'matches.now' | 'matches.upcoming' | 'matches.ended', rows: MatchRow[]) {
    if (!rows.length) return '';
    return html`
      <section class="matches-section" data-status="${rows[0].status}">
        <div class="matches-section-heading">
          <strong>${t(labelKey)}</strong>
          <span>${rows.length}</span>
          <div class="matches-section-line"></div>
        </div>
        <div class="matches-rows">
          ${rows.map(row => this.row(row))}
        </div>
      </section>
    `;
  }

  private row(row: MatchRow) {
    const time = row.start ? formatTime(row.start) : '--:--';
    const endTime = row.end ? formatTime(row.end) : '';
    return html`
      <button class="matches-row matches-row-${row.status}" data-focusable data-key="ch:${row.index}"
              data-match-index="${row.index}">
        <time class="matches-time">${time}</time>
        <div class="matches-details">
          <div class="matches-title">${row.title}</div>
          <div class="matches-meta">
            ${row.programme ? html`<span>${row.programme.title.replace(ENDED_TITLE, '').trim()}</span>` : ''}
            ${endTime && row.status !== 'ended' ? html`<span class="matches-end">${t('matches.until', { time: endTime })}</span>` : ''}
            ${row.world ? html`<span class="matches-world">${t('matches.world')}</span>` : ''}
          </div>
        </div>
        <div class="matches-status">
          ${row.status === 'live'
            ? liveBadge('matches-live')
            : row.status === 'ended'
              ? html`<span class="matches-badge matches-badge-ended">${t('matches.endedBadge')}</span>`
              : html`<span class="matches-badge matches-badge-upcoming">${t('matches.upcomingBadge')}</span>`}
        </div>
      </button>
    `;
  }

  private activate(control: HTMLElement): void {
    const index = Number(control.dataset.matchIndex);
    if (Number.isFinite(index)) this.onPlay(index);
  }

  private focusFirst(): void {
    this.nav.focus(this.container.querySelector<HTMLElement>('.matches-row'));
  }
}
