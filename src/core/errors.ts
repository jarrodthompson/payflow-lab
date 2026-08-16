// A typed application error carrying an HTTP status and a stable machine code.
// The error handler turns these into a consistent JSON envelope.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);

export const notFound = (message = "Resource not found") =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
