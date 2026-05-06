import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  encryptPrivateKey,
  decryptPrivateKey,
  exportSeedPhrase,
  importSeedPhrase,
  validatePin,
  signChallenge,
  verifyChallenge,
} from './crypto';

// ─────────────────────────────────────────────
// PIN validation
// ─────────────────────────────────────────────
describe('PIN validation', () => {
  it('accepts a strong passphrase', () => {
    expect(() => validatePin('correct-horse-battery')).not.toThrow();
  });

  it('accepts a long numeric PIN (12+ digits)', () => {
    expect(() => validatePin('123456789012')).not.toThrow();
  });

  it('rejects anything under 8 characters', () => {
    expect(() => validatePin('abc')).toThrow('at least 8 characters');
  });

  it('rejects a short numeric PIN under 12 digits', () => {
    expect(() => validatePin('12345678')).toThrow('at least 12 digits');
  });
});

// ─────────────────────────────────────────────
// Identity (keypair generation)
// ─────────────────────────────────────────────
describe('Identity', () => {
  it('generates a keypair with public and private keys', async () => {
    const identity = await generateIdentity();
    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(identity.publicKey).not.toBe(identity.privateKey);
  });

  it('two generated identities are always unique', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

// ─────────────────────────────────────────────
// Private key encryption / decryption
// ─────────────────────────────────────────────
describe('Private key encryption', () => {
  const pin = 'correct-horse-battery';

  it('encrypts and decrypts with the correct PIN', async () => {
    const identity = await generateIdentity();
    const { encrypted, salt, level } = await encryptPrivateKey(identity.privateKey, pin);
    const decrypted = await decryptPrivateKey(encrypted, salt, pin, level);
    expect(decrypted).toBe(identity.privateKey);
  });

  it('throws when decrypting with the wrong PIN', async () => {
    const identity = await generateIdentity();
    const { encrypted, salt, level } = await encryptPrivateKey(identity.privateKey, pin);
    await expect(
      decryptPrivateKey(encrypted, salt, 'wrong-horse-battery', level)
    ).rejects.toThrow();
  });

  it('produces different ciphertext each time even with the same PIN', async () => {
    const identity = await generateIdentity();
    const first = await encryptPrivateKey(identity.privateKey, pin);
    const second = await encryptPrivateKey(identity.privateKey, pin);
    // Different random nonce and salt every time
    expect(first.encrypted).not.toBe(second.encrypted);
  });

  it('includes a version byte in the bundle', async () => {
    const identity = await generateIdentity();
    const { encrypted } = await encryptPrivateKey(identity.privateKey, pin);
    // Decode the base64 bundle and check the first byte is 0x01
    const { default: _sodium } = await import('libsodium-wrappers-sumo');
    await _sodium.ready;
    const bundle = _sodium.from_base64(encrypted);
    expect(bundle[0]).toBe(0x01);
  });

  it('rejects a weak PIN at encryption time', async () => {
    const identity = await generateIdentity();
    await expect(
      encryptPrivateKey(identity.privateKey, '123456')
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────
// Seed phrase (backup & recovery)
// ─────────────────────────────────────────────
describe('Seed phrase', () => {
  it('exports a valid 24-word mnemonic', async () => {
    const identity = await generateIdentity();
    const mnemonic = await exportSeedPhrase(identity.privateKey);
    const words = mnemonic.split(' ');
    expect(words.length).toBe(24);
  });

  it('recovers the exact same private key from the seed phrase', async () => {
    const identity = await generateIdentity();
    const mnemonic = await exportSeedPhrase(identity.privateKey);
    const recovered = await importSeedPhrase(mnemonic);
    expect(recovered).toBe(identity.privateKey);
  });

  it('throws on an invalid mnemonic', async () => {
    await expect(
      importSeedPhrase('these are not valid bip39 words at all ever')
    ).rejects.toThrow('Invalid seed phrase');
  });

  it('always produces the same mnemonic from the same private key', async () => {
    const identity = await generateIdentity();
    const first = await exportSeedPhrase(identity.privateKey);
    const second = await exportSeedPhrase(identity.privateKey);
    expect(first).toBe(second);
  });
});

describe('Challenge-response authentication', () => {
  it('signs a challenge and verifies it successfully', async () => {
    const identity = await generateIdentity();
    const challenge = 'random-server-challenge-abc123';
    const signature = await signChallenge(identity.privateKey, challenge);
    const valid = await verifyChallenge(identity.publicKey, challenge, signature);
    expect(valid).toBe(true);
  });

  it('rejects a signature for a different challenge', async () => {
    const identity = await generateIdentity();
    const signature = await signChallenge(identity.privateKey, 'challenge-one');
    const valid = await verifyChallenge(identity.publicKey, 'challenge-two', signature);
    expect(valid).toBe(false);
  });

  it('rejects a signature from a different keypair', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const challenge = 'some-challenge';
    const signature = await signChallenge(alice.privateKey, challenge);
    const valid = await verifyChallenge(bob.publicKey, challenge, signature);
    expect(valid).toBe(false);
  });
});