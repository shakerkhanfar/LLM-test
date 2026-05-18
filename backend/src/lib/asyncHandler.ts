import type { Response, NextFunction } from "express";
import type { AuthRequest } from "../middleware/auth";

/**
 * Wraps an async Express handler so that any thrown error is forwarded to
 * the next() error-handler instead of producing an unhandled rejection.
 *
 * The return type is `any` to accommodate handlers that use early `return res.json()`
 * (which returns `Response`) alongside handlers that return `void`.
 */
export function asyncHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<any>,
) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
