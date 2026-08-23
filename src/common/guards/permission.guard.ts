import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Permission } from '../decorators/permission.decorator';
import { SpecialRolesEnum } from '../decorators/special-roles.decorator';
import { PrismaService } from '@/shared/database/prisma/prisma.service';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly prisma: PrismaService,
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

    if (!user) {
      return false;
    }

    // 超级管理员拥有所有权限, 使用可选链模式避免报错
    if (user.specialRoles?.includes(SpecialRolesEnum.SuperAdmin)) {
      return true;
    }

    // 用 Prisma 单次深嵌套查询直接判断用户是否拥有目标权限：
    // Permission → RolePermissions → Role → UserRoles → User
    // 相比原先"先查角色再查权限"的两次往返，这里合并为一次 COUNT 查询，
    // 命中索引后直接返回 0/1，无需拉取权限列表到内存再做 some()。
    const count = await this.prisma.permission.count({
      where: {
        code: requiredPermission,
        deletedAt: null,
        rolePermissions: {
          some: {
            role: {
              deletedAt: null,
              users: {
                some: {
                  userId: user.id,
                },
              },
            },
          },
        },
      },
    });

    return count > 0;
  }
}
