import type { Role } from '../db/repositories/users.js';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

// Module augmentation: attachUser populates these on the request. This file
// is imported by auth/middleware.ts, which is what loads the augmentation.
declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthedUser;
    /** SHA-256 of the raw session id — the primary key of the sessions row. */
    sessionKey?: string;
  }
}
