// mngtv: sunucu grup adlarinin kenar cubugunda gosterimi.
//   TURKIYE SPOR BEIN        -> [TURKIYE SPOR]  TR | Bein
//   EU | GERMANY SPORTS      -> [DUNYA SPOR]    DE | Germany
//   TURKIYE TV               -> [TV KANALLARI]  TR | TV
//   AR | ARAB DIGER          -> [TV KANALLARI]  AR | Arab
//   GUNUN MACLARI, ayraclar  -> gizli (Maclar sekmesi var)
// Grup kimligi (source:<ad>) degismez; yalniz etiket ve bolum eklenir.
import { CONFIG } from '../config';

export type GroupSection = 'tr-sport' | 'world-sport' | 'tv';

export interface GroupPresentation {
  section: GroupSection;
  label: string;
}

const SECTION_ORDER: Record<GroupSection, number> = { 'tr-sport': 0, 'world-sport': 1, tv: 2 };

const COUNTRY_CODES: Record<string, string> = {
  'ARAB': 'AR', 'EGYPT': 'EG', 'AFRICA': 'AF', 'BRAZIL': 'BR', 'CANADA': 'CA', 'CHILE': 'CL', 'MEXICO': 'MX', 'PERU': 'PE',
  'USA': 'US', 'ARGENTINA': 'AR', 'COLOMBIA': 'CO', 'LATINO': 'LA', 'AZERBAIJAN': 'AZ', 'BANGLADESH': 'BD', 'INDIA': 'IN',
  'IRAN': 'IR', 'ISRAEL': 'IL', 'KOREA': 'KR', 'PAKISTAN': 'PK', 'PHILIPPINES': 'PH', 'THAILAND': 'TH', 'VIETNAM': 'VN',
  'CHINA': 'CN', 'JAPAN': 'JP', 'INDONESIA': 'ID', 'MALAYSIA': 'MY', 'ALBANIA': 'AL', 'AUSTRIA': 'AT', 'BELGIUM': 'BE',
  'BULGARIA': 'BG', 'CZECHIA': 'CZ', 'CZECH': 'CZ', 'DENMARK': 'DK', 'EX-YU': 'YU', 'FINLAND': 'FI', 'FRANCE': 'FR',
  'GERMANY': 'DE', 'GREECE': 'GR', 'HUNGARY': 'HU', 'ITALY': 'IT', 'NETHERLANDS': 'NL', 'NORWAY': 'NO', 'POLAND': 'PL',
  'PORTUGAL': 'PT', 'ROMANIA': 'RO', 'SCANDINAVIA': 'SC', 'SPAIN': 'ES', 'SWEDEN': 'SE', 'SWITZERLAND': 'CH',
  'UNITED KINGDOM': 'UK', 'UK': 'UK', 'IRELAND': 'IE', 'RUSSIA': 'RU', 'UKRAINE': 'UA', 'TURKIYE': 'TR', 'TURKEY': 'TR',
  'AUSTRALIA': 'AU', 'NEW ZEALAND': 'NZ', 'WORLD': 'WW', 'VIP': 'WW', 'DIGER': 'WW', 'SLOVAKIA': 'SK', 'SLOVENIA': 'SI',
  'CROATIA': 'HR', 'SERBIA': 'RS', 'BOSNIA': 'BA', 'MACEDONIA': 'MK', 'LITHUANIA': 'LT', 'LATVIA': 'LV', 'ESTONIA': 'EE',
  'ICELAND': 'IS', 'MALTA': 'MT', 'CYPRUS': 'CY', 'LUXEMBOURG': 'LU', 'ARMENIA': 'AM', 'GEORGIA': 'GE', 'KAZAKHSTAN': 'KZ',
};

const TR_SPORT = /^TURKIYE SPOR\s+(.+)$/i;
const TR_TV = /^TURKIYE TV$/i;
const WORLD = /^(EU|AM|AS|AF|AR|WW)\s*\|\s*(.+?)\s+(SPORTS?|DIGER)$/i;
const SEPARATOR = /^-+$/;

const FIXED_WORDS: Record<string, string> = { DIGER: 'Diğer', TRT: 'TRT', USA: 'USA', UK: 'UK', 'EX-YU': 'Ex-YU', VIP: 'VIP' };

function titleCase(s: string): string {
  return s.split(/\s+/).map(w => FIXED_WORDS[w.toUpperCase()]
    ?? w.toLowerCase().replace(/(^|[\-/])([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase())).join(' ');
}

/** null = kenar cubugunda gizli (Gunun Maclari, ayrac, arsiv). */
export function presentGroup(name: string): GroupPresentation | null {
  const n = (name || '').trim();
  if (!n || SEPARATOR.test(n) || CONFIG.MNGTV.MATCHES.HIDE_RE.test(n) || /^arsiv$/i.test(n)) return null;
  let m = TR_SPORT.exec(n);
  if (m) return { section: 'tr-sport', label: `TR | ${titleCase(m[1])}` };
  if (TR_TV.test(n)) return { section: 'tv', label: 'TR | TV' };
  m = WORLD.exec(n);
  if (m) {
    const country = m[2].trim();
    const code = COUNTRY_CODES[country.toUpperCase()] ?? country.slice(0, 2).toUpperCase();
    const kind = m[3].toUpperCase();
    const pretty = titleCase(country);
    return { section: kind.startsWith('SPORT') ? 'world-sport' : 'tv', label: `${code} | ${pretty}` };
  }
  return { section: 'tv', label: n };
}

export function sectionTitleKey(section: GroupSection): 'channel.sectionTrSport' | 'channel.sectionWorldSport' | 'channel.sectionTv' {
  return section === 'tr-sport' ? 'channel.sectionTrSport' : section === 'world-sport' ? 'channel.sectionWorldSport' : 'channel.sectionTv';
}

/** Sunucu sirasini bolum icinde korur; bolumler TR spor, dunya spor, TV sirasiyla. */
export function orderGroups(names: readonly string[]): Array<{ name: string; present: GroupPresentation; sectionStart: boolean }> {
  const rows = names
    .map((name, i) => ({ name, present: presentGroup(name), i }))
    .filter((r): r is { name: string; present: GroupPresentation; i: number } => r.present !== null)
    .sort((a, b) => SECTION_ORDER[a.present.section] - SECTION_ORDER[b.present.section] || a.i - b.i);
  let last: GroupSection | null = null;
  return rows.map(r => {
    const sectionStart = r.present.section !== last;
    last = r.present.section;
    return { name: r.name, present: r.present, sectionStart };
  });
}
