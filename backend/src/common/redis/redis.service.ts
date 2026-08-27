import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type RedisClientType } from 'redis';

export interface RedisLeakyBucketResult {
  allowed: boolean;
  retryAfterMs: number;
}

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

  async getDelJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.getDel(key);
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

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, value, {
      condition: 'NX',
      expiration: { type: 'PX', value: ttlMs },
    });
    return result === 'OK';
  }

  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const result = await this.client.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
      { keys: [key], arguments: [String(ttlSeconds)] },
    );
    return Number(result);
  }

  async increment(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async tryAcquireLeakyBucket(
    key: string,
    intervalMs: number,
    burst: number,
  ): Promise<RedisLeakyBucketResult> {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error('Leaky bucket intervalMs must be positive');
    }
    if (!Number.isInteger(burst) || burst <= 0) {
      throw new Error('Leaky bucket burst must be a positive integer');
    }
    const result = await this.client.eval(
      [
        "local t = redis.call('TIME')",
        'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)',
        'local interval = tonumber(ARGV[1])',
        'local burst = tonumber(ARGV[2])',
        "local tat = tonumber(redis.call('GET', KEYS[1])) or now",
        'if tat < now then tat = now end',
        'local allow_at = tat - ((burst - 1) * interval)',
        'if now < allow_at then return {0, math.ceil(allow_at - now)} end',
        'local next_tat = tat + interval',
        'local ttl = math.ceil(math.max(interval * burst * 2, 1000))',
        "redis.call('PSETEX', KEYS[1], ttl, tostring(next_tat))",
        'return {1, 0}',
      ].join('\n'),
      {
        keys: [key],
        arguments: [String(intervalMs), String(burst)],
      },
    );
    const values = Array.isArray(result) ? result : [0, intervalMs];
    return {
      allowed: Number(values[0]) === 1,
      retryAfterMs: Math.max(0, Number(values[1]) || 0),
    };
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
    const result = await this.client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [expectedValue] },
    );
    return Number(result) > 0;
  }

  async compareAndPExpire(
    key: string,
    expectedValue: string,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.client.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
      { keys: [key], arguments: [expectedValue, String(ttlMs)] },
    );
    return Number(result) > 0;
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
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
}
