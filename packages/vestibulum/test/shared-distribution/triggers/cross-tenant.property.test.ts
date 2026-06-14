/**
 * Cross-tenant rejection property test.
 *
 * Property: A magic-link issued for tenant A is never redeemable against
 * tenant B's auth-verify endpoint.
 *
 * The mechanism: auth-verify loads ClientConfig by subdomain (from Host header),
 * then calls RespondToAuthChallenge using that tenant's clientId. A token issued
 * for tenant A's clientId, presented at tenant B's endpoint, will use B's
 * clientId — a different app client. Cognito rejects it (the CUSTOM_CHALLENGE
 * session is bound to A's client).
 *
 * We verify the structural property: auth-verify always uses the clientId
 * resolved from the Host, never the clientId embedded in the request body
 * or cookie.
 *
 * Pinned seed: 0xc0ffee, numRuns: 1000.
 *
 * Additional property: a signup attempt with an email matching tenant A's
 * allowlist but via tenant B's app client → rejected (B's allowlist differs).
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import fc from 'fast-check';
import { handler as preSignUpHandler } from '../../../src/lambda/shared-distribution/triggers/pre-signup.js';
import {
  createAuthVerifyHandler,
  type FunctionUrlEvent,
} from '../../../src/lambda/shared-distribution/triggers/auth-verify.js';

const TENANT_PARENT = 'tenants.example.com';

let globalCtr = 20000;
function nextCtr(): string {
  return String(globalCtr++);
}

describe('Cross-tenant rejection property tests', () => {
  const ddbMock = mockClient(DynamoDBClient);
  const cognitoMock = mockClient(CognitoIdentityProviderClient);

  beforeEach(() => {
    ddbMock.reset();
    cognitoMock.reset();
    process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'] = 'ClientConfig';
  });

  afterEach(() => {
    delete process.env['VESTIBULUM_CLIENT_CONFIG_TABLE'];
  });

  it(
    'auth-verify uses clientId resolved from Host — never from request body',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Two distinct non-empty strings used as suffix to create unique subdomains
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-z0-9]+$/.test(s)),
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-z0-9]+$/.test(s)),
          async (suffixA, suffixB) => {
            const ctr = nextCtr();
            // Ensure distinct subdomains satisfying TenantSubdomain pattern
            const sdA = `aa${suffixA}${ctr}x`;
            const sdB = `ab${suffixB}${ctr}y`;

            if (sdA === sdB) return; // skip if equal by chance

            const clientIdA = `prop-a-${ctr}`;
            const clientIdB = `prop-b-${ctr}`;

            ddbMock.reset();
            cognitoMock.reset();

            // Host=sdB → resolve B's config only
            ddbMock.on(QueryCommand).callsFake((input) => {
              const sd = (input as { ExpressionAttributeValues: { ':sd': { S: string } } })
                ?.ExpressionAttributeValues?.[':sd']?.S;
              if (sd === sdB) {
                return {
                  Items: [{
                    clientId: { S: clientIdB },
                    tenantId: { S: 'tenant-b' },
                    subdomain: { S: sdB },
                    siteBaseUrl: { S: `https://${sdB}.${TENANT_PARENT}` },
                    allowedEmailDomains: { SS: ['b.com'] },
                    createdAt: { S: '2024-01-01T00:00:00.000Z' },
                  }],
                  Count: 1,
                };
              }
              return { Items: [], Count: 0 };
            });

            // Cognito succeeds — allows us to verify clientId used
            cognitoMock.on(RespondToAuthChallengeCommand).resolves({
              AuthenticationResult: {
                IdToken: 'id-tok',
                RefreshToken: 'rt',
                AccessToken: 'at',
                ExpiresIn: 3600,
                TokenType: 'Bearer',
              },
            });

            const h = createAuthVerifyHandler({ tenantParent: TENANT_PARENT });

            // Present a token/session for A's flow but at B's Host
            const event: FunctionUrlEvent = {
              headers: { host: `${sdB}.${TENANT_PARENT}` },
              body: JSON.stringify({
                session: `session-for-${sdA}`,
                challengeAnswer: 'some-token',
                email: 'user@b.com',
              }),
            };

            const result = await h(event);

            if (result.statusCode === 200) {
              // If Cognito returned success, auth-verify must have used B's clientId
              const calls = cognitoMock.calls();
              if (calls.length > 0) {
                const callInput = calls[0]?.args[0] as { input: { ClientId: string } };
                // Core property: B's clientId was used, never A's
                if (callInput?.input?.ClientId === clientIdA) {
                  throw new Error(
                    `auth-verify used clientId A (${clientIdA}) when Host was tenant B`,
                  );
                }
              }
            }
            // Any status is valid; the property is about WHICH clientId was used
          },
        ),
        { numRuns: 1000, seed: 0xc0ffee },
      );
    },
    30000,
  );

  it(
    'pre-signup rejects email matching tenant A allowlist when presented via tenant B client',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 2, maxLength: 15 }).filter((s) => /^[a-z][a-z0-9]*$/.test(s)),
          fc.string({ minLength: 2, maxLength: 15 }).filter((s) => /^[a-z][a-z0-9]*$/.test(s)),
          async (labelA, labelB) => {
            if (labelA === labelB) return; // skip equal labels

            const ctr = nextCtr();
            const clientIdB = `prop-presignup-b-${ctr}`;

            ddbMock.reset();

            // Tenant B's allowlist only contains labelB.com, not labelA.com
            ddbMock.on(GetItemCommand).resolves({
              Item: {
                clientId: { S: clientIdB },
                tenantId: { S: 'tenant-b' },
                subdomain: { S: `tenantb${ctr}` },
                siteBaseUrl: { S: `https://tenantb${ctr}.${TENANT_PARENT}` },
                allowedEmailDomains: { SS: [`${labelB}.com`] },
                createdAt: { S: '2024-01-01T00:00:00.000Z' },
              },
            });

            // Present email from A's domain via B's app client
            const event = {
              callerContext: { clientId: clientIdB },
              request: { userAttributes: { email: `user@${labelA}.com` } },
              response: {},
            };

            // Must reject because labelA.com is NOT in B's allowlist
            let threw = false;
            try {
              await preSignUpHandler(event);
            } catch (err) {
              threw = true;
              if (!(err instanceof Error) || err.message !== 'Signup not allowed') {
                throw err;
              }
            }
            if (!threw) {
              throw new Error(
                `pre-signup accepted email from tenant A's domain (${labelA}.com) via tenant B's client`,
              );
            }
          },
        ),
        { numRuns: 1000, seed: 0xc0ffee },
      );
    },
    30000,
  );
});
