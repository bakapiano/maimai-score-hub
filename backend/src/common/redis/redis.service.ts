import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';

export interface RedisStreamEntry {
  id: string;
  fields: Record<string, string>;
}

type RedisFieldValue = string | number | boolean | null | undefined;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: RedisClientType;
  private prefix = '';

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.prefix = this.config.get<string>('REDIS_KEY_PREFIX', 'maimai:');

    const url = this.getRedisUrl();
    this.client = createClient({ url });
    this.client.on('error', (err) => {
      this.logger.error(
        `Redis error: ${err instanceof Error ? err.message : err}`,
      );
    });

    await this.client.connect();
    await this.client.ping();
    this.logger.log(`Connected to Redis at ${this.redactRedisUrl(url)}`);
  }

  async onModuleDestroy() {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }

  key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  async setJson(
    key: string,
    value: unknown,
    options: { ttlSeconds?: number } = {},
  ): Promise<void> {
    const raw = JSON.stringify(value);
    if (options.ttlSeconds && options.ttlSeconds > 0) {
      await this.client.set(key, raw, {
        expiration: { type: 'EX', value: options.ttlSeconds },
      });
      return;
    }
    await this.client.set(key, raw);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async xAddMaxLen(
    streamKey: string,
    fields: Record<string, RedisFieldValue>,
    maxLen: number,
  ): Promise<string> {
    const args = ['XADD', streamKey];
    if (Number.isFinite(maxLen) && maxLen > 0) {
      args.push('MAXLEN', '~', String(Math.floor(maxLen)));
    }
    args.push('*');

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      args.push(key, value === null ? '' : String(value));
    }

    return await this.client.sendCommand(args);
  }

  async xRevRange(
    streamKey: string,
    count: number,
  ): Promise<RedisStreamEntry[]> {
    const raw = await this.client.sendCommand([
      'XREVRANGE',
      streamKey,
      '+',
      '-',
      'COUNT',
      String(Math.max(1, Math.floor(count))),
    ]);
    return this.parseStreamEntries(raw);
  }

  private getRedisUrl(): string {
    const explicit = this.config.get<string>('REDIS_URL');
    if (explicit) {
      return explicit;
    }

    const host = this.config.get<string>('REDIS_HOST', '127.0.0.1');
    const port = this.config.get<string>('REDIS_PORT', '6379');
    const db = this.config.get<string>('REDIS_DB', '0');
    const password = this.config.get<string>('REDIS_PASSWORD');
    const auth = password ? `:${encodeURIComponent(password)}@` : '';
    return `redis://${auth}${host}:${port}/${db}`;
  }

  private redactRedisUrl(url: string): string {
    return url.replace(/:\/\/:[^@]+@/, '://:<redacted>@');
  }

  private parseStreamEntries(raw: unknown): RedisStreamEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const entries: RedisStreamEntry[] = [];

    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 2) {
        continue;
      }
      const rowItems = row as unknown[];
      const id = String(rowItems[0]);
      const payload: unknown = rowItems[1];
      const fields: Record<string, string> = {};

      if (Array.isArray(payload)) {
        for (let i = 0; i + 1 < payload.length; i += 2) {
          fields[String(payload[i])] = String(payload[i + 1]);
        }
      } else if (payload && typeof payload === 'object') {
        for (const [key, value] of Object.entries(
          payload as Record<string, unknown>,
        )) {
          fields[key] = String(value);
        }
      }

      entries.push({ id, fields });
    }

    return entries;
  }
}
