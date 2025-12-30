import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
} from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list() {
    return this.users.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.users.getById(id);
  }

  @Post()
  async create(@Body() body: { friendCode?: unknown }) {
    if (typeof body.friendCode !== 'string' || !body.friendCode.trim()) {
      throw new BadRequestException('friendCode is required');
    }

    return this.users.create({ friendCode: body.friendCode.trim() });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { friendCode?: unknown },
  ) {
    if (typeof body.friendCode !== 'string' || !body.friendCode.trim()) {
      throw new BadRequestException('friendCode is required');
    }

    return this.users.update(id, { friendCode: body.friendCode.trim() });
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
