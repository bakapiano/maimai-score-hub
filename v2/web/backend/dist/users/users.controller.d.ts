import { UsersService } from './users.service';
export declare class UsersController {
    private readonly users;
    constructor(users: UsersService);
    list(): Promise<(import("./user.schema").UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    })[]>;
    get(id: string): Promise<import("./user.schema").UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    create(body: {
        friendCode?: unknown;
    }): Promise<import("./user.schema").UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    update(id: string, body: {
        friendCode?: unknown;
    }): Promise<import("./user.schema").UserEntity & {
        _id: import("mongoose").Types.ObjectId;
    } & {
        __v: number;
    }>;
    remove(id: string): Promise<{
        deleted: boolean;
    }>;
}
