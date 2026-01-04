import { ConfigModule, ConfigService } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { CoverModule } from './modules/cover/cover.module';
import { JobModule } from './modules/job/job.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicModule } from './modules/music/music.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncModule } from './modules/sync/sync.module';
import { UsersModule } from './modules/users/users.module';

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

        if (!user || !password) {
          throw new Error('MONGO_USER and MONGO_PASSWORD are required');
        }

        const creds = `${encodeURIComponent(user)}:${encodeURIComponent(
          password,
        )}@`;
        const uri = `mongodb://${creds}${host}:${port}/${db}?authSource=${encodeURIComponent(
          authSource,
        )}`;

        return { uri };
      },
    }),
    AuthModule,
    CoverModule,
    JobModule,
    MusicModule,
    SyncModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
