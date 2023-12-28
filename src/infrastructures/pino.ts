import { pino } from 'pino';

export const logger = pino({
  level: 'trace',
  transport: {
    level: 'trace',
    target: 'pino-pretty',
    options: {
      colorize: process.env.NODE_ENV !== 'production',
      translateTime: true,
      ignore: 'pid,hostname',
    },
  },
});
