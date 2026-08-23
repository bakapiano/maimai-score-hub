import { Module } from '@nestjs/common';

import { AndroidWorkflowService } from './services/android-workflow.service';

@Module({
  providers: [AndroidWorkflowService],
  exports: [AndroidWorkflowService],
})
export class AndroidWorkflowModule {}
