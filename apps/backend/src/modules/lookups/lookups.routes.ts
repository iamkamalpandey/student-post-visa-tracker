import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';

import { prisma } from '../../config/db.js';
import { BadRequest, Unauthorized } from '../../shared/errors.js';
import { CountryAlpha2 } from '@spv/zod-schemas';

// Read-only catalog endpoints. Global tables (countries, currencies, isced fields,
// airports, airlines) are not tenant-scoped — there's no tenant_id column. Tenant-
// scoped tables filter on req.user.tid.

function dbFor(req: Request): PrismaClient {
  return ((req.db as unknown as PrismaClient) ?? prisma);
}

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

export const lookupsRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.

// ----- Global (no tenant filter) --------------------------------------------

lookupsRouter.get('/countries', async (req, res, next) => {
  try {
    const data = await dbFor(req).country.findMany({
      where: { is_active: true },
      orderBy: { name: 'asc' },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

lookupsRouter.get('/currencies', async (req, res, next) => {
  try {
    // SVT-LOOKUP-FILTERS-2026-05: hide deprecated ISO codes from the picker.
    // Wire shape unchanged — just shrinks the list.
    const data = await dbFor(req).currency.findMany({
      where: { is_active: true },
      orderBy: { code: 'asc' },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

lookupsRouter.get('/isced-fields', async (req, res, next) => {
  try {
    const data = await dbFor(req).iscedField.findMany({ orderBy: { code: 'asc' } });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ----- Tenant-scoped --------------------------------------------------------

lookupsRouter.get('/document-types', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const data = await dbFor(req).documentType.findMany({
      where: { tenant_id: user.tid, is_active: true },
      orderBy: { label: 'asc' },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

lookupsRouter.get('/relationship-types', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const data = await dbFor(req).relationshipType.findMany({
      where: { tenant_id: user.tid, is_active: true },
      orderBy: { label: 'asc' },
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Visa categories are global per ISO country but optionally filter by ?country=XX.
lookupsRouter.get('/visa-categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const country = req.query['country'];
    let countryCode: string | undefined;
    if (typeof country === 'string' && country.length > 0) {
      const parsed = CountryAlpha2.safeParse(country);
      if (!parsed.success) {
        return next(BadRequest('Invalid country code (expected ISO 3166-1 alpha-2 uppercase)'));
      }
      countryCode = parsed.data;
    }
    const data = await dbFor(req).visaCategory.findMany({
      where: {
        is_active: true,
        ...(countryCode ? { country_code: countryCode } : {}),
      },
      orderBy: [{ country_code: 'asc' }, { code: 'asc' }],
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
