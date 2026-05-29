import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import {
  SystemSettingsEntity,
  type SystemSettingsDocument,
} from './system-settings.schema';

const KEY = 'default';
// Hot path (JobService.create), so cache in-memory. setCabinetOnlyMode
// invalidates immediately; otherwise re-read every 5s as a fallback for
// the other backend replica's writes.
const CACHE_TTL_MS = 5_000;

export interface SystemSettings {
  cabinetOnlyMode: boolean;
}

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);
  private cached: SystemSettings | null = null;
  private cachedAt = 0;

  constructor(
    @InjectModel(SystemSettingsEntity.name)
    private readonly model: Model<SystemSettingsDocument>,
  ) {}

  async get(): Promise<SystemSettings> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cached;
    }
    const doc = await this.model.findOne({ key: KEY }).lean();
    const result: SystemSettings = {
      cabinetOnlyMode: doc?.cabinetOnlyMode ?? false,
    };
    this.cached = result;
    this.cachedAt = now;
    return result;
  }

  async setCabinetOnlyMode(value: boolean): Promise<SystemSettings> {
    await this.model.updateOne(
      { key: KEY },
      { $set: { cabinetOnlyMode: value } },
      { upsert: true },
    );
    this.cached = null;
    this.logger.log(`cabinetOnlyMode set to ${value}`);
    return this.get();
  }
}
