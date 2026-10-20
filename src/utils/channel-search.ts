import {
  isLetterOrNumber,
  splitLetterNumberTokens,
  stripCombiningDiacritics,
} from './unicode-text';

const SYNONYM_GROUPS = [
  ['sports', 'sport', 'footy', 'football', 'soccer', 'athletics'],
  ['kids', 'kid', 'children', 'child', 'cartoons', 'cartoon', 'animation', 'animated'],
  ['news', 'headlines', 'current affairs'],
  ['movies', 'movie', 'films', 'film', 'cinema'],
  ['music', 'songs', 'song', 'concerts', 'concert'],
  ['documentaries', 'documentary', 'docs', 'history', 'nature'],
] as const;

const STOP_WORDS = new Set(['find', 'me', 'show', 'watch', 'for', 'please', 'channel', 'channels', 'program', 'programs']);

function fold(value: string): string {
  return stripCombiningDiacritics(value.normalize('NFD')).toLowerCase();
}

function splitFolded(value: string): string[] {
  return splitLetterNumberTokens(value);
}

function tokens(value: string): string[] {
  return splitFolded(fold(value));
}

function queryTokens(query: string): string[] {
  const all = tokens(query);
  const meaningful = all.filter(token => !STOP_WORDS.has(token));
  return meaningful.length ? meaningful : all;
}

function variants(token: string): string[] {
  for (const group of SYNONYM_GROUPS) {
    if ((group as readonly string[]).includes(token)) return [token, ...group.filter(value => value !== token)];
  }
  return [token];
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let edits = 0;
    for (let i = 0; i < a.length;) {
      if (a[i] === b[i]) {
        i++;
        continue;
      }
      if (edits > 0) return false;
      edits++;
      if (i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i]) i += 2;
      else i++;
    }
    return true;
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      longIndex++;
    } else {
      if (edits > 0) return false;
      edits++;
      longIndex++;
    }
  }
  return true;
}

function tokenScore(
  queryToken: string,
  fieldTokens: string[],
  start: number,
  end: number,
): number | null {
  let best: number | null = null;
  const expanded = variants(queryToken);
  for (let variantIndex = 0; variantIndex < expanded.length; variantIndex++) {
    const variant = expanded[variantIndex];
    for (let tokenIndex = start; tokenIndex < end; tokenIndex++) {
      const fieldToken = fieldTokens[tokenIndex];
      let score: number | null = null;
      if (fieldToken === variant) score = variantIndex === 0 ? 0 : 4;
      else if (fieldToken.startsWith(variant)) score = variantIndex === 0 ? 1 : 5;
      else if (variantIndex === 0 && variant.length >= 4 && withinOneEdit(variant, fieldToken)) score = 2;
      if (score !== null && (best === null || score < best)) best = score;
    }
  }
  return best;
}

export interface PreparedSearchItem<T> {
  item: T;
  values: string[];
  fieldTokens: string[];
  fieldTokenOffsets: number[];
}

export interface PreparedNameSearchIndex<T> {
  items: T[];
  values: string[];
  // mngtv: kelime-basi on-ek dizini (tembel kurulur; bkz. buildNamePrefixIndex)
  prefix?: NamePrefixIndex;
}

/** Her ad icin her kelime basindan baslayan sonek, sirali. Tier 0-2 eslesmeleri ikili aramayla bulunur. */
export interface NamePrefixIndex {
  suffixes: string[];   // sirali
  owner: Int32Array;    // suffixes[i] -> item indeksi
  pos: Int32Array;      // suffixes[i] -> ad icindeki konum
}

export interface RankedSearchResult<T> {
  items: T[];
  hasMore: boolean;
  // mngtv: tum dogrudan (indexOf) eslesmelerin indeksleri; daraltarak arama icin
  direct?: number[];
}

/** mngtv: siralama secenekleri. */
export interface RankOptions {
  includeFuzzy?: boolean;
  fuzzyMinLength?: number;        // katlanmis sorgu bundan kisaysa bulanik tarama yapilmaz
  fuzzySkipField?: number;        // bu alan bulanik taramaya girmez (orn. program aciklamasi)
  candidates?: ArrayLike<number> | null; // yalniz bu indeksler taranir (daraltma)
  collectDirect?: boolean;        // direct listesi dondurulur
}

interface ScoredSearchItem<T> {
  item: T;
  score: number;
  idx: number;
}

interface ScoredNameItem<T> {
  item: T;
  tier: number;
  pos: number;
  len: number;
  idx: number;
}

export { fold as foldSearchText };

export function prepareSearchItem<T>(
  item: T,
  fields: (item: T) => string[],
): PreparedSearchItem<T> {
  return prepareFoldedSearchItem(item, fields(item).map(fold));
}

/** Like `prepareSearchItem`, for field values already passed through `foldSearchText`. */
export function prepareFoldedSearchItem<T>(item: T, folded: string[]): PreparedSearchItem<T> {
  const values = folded.filter(Boolean);
  const fieldTokens: string[] = [];
  const fieldTokenOffsets = [0];
  for (const value of values) {
    const tokens = splitFolded(value);
    for (const token of tokens) fieldTokens.push(token);
    fieldTokenOffsets.push(fieldTokens.length);
  }
  return { item, values, fieldTokens, fieldTokenOffsets };
}

export function prepareSearchItems<T>(items: T[], fields: (item: T) => string[]): PreparedSearchItem<T>[] {
  return items.map(item => prepareSearchItem(item, fields));
}

export function prepareNameSearchItems<T extends { name: string }>(
  items: T[],
): PreparedNameSearchIndex<T> {
  return {
    items,
    values: items.map(item => fold(item.name)),
  };
}

function compareScored<T>(a: ScoredSearchItem<T>, b: ScoredSearchItem<T>): number {
  return a.score - b.score || a.idx - b.idx;
}

function compareNameScored<T>(a: ScoredNameItem<T>, b: ScoredNameItem<T>): number {
  return a.tier - b.tier
    || a.pos - b.pos
    || a.len - b.len
    || a.idx - b.idx;
}

function directScore<T>(
  prepared: PreparedSearchItem<T>,
  query: string,
): number | null {
  let best: number | null = null;
  for (let fieldIndex = 0; fieldIndex < prepared.values.length; fieldIndex++) {
    const value = prepared.values[fieldIndex];
    const pos = value.indexOf(query);
    if (pos === -1) continue;
    const tier = value === query
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    const score = tier * 1000 + fieldIndex * 100 + pos * 10 + value.length;
    if (best === null || score < best) best = score;
  }
  return best;
}

function fuzzyScore<T>(
  prepared: PreparedSearchItem<T>,
  terms: string[],
  skipField = -1,
): number | null {
  let total = 10000;
  for (const term of terms) {
    let best: number | null = null;
    for (let fieldIndex = 0; fieldIndex < prepared.values.length; fieldIndex++) {
      if (fieldIndex === skipField) continue;
      const score = tokenScore(
        term,
        prepared.fieldTokens,
        prepared.fieldTokenOffsets[fieldIndex],
        prepared.fieldTokenOffsets[fieldIndex + 1],
      );
      if (score !== null) {
        const weighted = score + fieldIndex * 10;
        if (best === null || weighted < best) best = weighted;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

class BoundedHeap<T> {
  private values: T[] = [];

  constructor(
    private limit: number,
    private compare: (a: T, b: T) => number,
  ) {}

  add(value: T): void {
    if (this.values.length < this.limit) {
      this.values.push(value);
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (this.compare(value, this.values[0]) >= 0) return;
    this.values[0] = value;
    this.bubbleDown(0);
  }

  sorted(): T[] {
    return this.values.sort(this.compare);
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], this.values[index]) >= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  private bubbleDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worse = index;
      if (left < this.values.length
          && this.compare(this.values[left], this.values[worse]) > 0) worse = left;
      if (right < this.values.length
          && this.compare(this.values[right], this.values[worse]) > 0) worse = right;
      if (worse === index) return;
      [this.values[index], this.values[worse]] = [this.values[worse], this.values[index]];
      index = worse;
    }
  }
}

export function rankPreparedTopK<T>(
  items: PreparedSearchItem<T>[],
  query: string,
  limit: number,
  options: boolean | RankOptions = true,
): RankedSearchResult<T> {
  const opts: RankOptions = typeof options === 'boolean' ? { includeFuzzy: options } : options;
  const q = fold(query.trim());
  const terms = queryTokens(query);
  if (!q || !terms.length || limit <= 0) return { items: [], hasMore: false, direct: opts.collectDirect ? [] : undefined };
  const includeFuzzy = (opts.includeFuzzy ?? true) && q.length >= (opts.fuzzyMinLength ?? 0);
  const heap = new BoundedHeap<ScoredSearchItem<T>>(limit, compareScored);
  const directMatches = includeFuzzy ? new Uint8Array(items.length) : null;
  const direct: number[] | null = opts.collectDirect ? [] : null;
  let matches = 0;
  const scan = (i: number): void => {
    const prepared = items[i];
    const score = directScore(prepared, q);
    if (score === null) return;
    if (directMatches) directMatches[i] = 1;
    if (direct) direct.push(i);
    matches++;
    heap.add({ item: prepared.item, score, idx: i });
  };
  const candidates = opts.candidates;
  if (candidates) {
    for (let c = 0; c < candidates.length; c++) scan(candidates[c]);
  } else {
    for (let i = 0; i < items.length; i++) scan(i);
  }
  if (includeFuzzy && matches < limit) {
    const skip = opts.fuzzySkipField ?? -1;
    for (let i = 0; i < items.length; i++) {
      const prepared = items[i];
      if (directMatches?.[i]) continue;
      const score = fuzzyScore(prepared, terms, skip);
      if (score === null) continue;
      matches++;
      heap.add({ item: prepared.item, score, idx: i });
    }
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit
      || (includeFuzzy && matches >= limit && items.length > matches),
    direct: direct ?? undefined,
  };
}

/** mngtv: adlarin her kelime basindan sonekleri, sirali. Bir kez kurulur, dizine asilir. */
export function buildNamePrefixIndex<T>(index: PreparedNameSearchIndex<T>): NamePrefixIndex {
  const suffixes: string[] = [];
  const owners: number[] = [];
  const positions: number[] = [];
  for (let i = 0; i < index.values.length; i++) {
    const value = index.values[i];
    for (let p = 0; p < value.length; p++) {
      if (!isLetterOrNumber(value[p]) || (p > 0 && isLetterOrNumber(value[p - 1]))) continue;
      suffixes.push(p === 0 ? value : value.slice(p));
      owners.push(i);
      positions.push(p);
    }
  }
  const order = suffixes.map((_, i) => i).sort((a, b) => (suffixes[a] < suffixes[b] ? -1 : suffixes[a] > suffixes[b] ? 1 : a - b));
  const out: NamePrefixIndex = {
    suffixes: order.map(i => suffixes[i]),
    owner: Int32Array.from(order, i => owners[i]),
    pos: Int32Array.from(order, i => positions[i]),
  };
  index.prefix = out;
  return out;
}

function lowerBound(sorted: string[], q: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function rankPreparedNamesTopK<T>(
  index: PreparedNameSearchIndex<T>,
  query: string,
  limit: number,
  options: RankOptions = {},
): RankedSearchResult<T> {
  const q = fold(query.trim());
  if (!q || limit <= 0) return { items: [], hasMore: false, direct: options.collectDirect ? [] : undefined };
  const heap = new BoundedHeap<ScoredNameItem<T>>(limit, compareNameScored);
  const direct: number[] | null = options.collectDirect ? [] : null;
  let matches = 0;
  const scan = (i: number): void => {
    const value = index.values[i];
    const pos = value.indexOf(q);
    if (pos === -1) return;
    const tier = value === q
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    matches++;
    if (direct) direct.push(i);
    heap.add({ item: index.items[i], tier, pos, len: value.length, idx: i });
  };
  const candidates = options.candidates;
  if (candidates) {
    for (let c = 0; c < candidates.length; c++) scan(candidates[c]);
  } else if (index.prefix) {
    // On-ek dizini: tier 0-2 (tam / bastan / kelime basi) ikili aramayla; her ad bir kez.
    const { suffixes, owner, pos } = index.prefix;
    const seen = new Uint8Array(index.items.length);
    for (let k = lowerBound(suffixes, q); k < suffixes.length && suffixes[k].startsWith(q); k++) {
      const i = owner[k];
      if (seen[i]) continue;
      seen[i] = 1;
      const value = index.values[i];
      const p = pos[k];
      // Ayni adda daha erken bir kelime-basi eslesmesi olabilir; indexOf en erkenini verir.
      const first = value.indexOf(q);
      const tier = value === q ? 0 : first === 0 ? 1 : !isLetterOrNumber(value[first - 1]) ? 2 : p === 0 ? 1 : 2;
      matches++;
      if (direct) direct.push(i);
      heap.add({ item: index.items[i], tier, pos: first, len: value.length, idx: i });
    }
    if (matches < limit) {
      // Kelime icinden gecen eslesmeler (tier 3): yalniz sonuc azsa tam tarama.
      for (let i = 0; i < index.items.length; i++) {
        if (seen[i]) continue;
        const value = index.values[i];
        const p = value.indexOf(q);
        if (p === -1) continue;
        matches++;
        if (direct) direct.push(i);
        heap.add({ item: index.items[i], tier: 3, pos: p, len: value.length, idx: i });
      }
    } else if (direct) {
      // Liste tam olmayabilir (tier 3 taranmadi): daraltma icin kullanilamaz.
      direct.length = 0;
      return { items: heap.sorted().map(value => value.item), hasMore: true, direct: undefined };
    }
  } else {
    for (let i = 0; i < index.items.length; i++) scan(i);
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit,
    direct: direct ?? undefined,
  };
}

export function rankPrepared<T>(items: PreparedSearchItem<T>[], query: string): T[] {
  return rankPreparedTopK(items, query, items.length).items;
}

export function rankByFields<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  return rankPrepared(prepareSearchItems(items, fields), query);
}

export function rankByName<T extends { name: string }>(items: T[], query: string): T[] {
  return rankPreparedNamesTopK(
    prepareNameSearchItems(items),
    query,
    items.length,
  ).items;
}

export function rankChannels<T extends { name: string; group: string; sourceName?: string }>(
  items: T[],
  query: string,
): T[] {
  // A renamed channel stays findable under its source name too.
  return rankByFields(items, query, item => [item.name, item.group, item.sourceName ?? '']);
}
