import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OcrBatchRecognitionResponseSchema,
  type OcrBatchRecognitionResponse,
} from '@maimai-score-hub/shared';

import { ConfigService } from '@nestjs/config';

@Injectable()
export class OcrService {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const baseUrl = config.get<string>('OCR_API_URL', 'http://127.0.0.1:19100');
    this.apiUrl = new URL(
      'v1/recognize',
      `${baseUrl.replace(/\/+$/, '')}/`,
    ).toString();
    this.token = config.get<string>('OCR_API_TOKEN', '').trim();
    const timeout = Number(config.get<string>('OCR_API_TIMEOUT_MS', '180000'));
    this.timeoutMs =
      Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000;
  }

  async recognize(
    files: readonly Express.Multer.File[],
  ): Promise<OcrBatchRecognitionResponse> {
    const form = new FormData();
    for (const file of files) {
      const arrayBuffer = new ArrayBuffer(file.buffer.byteLength);
      new Uint8Array(arrayBuffer).set(file.buffer);
      form.append(
        'images',
        new Blob([arrayBuffer], { type: file.mimetype }),
        file.originalname,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: this.token
          ? { Authorization: `Bearer ${this.token}` }
          : undefined,
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GatewayTimeoutException('OCR recognition timed out');
      }
      throw new ServiceUnavailableException(
        `OCR service unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new BadGatewayException('OCR service returned invalid JSON');
    }
    if (!response.ok) {
      if ([400, 401, 413, 415, 429].includes(response.status)) {
        throw new HttpException(payload ?? { message: text }, response.status);
      }
      throw new BadGatewayException({
        message: 'OCR service request failed',
        upstreamStatus: response.status,
        upstream: payload,
      });
    }

    const parsed = OcrBatchRecognitionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadGatewayException({
        message: 'OCR service returned an invalid response',
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }
}
