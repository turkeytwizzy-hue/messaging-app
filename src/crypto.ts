import _sodium from 'libsodium-wrappers-sumo';

export async function verifyChallenge(
  publicKeyB64: string,
  challenge: string,
  signatureB64: string
): Promise<boolean> {
  await _sodium.ready;
  const sodium = _sodium;
  const publicKey = sodium.from_base64(publicKeyB64);
  const challengeBytes = sodium.from_string(challenge);
  const signature = sodium.from_base64(signatureB64);
  return sodium.crypto_sign_verify_detached(signature, challengeBytes, publicKey);
}
