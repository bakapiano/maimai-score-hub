import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

export class DxnetBotAssignmentBusyException extends ServiceUnavailableException {
  constructor(message = 'Bot assignment is busy; retry after 5 seconds') {
    super({ code: 'bot_assignment_busy', message });
  }
}

@Catch(DxnetBotAssignmentBusyException)
export class DxnetBotAssignmentBusyFilter implements ExceptionFilter {
  catch(exception: DxnetBotAssignmentBusyException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', '5');
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
