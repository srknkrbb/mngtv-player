// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Channel, Programme } from '../types';
import { buildMatchRows, isMatchGroup } from './matches-view';

function ch(name: string, group: string): Channel {
  return { id: name, name, logo: '', group, url: '', extras: null, playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0 };
}
function prog(title: string, start: number, stop: number): Programme {
  return { title, start: new Date(start), stop: new Date(stop), description: '', category: '', icon: '' };
}

describe('Gunun Maclari satirlari', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0); // 15:00 Turkiye (+03:00)
  const H = 3600 * 1000;
  const channels = [
    ch('Bein Sport 1', 'TURKIYE SPOR BEIN'),
    ch('(14:00) Angers-Marseille Bein Connect 4', 'TURKIYE GUNUN MACLARI'),
    ch('(19:25) Monza-Cagliari S Sport Plus', 'TURKIYE GUNUN MACLARI'),
    ch('(12:00) Lille-Nice Bein Connect 2', 'TURKIYE GUNUN MACLARI'),
    ch('(16:00) Ajax-PSV ESPN', 'DUNYA GUNUN MACLARI'),
    ch('(15:30) Eski Mac TRT', 'TURKIYE GUNUN MACLARI'),
  ];
  const epg = new Map<string, Programme[]>([
    ['(14:00) Angers-Marseille Bein Connect 4', [prog('CANLI: Angers - Marseille | Bein Connect 4', now - H, now + H)]],
    ['(19:25) Monza-Cagliari S Sport Plus', [prog('Monza - Cagliari | S Sport Plus (saat 19:25)', now - 2 * H, now + 4.4 * H), prog('CANLI: Monza - Cagliari | S Sport Plus', now + 4.4 * H, now + 6.4 * H)]],
    ['(12:00) Lille-Nice Bein Connect 2', [prog('Lille - Nice (sona erdi)', now - 3 * H, now + 16 * H)]],
  ]);

  it('grup disi kanallar atlanir, durum EPG ya da ad onekinden cikar, siralama canli > yaklasan > biten', () => {
    const rows = buildMatchRows(channels, c => epg.get(c.name) ?? null, now);
    expect(rows.map(r => [r.title, r.status])).toEqual([
      ['Angers-Marseille Bein Connect 4', 'live'],
      ['Eski Mac TRT', 'upcoming'],       // EPG yok: (15:30) ad onekinden, 15:00'te yaklasan
      ['Ajax-PSV ESPN', 'upcoming'],      // EPG yok: (16:00) + 2 sa varsayimi
      ['Monza-Cagliari S Sport Plus', 'upcoming'],
      ['Lille-Nice Bein Connect 2', 'ended'],
    ]);
    expect(rows[0].programme?.title).toBe('CANLI: Angers - Marseille | Bein Connect 4');
    expect(rows[0].index).toBe(1);
    expect(rows.find(r => r.title.startsWith('Ajax'))?.world).toBe(true);
  });

  it('ayni mac TR ve DUNYA grubunda: tek satir, Turkce yayin kalir, +1 yayin', () => {
    const dup = [
      ch('(14:15) Paris FC-Rennes · Bein Sport 04', 'DUNYA GUNUN MACLARI'),
      ch('(14:15) Paris FC-Rennes Bein Connect 4', 'TURKIYE GUNUN MACLARI'),
    ];
    const e = new Map<string, Programme[]>([
      [dup[0].name, [prog('CANLI: Paris FC - Rennes | Bein Sport 04', now - H, now + H)]],
      [dup[1].name, [prog('CANLI: Paris FC - Rennes | Bein Connect 4', now - H, now + H)]],
    ]);
    const rows = buildMatchRows(dup, c => e.get(c.name) ?? null, now);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Paris FC-Rennes Bein Connect 4');
    expect(rows[0].world).toBe(false);
    expect(rows[0].alts).toBe(1);
  });

  it('grup deseni', () => {
    expect(isMatchGroup('TURKIYE GUNUN MACLARI')).toBe(true);
    expect(isMatchGroup('DUNYA GUNUN MACLARI DIGER')).toBe(false);   // futbol disi: Maclar'da yok
    expect(isMatchGroup('DUNYA GUNUN MACLARI')).toBe(true);
    expect(isMatchGroup('TURKIYE SPOR BEIN')).toBe(false);
  });
});
