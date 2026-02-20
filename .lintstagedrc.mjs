import path from 'node:path';

const toRelative = (dir, files) =>
  files.map((f) => path.relative(dir, f).replace(/\\/g, '/')).join(' ');

/** @type {import('lint-staged').Config} */
export default {
  'frontend/src/**/*.{ts,tsx}': (files) => [
    `cd frontend && npx eslint --no-warn-ignored ${toRelative('frontend', files)}`,
    'cd frontend && npx tsc -b --noEmit',
  ],
  'backend/src/**/*.ts': (files) => [
    `cd backend && npx eslint --no-warn-ignored ${toRelative('backend', files)}`,
    'cd backend && npx tsc --noEmit',
  ],
  'shared/src/**/*.ts': () => 'cd shared && npx tsc --noEmit',
};
