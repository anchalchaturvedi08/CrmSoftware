/**
 * Error types and the single error-handling middleware.
 *
 * Two rules this file exists to enforce:
 *  - Clients get a stable, typed error shape (spec §21 asks for meaningful
 *    validation messages and clear error states in the UI).
 *  - Unexpected errors never leak internals. Only errors we deliberately
 *    constructed are described to the caller; everything else is logged in
 *    full and reported as a generic 500.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';

/** Machine-readable error codes. Clients branch on these, never on messages. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATUS_TRANSITION'
  | 'HAPPY_CODE_INVALID'
  | 'HAPPY_CODE_LOCKED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface FieldIssue {
  field: string;
  message: string;
}

/** An error we raised on purpose, and are therefore willing to describe. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly issues?: FieldIssue[];
  /** Extra context for the log only — never serialized to the client. */
  readonly context?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: { issues?: FieldIssue[]; context?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (options?.issues) this.issues = options.issues;
    if (options?.context) this.context = options.context;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, issues?: FieldIssue[]) =>
  new AppError(400, 'VALIDATION_ERROR', message, issues ? { issues } : undefined);

export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, context?: Record<string, unknown>) =>
  new AppError(409, 'CONFLICT', message, context ? { context } : undefined);

/** Maps a ZodError onto our field-issue shape so forms can highlight inputs. */
function issuesFromZod(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Extracts the offending keys from a MongoDB duplicate-key error. */
function duplicateKeyFields(err: mongoose.mongo.MongoServerError): FieldIssue[] {
  const keys = Object.keys((err.keyPattern ?? {}) as Record<string, unknown>);
  return keys.map((field) => ({ field, message: `${field} is already in use` }));
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  /* --- Errors we raised deliberately --------------------------------- */
  if (err instanceof AppError) {
    /* 5xx means we broke something; 4xx is the caller's problem and is
       expected traffic, so it should not pollute the error logs. */
    const log = err.status >= 500 ? logger.error : logger.warn;
    log.call(
      logger,
      { err, code: err.code, status: err.status, context: err.context, path: req.originalUrl },
      'request failed',
    );

    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.issues ? { issues: err.issues } : {}),
      },
    });
    return;
  }

  /* --- Schema validation from a route boundary ----------------------- */
  /* The message is the first problem in words, not "failed validation": a
     dialog that toasts the message used to say only that, leaving someone who
     typed a two-letter reason no idea what was wrong (pre-launch review). The
     full list stays in `issues` for forms that mark each field. */
  if (err instanceof ZodError) {
    const issues = issuesFromZod(err);
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR' satisfies ErrorCode,
        message: issues[0]?.message ?? 'The request body failed validation',
        issues,
      },
    });
    return;
  }

  /* --- Mongoose document validation --------------------------------- */
  if (err instanceof mongoose.Error.ValidationError) {
    const issues = Object.entries(err.errors).map(([field, detail]) => ({
      field,
      message: detail.message,
    }));
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR' satisfies ErrorCode,
        message: issues[0]?.message ?? 'The record failed validation',
        issues,
      },
    });
    return;
  }

  /* A malformed ObjectId is a client mistake, not a server fault. */
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR' satisfies ErrorCode,
        message: `'${err.path}' is not a valid identifier`,
        issues: [{ field: err.path, message: 'Malformed identifier' }],
      },
    });
    return;
  }

  /* --- Unique index violation ---------------------------------------- */
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
    const issues = duplicateKeyFields(err);
    res.status(409).json({
      error: {
        code: 'CONFLICT' satisfies ErrorCode,
        message: 'That record already exists',
        ...(issues.length ? { issues } : {}),
      },
    });
    return;
  }

  /* --- Anything else: log fully, reveal nothing ---------------------- */
  logger.error({ err, path: req.originalUrl }, 'unhandled error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR' satisfies ErrorCode,
      message: 'Something went wrong on our side',
      ...(isProduction ? {} : { debug: err instanceof Error ? err.message : String(err) }),
    },
  });
};
