"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobController = void 0;
const common_1 = require("@nestjs/common");
const job_service_1 = require("./job.service");
let JobController = class JobController {
    jobs;
    constructor(jobs) {
        this.jobs = jobs;
    }
    async create(body) {
        if (typeof body.friendCode !== 'string' || !body.friendCode) {
            throw new common_1.BadRequestException('friendCode is required');
        }
        if (body.skipUpdateScore !== undefined && typeof body.skipUpdateScore !== 'boolean') {
            throw new common_1.BadRequestException('skipUpdateScore must be a boolean');
        }
        return this.jobs.create({
            friendCode: body.friendCode,
            skipUpdateScore: body.skipUpdateScore ?? false,
        });
    }
    async get(jobId) {
        return this.jobs.get(jobId);
    }
    async next(res) {
        const job = await this.jobs.claimNext();
        if (!job) {
            res.status(204).send();
            return;
        }
        res.json(job);
    }
    async patch(jobId, body) {
        return this.jobs.patch(jobId, body);
    }
};
exports.JobController = JobController;
__decorate([
    (0, common_1.Post)('create'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], JobController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(':jobId'),
    __param(0, (0, common_1.Param)('jobId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], JobController.prototype, "get", null);
__decorate([
    (0, common_1.Post)('next'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], JobController.prototype, "next", null);
__decorate([
    (0, common_1.Patch)(':jobId'),
    __param(0, (0, common_1.Param)('jobId')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], JobController.prototype, "patch", null);
exports.JobController = JobController = __decorate([
    (0, common_1.Controller)('job'),
    __metadata("design:paramtypes", [job_service_1.JobService])
], JobController);
//# sourceMappingURL=job.controller.js.map