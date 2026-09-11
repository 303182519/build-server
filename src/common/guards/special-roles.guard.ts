import { matchRoles } from '@/shared/utils/roles';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { SpecialRoles } from '../decorators/special-roles.decorator';

@Injectable()
export class SpecialRolesGuard implements CanActivate {
  private readonly logger = new Logger(SpecialRolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get(
      SpecialRoles,
      context.getHandler(),
    );

    this.logger.debug(
      `权限校验 requiredSpecialRoles=${JSON.stringify(requiredRoles)}`,
    );

    if (!requiredRoles) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    const user = request.user;

    if (!user || !user.specialRoles) {
      return false;
    }

    return matchRoles(requiredRoles, [user.specialRoles]);
  }
}
