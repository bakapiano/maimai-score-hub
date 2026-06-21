import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }
}
