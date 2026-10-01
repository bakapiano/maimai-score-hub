import { json } from 'express';

/** Limit is applied to the inflated body too; DTOs additionally bound score rows. */
export function createJsonBodyParser(limit = '100mb') {
  return json({ limit, inflate: true });
}
