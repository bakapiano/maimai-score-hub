import { initContract } from '@ts-rest/core';

import {
  adminContract,
  appContract,
  authContract,
  coverContract,
  jobContract,
  musicContract,
  observabilityContract,
  scoreExportContract,
  sdgbWorkerContract,
  syncContract,
  usersContract,
} from './modules';

const c = initContract();

export const openApiContract = c.router({
  app: appContract,
  auth: authContract,
  users: usersContract,
  sync: syncContract,
  job: jobContract,
  music: musicContract,
  admin: adminContract,
  cover: coverContract,
  scoreExport: scoreExportContract,
  sdgbWorker: sdgbWorkerContract,
  observability: observabilityContract,
});
