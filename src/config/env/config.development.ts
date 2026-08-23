import { registerAs } from '@nestjs/config';
import { AppConfig } from '../configuration.interface';

export const developmentConfig = registerAs('development', (): AppConfig => ({
  server: {},
  // database: {
  //   synchronize: true,
  //   // logging: true,
  // },
  jwt: {
    accessExpiresIn: 900,
    refreshExpiresIn: 604800,
  },
}));
