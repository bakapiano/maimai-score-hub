import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CURRENT_WORKFLOW_VERSION = '2026.08.24.1';
const WORKFLOW_API_VERSION = 1;
const BRIDGE_API_VERSION = 1;

export type AndroidWorkflowManifest = {
  workflowVersion: string;
  workflowApiVersion: number;
  bridgeApiVersion: number;
  entry: string;
  sha256: string;
  bytes: number;
};

@Injectable()
export class AndroidWorkflowService {
  private readonly source: string;
  private readonly manifest: AndroidWorkflowManifest;

  constructor() {
    const filename = `score-workflow-${CURRENT_WORKFLOW_VERSION}.mjs`;
    const sourcePath = join(__dirname, '..', 'workflows', filename);
    this.source = readFileSync(sourcePath, 'utf8');
    this.manifest = {
      workflowVersion: CURRENT_WORKFLOW_VERSION,
      workflowApiVersion: WORKFLOW_API_VERSION,
      bridgeApiVersion: BRIDGE_API_VERSION,
      entry: `/android/workflow/${CURRENT_WORKFLOW_VERSION}.js`,
      sha256: createHash('sha256').update(this.source).digest('hex'),
      bytes: Buffer.byteLength(this.source),
    };
  }

  getManifest(): AndroidWorkflowManifest {
    return { ...this.manifest };
  }

  getBundle(version: string): string {
    if (version !== CURRENT_WORKFLOW_VERSION) {
      throw new NotFoundException('Android workflow version not found');
    }
    return this.source;
  }
}
