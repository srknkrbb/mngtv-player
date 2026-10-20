// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Channel } from '../types';
import {
  prepareSearchItems,
  prepareNameSearchItems,
  rankByName,
  rankChannels,
  rankByFields,
  rankPrepared,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  buildNamePrefixIndex,
} from './channel-search';

function ch(name: string, id = name): Channel {
  return { id, name, logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0 };
}
const names = (cs: Channel[]) => cs.map(c => c.name);

describe('rankByName', () => {
  it('returns [] for a blank/whitespace query', () => {
    expect(rankByName([ch('Alpha')], '   ')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(names(rankByName([ch('Alpha')], 'ALPHA'))).toEqual(['Alpha']);
  });

  it('excludes non-matching channels (result set == substring set)', () => {
    expect(names(rankByName([ch('Alpha'), ch('Bravo')], 'alp'))).toEqual(['Alpha']);
  });

  it('orders exact > prefix > word-start > mid-word', () => {
    const cs = [ch('XAlpha'), ch('HD Alpha'), ch('Alpha HD'), ch('Alpha')];
    expect(names(rankByName(cs, 'alpha'))).toEqual(['Alpha', 'Alpha HD', 'HD Alpha', 'XAlpha']);
  });

  it('treats Unicode punctuation as a word boundary', () => {
    const cs = [ch('AlphaNews'), ch('Alpha—News')];
    expect(names(rankByName(cs, 'news'))).toEqual(['Alpha—News', 'AlphaNews']);
  });

  it('breaks ties by earlier match position', () => {
    const cs = [ch('XXAlpha'), ch('XAlpha')]; // both mid-word; pos 2 vs pos 1
    expect(names(rankByName(cs, 'alpha'))).toEqual(['XAlpha', 'XXAlpha']);
  });

  describe('Chrome 53 Unicode fallback', () => {
    it('keeps Unicode punctuation as a search boundary', async () => {
      const NativeRegExp = RegExp;
      const LegacyRegExp = function (pattern?: string | RegExp, flags?: string): RegExp {
        if (typeof pattern === 'string' && pattern.includes('\\p{')) {
          throw new SyntaxError('Unsupported Unicode property escape');
        }
        return new NativeRegExp(pattern, flags);
      } as RegExpConstructor;

      vi.stubGlobal('RegExp', LegacyRegExp);
      vi.resetModules();
      try {
        const { rankByName: fallbackRankByName } = await import('./channel-search');
        const channels = [ch('AlphaNews'), ch('Alpha—News')];
        expect(names(fallbackRankByName(channels, 'news')))
          .toEqual(['Alpha—News', 'AlphaNews']);
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    });
  });

  it('breaks remaining ties by shorter name', () => {
    const cs = [ch('Alpha International'), ch('Alpha HD')]; // both prefix, pos 0
    expect(names(rankByName(cs, 'alpha'))).toEqual(['Alpha HD', 'Alpha International']);
  });

  it('breaks full ties by original order on legacy Chromium unstable sort', () => {
    const cs = [ch('Alpha', 'a'), ch('Alpha', 'b'), ch('Alpha', 'c')];
    expect(rankByName(cs, 'alpha').map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats the query as one whole substring', () => {
    const cs = [ch('X a b Y'), ch('b a')];
    expect(names(rankByName(cs, 'a b'))).toEqual(['X a b Y']);
  });

  it('ranks any object with a name field (generic over the item type)', () => {
    const items = [{ streamId: '1', name: 'XAlpha' }, { streamId: '2', name: 'Alpha' }];
    expect(rankByName(items, 'alpha').map(i => i.streamId)).toEqual(['2', '1']); // prefix before mid-word
  });

  it('keeps match position ahead of a large name-length difference in Top-K', () => {
    const items = [
      { name: 'xxxxAlpha with an unusually long suffix' },
      { name: 'xxxxxAlpha' },
    ];
    const prepared = prepareNameSearchItems(items);
    expect(rankPreparedNamesTopK(prepared, 'alpha', 1).items).toEqual([items[0]]);
  });

});

describe('rankChannels', () => {
  it('matches channel groups through genre synonyms and ignores conversational filler', () => {
    const channels = [ch('Alpha'), ch('Bravo')];
    channels[0].group = 'Sports';
    channels[1].group = 'Kids';
    expect(names(rankChannels(channels, 'show me footy channels'))).toEqual(['Alpha']);
    expect(names(rankChannels(channels, 'cartoons'))).toEqual(['Bravo']);
  });

  it('tolerates a one-character typo and adjacent transposition', () => {
    expect(names(rankChannels([ch('Alpha'), ch('Bravo')], 'alhpa'))).toEqual(['Alpha']);
    expect(names(rankChannels([ch('Alpha'), ch('Bravo')], 'brvo'))).toEqual(['Bravo']);
  });

  it('matches multiple query words without requiring an exact phrase', () => {
    expect(names(rankChannels([ch('Alpha News HD'), ch('News Bravo')], 'news alpha'))).toEqual(['Alpha News HD']);
  });
});

describe('rankByFields', () => {
  it('searches secondary metadata while preferring direct name matches', () => {
    const items = [
      { title: 'Alpha', category: 'Drama' },
      { title: 'Bravo', category: 'Alpha' },
    ];
    expect(rankByFields(items, 'alpha', item => [item.title, item.category]).map(item => item.title))
      .toEqual(['Alpha', 'Bravo']);
  });

  it('returns exactly the full ranking prefix for every Top-K size', () => {
    const items = [
      { title: 'X Alpha', category: 'Drama' },
      { title: 'Alpha', category: 'News' },
      { title: 'Bravo', category: 'Alpha' },
      { title: 'Alhpa', category: 'Sports' },
      { title: 'Alpha Two', category: 'Drama' },
    ];
    const prepared = prepareSearchItems(items, item => [item.title, item.category]);
    const full = rankPrepared(prepared, 'alpha');
    for (let limit = 1; limit <= full.length; limit++) {
      expect(rankPreparedTopK(prepared, 'alpha', limit).items)
        .toEqual(full.slice(0, limit));
    }
  });

  it('skips fuzzy results when direct matches fill Top-K', () => {
    const items = [
      { title: 'Alpha' },
      { title: 'Alpha Two' },
      { title: 'Alhpa' },
    ];
    const prepared = prepareSearchItems(items, item => [item.title]);
    const result = rankPreparedTopK(prepared, 'alpha', 2);
    expect(result.items).toEqual(items.slice(0, 2));
    expect(result.hasMore).toBe(true);
  });
});

describe('mngtv: on-ek dizini, daraltma ve bulanik sinirlari', () => {
  const pool = ['Bein Sport 1', 'Bein Sport 2', 'S Sport Plus', 'Sport TV', 'The Sporting Life', 'Transport', 'Kanal D', 'Deport Sport', 'abc sport'];
  const items = pool.map(name => ({ name }));

  it('on-ek dizini duz taramayla ayni siralamayi verir', () => {
    for (const q of ['sp', 'sport', 'ort', 'bein sport 1', 'z', 'd', 'tv']) {
      for (const limit of [1, 3, 100]) {
        const plain = rankPreparedNamesTopK(prepareNameSearchItems(items), q, limit).items.map(i => i.name);
        const index = prepareNameSearchItems(items);
        buildNamePrefixIndex(index);
        const fast = rankPreparedNamesTopK(index, q, limit).items.map(i => i.name);
        expect(fast, `${q}/${limit}`).toEqual(plain);
      }
    }
  });

  it('daraltma: aday listesi disindakiler taranmaz, direct listesi tam doner', () => {
    const index = prepareNameSearchItems(items);
    const first = rankPreparedNamesTopK(index, 'sp', 100, { collectDirect: true });
    expect(first.direct).toHaveLength(8);
    const second = rankPreparedNamesTopK(index, 'spor', 100, { candidates: first.direct, collectDirect: true });
    expect(second.items.map(i => i.name)).toEqual(
      rankPreparedNamesTopK(prepareNameSearchItems(items), 'spor', 100).items.map(i => i.name));
    expect(second.direct).toHaveLength(8);
    const none = rankPreparedNamesTopK(index, 'spx', 100, { candidates: [], collectDirect: true });
    expect(none.items).toEqual([]);
  });

  it('on-ek dizini sonuc siniri dolunca direct listesi vermez (tier 3 taranmadi)', () => {
    const index = prepareNameSearchItems(items);
    buildNamePrefixIndex(index);
    const r = rankPreparedNamesTopK(index, 'sp', 2, { collectDirect: true });
    expect(r.items).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(r.direct).toBeUndefined();
  });

  it('bulanik tarama kisa sorguda ve haric alanda calismaz', () => {
    const prepared = prepareSearchItems(
      [{ title: 'Haber', description: 'spor bulteni' }, { title: 'Film', description: 'drama' }],
      item => [item.title, item.description],
    );
    expect(rankPreparedTopK(prepared, 'spro', 10).items.map(i => i.title)).toEqual(['Haber']);
    expect(rankPreparedTopK(prepared, 'spro', 10, { fuzzySkipField: 1 }).items).toEqual([]);
    expect(rankPreparedTopK(prepared, 'hab', 10, { fuzzyMinLength: 3 }).items.map(i => i.title)).toEqual(['Haber']);
    expect(rankPreparedTopK(prepared, 'hb', 10, { fuzzyMinLength: 3 }).items).toEqual([]);
    const direct = rankPreparedTopK(prepared, 'a', 10, { collectDirect: true });
    expect(direct.direct).toEqual([0, 1]);
    expect(rankPreparedTopK(prepared, 'am', 10, { candidates: [1], collectDirect: true }).direct).toEqual([1]);
  });
});
