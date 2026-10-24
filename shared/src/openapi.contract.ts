import { initContract } from '@ts-rest/core';

import {
  adminContract,
  androidAppReleaseContract,
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
  statsCardContract,
} from './modules';

const c = initContract();

export const openApiContract = c.router({
  androidAppRelease: androidAppReleaseContract,
  app: appContract,
  auth: authContract,
  users: usersContract,
  statsCard: statsCardContract,
  sync: syncContract,
  job: jobContract,
  music: musicContract,
  admin: adminContract,
  cover: coverContract,
  scoreExport: scoreExportContract,
  sdgbWorker: sdgbWorkerContract,
  observability: observabilityContract,
});
