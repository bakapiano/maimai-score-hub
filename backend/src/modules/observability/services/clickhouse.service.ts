import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { getPositiveInt, isObservabilityEnabled } from './observability-env';

const CLICKHOUSE_TABLES = [
  'http_requests',
  'frontend_rum',
  'analytics_events',
  'structured_logs',
  'external_api_calls',
  'job_timeline_events',
] as const;

export type ClickHouseTable = (typeof CLICKHOUSE_TABLES)[number];
export type ClickHouseRow = Record<string, unknown>;

interface ClickHouseStatus {
  enabled: boolean;
  urlConfigured: boolean;
  database: string;
  bufferedRows: number;
  droppedRows: number;
  insertedRows: number;
  lastInsertAt: string | null;
  lastError: string | null;
}

@Injectable()
export class ClickHouseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClickHouseService.name);
  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly database: string;
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly flushIntervalMs: number;
  private readonly maxBatchRows: number;
  private readonly maxBufferedRows: number;
  private readonly buffers = new Map<ClickHouseTable, ClickHouseRow[]>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private droppedRows = 0;
  private insertedRows = 0;
  private lastInsertAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.url = config.get<string>('CLICKHOUSE_URL') || null;
    this.database = config.get<string>(
      'CLICKHOUSE_DATABASE',
      'maimai_observability',
    );
    this.username = config.get<string>('CLICKHOUSE_USER') || null;
    this.password = config.get<string>('CLICKHOUSE_PASSWORD') || null;
    this.enabled = isObservabilityEnabled(config) && Boolean(this.url);
    this.flushIntervalMs = getPositiveInt(
      config,
      'CLICKHOUSE_FLUSH_INTERVAL_MS',
      3000,
    );
    this.maxBatchRows = getPositiveInt(
      config,
      'CLICKHOUSE_MAX_BATCH_ROWS',
      1000,
    );
    this.maxBufferedRows = getPositiveInt(
      config,
      'CLICKHOUSE_MAX_BUFFERED_ROWS',
      50_000,
    );
    for (const table of CLICKHOUSE_TABLES) {
      this.buffers.set(table, []);
    }
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('ClickHouse observability disabled');
      return;
    }
    this.flushTimer = setInterval(() => {
      this.flushAll().catch((err) => this.rememberError(err));
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
    this.logger.log(
      `ClickHouse observability enabled for database ${this.database}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flushAll();
  }

  insert(table: ClickHouseTable, rows: ClickHouseRow[]): void {
    if (!this.enabled || rows.length === 0) {
      return;
    }
    const buffer = this.buffers.get(table);
    if (!buffer) {
      this.droppedRows += rows.length;
      this.lastError = `unknown table ${table}`;
      return;
    }
    const totalBuffered = this.getBufferedRows();
    if (totalBuffered + rows.length > this.maxBufferedRows) {
      this.droppedRows += rows.length;
      this.lastError = 'clickhouse buffer full';
      return;
    }
    buffer.push(...rows);
    if (buffer.length >= this.maxBatchRows) {
      this.flushTable(table).catch((err) => this.rememberError(err));
    }
  }

  async query<T>(
    sql: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T[]> {
    if (!this.enabled || !this.url) {
      return [];
    }
    const result = await this.request(`${sql.trim()}\nFORMAT JSON`, params);
    const parsed = JSON.parse(result) as { data?: T[] };
    return Array.isArray(parsed.data) ? parsed.data : [];
  }

  async ping(): Promise<boolean> {
    if (!this.enabled || !this.url) {
      return false;
    }
    try {
      const response = await fetch(new URL('/ping', this.url), {
        headers: this.authHeaders(),
      });
      return response.ok && (await response.text()).trim() === 'Ok.';
    } catch (err) {
      this.rememberError(err);
      return false;
    }
  }

  getStatus(): ClickHouseStatus {
    return {
      enabled: this.enabled,
      urlConfigured: Boolean(this.url),
      database: this.database,
      bufferedRows: this.getBufferedRows(),
      droppedRows: this.droppedRows,
      insertedRows: this.insertedRows,
      lastInsertAt: this.lastInsertAt,
      lastError: this.lastError,
    };
  }

  private async flushAll(): Promise<void> {
    if (!this.enabled || this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      for (const table of CLICKHOUSE_TABLES) {
        await this.flushTable(table);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flushTable(table: ClickHouseTable): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const buffer = this.buffers.get(table);
    if (!buffer?.length) {
      return;
    }
    const rows = buffer.splice(0, this.maxBatchRows);
    try {
      await this.insertRows(table, rows);
      this.insertedRows += rows.length;
      this.lastInsertAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.rememberError(err);
      this.droppedRows += rows.length;
    }
  }

  private async insertRows(
    table: ClickHouseTable,
    rows: ClickHouseRow[],
  ): Promise<void> {
    const body = [
      `INSERT INTO ${table} FORMAT JSONEachRow`,
      rows.map((row) => JSON.stringify(row)).join('\n'),
    ].join('\n');
    await this.request(body);
  }

  private async request(
    body: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<string> {
    if (!this.url) {
      throw new Error('CLICKHOUSE_URL is not configured');
    }
    const url = new URL('/', this.url);
    url.searchParams.set('database', this.database);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(`param_${key}`, String(value));
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'text/plain; charset=utf-8',
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `ClickHouse HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return text;
  }

  private authHeaders(): Record<string, string> {
    if (!this.username) {
      return {};
    }
    const token = Buffer.from(
      `${this.username}:${this.password ?? ''}`,
      'utf8',
    ).toString('base64');
    return { authorization: `Basic ${token}` };
  }

  private getBufferedRows(): number {
    let total = 0;
    for (const rows of this.buffers.values()) {
      total += rows.length;
    }
    return total;
  }

  private rememberError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = message;
    this.logger.warn(`ClickHouse observability write failed: ${message}`);
  }
}
