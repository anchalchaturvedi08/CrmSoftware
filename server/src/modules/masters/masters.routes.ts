/**
 * Master data routes (spec section 25 Phase 2).
 *
 * Reference reads are open to all three roles because every portal needs
 * them: a technician's job card shows the product, an Owner's forms list the
 * cities. Writes are Admin-only — section 3.1 gives Admin the management of
 * customers, products, cities, territories and service centers, and sections
 * 3.2 and 3.3 give neither of the other roles any of it.
 *
 * Customers are the exception to open reads. The customer register is every
 * customer's name, mobile and address across all centres; an Owner or a
 * technician reaches the customers of their own work through the complaint,
 * which is scoped, and has no reason to page through everyone else's. Found
 * in the pre-launch security review (DECISIONS.md section 29).
 *
 * The one exception is technicians, which an Owner creates for their own
 * centre — that lives in the users module, where the rule is per-request
 * rather than per-route.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, requirePasswordChanged } from '../../middleware/authorize.js';
import * as controller from './masters.controller.js';

export const mastersRouter = Router();

mastersRouter.use(authenticate, requirePasswordChanged);

/* ---- Territories ------------------------------------------------------- */
mastersRouter.get('/territories', controller.getTerritories);
mastersRouter.post('/territories', adminOnly, controller.postTerritory);
mastersRouter.patch('/territories/:id', adminOnly, controller.patchTerritory);

/* ---- Cities ------------------------------------------------------------ */
mastersRouter.get('/cities', controller.getCities);
mastersRouter.post('/cities', adminOnly, controller.postCity);
mastersRouter.patch('/cities/:id', adminOnly, controller.patchCity);

/* ---- Service centers --------------------------------------------------- */
mastersRouter.get('/service-centers', controller.getServiceCenters);
mastersRouter.post('/service-centers', adminOnly, controller.postServiceCenter);
/** Admin's page for one centre: contact, coverage, staff, open work, stock. */
mastersRouter.get('/service-centers/:id/overview', adminOnly, controller.getServiceCenterOverview);
mastersRouter.patch('/service-centers/:id', adminOnly, controller.patchServiceCenter);

/* ---- Products and models ----------------------------------------------- */
mastersRouter.get('/products', controller.getProducts);
mastersRouter.post('/products', adminOnly, controller.postProduct);
mastersRouter.patch('/products/:id', adminOnly, controller.patchProduct);

mastersRouter.get('/product-models', controller.getProductModels);
mastersRouter.post('/product-models', adminOnly, controller.postProductModel);
mastersRouter.patch('/product-models/:id', adminOnly, controller.patchProductModel);

/* ---- Customers --------------------------------------------------------- */
mastersRouter.get('/customers', adminOnly, controller.getCustomers);
mastersRouter.post('/customers', adminOnly, controller.postCustomer);
mastersRouter.get('/customers/:id', adminOnly, controller.getCustomerById);
mastersRouter.patch('/customers/:id', adminOnly, controller.patchCustomer);

/**
 * Section 13. Declared before nothing else claims the path, and kept as its
 * own route rather than a flag on the customer read, because it is a different
 * question: not "who is this" but "what has happened to them before".
 */
mastersRouter.get('/customers/:id/history', adminOnly, controller.getCustomerHistory);

/**
 * Serial-number history, which crosses customers — a unit can change hands.
 *
 * Open to every role because the technician app shows it on a job (section
 * 10, "View History"), but scoped in the service: anyone other than Admin
 * must have the unit in their own work, and sees what happened to it without
 * who owned it.
 */
mastersRouter.get('/serial-history/:serialNumber', controller.getSerialHistory);
