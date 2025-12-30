"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const config_1 = require("@nestjs/config");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const job_module_1 = require("./job/job.module");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const users_module_1 = require("./users/users.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            mongoose_1.MongooseModule.forRootAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => {
                    const host = config.get('MONGO_HOST', 'localhost');
                    const port = config.get('MONGO_PORT', '27017');
                    const db = config.get('MONGO_DB', 'maimai_web');
                    const user = config.get('MONGO_USER');
                    const password = config.get('MONGO_PASSWORD');
                    const authSource = config.get('MONGO_AUTH_SOURCE', 'admin');
                    if (!user || !password) {
                        throw new Error('MONGO_USER and MONGO_PASSWORD are required');
                    }
                    const creds = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
                    const uri = `mongodb://${creds}${host}:${port}/${db}?authSource=${encodeURIComponent(authSource)}`;
                    return { uri };
                },
            }),
            job_module_1.JobModule,
            users_module_1.UsersModule,
        ],
        controllers: [app_controller_1.AppController],
        providers: [app_service_1.AppService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map