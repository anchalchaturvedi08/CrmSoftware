/**
 * Master data HTTP layer.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireAuth } from '../../middleware/authenticate.js';
import { serviceCenterOverview } from './centerOverview.service.js';
import * as masters from './masters.service.js';
import {
  createCitySchema,
  createCustomerSchema,
  createProductModelSchema,
  createProductSchema,
  createServiceCenterSchema,
  createTerritorySchema,
  listCitiesSchema,
  listCustomersSchema,
  listProductModelsSchema,
  listQuerySchema,
  listServiceCentersSchema,
  updateCitySchema,
  updateCustomerSchema,
  updateProductModelSchema,
  updateProductSchema,
  updateServiceCenterSchema,
  updateTerritorySchema,
} from './masters.validation.js';

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const id = (req: Request): string => String(req.params['id']);

/* ---- Territories ------------------------------------------------------- */

export const postTerritory = handler(async (req, res) => {
  const auth = requireAuth(req);
  const territory = await masters.createTerritory(
    createTerritorySchema.parse(req.body),
    auth,
  );
  res.status(201).json({ territory });
});

export const getTerritories = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await masters.listTerritories(listQuerySchema.parse(req.query)));
});

export const patchTerritory = handler(async (req, res) => {
  const auth = requireAuth(req);
  const territory = await masters.updateTerritory(
    id(req),
    updateTerritorySchema.parse(req.body),
    auth,
  );
  res.status(200).json({ territory });
});

/* ---- Cities ------------------------------------------------------------ */

export const postCity = handler(async (req, res) => {
  const auth = requireAuth(req);
  const city = await masters.createCity(createCitySchema.parse(req.body), auth);
  res.status(201).json({ city });
});

export const getCities = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await masters.listCities(listCitiesSchema.parse(req.query)));
});

export const patchCity = handler(async (req, res) => {
  const auth = requireAuth(req);
  const city = await masters.updateCity(id(req), updateCitySchema.parse(req.body), auth);
  res.status(200).json({ city });
});

/* ---- Service centers --------------------------------------------------- */

export const postServiceCenter = handler(async (req, res) => {
  const auth = requireAuth(req);
  const center = await masters.createServiceCenter(
    createServiceCenterSchema.parse(req.body),
    auth,
  );
  res.status(201).json({ center });
});

export const getServiceCenters = handler(async (req, res) => {
  requireAuth(req);
  res
    .status(200)
    .json(await masters.listServiceCenters(listServiceCentersSchema.parse(req.query)));
});

export const getServiceCenterOverview = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await serviceCenterOverview(id(req)));
});

export const patchServiceCenter = handler(async (req, res) => {
  const auth = requireAuth(req);
  const result = await masters.updateServiceCenter(
    id(req),
    updateServiceCenterSchema.parse(req.body),
    auth,
  );

  res.status(200).json({
    center: result.center,
    ...(result.openComplaintsNeedingReassignment
      ? {
          openComplaintsNeedingReassignment: result.openComplaintsNeedingReassignment,
          /* Section 8: history is untouched, but live work needs a new home. */
          warning:
            `${result.openComplaintsNeedingReassignment.length} open complaint(s) are ` +
            'still with this service center and must be reassigned.',
        }
      : {}),
  });
});

/* ---- Products and models ----------------------------------------------- */

export const postProduct = handler(async (req, res) => {
  const auth = requireAuth(req);
  const product = await masters.createProduct(createProductSchema.parse(req.body), auth);
  res.status(201).json({ product });
});

export const getProducts = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await masters.listProducts(listQuerySchema.parse(req.query)));
});

export const patchProduct = handler(async (req, res) => {
  const auth = requireAuth(req);
  const product = await masters.updateProduct(
    id(req),
    updateProductSchema.parse(req.body),
    auth,
  );
  res.status(200).json({ product });
});

export const postProductModel = handler(async (req, res) => {
  const auth = requireAuth(req);
  const model = await masters.createProductModel(
    createProductModelSchema.parse(req.body),
    auth,
  );
  res.status(201).json({ model });
});

export const getProductModels = handler(async (req, res) => {
  requireAuth(req);
  res
    .status(200)
    .json(await masters.listProductModels(listProductModelsSchema.parse(req.query)));
});

export const patchProductModel = handler(async (req, res) => {
  const auth = requireAuth(req);
  const model = await masters.updateProductModel(
    id(req),
    updateProductModelSchema.parse(req.body),
    auth,
  );
  res.status(200).json({ model });
});

/* ---- Customers --------------------------------------------------------- */

export const postCustomer = handler(async (req, res) => {
  const auth = requireAuth(req);
  const customer = await masters.createCustomer(
    createCustomerSchema.parse(req.body),
    auth,
  );
  res.status(201).json({ customer });
});

export const getCustomers = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json(await masters.listCustomers(listCustomersSchema.parse(req.query)));
});

export const getCustomerById = handler(async (req, res) => {
  requireAuth(req);
  res.status(200).json({ customer: await masters.getCustomer(id(req)) });
});

export const patchCustomer = handler(async (req, res) => {
  const auth = requireAuth(req);
  const customer = await masters.updateCustomer(
    id(req),
    updateCustomerSchema.parse(req.body),
    auth,
  );
  res.status(200).json({ customer });
});

/**
 * Section 13, Workflow G: what Admin reads before deciding whether a call is a
 * repeat or a new complaint. The decision stays human — the spec rules out
 * automatic duplicate detection for the MVP.
 */
export const getCustomerHistory = handler(async (req, res) => {
  requireAuth(req);
  const history = await masters.customerHistory(id(req));

  res.status(200).json({
    ...history,
    note: 'Review this history to decide whether to reopen an existing complaint or raise a new one.',
  });
});

/** Section 13's serial-number history, across customers. */
export const getSerialHistory = handler(async (req, res) => {
  const auth = requireAuth(req);
  res
    .status(200)
    .json(await masters.serialHistory(String(req.params['serialNumber']), auth));
});
