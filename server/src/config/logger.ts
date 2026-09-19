/**
 * Application logger.
 *
 * Redaction is not optional here: spec §17 requires an audit trail of who did
 * what, and spec §19 requires secure Happy Code handling. Logs must never
 * become a side channel that leaks credentials or Happy Codes.
 */
import pino from 'pino';
import { config, isProduction } from './env.js';

export const logger = pino({
  level: config.LOG_LEVEL,

  /* Anything that could carry a secret is redacted before it reaches a log
     sink. Add to this list whenever a new sensitive field appears. */
  redact: {
    paths: [
      'password',
      'passwordHash',
      'currentPassword',
      'newPassword',
      'happyCode',
      'happy_code',
      'happyCodeCiphertext',
      'token',
      'accessToken',
      'refreshToken',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.happyCode',
    ],
    censor: '[redacted]',
  },

  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            /**
             * `req` and `res` are dropped in development only.
             *
             * The request line already reads `POST /complaints 201`, so
             * printing the same method, URL and status again underneath is
             * pure noise. Production keeps them: there, logs are structured
             * JSON read after the fact, where the fields are what you query.
             */
            ignore: 'pid,hostname,req,res',
          },
        },
      }),
});
