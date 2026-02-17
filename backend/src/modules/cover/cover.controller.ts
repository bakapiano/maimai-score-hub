import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { CoverService } from './cover.service';
import { AdminGuard } from '../admin/admin.guard';

@Controller('cover')
export class CoverController {
  constructor(private readonly covers: CoverService) {}

  @Post('sync')
  @UseGuards(AdminGuard)
  async syncAll() {
    return this.covers.syncAll();
  }

  @Post('force-sync')
  @UseGuards(AdminGuard)
  async forceSyncAll() {
    return await this.covers.forceSyncAll();
  }

  @Post('backfill-variants')
  @UseGuards(AdminGuard)
  async backfillVariants() {
    return await this.covers.backfillLocalVariants();
  }

  @Get(':id')
  async getCover(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const accept = req.headers.accept ?? '';
    const preferWebp = accept.includes('image/webp');
    const selected = await this.covers.getPreferredLocalPath(id, preferWebp);

    if (!selected?.path) {
      res.status(404).send('Not found');
      return;
    }

    // Encourage long-lived browser/proxy caching for cover images
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.vary('Accept');
    res.type(selected.format);
    res.sendFile(selected.path);
  }
}
