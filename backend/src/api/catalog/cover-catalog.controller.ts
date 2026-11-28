import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { CoverService } from '../../modules/cover/services/cover.service';

@Controller('catalog/covers')
export class CoverCatalogController {
  constructor(private readonly covers: CoverService) {}

  @Get(':id')
  async getCover(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Query('size') size: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const accept = req.headers.accept ?? '';
    const forceFormat =
      format === 'webp' ? 'webp' : format === 'png' ? 'png' : undefined;
    const coverSize = size === 'thumb' ? 'thumb' : 'full';
    const preferWebp = forceFormat
      ? forceFormat === 'webp'
      : accept.includes('image/webp');
    const selected = await this.covers.getPreferredLocalPath(id, preferWebp, {
      size: coverSize,
      forceFormat,
    });

    if (!selected?.path) {
      res.status(404).send('Not found');
      return;
    }

    // Encourage long-lived browser/proxy caching for cover images
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (!forceFormat) {
      res.vary('Accept');
    }
    res.type(selected.format);
    res.sendFile(selected.path);
  }
}
