import { registerAs } from '@nestjs/config';
import { AppConfig } from '../configuration.interface';

export const developmentConfig = registerAs('development', (): AppConfig => ({
  server: {},
  jwt: {
    accessExpiresIn: 900,
    refreshExpiresIn: 604800,
  },
}));
