import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UploadedFiles,
  UnsupportedMediaTypeException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import sharp from 'sharp';

import { AuthGuard } from '../../modules/auth/guards/auth.guard';
import { OcrService } from '../../modules/ocr/services/ocr.service';

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type AuthedRequest = Request & {
  user?: { sub?: string };
};

@Controller('me/ocr')
@UseGuards(AuthGuard)
export class MeOcrController {
  private readonly logger = new Logger(MeOcrController.name);

  constructor(private readonly ocr: OcrService) {}

  @Post('recognize')
  @HttpCode(200)
  @UseInterceptors(
    FilesInterceptor('images', MAX_IMAGES, {
      limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
      fileFilter: (_request, file, callback) => {
        const allowed = ALLOWED_IMAGE_TYPES.has(file.mimetype);
        callback(
          allowed
            ? null
            : new UnsupportedMediaTypeException(
                'Only JPEG, PNG and WebP images are accepted',
              ),
          allowed,
        );
      },
    }),
  )
  async recognize(
    @Req() req: AuthedRequest,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files?.length) {
      throw new BadRequestException('At least one image is required');
    }
    await Promise.all(
      files.map(async (file) => {
        try {
          const metadata = await sharp(file.buffer, {
            limitInputPixels: 40_000_000,
          }).metadata();
          if (!metadata.width || !metadata.height) {
            throw new Error('missing dimensions');
          }
        } catch {
          throw new BadRequestException(
            `${file.originalname}: invalid image or pixel limit exceeded`,
          );
        }
      }),
    );
    const startedAt = Date.now();
    try {
      const result = await this.ocr.recognize(files);
      this.logger.log({
        event: 'ocr_recognition_usage',
        requestCount: 1,
        imageCount: files.length,
        recognizedCount: result.results.filter((item) => item.status === 'ok')
          .length,
        outcome: 'success',
        userId: req.user?.sub ?? 'unknown',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.logger.log({
        event: 'ocr_recognition_usage',
        requestCount: 1,
        imageCount: files.length,
        recognizedCount: 0,
        outcome: 'failed',
        userId: req.user?.sub ?? 'unknown',
        durationMs: Date.now() - startedAt,
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }
}
