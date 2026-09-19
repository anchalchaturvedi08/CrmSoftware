/**
 * Parts HTTP layer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import * as parts from './parts.service.js';
import {
  adjustStockSchema,
  createPartRequestSchema,
  createPartSchema,
  decidePartRequestSchema,
  listPartRequestsSchema,
  listPartsSchema,
  listStockSchema,
  recordUsageSchema,
  setStockSchema,
  updatePartSchema,
} from './parts.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/* ---- Part master ------------------------------------------------------- */

export const postPart = handler(async (req, res) => {
  const auth = requireAuth(req);
  const part = await parts.createPart(createPartSchema.parse(req.body), auth);
  res.status(201).json({ part });
});

export const patchPart = handler(async (req, res) => {
  const auth = requireAuth(req);
  const part = await parts.updatePart(
    String(req.params['id']),
    updatePartSchema.parse(req.body),
    auth,
  );
  res.status(200).json({ part });
});

export const getParts = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await parts.listParts(listPartsSchema.parse(req.query)));
});

/* ---- Stock ------------------------------------------------------------- */

export const getStock = handler(async (req, res) => {
  const auth = requireAuth(req);
  res.status(200).json(await parts.listStock(listStockSchema.parse(req.query), auth));
});

export const putStock = handler(async (req, res) => {
  const auth = requireAuth(req);
  const stock = await parts.setStock(setStockSchema.parse(req.body), auth);
  res.status(200).json({ stock });
});

export const postStockAdjustment = handler(async (req, res) => {
  const auth = requireAuth(req);
  const stock = await parts.adjustStock(adjustStockSchema.parse(req.body), auth);

  res.status(200).json({
    stock,
    isLowStock: stock.availableQuantity <= stock.minimumStock,
  });
});

/* ---- Requests ---------------------------------------------------------- */

export const postPartRequest = handler(async (req, res) => {
  const auth = requireAuth(req);
  const request = await parts.createPartRequest(
    String(req.params['id']),
    createPartRequestSchema.parse(req.body),
    auth,
  );
  res.status(201).json({ request });
});

export const getPartRequests = handler(async (req, res) => {
  const auth = requireAuth(req);
  res
    .status(200)
    .json(await parts.listPartRequests(listPartRequestsSchema.parse(req.query), auth));
});

export const postPartRequestDecision = handler(async (req, res) => {
  const auth = requireAuth(req);
  const request = await parts.decidePartRequest(
    String(req.params['requestId']),
    decidePartRequestSchema.parse(req.body),
    auth,
  );

  res.status(200).json({
    request,
    /* Issuing hands parts over but does not move inventory — section 11 puts
       the decrement at usage finalisation. Saying so here stops an Owner
       wondering why the stock figure has not changed. */
    ...(request.status === 'ISSUED'
      ? { note: 'Stock will be decremented when the technician\'s usage is finalised.' }
      : {}),
  });
});

/* ---- Usage ------------------------------------------------------------- */

export const postUsage = handler(async (req, res) => {
  const auth = requireAuth(req);
  const usage = await parts.recordUsage(
    String(req.params['id']),
    recordUsageSchema.parse(req.body),
    auth,
  );

  res.status(201).json({
    usage,
    note: 'Recorded. Stock moves once the service center finalises this usage.',
  });
});

export const getUsage = handler(async (req, res) => {
  const auth = requireAuth(req);
  res
    .status(200)
    .json({ items: await parts.listUsage(String(req.params['id']), auth) });
});

export const postFinalizeUsage = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await parts.finalizeUsage(String(req.params['usageId']), auth);

  res.status(200).json({
    usage: result.usage,
    remainingStock: result.remainingStock,
    isLowStock: result.isLowStock,
    ...(result.isLowStock
      ? { warning: 'This part is now at or below its minimum stock level.' }
      : {}),
  });
});
