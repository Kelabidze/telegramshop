import { HTTP_STATUS_BY_CODE, type ApiErrorCode } from '@shop/shared';

/** An error that is safe to serialize to the client. */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = HTTP_STATUS_BY_CODE[code];
    this.details = details;
  }

  toPayload() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const unauthorized = (message = 'Authentication required.') =>
  new AppError('UNAUTHORIZED', message);

export const forbidden = (message = 'Access denied.') =>
  new AppError('FORBIDDEN', message);

export const notFound = (message = 'Resource not found.') =>
  new AppError('NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, details);

export const validationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, details);
