import type { NextFunction, Request, Response } from 'express';
import type {
  CreateCampusRequest,
  CreateDepartmentRequest,
  CreateInstitutionAccreditationRequest,
  CreateInstitutionContactRequest,
  CreateInstitutionIdentifierRequest,
  CreateInstitutionRequest,
  CreateSchoolRequest,
  InstitutionListQuery,
  UpdateCampusRequest,
  UpdateDepartmentRequest,
  UpdateInstitutionRequest,
  UpdateSchoolRequest,
} from '@spv/zod-schemas';

import { PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './institutions.service.js';
import { dbFor } from './institutions.types.js';

// Every handler needs the authenticated user. We assert here so the rest of the
// file can rely on req.user being populated (authenticate middleware).
function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

// ---------------------------------------------------------------------------
// Institutions
// ---------------------------------------------------------------------------

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as InstitutionListQuery;
    const result = await service.list({ db: dbFor(req), tenantId: user.tid }, q);
    res.json({
      data: result.data,
      page: { nextCursor: result.nextCursor, hasMore: result.hasMore, total: result.total },
    });
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById({ db: dbFor(req), tenantId: user.tid }, id);
    if (row && typeof (row as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(row as { version: number }).version}"`);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateInstitutionRequest;
    await runIdempotent(req, res, { scope: 'institutions.create' }, async () => {
      const created = await service.create(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        body,
      );
      const id = (created as { id: string }).id;
      res.setHeader('Location', `/api/v1/institutions/${id}`);
      res.setHeader('ETag', `"${(created as { version: number }).version}"`);
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const expected = readIfMatch(req);
    if (expected === undefined) throw PreconditionFailed('If-Match required for PATCH');
    const body = req.body as UpdateInstitutionRequest;
    const updated = await service.update(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
      String(expected),
    );
    if (updated && typeof (updated as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(updated as { version: number }).version}"`);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function softDeleteHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.softDelete({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export async function listIdentifiersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listIdentifiers({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createIdentifierHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateInstitutionIdentifierRequest;
    await runIdempotent(req, res, { scope: 'institution-identifiers.create' }, () =>
      service.createIdentifier(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function deleteIdentifierHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteIdentifier(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Accreditations
// ---------------------------------------------------------------------------

export async function listAccreditationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listAccreditations({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createAccreditationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateInstitutionAccreditationRequest;
    await runIdempotent(req, res, { scope: 'institution-accreditations.create' }, () =>
      service.createAccreditation(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function deleteAccreditationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteAccreditation(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function listContactsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listContacts({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createContactHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateInstitutionContactRequest;
    await runIdempotent(req, res, { scope: 'institution-contacts.create' }, () =>
      service.createContact(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function deleteContactHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteContact(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Campuses
// ---------------------------------------------------------------------------

export async function listCampusesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listCampuses({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createCampusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateCampusRequest;
    await runIdempotent(req, res, { scope: 'campuses.create' }, () =>
      service.createCampus(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateCampusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateCampusRequest;
    const updated = await service.updateCampus(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteCampusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteCampus(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Schools / Departments
// ---------------------------------------------------------------------------

export async function listSchoolsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listSchools({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createSchoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateSchoolRequest;
    await runIdempotent(req, res, { scope: 'schools.create' }, () =>
      service.createSchool(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateSchoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateSchoolRequest;
    const updated = await service.updateSchool(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteSchoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteSchool(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function createDepartmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateDepartmentRequest;
    await runIdempotent(req, res, { scope: 'departments.create' }, () =>
      service.createDepartment(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateDepartmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateDepartmentRequest;
    const updated = await service.updateDepartment(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteDepartmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteDepartment(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
