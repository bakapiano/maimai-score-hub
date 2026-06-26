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
} from '../modules/sync/schemas/sync.schema';
import {
  MusicEntity,
  type MusicDocument,
} from '../modules/music/schemas/music.schema';

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

  // 3. Build music lookup: id -> { title, type }
  const allMusics = await musicModel.find().lean();
  const musicById = new Map<string, { title: string; type: string }>();
  for (const m of allMusics) {
    musicById.set(m.id, { title: m.title, type: m.type });
  }
  console.log(`Musics in DB: ${musicById.size}`);

  // 4. Build sets from sync scores: musicId -> Set<chartIndex>
  const syncScores = sync.scores ?? [];
  const syncSet = new Map<string, Set<number>>();
  for (const s of syncScores) {
    if (!syncSet.has(s.musicId)) syncSet.set(s.musicId, new Set());
    syncSet.get(s.musicId)!.add(s.chartIndex);
  }

  // 5. Build sets from record.json: songId -> Set<levelIndex>
  const recordSet = new Map<string, Set<number>>();
  const recordTitleById = new Map<string, string>();
  for (const r of records) {
    const id = String(r.song_id);
    if (!recordSet.has(id)) recordSet.set(id, new Set());
    recordSet.get(id)!.add(r.level_index);
    recordTitleById.set(id, r.title);
  }

  // 6. Diff: find musicIds in sync but not in record
  const onlyInSync: Array<{
    musicId: string;
    title: string;
    type: string;
    chartIndices: number[];
  }> = [];
  for (const [musicId, indices] of syncSet) {
    if (!recordSet.has(musicId)) {
      const music = musicById.get(musicId);
      onlyInSync.push({
        musicId,
        title: music?.title ?? '(unknown)',
        type: music?.type ?? '?',
        chartIndices: [...indices].sort(),
      });
    }
  }

  // 7. Diff: find songIds in record but not in sync
  const onlyInRecord: Array<{
    musicId: string;
    title: string;
    type: string;
    levelIndices: number[];
  }> = [];
  for (const [songId, indices] of recordSet) {
    if (!syncSet.has(songId)) {
      onlyInRecord.push({
        musicId: songId,
        title: recordTitleById.get(songId) ?? '(unknown)',
        type: records.find((r) => String(r.song_id) === songId)?.type ?? '?',
        levelIndices: [...indices].sort(),
      });
    }
  }

  // 8. Print results
  console.log('\n========================================');
  console.log(
    `Only in SYNC (DB) — not in record.json: ${onlyInSync.length} songs`,
  );
  console.log('========================================');
  for (const item of onlyInSync.sort((a, b) =>
    a.musicId.localeCompare(b.musicId, undefined, { numeric: true }),
  )) {
    console.log(
      `  [${item.musicId}] "${item.title}" (${item.type}) charts: ${item.chartIndices.join(',')}`,
    );
  }

  console.log('\n========================================');
  console.log(
    `Only in RECORD.JSON — not in sync (DB): ${onlyInRecord.length} songs`,
  );
  console.log('========================================');
  for (const item of onlyInRecord.sort((a, b) =>
    a.musicId.localeCompare(b.musicId, undefined, { numeric: true }),
  )) {
    console.log(
      `  [${item.musicId}] "${item.title}" (${item.type}) levels: ${item.levelIndices.join(',')}`,
    );
  }

  // 9. Summary
  const syncMusicIds = new Set(syncSet.keys());
  const recordMusicIds = new Set(recordSet.keys());
  const commonIds = [...syncMusicIds].filter((id) => recordMusicIds.has(id));
  console.log('\n========================================');
  console.log(`Summary:`);
  console.log(`  Sync unique songs:   ${syncMusicIds.size}`);
  console.log(`  Record unique songs: ${recordMusicIds.size}`);
  console.log(`  Common songs:        ${commonIds.length}`);
  console.log(`  Only in sync:        ${onlyInSync.length}`);
  console.log(`  Only in record:      ${onlyInRecord.length}`);
  console.log('========================================');

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
