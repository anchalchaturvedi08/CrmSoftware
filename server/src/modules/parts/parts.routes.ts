/**
 * Parts routes (spec section 11).
 *
 * The role split follows section 11 and section 3:
 *
 *  - the **part master** is company-wide reference data, so Admin maintains it
 *    while all three roles can read it (a technician has to pick from it)
 *  - **stock** is per service center and the Owner's to manage; a technician
 *    requests parts rather than reading inventory
 *  - **requests and usage** are raised by the technician and decided by the
 *    Owner
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import {
  adminOnly,
  requireRole,
  requirePasswordChanged,
} from '../../middleware/authorize.js';
import * as controller from './parts.controller.js';

export const partsRouter = Router();

partsRouter.use(authenticate, requirePasswordChanged);

/* ---- Part master ------------------------------------------------------- */
/* Readable by everyone: the technician's parts picker needs it. */
partsRouter.get('/', controller.getParts);
partsRouter.post('/', adminOnly, controller.postPart);
partsRouter.patch('/:id', adminOnly, controller.patchPart);

/* ---- Stock (Owner's own centre; Admin must name one) ------------------- */
partsRouter.get(
  '/stock/list',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.getStock,
);
partsRouter.put(
  '/stock',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.putStock,
);
partsRouter.post(
  '/stock/adjust',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.postStockAdjustment,
);

/* ---- Request queue and decisions --------------------------------------- */
partsRouter.get('/requests/list', controller.getPartRequests);
partsRouter.post(
  '/requests/:requestId/decide',
  requireRole('SERVICE_CENTER_OWNER'),
  controller.postPartRequestDecision,
);

/**
 * Finalising moves stock, so it belongs to whoever manages stock — the Owner,
 * or Admin acting for a centre. A technician recording usage cannot also
 * confirm it against inventory.
 */
partsRouter.post(
  '/usage/:usageId/finalize',
  requireRole('ADMIN', 'SERVICE_CENTER_OWNER'),
  controller.postFinalizeUsage,
);
