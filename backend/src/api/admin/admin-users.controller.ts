import { Controller, Get, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminUsersService } from '../../modules/admin/services/admin-users.service';

@Controller('admin/users')
@UseGuards(SharedSecretGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  async getAllUsers() {
    return this.adminUsersService.getAllUsers();
  }
}
