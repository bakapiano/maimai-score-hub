import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { CoverService } from '../../modules/cover/services/cover.service';

@Controller('catalog/covers')
export class CoverCatalogController {
  constructor(private readonly covers: CoverService) {}

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
