import { Router } from 'express';
import { jwks } from '../../shared/jwt.js';

export const wellKnownRouter: Router = Router();

// Standard discovery endpoint. Mounted at /.well-known so SDKs find it without configuration.
wellKnownRouter.get('/jwks.json', async (_req, res, next) => {
  try {
    const keyset = await jwks();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(keyset);
  } catch (err) {
    next(err);
  }
});
