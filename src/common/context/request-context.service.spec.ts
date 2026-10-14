import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import type { User } from '@prisma/client';
import { RequestContextService } from './request-context.service';
import type { AppClsStore } from './cls-store';

/**
 * 门面单元测试（ADR-005）。
 *
 * 覆盖迁移前后的行为等价点：
 * - 「读」在无上下文时返回空值且不抛错；
 * - 「写」在无上下文时静默忽略（降级哲学）；
 * - requireUser / isRequestUser 在无上下文时抛错（供业务 try/catch 降级）；
 * - 有上下文时写入可被正确读出。
 */
function createService() {
  const als = new AsyncLocalStorage<AppClsStore>();
  const cls = new ClsService<AppClsStore>(als);
  return { cls, service: new RequestContextService(cls) };
}

const fakeUser = { id: 7n, username: 'tester' } as unknown as User;

describe('RequestContextService', () => {
  it('无上下文时读操作返回空值且不抛错', () => {
    const { service } = createService();

    expect(service.getUser()).toBeUndefined();
    expect(service.getRequestId()).toBeUndefined();
    expect(service.getBizCode()).toBeUndefined();
    expect(service.getCacheState()).toEqual({
      cache: undefined,
      cacheKey: undefined,
    });
  });

  it('无上下文时写操作静默忽略（不抛错）', () => {
    const { service } = createService();

    expect(() => service.setUser(fakeUser)).not.toThrow();
    expect(() => service.setRequestId('rid')).not.toThrow();
    expect(() => service.setBizCode('MMS01')).not.toThrow();
    expect(() => service.setCacheState('HIT', 'key')).not.toThrow();
  });

  it('无上下文时 requireUser / isRequestUser 抛错', () => {
    const { service } = createService();

    expect(() => service.requireUser()).toThrow();
    expect(() => service.isRequestUser('7')).toThrow();
  });

  it('有上下文时写入可被读出，且用户判定正确', () => {
    const { cls, service } = createService();

    cls.run(() => {
      service.setUser(fakeUser);
      service.setRequestId('rid-1');
      service.setBizCode('MMS01');
      service.setCacheState('MISS', 'k1');

      expect(service.getUser()).toBe(fakeUser);
      expect(service.requireUser()).toBe(fakeUser);
      expect(service.getRequestId()).toBe('rid-1');
      expect(service.getBizCode()).toBe('MMS01');
      expect(service.getCacheState()).toEqual({
        cache: 'MISS',
        cacheKey: 'k1',
      });
      expect(service.isRequestUser('7')).toBe(true);
      expect(service.isRequestUser('8')).toBe(false);
    });
  });
});
