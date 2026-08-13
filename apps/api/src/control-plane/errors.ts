export class ControlPlaneError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: readonly Readonly<Record<string, unknown>>[];

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details: readonly Readonly<Record<string, unknown>>[] = [],
  ) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function badRequest(
  message: string,
  details: readonly Readonly<Record<string, unknown>>[] = [],
): ControlPlaneError {
  return new ControlPlaneError("INVALID_REQUEST", message, 400, details);
}

export function notFound(resource: string): ControlPlaneError {
  return new ControlPlaneError("NOT_FOUND", `${resource} 不存在。`, 404);
}

export function conflict(
  message: string,
  details: readonly Readonly<Record<string, unknown>>[] = [],
): ControlPlaneError {
  return new ControlPlaneError("CONFLICT", message, 409, details);
}
