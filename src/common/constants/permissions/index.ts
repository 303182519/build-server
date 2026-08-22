import {
  PERMISSIONS_PERMISSIONS,
  PermissionsPermissionCode,
} from './permissions.permission';
import { ROLES_PERMISSIONS, RolesPermissionCode } from './roles.permission';
import { USERS_PERMISSIONS, UsersPermissionCode } from './users.permission';

export const PermissionCode = {
  ...UsersPermissionCode,
  ...RolesPermissionCode,
  ...PermissionsPermissionCode,
} as const;

export type PermissionCodeType =
  (typeof PermissionCode)[keyof typeof PermissionCode];

export const PERMISSIONS = [
  ...USERS_PERMISSIONS,
  ...ROLES_PERMISSIONS,
  ...PERMISSIONS_PERMISSIONS,
];
