import { Module, forwardRef } from '@nestjs/common';

import { ProberExportModule } from '../prober-export/prober-export.module';
import { SdgbWorkerModule } from '../sdgb-worker/sdgb-worker.module';
import { SyncModule } from '../sync/sync.module';
import { UsersModule } from '../users/users.module';
import { CabinetScoreSyncService } from './cabinet-score-sync.service';

@Module({
  imports: [
    SdgbWorkerModule,
    ProberExportModule,
    SyncModule,
    forwardRef(() => UsersModule),
  ],
  providers: [CabinetScoreSyncService],
  exports: [CabinetScoreSyncService],
})
export class CabinetScoreSyncModule {}
