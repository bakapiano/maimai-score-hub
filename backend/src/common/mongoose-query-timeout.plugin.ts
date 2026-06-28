import type { Aggregate, Query, Schema } from 'mongoose';

export interface MongooseQueryTimeoutPluginOptions {
  readMaxTimeMS: number;
  aggregateMaxTimeMS: number;
  writeMaxTimeMS?: number;
}

const READ_QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
] as const;

const WRITE_QUERY_OPS = [
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const;

function isEnabled(ms: number | undefined): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

function setQueryMaxTimeMS(query: Query<unknown, unknown>, maxTimeMS: number) {
  const options = query.getOptions();
  if (options.maxTimeMS === null || options.maxTimeMS === undefined) {
    query.setOptions({ maxTimeMS });
  }
}

export function createMongooseQueryTimeoutPlugin(
  options: MongooseQueryTimeoutPluginOptions,
) {
  return function mongooseQueryTimeoutPlugin(schema: Schema) {
    if (isEnabled(options.readMaxTimeMS)) {
      for (const op of READ_QUERY_OPS) {
        schema.pre(op, function defaultReadMaxTimeMS() {
          setQueryMaxTimeMS(
            this as Query<unknown, unknown>,
            options.readMaxTimeMS,
          );
        });
      }
    }

    if (isEnabled(options.writeMaxTimeMS)) {
      for (const op of WRITE_QUERY_OPS) {
        schema.pre(op, function defaultWriteMaxTimeMS() {
          setQueryMaxTimeMS(
            this as Query<unknown, unknown>,
            options.writeMaxTimeMS!,
          );
        });
      }
    }

    if (isEnabled(options.aggregateMaxTimeMS)) {
      schema.pre('aggregate', function defaultAggregateMaxTimeMS() {
        const aggregate = this as Aggregate<unknown[]>;
        if (
          aggregate.options.maxTimeMS === null ||
          aggregate.options.maxTimeMS === undefined
        ) {
          aggregate.option({ maxTimeMS: options.aggregateMaxTimeMS });
        }
      });
    }
  };
}
