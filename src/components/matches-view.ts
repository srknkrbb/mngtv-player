// mngtv: Gunun Maclari gorunumu (C asamasi). Sunucunun "GUNUN MACLARI" gruplarindaki
// kanallari (her mac x yayin kanali; kayan 24 saatlik pencere) uc sutunda gosterir:
// CANLI | YAKLASAN (hatirlatici eklenebilir) | BITEN (dar, sade). Saatler cihazin saat
// dilimindedir (uygulamanin EPG saat dilimi ayarindan bagimsiz). Secim = kanali oynat.
import type { Action, Channel, Programme } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { ReminderService } from '../services/reminder-service';
import { channelKey } from '../utils/channel';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { liveBadge } from './live-badge';
import { bellIcon } from './icons';
import { showToast } from './toast';

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
// Sunucu biten mac icin "... (sona erdi)" dolgu programi yazar; bu CANLI degil BITTI'dir.
const ENDED_TITLE = /\(sona erdi\)|\(ended\)|\(bitti\)/i;
const PRE_TITLE = /\(saat \d{1,2}[:.]\d{2}\)\s*$/i;
const LIVE_PREFIX = /^CANLI:\s*/i;
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export function isMatchGroup(group: string): boolean {
  return CONFIG.MNGTV.MATCHES.GROUP_RE.test(group || '');
}

/** Cihazin saat diliminde HH:MM (EPG saat dilimi ayarindan bagimsiz). */
export function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Bir kanalin EPG'sinden macin kendisini (CANLI: ...) ve zamanini cikarir. */
function matchProgramme(list: Programme[], now: number): { programme: Programme | null; start: Date | null; end: Date | null; ended: boolean } {
  const live = list.filter(p => LIVE_PREFIX.test(p.title)).sort((a, b) => a.start.getTime() - b.start.getTime());
  if (live.length) {
    const p = live.find(x => x.stop.getTime() > now) ?? live[live.length - 1];
    return { programme: p, start: p.start, end: p.stop, ended: p.stop.getTime() <= now };
  }
  const current = list.find(p => p.start.getTime() <= now && p.stop.getTime() > now) ?? null;
  if (current && ENDED_TITLE.test(current.title)) return { programme: current, start: null, end: null, ended: true };
  if (current && !PRE_TITLE.test(current.title)) return { programme: current, start: current.start, end: current.stop, ended: false };
  const next = list.filter(p => p.start.getTime() > now && !ENDED_TITLE.test(p.title) && !PRE_TITLE.test(p.title))
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  if (next) return { programme: next, start: next.start, end: next.stop, ended: false };
  return { programme: current, start: null, end: null, ended: false };
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
    const epg = matchProgramme(programmesOf(channel) ?? [], now);
    let { start, end } = epg;
    if (!start && m) {
      // Ad onekindeki saat sunucunun saat dilimindedir (Turkiye, +03:00); mutlak zamana cevrilir.
      const off = CONFIG.MNGTV.MATCHES.NAME_TZ_OFFSET_MIN * 60000;
      const day = new Date(now + off);
      start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]), Number(m[2])) - off);
      // Pencere simdi-6 sa ... +18 sa: biten mac gelecekte olamaz (dunun saati), 6 saatten eski saat yarinin macidir
      if (epg.ended) {
        if (start.getTime() > now) start = new Date(start.getTime() - 86400000);
      } else if (start.getTime() < now - 6 * 3600 * 1000) {
        start = new Date(start.getTime() + 86400000);
      }
      end = new Date(start.getTime() + DEFAULT_DURATION_MS);
    }
    const status: MatchStatus = epg.ended
      ? 'ended'
      : !start || !end
        ? 'upcoming'
        : start.getTime() <= now && end.getTime() > now
          ? 'live'
          : start.getTime() > now ? 'upcoming' : 'ended';
    rows.push({ channel, index, title, start, end, status, programme: epg.programme, world: /DUNYA|WORLD/i.test(channel.group) });
  });
  const order: Record<MatchStatus, number> = { live: 0, upcoming: 1, ended: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status]
    || (a.status === 'ended'
      ? (b.end?.getTime() ?? 0) - (a.end?.getTime() ?? 0)          // bitenler: en son biten ustte
      : (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
    || Number(a.world) - Number(b.world)
    || a.index - b.index);
  return rows;
}

export class MatchesView {
  private nav: SpatialNav;
  readonly focusScope: FocusScope;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private endedOpen = false;   // Bitenler sutunu varsayilan kapali; dugmeyle acilir

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
    this.endedOpen = false;
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
            <div class="matches-columns ${this.endedOpen ? 'ended-open' : ''}">
              ${this.column('live', t('matches.now'), live, t('matches.noLive'), now)}
              ${this.column('upcoming', t('matches.upcoming'), upcoming, t('matches.noUpcoming'), now)}
              ${this.endedOpen
                ? this.column('ended', t('matches.ended'), ended, t('matches.noEnded'), now, true)
                : html`
                  <section class="matches-column matches-column-ended matches-column-collapsed" data-status="ended">
                    <button class="matches-toggle" data-focusable data-key="ended-toggle" data-match-action="toggle-ended">
                      <strong>${t('matches.ended')}</strong><span>${ended.length}</span>
                    </button>
                  </section>`}
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

  private column(status: MatchStatus, label: string, rows: MatchRow[], emptyText: string, now: number, closable = false) {
    return html`
      <section class="matches-column matches-column-${status}" data-status="${status}">
        ${closable
          ? html`<button class="matches-toggle matches-section-heading" data-focusable data-key="ended-toggle" data-match-action="toggle-ended">
                   <strong>${label}</strong><span>${rows.length}</span><em>${t('common.close')}</em>
                 </button>`
          : html`<div class="matches-section-heading">
                   <strong>${label}</strong>
                   <span>${rows.length}</span>
                 </div>`}
        <div class="matches-rows">
          ${rows.length ? rows.map(row => this.row(row, now)) : html`<p class="matches-column-empty">${emptyText}</p>`}
        </div>
      </section>
    `;
  }

  private row(row: MatchRow, now: number) {
    const time = row.start ? localTime(row.start) : '--:--';
    const endTime = row.end ? localTime(row.end) : '';
    const today = new Date(now);
    const dayLabel = row.start && !sameLocalDay(row.start, today)
      ? (row.start.getTime() > now ? t('common.tomorrow') : t('matches.yesterday'))
      : '';
    const key = `ch:${row.index}`;
    const reminder = row.status === 'upcoming' && row.start && row.end
      ? ReminderService.has(channelKey(row.channel), row.start.getTime())
      : null;
    return html`
      <div class="matches-row matches-row-${row.status}" data-row-key="${key}">
        <button class="matches-main" data-focusable data-key="${key}" data-match-index="${row.index}" data-match-action="play">
          <time class="matches-time">${time}${dayLabel ? html`<small>${dayLabel}</small>` : ''}</time>
          <div class="matches-details">
            <div class="matches-title">${row.title}</div>
            <div class="matches-meta">
              ${row.status !== 'ended' && endTime ? html`<span class="matches-end">${t('matches.until', { time: endTime })}</span>` : ''}
              ${row.world ? html`<span class="matches-world">${t('matches.world')}</span>` : ''}
            </div>
          </div>
          <div class="matches-status">
            ${row.status === 'live'
              ? liveBadge('matches-live')
              : row.status === 'ended'
                ? html`<span class="matches-badge matches-badge-ended">${t('matches.endedBadge')}</span>`
                : ''}
          </div>
        </button>
        ${reminder !== null
          ? html`<button class="matches-bell ${reminder ? 'set' : ''}" data-focusable data-key="bell:${row.index}"
                         data-match-index="${row.index}" data-match-action="reminder"
                         title="${t('matches.reminder')}">${raw(bellIcon(reminder))}</button>`
          : ''}
      </div>
    `;
  }

  private activate(control: HTMLElement): void {
    if (control.dataset.matchAction === 'toggle-ended') {
      this.endedOpen = !this.endedOpen;
      this.render();
      this.nav.focus(this.container.querySelector<HTMLElement>('[data-key="ended-toggle"]'));
      return;
    }
    const index = Number(control.dataset.matchIndex);
    if (!Number.isFinite(index)) return;
    if (control.dataset.matchAction === 'reminder') {
      this.toggleReminder(index);
      return;
    }
    this.onPlay(index);
  }

  private toggleReminder(index: number): void {
    const row = this.rows().find(r => r.index === index);
    if (!row?.start || !row.end) return;
    const key = channelKey(row.channel);
    const startMs = row.start.getTime();
    if (ReminderService.has(key, startMs)) {
      ReminderService.remove(key, startMs);
      showToast(t('epg.reminderRemoved'));
    } else {
      ReminderService.add({
        channelKey: key,
        channelName: row.channel.name,
        playlistIds: row.channel.playlistIds.slice(),
        epgSourceUrl: EpgService.getSourceUrl(row.channel) ?? undefined,
        title: row.programme?.title.replace(LIVE_PREFIX, '') ?? row.title,
        startMs,
        stopMs: row.end.getTime(),
      });
      showToast(t('epg.reminderSet'));
    }
    this.render();
  }

  private focusFirst(): void {
    this.nav.focus(this.container.querySelector<HTMLElement>('.matches-main'));
  }
}
