import { Module, forwardRef } from '@nestjs/common';
import { UserEntity, UserSchema } from './schemas/user.schema';

import { AuthModule } from '../auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './services/users.service';
import { CabinetService } from './services/cabinet.service';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncEntity, SyncSchema } from '../sync/schemas/sync.schema';
import { JobEntity, JobSchema } from '../job/schemas/job.schema';
import { AccountDeletionService } from './services/account-deletion.service';
import {
  PasskeyCredentialEntity,
  PasskeyCredentialSchema,
} from '../auth/schemas/passkey-credential.schema';
import {
  ProberExportJobEntity,
  ProberExportJobSchema,
} from '../prober-export/schemas/prober-export-job.schema';
import {
  ProberExportStateEntity,
  ProberExportStateSchema,
} from '../prober-export/schemas/prober-export-state.schema';
import {
  ScoreChangeEntity,
  ScoreChangeSchema,
} from '../sync/schemas/score-change.schema';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    SdgbWorkerModule,
    MongooseModule.forFeature([
      { name: UserEntity.name, schema: UserSchema },
      { name: SyncEntity.name, schema: SyncSchema },
      { name: ScoreChangeEntity.name, schema: ScoreChangeSchema },
      { name: JobEntity.name, schema: JobSchema },
      { name: PasskeyCredentialEntity.name, schema: PasskeyCredentialSchema },
      { name: ProberExportJobEntity.name, schema: ProberExportJobSchema },
      { name: ProberExportStateEntity.name, schema: ProberExportStateSchema },
    ]),
  ],
  providers: [UsersService, CabinetService, AccountDeletionService],
  exports: [UsersService, CabinetService, AccountDeletionService],
})
export class UsersModule {}
