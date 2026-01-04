import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CoverService } from './cover.service';

@Controller('cover')
export class CoverController {
  constructor(private readonly covers: CoverService) {}

  @Post('sync')
  async syncAll() {
    return this.covers.syncAll();
  }

  @Get(':id')
  async getCover(@Param('id') id: string, @Res() res: Response) {
    const path = await this.covers.getLocalPathIfExists(id);
    if (!path) {
      res.status(404).send('Not found');
      return;
    }
    res.sendFile(path);
  }
}
