declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DATABASE_URL: string;
      DATABASE_SYNCHRONIZE: boolean;
      DEFAULT_ADMIN_USERNAME: string;
      DEFAULT_ADMIN_PASSWORD: string;
      JWT_SECRET: string;
      JWT_ACCESS_EXPIRES_IN: number;
      JWT_REFRESH_EXPIRES_IN: number;
      SWAGGER_OPEN: boolean;
      WORKER_ID: number;
      DATACENTER_ID: number;
    }
  }
}

export {};
