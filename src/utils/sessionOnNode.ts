/**
 * cf. https://supertokens.com/docs/emailpassword/nextjs/app-directory/protecting-route#using---presessionauthfornextjs-and-checking-for-sessions--pre
 */

import type { JwtHeader, JwtPayload, SigningKeyCallback } from 'jsonwebtoken';
import { verify } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import SuperTokensNode from 'supertokens-node';

import { ensureSuperTokensInit } from '../infrastructures/supertokens/backendConfig';

ensureSuperTokensInit();
const client = jwksClient({
  jwksUri: `${process.env.SUPERTOKENS_URI}/.well-known/jwks.json`,
});

export type SessionOnNode = {
  superTokensUserId: string;
  superTokensRecipeUserId: SuperTokensNode.RecipeUserId;
  roles: string[];
  tenantId: string;
};

/**
 * A helper function to retrieve session details on the server side.
 *
 * NOTE: This function does not use the getSession / verifySession function from the supertokens-node SDK
 * because those functions may update the access token. These updated tokens would not be
 * propagated to the client side properly, as request interceptors do not run on the server side.
 * So instead, we use regular JWT verification library
 */
export async function getSessionOnNode(accessToken: string): Promise<SessionOnNode | undefined> {
  const decoded = await verifyToken(accessToken);
  const superTokensUserId = sanitizeStringInput(decoded.sub);
  const superTokensRecipeUserId = sanitizeStringInput(decoded.rsub);
  const tenantId = sanitizeStringInput(decoded.tId);
  const roles = decoded['st-role']?.v;
  return superTokensUserId && superTokensRecipeUserId && tenantId
    ? {
        superTokensUserId,
        superTokensRecipeUserId: new SuperTokensNode.RecipeUserId(superTokensRecipeUserId),
        roles: Array.isArray(roles) ? roles : [],
        tenantId,
      }
    : undefined;
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    verify(token, getPublicKey, {}, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded as JwtPayload);
      }
    });
  });
}

export function getPublicKey(header: JwtHeader, callback: SigningKeyCallback): void {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
    } else {
      const signingKey = key?.getPublicKey();
      // eslint-disable-next-line unicorn/no-null
      callback(null, signingKey);
    }
  });
}

function sanitizeStringInput(field: unknown): string | undefined {
  if (field === '') {
    return '';
  }
  if (typeof field !== 'string') {
    return;
  }
  try {
    return field.trim();
  } catch {
    // do nothing
  }
  return;
}
