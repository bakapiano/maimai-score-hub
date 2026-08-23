import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AndroidWorkflowService } from '../../modules/android-workflow/services/android-workflow.service';

@Controller('android/workflow')
export class AndroidWorkflowController {
  constructor(private readonly workflows: AndroidWorkflowService) {}

  @Get('manifest')
  @Header('Cache-Control', 'no-store')
  getManifest() {
    return this.workflows.getManifest();
  }

  @Get(':version.js')
  getBundle(
    @Param('version') version: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return this.workflows.getBundle(version);
  }
}
