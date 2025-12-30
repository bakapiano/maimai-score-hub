import type { JobStage, JobStatus } from './job.types';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';
export declare class JobEntity {
    id: string;
    friendCode: string;
    skipUpdateScore: boolean;
    botUserFriendCode: string | null;
    status: JobStatus;
    stage: JobStage;
    result?: any;
    error: string | null;
    executing: boolean;
    retryCount: number;
    nextRetryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}
export type JobDocument = HydratedDocument<JobEntity>;
export declare const JobSchema: MongooseSchema<JobEntity, import("mongoose").Model<JobEntity, any, any, any, import("mongoose").Document<unknown, any, JobEntity, any, import("mongoose").DefaultSchemaOptions> & JobEntity & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any, JobEntity>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, {
    id?: import("mongoose").SchemaDefinitionProperty<string, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    friendCode?: import("mongoose").SchemaDefinitionProperty<string, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    skipUpdateScore?: import("mongoose").SchemaDefinitionProperty<boolean, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    botUserFriendCode?: import("mongoose").SchemaDefinitionProperty<string | null, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    status?: import("mongoose").SchemaDefinitionProperty<JobStatus, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    stage?: import("mongoose").SchemaDefinitionProperty<JobStage, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    result?: import("mongoose").SchemaDefinitionProperty<any, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    error?: import("mongoose").SchemaDefinitionProperty<string | null, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    executing?: import("mongoose").SchemaDefinitionProperty<boolean, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    retryCount?: import("mongoose").SchemaDefinitionProperty<number, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    nextRetryAt?: import("mongoose").SchemaDefinitionProperty<Date | null, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    createdAt?: import("mongoose").SchemaDefinitionProperty<Date, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
    updatedAt?: import("mongoose").SchemaDefinitionProperty<Date, JobEntity, import("mongoose").Document<unknown, {}, JobEntity, {}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & JobEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }> | undefined;
}, JobEntity>;
