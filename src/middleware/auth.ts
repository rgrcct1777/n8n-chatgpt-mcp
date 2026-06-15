import { Request, Response, NextFunction } from 'express';
import passport from 'passport';

/** Pass-through when auth is disabled (default for local dev). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  next();
}

export default passport;
