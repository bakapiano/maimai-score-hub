import { ConfigModule, ConfigService } from '@nestjs/config';

import { AdminModule } from './modules/admin/admin.module';
import { AppController } from './app.controller';
import { AuthModule } from './modules/auth/auth.module';
import { AutoUpdateModule } from './modules/auto-update/auto-update.module';
import { CoverModule } from './modules/cover/cover.module';
import { JobModule } from './modules/job/job.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from './modules/music/music.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ScoreExportModule } from './modules/score-export/score-export.module';
import { SdgbWorkerModule } from './modules/sdgb-worker/sdgb-worker.module';
import { SyncModule } from './modules/sync/sync.module';
import { UsersModule } from './modules/users/users.module';
import { WorkerLogsModule } from './modules/worker-logs/worker-logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('MONGO_HOST', 'localhost');
        const port = config.get<string>('MONGO_PORT', '27017');
        const db = config.get<string>('MONGO_DB', 'maimai_web');
        const user = config.get<string>('MONGO_USER');
        const password = config.get<string>('MONGO_PASSWORD');
        const authSource = config.get<string>('MONGO_AUTH_SOURCE', 'admin');

        let uri: string;
        if (user && password) {
          const creds = `${encodeURIComponent(user)}:${encodeURIComponent(
            password,
          )}@`;
          uri = `mongodb://${creds}${host}:${port}/${db}?authSource=${encodeURIComponent(
            authSource,
          )}`;
        } else {
          uri = `mongodb://${host}:${port}/${db}`;
        }

        return {
          uri,
          serverSelectionTimeoutMS: 30000,
          retryWrites: true,
          retryReads: true,
        };
      },
    }),
    AuthModule,
    AdminModule,
    AutoUpdateModule,
    CoverModule,
    JobModule,
    MusicModule,
    ScoreExportModule,
    SdgbWorkerModule,
    SyncModule,
    UsersModule,
    WorkerLogsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
