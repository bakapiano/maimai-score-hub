import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module, forwardRef } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { JobModule } from '../job/job.module';
import { JwtModule } from '@nestjs/jwt';
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
    UsersModule,
    forwardRef(() => JobModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
