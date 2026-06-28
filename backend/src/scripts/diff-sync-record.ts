/**
 * Diff sync scores (from DB) against diving-fish records (from record.json).
 *
 * Finds music IDs / titles that exist in one side but not the other.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/diff-sync-record.ts
 */

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppModule } from '../app.module';
import {
  SyncEntity,
  type SyncDocument,
  type SyncScore,
} from '../modules/sync/schemas/sync.schema';
import {
  MusicEntity,
  type MusicDocument,
} from '../modules/music/schemas/music.schema';

type RecordRow = {
  song_id: number;
  title: string;
  type: string;
  level_index: number;
};
type MusicLookup = Map<string, { title: string; type: string }>;
type ChartIndexSet = Map<string, Set<number>>;

async function run() {
  const friendCode = '634142510810999';

  // Bootstrap NestJS to get DB connection
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const syncModel = app.get<Model<SyncDocument>>(
    getModelToken(SyncEntity.name),
  );
  const musicModel = app.get<Model<MusicDocument>>(
    getModelToken(MusicEntity.name),
  );

  // 1. Get sync from DB
  const sync = await syncModel
    .findOne({ friendCode })
    .sort({ createdAt: -1 })
    .lean();

  if (!sync) {
    console.error(`No sync found for friendCode=${friendCode}`);
    await app.close();
    return;
  }

  console.log(`Sync found: id=${sync.id}, scores=${sync.scores?.length ?? 0}`);

  // 2. Load record.json
  const recordPath = join(__dirname, 'record.json');
  const raw = await readFile(recordPath, 'utf8');
  const recordData = JSON.parse(raw) as {
    records: Array<{
      song_id: number;
      title: string;
      type: string;
      level_index: number;
    }>;
  };
  const records = recordData.records;
  console.log(`Records in record.json: ${records.length}`);

  const allMusics = await musicModel.find().lean();
  const musicById = buildMusicLookup(allMusics);
  console.log(`Musics in DB: ${musicById.size}`);

  const syncSet = buildSyncSet(sync.scores ?? []);
  const recordLookup = buildRecordLookup(records);
  const onlyInSync = findOnlyInSync(syncSet, recordLookup.recordSet, musicById);
  const onlyInRecord = findOnlyInRecord(recordLookup, syncSet);

  printOnlyInSync(onlyInSync);
  printOnlyInRecord(onlyInRecord);
  printSummary(
    syncSet,
    recordLookup.recordSet,
    onlyInSync.length,
    onlyInRecord.length,
  );

  await app.close();
}

function buildMusicLookup(
  rows: Array<{ id: string; title: string; type: string }>,
): MusicLookup {
  return new Map(rows.map((m) => [m.id, { title: m.title, type: m.type }]));
}

function addIndex(set: ChartIndexSet, id: string, index: number): void {
  const indices = set.get(id) ?? new Set<number>();
  indices.add(index);
  set.set(id, indices);
}

function buildSyncSet(scores: SyncScore[]): ChartIndexSet {
  const set = new Map<string, Set<number>>();
  for (const score of scores) {
    addIndex(set, score.musicId, score.chartIndex);
  }
  return set;
}

function buildRecordLookup(records: RecordRow[]): {
  recordSet: ChartIndexSet;
  titleById: Map<string, string>;
  typeById: Map<string, string>;
} {
  const recordSet = new Map<string, Set<number>>();
  const titleById = new Map<string, string>();
  const typeById = new Map<string, string>();
  for (const record of records) {
    const id = String(record.song_id);
    addIndex(recordSet, id, record.level_index);
    titleById.set(id, record.title);
    typeById.set(id, record.type);
  }
  return { recordSet, titleById, typeById };
}

function findOnlyInSync(
  syncSet: ChartIndexSet,
  recordSet: ChartIndexSet,
  musicById: MusicLookup,
) {
  return [...syncSet.entries()]
    .filter(([musicId]) => !recordSet.has(musicId))
    .map(([musicId, indices]) => {
      const music = musicById.get(musicId);
      return {
        musicId,
        title: music?.title ?? '(unknown)',
        type: music?.type ?? '?',
        chartIndices: [...indices].sort(),
      };
    });
}

function findOnlyInRecord(
  recordLookup: ReturnType<typeof buildRecordLookup>,
  syncSet: ChartIndexSet,
) {
  return [...recordLookup.recordSet.entries()]
    .filter(([songId]) => !syncSet.has(songId))
    .map(([songId, indices]) => ({
      musicId: songId,
      title: recordLookup.titleById.get(songId) ?? '(unknown)',
      type: recordLookup.typeById.get(songId) ?? '?',
      levelIndices: [...indices].sort(),
    }));
}

function byMusicId<T extends { musicId: string }>(a: T, b: T): number {
  return a.musicId.localeCompare(b.musicId, undefined, { numeric: true });
}

function printOnlyInSync(items: ReturnType<typeof findOnlyInSync>): void {
  console.log('\n========================================');
  console.log(`Only in SYNC (DB) — not in record.json: ${items.length} songs`);
  console.log('========================================');
  for (const item of items.sort(byMusicId)) {
    console.log(
      `  [${item.musicId}] "${item.title}" (${item.type}) charts: ${item.chartIndices.join(',')}`,
    );
  }
}

function printOnlyInRecord(items: ReturnType<typeof findOnlyInRecord>): void {
  console.log('\n========================================');
  console.log(`Only in RECORD.JSON — not in sync (DB): ${items.length} songs`);
  console.log('========================================');
  for (const item of items.sort(byMusicId)) {
    console.log(
      `  [${item.musicId}] "${item.title}" (${item.type}) levels: ${item.levelIndices.join(',')}`,
    );
  }
}

function printSummary(
  syncSet: ChartIndexSet,
  recordSet: ChartIndexSet,
  onlyInSyncCount: number,
  onlyInRecordCount: number,
): void {
  const syncMusicIds = new Set(syncSet.keys());
  const recordMusicIds = new Set(recordSet.keys());
  const commonIds = [...syncMusicIds].filter((id) => recordMusicIds.has(id));
  console.log('\n========================================');
  console.log(`Summary:`);
  console.log(`  Sync unique songs:   ${syncMusicIds.size}`);
  console.log(`  Record unique songs: ${recordMusicIds.size}`);
  console.log(`  Common songs:        ${commonIds.length}`);
  console.log(`  Only in sync:        ${onlyInSyncCount}`);
  console.log(`  Only in record:      ${onlyInRecordCount}`);
  console.log('========================================');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
