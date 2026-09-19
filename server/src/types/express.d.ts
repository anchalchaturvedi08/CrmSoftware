/**
 * Express request augmentation.
 *
 * `auth` is optional in the type because a request arriving at unauthenticated
 * middleware genuinely has none. Handlers should go through `requireAuth(req)`
 * rather than reading it directly, so a route mounted without `authenticate`
 * fails loudly instead of silently treating an undefined caller as allowed.
 */
import type { AuthContext } from '../middleware/authenticate.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
