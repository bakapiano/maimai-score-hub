import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module, forwardRef } from '@nestjs/common';

import { AuthGuard } from './guards/auth.guard';
import { AuthService } from './services/auth.service';
import { BotsModule } from '../bots/bots.module';
import { JobModule } from '../job/job.module';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { MusicEntity, MusicSchema } from '../music/schemas/music.schema';
import {
  QrLoginAttemptEntity,
  QrLoginAttemptSchema,
} from './schemas/qr-login-attempt.schema';
import { QrLoginService } from './services/qr-login.service';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { UsersModule } from '../users/users.module';
import { randomBytes } from 'node:crypto';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('AUTH_JWT_SECRET') ||
          randomBytes(32).toString('hex'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
    MongooseModule.forFeature([
      { name: MusicEntity.name, schema: MusicSchema },
      { name: QrLoginAttemptEntity.name, schema: QrLoginAttemptSchema },
    ]),
    UsersModule,
    SdgbWorkerModule,
    BotsModule,
    forwardRef(() => JobModule),
  ],
  providers: [AuthService, AuthGuard, QrLoginService],
  exports: [AuthService, AuthGuard, QrLoginService],
})
export class AuthModule {}
