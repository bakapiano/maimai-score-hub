import { createHash } from 'node:crypto';

import { AndroidWorkflowService } from './android-workflow.service';

describe('AndroidWorkflowService', () => {
  it('publishes a versioned self-contained workflow with a matching digest', () => {
    const service = new AndroidWorkflowService();
    const manifest = service.getManifest();
    const source = service.getBundle(manifest.workflowVersion);

    expect(manifest.entry).toBe(
      `/android/workflow/${manifest.workflowVersion}.js`,
    );
    expect(manifest.workflowApiVersion).toBe(1);
    expect(manifest.bridgeApiVersion).toBe(1);
    expect(manifest.bytes).toBe(Buffer.byteLength(source));
    expect(manifest.sha256).toBe(
      createHash('sha256').update(source).digest('hex'),
    );
    expect(source).toContain('export async function run');
  });

  it('rejects unknown workflow versions', () => {
    const service = new AndroidWorkflowService();
    expect(() => service.getBundle('missing')).toThrow(
      'Android workflow version not found',
    );
  });
});
