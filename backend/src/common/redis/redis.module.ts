import { Global, Module } from '@nestjs/common';

import { RedisLeaseService } from './redis-lease.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RedisLeaseService],
  exports: [RedisService, RedisLeaseService],
})
export class RedisModule {}
