import { GroupsService } from '@/modules/groups/groups.service';
import { User } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  GroupMemberRoles,
  GroupMemberRolesEnum,
} from '../decorators/group-member-roles.decorator';
import { Permission } from '../decorators/permission.decorator';
import { SpecialRolesEnum } from '../decorators/special-roles.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly groupsService: GroupsService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.get(
      Permission,
      context.getHandler(),
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    const user = request.user;

    // 超级管理员拥有所有权限, 使用可选链模式避免报错
    if (user?.specialRoles?.includes(SpecialRolesEnum.SuperAdmin)) {
      return true;
    }

    if (!user) {
      return false;
    }

    const permissions = await this.usersService.getPermissions(user.id);

    const hasPermission = permissions.some(
      (permission) => permission.code === requiredPermission,
    );

    if (hasPermission) {
      return true;
    }

    return false;
  }
}
