import type { HydratedDocument } from 'mongoose';
export declare class UserEntity {
    friendCode: string;
}
export type UserDocument = HydratedDocument<UserEntity>;
export declare const UserSchema: import("mongoose").Schema<UserEntity, import("mongoose").Model<UserEntity, any, any, any, (import("mongoose").Document<unknown, any, UserEntity, any, import("mongoose").DefaultSchemaOptions> & UserEntity & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
} & {
    id: string;
}) | (import("mongoose").Document<unknown, any, UserEntity, any, import("mongoose").DefaultSchemaOptions> & UserEntity & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}), any, UserEntity>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, UserEntity, import("mongoose").Document<unknown, {}, UserEntity, {
    id: string;
}, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & Omit<UserEntity & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, "id"> & {
    id: string;
}, {
    friendCode?: import("mongoose").SchemaDefinitionProperty<string, UserEntity, import("mongoose").Document<unknown, {}, UserEntity, {
        id: string;
    }, import("mongoose").ResolveSchemaOptions<import("mongoose").DefaultSchemaOptions>> & Omit<UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }, "id"> & {
        id: string;
    }> | undefined;
}, UserEntity>;
