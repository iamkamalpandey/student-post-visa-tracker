import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { env } from '../../config/env.js';
import { BadRequest } from '../../shared/errors.js';

export type PrepTokenPayload = { tid: string };

let _privateKey: ReturnType<typeof importPKCS8> | null = null;
let _publicKey: ReturnType<typeof importSPKI> | null = null;

function getPrivateKey() {
  if (!_privateKey) _privateKey = importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  return _privateKey;
}

function getPublicKey() {
  if (!_publicKey) _publicKey = importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  return _publicKey;
}

export async function createPrepToken(tenantId: string): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({ tid: tenantId, purpose: 'interview_prep' })
    .setProtectedHeader({ alg: 'RS256', kid: env.JWT_KID })
    .setIssuedAt()
    .setExpirationTime('365d')
    .sign(key);
}

export async function verifyPrepToken(token: string): Promise<PrepTokenPayload> {
  try {
    const key = await getPublicKey();
    const { payload } = await jwtVerify(token, key, { algorithms: ['RS256'] });
    if (payload.purpose !== 'interview_prep' || typeof payload.tid !== 'string') {
      throw new Error('invalid purpose');
    }
    return { tid: payload.tid };
  } catch {
    throw BadRequest('Invalid or expired interview prep access token');
  }
}
