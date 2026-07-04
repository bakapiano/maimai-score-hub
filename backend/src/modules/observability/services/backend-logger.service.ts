import { ConsoleLogger, Injectable, type LogLevel } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ObservabilityIngestService } from './observability-ingest.service';
import { getObservabilityEnvironment } from './observability-env';

type BackendLogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

@Injectable()
export class BackendLoggerService extends ConsoleLogger {
  private readonly clickhouseEnabled: boolean;
  private readonly debugEnabled: boolean;
  private readonly instance: string;

  constructor(
    private readonly ingest: ObservabilityIngestService,
    config: ConfigService,
  ) {
    super();
    this.clickhouseEnabled =
      config.get<string>('BACKEND_LOG_CLICKHOUSE_ENABLED') !== 'false';
    this.debugEnabled =
      config.get<string>('BACKEND_LOG_DEBUG_ENABLED') === 'true';
    this.instance =
      config.get<string>('OBSERVABILITY_INSTANCE') ||
      config.get<string>('HOSTNAME') ||
      process.env.COMPUTERNAME ||
      'backend';
    getObservabilityEnvironment(config);
  }

  log(message: unknown, context?: string): void {
    super.log(message, context);
    this.record('log', message, undefined, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    super.error(message, stackOrContext, context);
    this.record('error', message, stackOrContext, context);
  }

  warn(message: unknown, context?: string): void {
    super.warn(message, context);
    this.record('warn', message, undefined, context);
  }

  debug(message: unknown, context?: string): void {
    super.debug(message, context);
    this.record('debug', message, undefined, context);
  }

  verbose(message: unknown, context?: string): void {
    super.verbose(message, context);
    this.record('verbose', message, undefined, context);
  }

  protected record(
    level: BackendLogLevel,
    message: unknown,
    stack?: string,
    context?: string,
  ): void {
    if (!this.shouldRecord(level)) {
      return;
    }
    try {
      this.ingest.recordStructuredLogs({
        service: 'backend',
        workerKind: 'backend',
        workerId: this.instance,
        entries: [
          {
            ts: new Date().toISOString(),
            level: level === 'verbose' ? 'debug' : level,
            message: formatLogMessage(message),
            eventName: context ?? '',
            errorClass: level === 'error' ? getErrorClass(message) : '',
            attrs: {
              ...(stack ? { stack: stack.slice(0, 4096) } : {}),
              ...(context ? { context } : {}),
            },
          },
        ],
      });
    } catch (err) {
      console.warn(
        `[BackendLoggerService] failed to record log: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private shouldRecord(level: LogLevel | BackendLogLevel): boolean {
    if (!this.clickhouseEnabled) {
      return false;
    }
    return (
      level === 'log' ||
      level === 'warn' ||
      level === 'error' ||
      (this.debugEnabled && (level === 'debug' || level === 'verbose'))
    );
  }
}

function formatLogMessage(message: unknown): string {
  if (message instanceof Error) {
    return message.stack || message.message;
  }
  if (typeof message === 'string') {
    return message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function getErrorClass(message: unknown): string {
  if (message instanceof Error) {
    return message.name || 'Error';
  }
  return 'Error';
}
