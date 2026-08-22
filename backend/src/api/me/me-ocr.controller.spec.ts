import { ServiceUnavailableException } from '@nestjs/common';
import sharp from 'sharp';

import { MeOcrController } from './me-ocr.controller';

async function imageFile(): Promise<Express.Multer.File> {
  const buffer = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: '#ffffff',
    },
  })
    .jpeg()
    .toBuffer();
  return {
    fieldname: 'images',
    originalname: 'score.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: buffer.byteLength,
    buffer,
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
  };
}

function loggerOf(controller: MeOcrController) {
  return (
    controller as unknown as {
      logger: { log: (message: unknown) => void };
    }
  ).logger;
}

describe('MeOcrController usage logging', () => {
  it('records one successful usage event with its image count', async () => {
    const response = {
      results: [{ status: 'ok' }, { status: 'unrecognized' }],
    };
    const ocr = { recognize: jest.fn().mockResolvedValue(response) };
    const controller = new MeOcrController(ocr as never);
    const log = jest.spyOn(loggerOf(controller), 'log').mockImplementation();

    const files = [await imageFile(), await imageFile()];
    await expect(
      controller.recognize(
        { user: { sub: '68a7e801e9abbd760017a62e' } } as never,
        files,
      ),
    ).resolves.toBe(response);

    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      event: 'ocr_recognition_usage',
      requestCount: 1,
      imageCount: 2,
      recognizedCount: 1,
      outcome: 'success',
      userId: '68a7e801e9abbd760017a62e',
    });
    expect(typeof (entry as { durationMs?: unknown }).durationMs).toBe(
      'number',
    );
  });

  it('records failed upstream attempts', async () => {
    const ocr = {
      recognize: jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('offline')),
    };
    const controller = new MeOcrController(ocr as never);
    const log = jest.spyOn(loggerOf(controller), 'log').mockImplementation();

    await expect(
      controller.recognize(
        { user: { sub: '68a7e801e9abbd760017a62e' } } as never,
        [await imageFile()],
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ocr_recognition_usage',
        requestCount: 1,
        imageCount: 1,
        recognizedCount: 0,
        outcome: 'failed',
        errorClass: 'ServiceUnavailableException',
      }),
    );
  });
});
