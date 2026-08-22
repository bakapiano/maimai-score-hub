import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { MeOcrController } from '../../api/me/me-ocr.controller';
import { OcrService } from './services/ocr.service';

@Module({
  imports: [AuthModule],
  controllers: [MeOcrController],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
