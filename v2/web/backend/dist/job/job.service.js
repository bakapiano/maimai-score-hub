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
exports.JobService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const crypto_1 = require("crypto");
const job_schema_1 = require("./job.schema");
function toJobResponse(job) {
    return {
        id: job.id,
        friendCode: job.friendCode,
        skipUpdateScore: job.skipUpdateScore,
        botUserFriendCode: job.botUserFriendCode ?? null,
        status: job.status,
        stage: job.stage,
        result: job.result,
        error: job.error ?? null,
        executing: job.executing,
        retryCount: job.retryCount,
        nextRetryAt: job.nextRetryAt ? job.nextRetryAt.toISOString() : null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
    };
}
const VALID_STATUS = [
    'queued',
    'processing',
    'completed',
    'failed',
];
const VALID_STAGE = [
    'send_request',
    'wait_acceptance',
    'update_score',
];
let JobService = class JobService {
    jobModel;
    constructor(jobModel) {
        this.jobModel = jobModel;
    }
    async create(input) {
        const id = (0, crypto_1.randomUUID)();
        const now = new Date();
        const created = await this.jobModel.create({
            id,
            friendCode: input.friendCode,
            skipUpdateScore: input.skipUpdateScore,
            botUserFriendCode: null,
            status: 'queued',
            stage: 'send_request',
            retryCount: 0,
            executing: false,
            nextRetryAt: null,
            error: null,
            result: undefined,
            createdAt: now,
            updatedAt: now,
        });
        return { jobId: id, job: toJobResponse(created.toObject()) };
    }
    async get(jobId) {
        const job = await this.jobModel.findOne({ id: jobId });
        if (!job) {
            throw new common_1.NotFoundException('Job not found');
        }
        return toJobResponse(job.toObject());
    }
    async claimNext() {
        const now = new Date();
        const query = {
            $and: [
                { status: { $in: ['queued', 'processing'] } },
                { $or: [{ executing: false }, { executing: { $exists: false } }] },
                {
                    $or: [
                        { nextRetryAt: null },
                        { nextRetryAt: { $exists: false } },
                        { nextRetryAt: { $lte: now } },
                    ],
                },
            ],
        };
        const updatePipeline = [
            {
                $set: {
                    executing: true,
                    updatedAt: now,
                    status: {
                        $cond: [{ $eq: ['$status', 'queued'] }, 'processing', '$status'],
                    },
                    stage: {
                        $cond: [{ $eq: ['$status', 'queued'] }, 'send_request', '$stage'],
                    },
                },
            },
        ];
        const claimed = await this.jobModel.findOneAndUpdate(query, updatePipeline, {
            sort: { createdAt: 1 },
            new: true,
            updatePipeline: true,
        });
        if (!claimed) {
            return null;
        }
        return toJobResponse(claimed.toObject());
    }
    async patch(jobId, body) {
        const update = {};
        if (body.botUserFriendCode !== undefined) {
            if (body.botUserFriendCode !== null && typeof body.botUserFriendCode !== 'string') {
                throw new common_1.BadRequestException('botUserFriendCode must be a string or null');
            }
            update.botUserFriendCode = body.botUserFriendCode;
        }
        if (body.status !== undefined) {
            if (!VALID_STATUS.includes(body.status)) {
                throw new common_1.BadRequestException('Invalid status value');
            }
            update.status = body.status;
        }
        if (body.stage !== undefined) {
            if (!VALID_STAGE.includes(body.stage)) {
                throw new common_1.BadRequestException('Invalid stage value');
            }
            update.stage = body.stage;
        }
        if (body.result !== undefined) {
            update.result = body.result;
        }
        if (body.error !== undefined) {
            if (body.error !== null && typeof body.error !== 'string') {
                throw new common_1.BadRequestException('error must be a string or null');
            }
            update.error = body.error;
        }
        if (body.executing !== undefined) {
            if (typeof body.executing !== 'boolean') {
                throw new common_1.BadRequestException('executing must be a boolean');
            }
            update.executing = body.executing;
        }
        if (body.retryCount !== undefined) {
            if (typeof body.retryCount !== 'number' || Number.isNaN(body.retryCount)) {
                throw new common_1.BadRequestException('retryCount must be a number');
            }
            update.retryCount = body.retryCount;
        }
        if (body.nextRetryAt !== undefined) {
            if (body.nextRetryAt === null) {
                update.nextRetryAt = null;
            }
            else if (typeof body.nextRetryAt === 'string') {
                const parsed = new Date(body.nextRetryAt);
                if (Number.isNaN(parsed.getTime())) {
                    throw new common_1.BadRequestException('nextRetryAt must be a valid ISO date');
                }
                update.nextRetryAt = parsed;
            }
            else {
                throw new common_1.BadRequestException('nextRetryAt must be null or ISO string');
            }
        }
        if (body.updatedAt !== undefined) {
            if (typeof body.updatedAt !== 'string') {
                throw new common_1.BadRequestException('updatedAt must be an ISO string');
            }
            const parsed = new Date(body.updatedAt);
            if (Number.isNaN(parsed.getTime())) {
                throw new common_1.BadRequestException('updatedAt must be a valid ISO date');
            }
            update.updatedAt = parsed;
        }
        else {
            update.updatedAt = new Date();
        }
        const updated = await this.jobModel.findOneAndUpdate({ id: jobId }, { $set: update }, { new: true });
        if (!updated) {
            throw new common_1.NotFoundException('Job not found');
        }
        return toJobResponse(updated.toObject());
    }
};
exports.JobService = JobService;
exports.JobService = JobService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(job_schema_1.JobEntity.name)),
    __metadata("design:paramtypes", [Function])
], JobService);
//# sourceMappingURL=job.service.js.map