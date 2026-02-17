import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  IdleUpdateMarkReadyBodySchema,
  type IdleUpdateMarkReadyBody,
} from '@maimai-score-hub/shared';

import { UsersService } from '../../users/users.service';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

@Controller('job')
export class IdleUpdateController {
  constructor(private readonly users: UsersService) {}

  /**
   * Worker 调用：标记用户已 ready for 闲时更新
   */
  @Post('idle-update/mark-ready')
  @HttpCode(200)
  async markIdleUpdateReady(
    @Body(new ZodValidationPipe(IdleUpdateMarkReadyBodySchema))
    body: IdleUpdateMarkReadyBody,
  ) {
    const user = await this.users.findByFriendCode(body.friendCode);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    await this.users.update(String(user._id), {
      idleUpdateBotFriendCode: body.botFriendCode,
    });

    return { ok: true };
  }

  /**
   * 获取指定 bot 的闲时更新 friendCode 列表
   */
  @Get('idle-update/friends/:botFriendCode')
  async getIdleUpdateFriendCodes(
    @Param('botFriendCode') botFriendCode: string,
  ) {
    const users = await this.users.getIdleUpdateUsers();
    return users
      .filter((u) => u.idleUpdateBotFriendCode === botFriendCode)
      .map((u) => u.friendCode);
  }
}
