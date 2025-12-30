import type { Model } from 'mongoose';
import { UserEntity } from './user.schema';
export declare class UsersService {
    private readonly userModel;
    constructor(userModel: Model<UserEntity>);
    list(): Promise<(UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    })[]>;
    getById(id: string): Promise<UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    create(input: {
        friendCode: string;
    }): Promise<UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    update(id: string, input: {
        friendCode: string;
    }): Promise<UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    remove(id: string): Promise<{
        deleted: boolean;
    }>;
}
