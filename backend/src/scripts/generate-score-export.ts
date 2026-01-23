import { mkdir, writeFile } from 'node:fs/promises';

import { AppModule } from '../app.module';
import { NestFactory } from '@nestjs/core';
import { ScoreExportService } from '../modules/score-export/score-export.service';
import { join } from 'node:path';

async function run() {
  const friendCode = '634142510810999';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const exporter = app.get(ScoreExportService);
  const outputDir = join(process.cwd(), 'score-exports');
  await mkdir(outputDir, { recursive: true });

  const best50 = await exporter.generateBest50Image(friendCode);
  const level = await exporter.generateLevelScoresImage(friendCode, '14+');
  const version = await exporter.generateVersionScoresImage(friendCode);

  await writeFile(join(outputDir, 'best50.png'), best50);
  await writeFile(join(outputDir, 'level.png'), level);
  await writeFile(join(outputDir, 'version.png'), version);

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
