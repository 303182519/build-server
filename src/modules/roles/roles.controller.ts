import {
  ApiEnvelope,
  ApiErrorEnvelope,
  ApiExceptionEnvelope,
} from '@/common/decorators/api-envelope.decorator';
import { PermissionCode } from '@/common/constants/permissions';
import { Permission } from '@/common/decorators/permission.decorator';
import {
  PermissionExceptionCode,
  PermissionExceptionMap,
} from '@/common/exceptions/permission.exception';
import {
  RoleExceptionCode,
  RoleExceptionMap,
} from '@/common/exceptions/role.exception';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { CreateRoleDto } from './dto/create-role.dto';
import {
  RoleRemoveResponseDto,
  RoleResponseDto,
} from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

// 路径参数 :id 的统一文档
const idParam = ApiParam({
  name: 'id',
  description: '角色雪花 ID',
});

@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @ApiOperation({
    summary: '创建角色',
  })
  @ApiEnvelope(RoleResponseDto)
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiExceptionEnvelope(
    PermissionExceptionMap,
    PermissionExceptionCode.PERMISSION_NOT_FOUND,
  )
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_CODE_EXISTS)
  @Permission(PermissionCode.ROLE_CREATE)
  @Post()
  create(@Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.create(createRoleDto);
  }

  @ApiOperation({
    summary: '获取所有角色',
  })
  @ApiEnvelope(RoleResponseDto, { isArray: true })
  @Permission(PermissionCode.ROLE_READ)
  @Get()
  findAll() {
    return this.rolesService.findAll();
  }

  @ApiOperation({
    summary: '获取角色',
  })
  @idParam
  @ApiEnvelope(RoleResponseDto)
  @Permission(PermissionCode.ROLE_READ)
  @Get(':id')
  findOne(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.rolesService.findOne(id);
  }

  @ApiOperation({
    summary: '更新角色',
  })
  @idParam
  @ApiEnvelope(RoleResponseDto)
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_NOT_FOUND)
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_IS_SYSTEM)
  @ApiExceptionEnvelope(
    PermissionExceptionMap,
    PermissionExceptionCode.PERMISSION_NOT_FOUND,
  )
  @Permission(PermissionCode.ROLE_UPDATE)
  @Patch(':id')
  update(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updateRoleDto: UpdateRoleDto,
  ) {
    return this.rolesService.update(id, updateRoleDto);
  }

  @ApiOperation({
    summary: '删除角色',
  })
  @idParam
  @ApiEnvelope(RoleRemoveResponseDto)
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_NOT_FOUND)
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_IS_SYSTEM)
  @ApiExceptionEnvelope(RoleExceptionMap, RoleExceptionCode.ROLE_IN_USE)
  @Permission(PermissionCode.ROLE_DELETE)
  @Delete(':id')
  remove(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.rolesService.remove(id);
  }
}
