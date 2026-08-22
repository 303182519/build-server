import { PermissionCode } from '@/common/constants/permissions';
import {
  ApiEnvelope,
  ApiErrorEnvelope,
  ApiExceptionEnvelope,
} from '@/common/decorators/api-envelope.decorator';
import { DisabledEndpoint } from '@/common/decorators/disabled-endpoint.decorator';
import { Permission } from '@/common/decorators/permission.decorator';
import {
  PermissionExceptionCode,
  PermissionExceptionMap,
} from '@/common/exceptions/permission.exception';
import { ParseSnowflakePipe } from '@/common/pipes/parse-snowflake.pipe';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { PermissionResponseDto } from './dto/permission-response.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionsService } from './permissions.service';

// 路径参数 :id 的统一文档
const idParam = ApiParam({
  name: 'id',
  description: '权限雪花 ID',
});

@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  // 暂时应该不暴露创建权限的接口，权限似乎应该与程序一起发布和同步
  // @DisabledEndpoint()
  @ApiOperation({ summary: '创建权限' })
  @ApiEnvelope(PermissionResponseDto, { status: 201, description: '创建成功' })
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @Post()
  create(@Body() createPermissionDto: CreatePermissionDto) {
    return this.permissionsService.create(createPermissionDto);
  }

  @ApiOperation({ summary: '权限列表' })
  @ApiEnvelope(PermissionResponseDto, { isArray: true })
  @Permission(PermissionCode.PERMISSION_READ)
  @Get()
  findAll() {
    return this.permissionsService.findAll();
  }

  @ApiOperation({ summary: '按 id 查单条权限' })
  @idParam
  @ApiEnvelope(PermissionResponseDto)
  @ApiExceptionEnvelope(
    PermissionExceptionMap,
    PermissionExceptionCode.PERMISSION_NOT_FOUND,
  )
  @Permission(PermissionCode.PERMISSION_READ)
  @Get(':id')
  findOne(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.permissionsService.findOne(id);
  }

  @ApiOperation({ summary: '局部更新权限' })
  @idParam
  @ApiEnvelope(PermissionResponseDto)
  @ApiErrorEnvelope(400, '参数校验失败', 'VALIDATION_ERROR')
  @ApiExceptionEnvelope(
    PermissionExceptionMap,
    PermissionExceptionCode.PERMISSION_NOT_FOUND,
  )
  @Permission(PermissionCode.PERMISSION_UPDATE)
  @Patch(':id')
  update(
    @Param('id', ParseSnowflakePipe) id: bigint,
    @Body() updatePermissionDto: UpdatePermissionDto,
  ) {
    return this.permissionsService.update(id, updatePermissionDto);
  }

  @ApiOperation({
    summary: '软删除权限（已禁用）',
    deprecated: true,
    description: '权限不应被删除，权限应与程序一起发布和同步',
  })
  @idParam
  @ApiEnvelope(PermissionResponseDto)
  @ApiErrorEnvelope(403, '此接口已被禁用或正在开发中，暂时无法使用', 'ENDPOINT_DISABLED')
  @ApiExceptionEnvelope(
    PermissionExceptionMap,
    PermissionExceptionCode.PERMISSION_NOT_FOUND,
  )
  @DisabledEndpoint()
  @Delete(':id')
  remove(@Param('id', ParseSnowflakePipe) id: bigint) {
    return this.permissionsService.remove(id);
  }
}
