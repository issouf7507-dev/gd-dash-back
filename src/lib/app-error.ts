// Erreurs applicatives : les routes les lancent, le middleware d'erreur les transforme en réponse JSON.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(message: string, statusCode: number, code: ErrorCode, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Données invalides') {
    super(message, 400, 'VALIDATION_ERROR', details)
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentification requise') {
    super(message, 401, 'UNAUTHENTICATED')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé') {
    super(message, 403, 'FORBIDDEN')
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super(message, 404, 'NOT_FOUND')
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
  }
}

export function formatErrorResponse(err: AppError) {
  return {
    error: {
      message: err.message,
      code: err.code,
      ...(err.details !== undefined && { details: err.details }),
    },
  }
}
