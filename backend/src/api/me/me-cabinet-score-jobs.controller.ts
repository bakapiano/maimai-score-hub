import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { CabinetScoreJobCreateBodySchema } from '@maimai-score-hub/shared';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { CabinetScoreSyncService } from '../../modules/cabinet-score-sync/cabinet-score-sync.service';
import { decodeQrImage } from '../../common/qr-decode';

type AuthedRequest = Request & { user?: { sub?: string } };
const MultipartFieldsSchema = z
  .object({ qrCode: z.string().trim().min(1).max(512).optional() })
  .strict();
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

@Controller('me/cabinet-score-jobs')
@UseGuards(AuthGuard)
export class MeCabinetScoreJobsController {
  constructor(private readonly jobs: CabinetScoreSyncService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) =>
        cb(
          ALLOWED_IMAGE_TYPES.has(file.mimetype)
            ? null
            : new BadRequestException({
                code: 'QR_IMAGE_UNSUPPORTED',
                message: '仅支持 PNG、JPEG 或 WebP 图片',
              }),
          ALLOWED_IMAGE_TYPES.has(file.mimetype),
        ),
    }),
  )
  async create(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() rawBody: unknown,
  ) {
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) {
      throw new BadRequestException('No user context');
    }
    const parsed = file
      ? MultipartFieldsSchema.parse(rawBody ?? {})
      : CabinetScoreJobCreateBodySchema.parse(rawBody ?? {});
    let qrCode = parsed.qrCode;
    if (!qrCode && file) {
      try {
        qrCode = (await decodeQrImage(file.buffer)) ?? undefined;
      } catch {
        throw new BadRequestException({
          code: 'QR_IMAGE_DECODE_FAILED',
          message: '图片中未识别出二维码',
        });
      }
    }
    if (!qrCode) {
      throw new BadRequestException({
        code: 'QR_INPUT_REQUIRED',
        message: '请粘贴二维码字符串或上传二维码图片',
      });
    }
    return this.jobs.create(ownerUserId, qrCode.trim());
  }

  @Get('active')
  async active(@Req() req: AuthedRequest) {
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) {
      throw new BadRequestException('No user context');
    }
    return this.jobs.getActiveOwned(ownerUserId);
  }

  @Get(':jobId')
  async get(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) {
      throw new BadRequestException('No user context');
    }
    return this.jobs.getOwned(jobId, ownerUserId);
  }
}
