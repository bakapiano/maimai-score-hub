import { ConfigModule, ConfigService } from '@nestjs/config';

import { AppController } from './app.controller';
import { BackendApiModule } from './api/backend-api.module';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ObservabilityModule } from './modules/observability/observability.module';
import { RedisModule } from './common/redis/redis.module';
import { ScheduleModule } from '@nestjs/schedule';
import { createMongooseQueryTimeoutPlugin } from './common/mongoose-query-timeout.plugin';
import type { Connection } from 'mongoose';

function getPositiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

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
        const queryMaxTimeMS = getPositiveInt(
          config,
          'MONGO_QUERY_MAX_TIME_MS',
          5000,
        );
        const aggregateMaxTimeMS = getPositiveInt(
          config,
          'MONGO_AGGREGATE_MAX_TIME_MS',
          queryMaxTimeMS,
        );
        const writeMaxTimeMS = getPositiveInt(
          config,
          'MONGO_WRITE_MAX_TIME_MS',
          0,
        );

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
          serverSelectionTimeoutMS: getPositiveInt(
            config,
            'MONGO_SERVER_SELECTION_TIMEOUT_MS',
            30000,
          ),
          connectTimeoutMS: getPositiveInt(
            config,
            'MONGO_CONNECT_TIMEOUT_MS',
            10000,
          ),
          socketTimeoutMS: getPositiveInt(
            config,
            'MONGO_SOCKET_TIMEOUT_MS',
            15000,
          ),
          retryWrites: true,
          retryReads: true,
          // Cap connection pool. Default mongoose maxPoolSize is 100 per
          // replica = 200 across our backend×2 setup; each mongo
          // connection is ~5MB on the server side, so 200 conns alone
          // burn ~1GB before any actual work. We never see >20
          // concurrent queries even at peak (sweep + bot status report
          // are well-batched). 30 leaves head room.
          maxPoolSize: 30,
          minPoolSize: 2,
          connectionFactory: (connection: Connection): Connection => {
            connection.plugin(
              createMongooseQueryTimeoutPlugin({
                readMaxTimeMS: queryMaxTimeMS,
                aggregateMaxTimeMS,
                writeMaxTimeMS,
              }),
            );
            return connection;
          },
        };
      },
    }),
    RedisModule,
    ObservabilityModule,
    BackendApiModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
