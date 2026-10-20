// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { orderGroups, presentGroup } from './mngtv-groups';

describe('mngtv grup gosterimi', () => {
  it('sunucu gruplarini bolum ve ulke koduyla etiketler, mac gruplarini ve ayraclari gizler', () => {
    expect(presentGroup('TURKIYE SPOR BEIN')).toEqual({ section: 'tr-sport', label: 'TR | Bein' });
    expect(presentGroup('TURKIYE SPOR S SPORT')).toEqual({ section: 'tr-sport', label: 'TR | S Sport' });
    expect(presentGroup('TURKIYE TV')).toEqual({ section: 'tv', label: 'TR | TV' });
    expect(presentGroup('EU | GERMANY SPORTS')).toEqual({ section: 'world-sport', label: 'DE | Germany' });
    expect(presentGroup('EU | UNITED KINGDOM SPORTS')).toEqual({ section: 'world-sport', label: 'UK | United Kingdom' });
    expect(presentGroup('AR | ARAB DIGER')).toEqual({ section: 'tv', label: 'AR | Arab' });
    expect(presentGroup('AM | USA DIGER')).toEqual({ section: 'tv', label: 'US | USA' });
    expect(presentGroup('TURKIYE SPOR DIGER')).toEqual({ section: 'tr-sport', label: 'TR | Diğer' });
    expect(presentGroup('TURKIYE SPOR TRT')).toEqual({ section: 'tr-sport', label: 'TR | TRT' });
    expect(presentGroup('WW | DIGER SPORTS')).toEqual({ section: 'world-sport', label: 'WW | Diğer' });
    expect(presentGroup('TURKIYE GUNUN MACLARI')).toBeNull();
    expect(presentGroup('DUNYA GUNUN MACLARI DIGER')).toBeNull();
    expect(presentGroup('-------')).toBeNull();
    expect(presentGroup('Arsiv')).toBeNull();
    expect(presentGroup('Some Provider Group')).toEqual({ section: 'tv', label: 'Some Provider Group' });
  });

  it('bolumleri siralar, bolum icinde sunucu sirasini korur, bolum baslarini isaretler', () => {
    const rows = orderGroups(['TURKIYE GUNUN MACLARI', 'TURKIYE SPOR BEIN', 'TURKIYE SPOR EXXEN', '-------', 'TURKIYE TV',
      'AR | ARAB SPORTS', 'EU | GERMANY SPORTS', 'AR | ARAB DIGER']);
    expect(rows.map(r => [r.present.label, r.sectionStart])).toEqual([
      ['TR | Bein', true], ['TR | Exxen', false],
      ['AR | Arab', true], ['DE | Germany', false],
      ['TR | TV', true], ['AR | Arab', false],
    ]);
  });
});
