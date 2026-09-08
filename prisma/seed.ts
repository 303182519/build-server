import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEFAULT_ROLES } from '../src/common/constants/roles';
import { PERMISSIONS } from '../src/common/constants/permissions';

const prisma = new PrismaClient();

// ─── 简易雪花 ID 生成（seed 专用，仅需唯一，不需要完整雪花算法） ───
let snowflakeCounter = BigInt(Date.now());
function generateId(): bigint {
  return ++snowflakeCounter;
}

async function seedPermissions() {
  console.log('📦 开始初始化权限...');
  const permissionMap = new Map<string, { id: bigint; code: string }>();

  for (const perm of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { code: perm.code },
    });

    if (existing) {
      permissionMap.set(perm.code, existing);
      console.log(`  ⏭️  权限已存在: ${perm.code}`);
      continue;
    }

    const record = await prisma.permission.create({
      data: {
        id: generateId(),
        name: perm.name,
        code: perm.code,
      },
    });
    permissionMap.set(perm.code, record);
    console.log(`  ✅ 权限: ${perm.code}`);
  }

  return permissionMap;
}

async function seedRoles(
  permissionMap: Map<string, { id: bigint; code: string }>,
) {
  console.log('📦 开始初始化角色...');

  for (const roleDef of DEFAULT_ROLES) {
    const existingRole = await prisma.role.findUnique({
      where: { code: roleDef.code },
    });

    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name, description: roleDef.description },
      create: {
        id: existingRole?.id ?? generateId(),
        name: roleDef.name,
        description: roleDef.description,
        code: roleDef.code,
      },
    });
    console.log(`  ✅ 角色: ${roleDef.code}`);

    // 关联该角色应有的权限
    const permCodes = roleDef.permissions.map((p) => p.code);
    let linkedCount = 0;

    for (const code of permCodes) {
      const perm = permissionMap.get(code);
      if (!perm) continue;

      const exists = await prisma.rolePermissions.findUnique({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: perm.id },
        },
      });

      if (!exists) {
        await prisma.rolePermissions.create({
          data: { roleId: role.id, permissionId: perm.id },
        });
        linkedCount++;
      }
    }

    console.log(
      `  🔗 角色 ${roleDef.code} 关联 ${linkedCount} 个新权限（共 ${permCodes.length} 个）`,
    );
  }
}

async function seedAdminUser() {
  console.log('📦 开始初始化管理员用户...');

  const adminRole = await prisma.role.findUnique({
    where: { code: 'admin' },
  });
  if (!adminRole) {
    throw new Error('admin 角色不存在，请先初始化角色数据');
  }

  const adminEmail = 'admin@example.com';
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    console.log(`  ⏭️  管理员用户已存在: ${adminEmail}`);
    return;
  }

  const hashedPassword = await argon2.hash('Admin@123456');

  const adminUser = await prisma.user.create({
    data: {
      id: generateId(),
      email: adminEmail,
      username: 'admin',
      password: hashedPassword,
      specialRoles: 'admin',
    },
  });

  await prisma.userRoles.create({
    data: {
      userId: adminUser.id,
      roleId: adminRole.id,
    },
  });

  console.log(`  ✅ 管理员用户: ${adminEmail} (密码: Admin@123456)`);
}

async function main() {
  console.log('🌱 开始种子数据初始化...\n');

  const permissionMap = await seedPermissions();
  console.log('');

  await seedRoles(permissionMap);
  console.log('');

  await seedAdminUser();

  console.log('\n🌱 种子数据初始化完成！');
}

main()
  .catch((e) => {
    console.error('\n❌ 种子数据失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
