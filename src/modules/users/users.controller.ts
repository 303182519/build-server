import { PermissionCode } from '@/common/constants/permissions';
import {
  SpecialRoles,
  SpecialRolesEnum,
} from '@/common/decorators/special-roles.decorator';
import { Permission } from '@/common/decorators/permission.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CreateUserDto } from './dto/create-user.dto';
import { FindUsersDto } from './dto/find-users.dto';
import { UpdatePasswordByAdminDto } from './dto/update-password.dto';
import {
  UpdateUserDto,
  UpdateUserRolesDto,
  UpdateUserSpecialRolesDto,
} from './dto/update-user.dto';
import { UsersService } from './users.service';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';

@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({
    summary: '创建用户 - NeedPermission',
  })
  @Permission(PermissionCode.USER_CREATE)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @ApiOperation({
    summary: '获取所有用户 - NeedPermission?',
  })
  @Permission(PermissionCode.USER_READ)
  @Get()
  findAll(@Query() query: FindUsersDto) {
    return this.usersService.findAll(query);
  }

  @ApiOperation({
    summary: '获取用户',
  })
  @Permission(PermissionCode.USER_READ)
  @Get(':id')
  findOne(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.usersService.findOneOrThrow(
      { id },
      {
        roles: true, // 包含角色信息, 包含已删除角色
      },
    );
  }

  @ApiOperation({
    summary: '更新用户 - NeedPermission',
  })
  @Permission(PermissionCode.USER_UPDATE)
  @Patch(':id')
  update(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.usersService.update(id, updateUserDto);
  }

  @ApiOperation({
    summary: '更新用户特殊角色 - NeedSpecialRoles',
  })
  @SpecialRoles([SpecialRolesEnum.SuperAdmin])
  @Patch(':id/special-roles')
  updateSpecialRoles(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updateSpecialRolesDto: UpdateUserSpecialRolesDto,
  ) {
    return this.usersService.updateUserSpecialRoles(id, updateSpecialRolesDto);
  }

  @ApiOperation({
    summary: '更新用户角色 - NeedPermission',
  })
  @Permission(PermissionCode.USER_UPDATE)
  @Patch(':id/roles')
  updateRoles(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updateRolesDto: UpdateUserRolesDto,
  ) {
    return this.usersService.updateUserRoles(id, updateRolesDto);
  }

  @ApiOperation({
    summary: '更新用户密码 - NeedPermission',
  })
  @Permission(PermissionCode.USER_UPDATE)
  @Patch(':id/password')
  updatePassword(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updatePasswordDto: UpdatePasswordByAdminDto,
  ) {
    return this.usersService.updatePasswordByAdmin(id, updatePasswordDto);
  }

  @ApiOperation({
    summary: '删除用户 - NeedPermission',
  })
  @Permission(PermissionCode.USER_DELETE)
  @Delete(':id')
  remove(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.usersService.remove(id);
  }
}
