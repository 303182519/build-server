import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { RolesModule } from '../roles/roles.module';
import { AccountController } from './account.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [RolesModule, PermissionsModule],
  controllers: [UsersController, AccountController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
