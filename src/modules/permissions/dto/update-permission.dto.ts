import { OmitType, PartialType } from '@nestjs/swagger';
import { CreatePermissionDto } from './create-permission.dto';

// PartialType：所有字段变可选（保留校验规则）
export class UpdatePermissionDto extends PartialType(
  // OmitType: 排除某些字段;  PickType: 只挑选某些字段
  OmitType(CreatePermissionDto, ['code']),
) {}
