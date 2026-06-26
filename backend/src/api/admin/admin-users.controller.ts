import { Controller, Get, UseGuards } from '@nestjs/common';

import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { AdminService } from '../../modules/admin/services/admin.service';

@Controller('admin/users')
@UseGuards(SharedSecretGuard)
export class AdminUsersController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }
}
