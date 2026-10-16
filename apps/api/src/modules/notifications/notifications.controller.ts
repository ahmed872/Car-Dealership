import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zPaginationQuery } from '@autohub/shared';
import { Authenticated, Ctx, TenantContext } from '../../common/context';
import { NotificationsService } from './notifications.service';

class NotificationListQueryDto extends createZodDto(zPaginationQuery.extend({ unread: z.enum(['true', 'false']).optional() })) {}

/** Each user sees only their own notifications. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Authenticated()
  list(@Ctx() ctx: TenantContext, @Query() q: NotificationListQueryDto) {
    return this.notifications.list(ctx, { unreadOnly: q.unread === 'true', page: q.page, pageSize: q.pageSize });
  }

  @Get('unread-count')
  @Authenticated()
  unread(@Ctx() ctx: TenantContext) {
    return this.notifications.unreadCount(ctx);
  }

  @Post('read-all')
  @HttpCode(200)
  @Authenticated()
  readAll(@Ctx() ctx: TenantContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Post(':id/read')
  @HttpCode(200)
  @Authenticated()
  read(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(ctx, id);
  }
}
