import { User } from '@prisma/client';
import type { Request as ExpressRequest } from 'express';

export type AuthRequest = ExpressRequest & {
  user?: User;
};

declare module 'express' {
  interface Request {
    user?: User;
  }
}
