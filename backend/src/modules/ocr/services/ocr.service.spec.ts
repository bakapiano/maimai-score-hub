import { BadGatewayException, GatewayTimeoutException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { OcrService } from './ocr.service';

const validPayload = {
  results: [
    {
      index: 0,
      filename: 'metatron.jpg',
      status: 'ok',
      candidates: [
        {
          title: 'METATRON',
          confidence: 0.99,
          sources: ['cover', 'title'],
        },
      ],
      achievement: 100.8039,
      dxScore: 2575,
      difficulty: 'master',
      level: '14',
      isDx: false,
      fc: null,
      fs: null,
      error: null,
    },
  ],
};

function file(): Express.Multer.File {
  return {
    fieldname: 'images',
    originalname: 'metatron.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 3,
    buffer: Buffer.from('jpg'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
  };
}

describe('OcrService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('forwards images and validates the OCR response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const config = new ConfigService({
      OCR_API_URL: 'http://127.0.0.1:19100',
      OCR_API_TOKEN: 'secret',
    });
    const service = new OcrService(config);

    await expect(service.recognize([file()])).resolves.toEqual(validPayload);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/recognize',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
      }),
    );
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
  });

  it('rejects an invalid upstream response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [{ status: 'ok' }] }), {
        status: 200,
      }),
    );
    const service = new OcrService(new ConfigService());
    await expect(service.recognize([file()])).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps an aborted upstream call to a gateway timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    ) as typeof fetch;
    const service = new OcrService(
      new ConfigService({ OCR_API_TIMEOUT_MS: '10' }),
    );
    const pending = service.recognize([file()]);
    const expectation = expect(pending).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    await jest.advanceTimersByTimeAsync(11);
    await expectation;
    jest.useRealTimers();
  });
});
