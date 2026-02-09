import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  JobApiLogEntity,
  type JobApiLogDocument,
} from './job-api-log.schema';

export interface ApiLogEntry {
  url: string;
  method: string;
  statusCode: number;
  responseBody?: string | null;
}

export interface ApiLogResponse {
  url: string;
  method: string;
  statusCode: number;
  responseBody: string | null;
  createdAt: string;
}

@Injectable()
export class JobApiLogService {
  constructor(
    @InjectModel(JobApiLogEntity.name)
    private readonly logModel: Model<JobApiLogDocument>,
  ) {}

  /**
   * 批量保存 API 调用日志
   */
  async saveLogs(jobId: string, logs: ApiLogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    const fallback = new Date();
    const docs = logs.map((log) => ({
      jobId,
      url: log.url,
      method: log.method,
      statusCode: log.statusCode,
      responseBody: log.responseBody ?? null,
      createdAt: fallback,
    }));

    await this.logModel.insertMany(docs);
  }

  /**
   * 获取某个 job 的 API 调用日志
   */
  async getLogsByJobId(jobId: string): Promise<ApiLogResponse[]> {
    const logs = await this.logModel
      .find({ jobId })
      .sort({ createdAt: 1 })
      .lean();

    return logs.map((log) => ({
      url: log.url,
      method: log.method,
      statusCode: log.statusCode,
      responseBody: log.responseBody,
      createdAt: log.createdAt.toISOString(),
    }));
  }
}
