import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import type {
  CabinetFriendshipStatus,
  PrepareCabinetFriendshipBody,
} from '@maimai-score-hub/shared';
import { BotStatusService } from '../../bots/services/bot-status.service';
import { SdgbJobDispatcher } from '../../sdgb-worker/services/sdgb-job.dispatcher';
import type { SdgbJobView } from '../../sdgb-worker/services/sdgb-job.view';
import { JobEntity } from '../schemas/job.schema';
import { JobFriendshipService } from './job-friendship.service';
import { DxnetBotAssignmentBusyException } from '../dxnet-job.exceptions';
import {
  QrLoginAttemptEntity,
  type QrLoginAttemptDocument,
} from '../../auth/schemas/qr-login-attempt.schema';

@Injectable()
export class DxnetCabinetPreparationService {
  constructor(
    @InjectModel(JobEntity.name)
    private readonly jobs: Model<JobEntity>,
    private readonly friendship: JobFriendshipService,
    private readonly bots: BotStatusService,
    private readonly sdgb: SdgbJobDispatcher,
    @InjectModel(QrLoginAttemptEntity.name)
    private readonly identityAttempts: Model<QrLoginAttemptDocument>,
  ) {}

  async prepare(jobId: string, body: PrepareCabinetFriendshipBody) {
    let job = await this.jobs.findOne({ id: jobId }).lean<JobEntity>();
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    this.assertExecution(job, body.execution);
    const currentStatus = job.cabinetFriendship?.status ?? 'not_required';
    if (isPreparedStatus(currentStatus)) {
      return { status: currentStatus };
    }

    const botFriendCode = job.botUserFriendCode;
    if (!botFriendCode) {
      throw new ConflictException({ code: 'invalid_route' });
    }
    const [targetCabinetUserId, bot] = await Promise.all([
      this.resolveTargetCabinetUserId(job),
      this.bots.getByFriendCode(botFriendCode),
    ]);
    if (targetCabinetUserId === null || bot?.cabinetUserId === null || !bot) {
      throw new ConflictException({
        code: 'bot_ineligible',
        reason: 'cabinet_binding',
      });
    }

    try {
      const sdgbJobId = await this.enqueueOrReuseAddRival(
        job,
        body.execution,
        botFriendCode,
        bot.cabinetUserId,
        targetCabinetUserId,
      );
      const running = await this.jobs.findOneAndUpdate(
        this.executionFilter(job, body.execution),
        {
          $set: {
            'cabinetFriendship.status': 'running',
            'cabinetFriendship.sdgbJobId': sdgbJobId,
            'cabinetFriendship.lastError': null,
            updatedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!running) {
        throw new ConflictException({ code: 'stale_execution' });
      }
      job = running.toObject() as JobEntity;
      const terminal = await this.sdgb.waitForTerminal(sdgbJobId, {
        timeoutMs: 90_000,
      });
      return this.applyTerminal(job, body.execution, terminal);
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof GoneException
      ) {
        throw error;
      }
      await this.jobs.updateOne(this.executionFilter(job, body.execution), {
        $set: {
          'cabinetFriendship.lastError': errorMessage(error),
          updatedAt: new Date(),
        },
      });
      throw new DxnetBotAssignmentBusyException(
        'Cabinet prerequisite is temporarily unavailable',
      );
    }
  }

  private async resolveTargetCabinetUserId(
    job: JobEntity,
  ): Promise<number | null> {
    const identityAttemptId =
      typeof job.context?.identityAttemptId === 'string'
        ? job.context.identityAttemptId
        : null;
    if (identityAttemptId) {
      const attempt = await this.identityAttempts
        .findOne({ id: identityAttemptId })
        .lean();
      return attempt?.cabinetUserId ?? null;
    }
    return job.friendCode
      ? this.friendship.getTargetCabinetUserId(job.friendCode)
      : null;
  }

  private async enqueueOrReuseAddRival(
    job: JobEntity,
    execution: PrepareCabinetFriendshipBody['execution'],
    botFriendCode: string,
    botCabinetUserId: number,
    targetCabinetUserId: number,
  ): Promise<string> {
    if (
      job.cabinetFriendship?.sdgbJobId &&
      job.cabinetFriendship.botFriendCode === botFriendCode
    ) {
      return job.cabinetFriendship.sdgbJobId;
    }
    const idempotencyKey = `dxnet:${job.id}:delivery:${execution.deliveryEpoch}:bot:${botFriendCode}:add-rival`;
    const enqueued = await this.sdgb.enqueueAddRival(
      { botCabinetUserId, targetCabinetUserId },
      {
        idempotencyKey,
        tag: `dxnet-prepare:${job.id}`,
        priority: job.priority,
        timeoutMs: 90_000,
      },
    );
    return enqueued.id;
  }

  private async applyTerminal(
    job: JobEntity,
    execution: PrepareCabinetFriendshipBody['execution'],
    terminal: SdgbJobView,
  ): Promise<{ status: CabinetFriendshipStatus }> {
    let status: CabinetFriendshipStatus;
    let errorCode: string | null = null;
    if (terminal.status === 'completed') {
      const code1 = terminal.result?.returnCode1;
      const code2 = terminal.result?.returnCode2;
      status =
        Number.isInteger(code1) &&
        Number(code1) >= 0 &&
        Number.isInteger(code2) &&
        Number(code2) >= 0
          ? 'ready'
          : 'uncertain';
    } else if (
      terminal.outcomeUnknown ||
      terminal.failureClass === 'outcome_unknown' ||
      terminal.failureClass === 'invalid_response'
    ) {
      status = 'uncertain';
    } else {
      status = 'failed';
      errorCode = 'cabinet_friendship_failed';
    }
    const set: Record<string, unknown> = {
      'cabinetFriendship.status': status,
      'cabinetFriendship.lastError': terminal.error ?? null,
      updatedAt: new Date(),
    };
    if (status === 'failed') {
      set.status = 'failed';
      set.errorCode = errorCode;
      set.error = terminal.error ?? 'Cabinet friendship preparation failed';
      set.runAt = null;
    }
    const updated = await this.jobs.findOneAndUpdate(
      this.executionFilter(job, execution),
      { $set: set },
      { new: true },
    );
    if (!updated) {
      throw new ConflictException({ code: 'stale_execution' });
    }
    return { status };
  }

  private assertExecution(
    job: JobEntity,
    execution: PrepareCabinetFriendshipBody['execution'],
  ): void {
    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      throw new GoneException({ code: 'job_terminal' });
    }
    if (job.deadlineAt && job.deadlineAt.getTime() <= Date.now()) {
      throw new GoneException({ code: 'job_terminal' });
    }
    if (
      job.routing?.version !== 2 ||
      job.routing.deliveryEpoch !== execution.deliveryEpoch ||
      !job.execution ||
      job.execution.deliveryEpoch !== execution.deliveryEpoch ||
      job.execution.attemptsStarted !== execution.attemptsStarted ||
      job.execution.workerId !== execution.workerId
    ) {
      throw new ConflictException({ code: 'stale_execution' });
    }
  }

  private executionFilter(
    job: JobEntity,
    execution: PrepareCabinetFriendshipBody['execution'],
  ): Record<string, unknown> {
    return {
      id: job.id,
      status: { $nin: ['completed', 'failed', 'canceled'] },
      'routing.deliveryEpoch': execution.deliveryEpoch,
      'execution.deliveryEpoch': execution.deliveryEpoch,
      'execution.attemptsStarted': execution.attemptsStarted,
      'execution.workerId': execution.workerId,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPreparedStatus(status: CabinetFriendshipStatus): boolean {
  return ['not_required', 'ready', 'uncertain', 'failed'].includes(status);
}
