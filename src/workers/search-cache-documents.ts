import { CONFIG } from '../config';
import { foldSearchText } from '../utils/channel-search';
import { SearchCacheError } from './search-cache-reader';
import { sourceIndexValue, type SourceIndex } from './search-source-index';
import type {
  SearchCachedChannels,
  SearchCachedNames,
  SearchCachedProgrammes,
  SearchDocumentSamples,
} from './tasks';

// Documents here hold folded values: ranking only ever sees folded text, so a
// sample that folds to the same values ranks the same.
function verifySamples(documents: string[][], samples: SearchDocumentSamples): void {
  for (let i = 0; i < samples.indices.length; i++) {
    const actual = documents[samples.indices[i]];
    const expected = samples.documents[i];
    if (!actual || actual.length !== expected.length) {
      throw new SearchCacheError('sample_mismatch');
    }
    for (let field = 0; field < expected.length; field++) {
      if (actual[field] !== foldSearchText(expected[field])) {
        throw new SearchCacheError('sample_mismatch');
      }
    }
  }
}

function checkLength(index: SourceIndex, length: number): void {
  if (index.length !== length) throw new SearchCacheError('record_changed');
}

export function foldDocuments(documents: string[][]): string[][] {
  return documents.map(fields => fields.map(foldSearchText));
}

// Customization keeps the source values on `sourceName` / `sourceGroup`, so
// the index holds the uncustomized fields whatever was applied when the record
// was written; the main thread sends the customized documents as overrides.
export function cachedChannelDocuments(
  index: SourceIndex,
  request: SearchCachedChannels,
): string[][] {
  checkLength(index, request.length);
  const selection = request.selection;
  const documents: string[][] = new Array(selection.length);
  for (let i = 0; i < selection.length; i++) {
    const item = selection[i];
    if (item >= index.length) throw new SearchCacheError('selection_out_of_range');
    documents[i] = [sourceIndexValue(index, item, 0), sourceIndexValue(index, item, 1), ''];
  }
  if (request.overrideIndices.length !== request.overrides.length) {
    throw new SearchCacheError('override_invalid');
  }
  for (let i = 0; i < request.overrideIndices.length; i++) {
    const item = request.overrideIndices[i];
    if (item >= documents.length) throw new SearchCacheError('override_invalid');
    documents[item] = request.overrides[i].map(foldSearchText);
  }
  verifySamples(documents, request.samples);
  return documents;
}

export function cachedNameDocuments(
  index: SourceIndex,
  request: SearchCachedNames,
): string[] {
  checkLength(index, request.length);
  const selection = request.selection;
  const count = selection ? selection.length : index.length;
  const names: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const item = selection ? selection[i] : i;
    if (item >= index.length) throw new SearchCacheError('selection_out_of_range');
    names[i] = sourceIndexValue(index, item, 0);
  }
  for (let i = 0; i < request.samples.indices.length; i++) {
    const expected = request.samples.documents[i];
    if (expected.length !== 1
        || names[request.samples.indices[i]] !== foldSearchText(expected[0])) {
      throw new SearchCacheError('sample_mismatch');
    }
  }
  return names;
}

export function checkProgrammeRuns(request: SearchCachedProgrammes): void {
  const runs = request.runChannels.length;
  if (request.runRecords.length !== runs
      || request.runIds.length !== runs
      || request.runCounts.length !== runs) {
    throw new SearchCacheError('runs_invalid');
  }
  for (let run = 0; run < runs; run++) {
    if (request.runRecords[run] >= request.records.length) {
      throw new SearchCacheError('runs_invalid');
    }
  }
}

interface RunLookup {
  positions: Map<string, number>;
  starts: Uint32Array;
}

// Where each channel id's programmes start in an EPG index.
const runLookups = new WeakMap<SourceIndex, RunLookup>();

function runLookupOf(index: SourceIndex): RunLookup {
  let lookup = runLookups.get(index);
  if (lookup) return lookup;
  const ids = index.runIds ?? [];
  const counts = index.runCounts ?? new Uint32Array(0);
  lookup = { positions: new Map(), starts: new Uint32Array(ids.length) };
  let start = 0;
  for (let i = 0; i < ids.length; i++) {
    lookup.positions.set(ids[i], i);
    lookup.starts[i] = start;
    start += counts[i];
  }
  runLookups.set(index, lookup);
  return lookup;
}

// Extracts the runs stored in one EPG index into `runs`, joined with the folded
// name and group of the channel each run belongs to.
export function cachedProgrammeRuns(
  index: SourceIndex,
  recordIndex: number,
  request: SearchCachedProgrammes,
  channels: string[][],
  runs: Array<string[][] | undefined>,
): void {
  const lookup = runLookupOf(index);
  for (let run = 0; run < request.runRecords.length; run++) {
    if (request.runRecords[run] !== recordIndex) continue;
    const channel = channels[request.runChannels[run]];
    if (!channel) throw new SearchCacheError('runs_invalid');
    const position = lookup.positions.get(request.runIds[run]);
    if (position === undefined || index.runCounts![position] !== request.runCounts[run]) {
      throw new SearchCacheError('record_changed');
    }
    const first = lookup.starts[position];
    const count = request.runCounts[run];
    const documents: string[][] = new Array(count);
    for (let i = 0; i < count; i++) {
      const item = first + i;
      documents[i] = CONFIG.MNGTV.SEARCH.INDEX_PROGRAMME_DESCRIPTION
        ? [
          sourceIndexValue(index, item, 0),
          sourceIndexValue(index, item, 1),
          sourceIndexValue(index, item, 2),
          channel[0],
          channel[1],
        ]
        : [
          sourceIndexValue(index, item, 0),
          sourceIndexValue(index, item, 1),
          channel[0],
          channel[1],
        ];
    }
    runs[run] = documents;
  }
}

export function joinProgrammeRuns(
  runs: Array<string[][] | undefined>,
  request: SearchCachedProgrammes,
): string[][] {
  const documents: string[][] = [];
  for (let run = 0; run < request.runChannels.length; run++) {
    const documentsOfRun = runs[run];
    if (!documentsOfRun) throw new SearchCacheError('runs_invalid');
    for (let i = 0; i < documentsOfRun.length; i++) documents.push(documentsOfRun[i]);
  }
  verifySamples(documents, request.samples);
  return documents;
}
