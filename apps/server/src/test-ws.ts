import { generateIdentity, signChallenge } from '@187/core';

const BASE_URL = 'http://localhost:3000';

async function main() {
  const identity = await generateIdentity();
  console.log('Generated identity:', identity.publicKey);

  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: identity.publicKey }),
  });
  console.log('Register:', registerRes.status);

  const challengeRes = await fetch(`${BASE_URL}/auth/challenge/${identity.publicKey}`);
  const { challenge } = await challengeRes.json() as { challenge: string };
  console.log('Challenge:', challenge);

  const signature = await signChallenge(identity.privateKey, challenge);
  const verifyRes = await fetch(`${BASE_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: identity.publicKey, challenge, signature }),
  });
  const { token } = await verifyRes.json() as { token: string };
  console.log('Token:', token ? 'received' : 'FAILED');
  console.log('Full token:', token);
}

main().catch(console.error);