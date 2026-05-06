import _sodium from 'libsodium-wrappers-sumo';
import * as bip39 from 'bip39';

const PWHASH_SALT_BYTES = 16;
const SECRETBOX_NONCE_BYTES = 24;
const PWHASH_KEY_BYTES = 32;

const VERSION = 0x01;

// ─────────────────────────────────────────────
// Security level — controls how hard Argon2id
// works when stretching the PIN into a key.
// INTERACTIVE is fast enough for unlock (~200ms)
// MODERATE is slower, better for first-time setup
// SENSITIVE is very slow, for paranoid users
// ─────────────────────────────────────────────
export type SecurityLevel = 'interactive' | 'moderate' | 'sensitive';

async function getArgon2Params(level: SecurityLevel = 'interactive') {
  const sodium = await getSodium();
  switch (level) {
    case 'interactive':
      return {
        opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      };
    case 'moderate':
      return {
        opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
        memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      };
    case 'sensitive':
      return {
        opslimit: sodium.crypto_pwhash_OPSLIMIT_SENSITIVE,
        memlimit: sodium.crypto_pwhash_MEMLIMIT_SENSITIVE,
      };
  }
}


export async function getSodium() {
  await _sodium.ready;
  return _sodium;
}

// ─────────────────────────────────────────────
// PIN / passphrase validation
// ─────────────────────────────────────────────
export function validatePin(pin: string): void {
  if (pin.length < 8) {
    throw new Error('PIN must be at least 8 characters');
  }
  const isAllNumeric = /^\d+$/.test(pin);
  if (isAllNumeric && pin.length < 12) {
    throw new Error(
      'Numeric PINs must be at least 12 digits — consider using a passphrase instead'
    );
  }
}

export async function generateIdentity() {
  const sodium = await getSodium();
  const keypair = sodium.crypto_sign_keypair();

  return {
    publicKey: sodium.to_base64(keypair.publicKey),
    privateKey: sodium.to_base64(keypair.privateKey),
    keyType: keypair.keyType,
  };
}


export async function encryptPrivateKey(
  privateKeyB64: string,
  pin: string,
  level: SecurityLevel = 'interactive'
): Promise<{ encrypted: string; salt: string; level: SecurityLevel }> {
  validatePin(pin); 

  const sodium = await getSodium();
  const { opslimit, memlimit } = await getArgon2Params(level);

  const salt = sodium.randombytes_buf(PWHASH_SALT_BYTES);

  const encryptionKey = sodium.crypto_pwhash(
    PWHASH_KEY_BYTES,
    pin,
    salt,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  const nonce = sodium.randombytes_buf(SECRETBOX_NONCE_BYTES);
  const privateKeyBytes = sodium.from_base64(privateKeyB64);
  const encrypted = sodium.crypto_secretbox_easy(privateKeyBytes, nonce, encryptionKey);

  const bundle = new Uint8Array(1 + nonce.length + encrypted.length);
  bundle[0] = VERSION;
  bundle.set(nonce, 1);
  bundle.set(encrypted, 1 + nonce.length);

  return {
    encrypted: sodium.to_base64(bundle),
    salt: sodium.to_base64(salt),
    level, 
  };
}

export async function decryptPrivateKey(
  encryptedB64: string,
  saltB64: string,
  pin: string,
  level: SecurityLevel = 'interactive'
): Promise<string> {
  const sodium = await getSodium();
  const { opslimit, memlimit } = await getArgon2Params(level);

  const salt = sodium.from_base64(saltB64);
  const bundle = sodium.from_base64(encryptedB64);

  const version = bundle[0];
  if (version !== 0x01) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const nonce = bundle.slice(1, 1 + SECRETBOX_NONCE_BYTES);
  const ciphertext = bundle.slice(1 + SECRETBOX_NONCE_BYTES);

  const encryptionKey = sodium.crypto_pwhash(
    PWHASH_KEY_BYTES,
    pin,
    salt,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );

  const privateKeyBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, encryptionKey);

  if (!privateKeyBytes) {
    throw new Error('Decryption failed — wrong PIN or corrupted data');
  }

  return sodium.to_base64(privateKeyBytes);
}

export async function exportSeedPhrase(privateKeyB64: string): Promise<string> {
  const sodium = await getSodium();
  const privateKeyBytes = sodium.from_base64(privateKeyB64);

  const entropy = privateKeyBytes.slice(0, 32);
  const entropyHex = sodium.to_hex(entropy);

  return bip39.entropyToMnemonic(entropyHex);
}

export async function importSeedPhrase(mnemonic: string): Promise<string> {
  const sodium = await getSodium();

  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid seed phrase');
  }

  const entropyHex = bip39.mnemonicToEntropy(mnemonic);
  const entropy = sodium.from_hex(entropyHex);
  const keypair = sodium.crypto_sign_seed_keypair(entropy);

  return sodium.to_base64(keypair.privateKey);
}

export async function signChallenge(
  privateKeyB64: string,
  challenge: string
): Promise<string> {
  const sodium = await getSodium();
  const privateKey = sodium.from_base64(privateKeyB64);
  const challengeBytes = sodium.from_string(challenge);
  const signature = sodium.crypto_sign_detached(challengeBytes, privateKey);
  return sodium.to_base64(signature);
}

export async function verifyChallenge(
  publicKeyB64: string,
  challenge: string,
  signatureB64: string
): Promise<boolean> {
  const sodium = await getSodium();
  const publicKey = sodium.from_base64(publicKeyB64);
  const challengeBytes = sodium.from_string(challenge);
  const signature = sodium.from_base64(signatureB64);
  return sodium.crypto_sign_verify_detached(signature, challengeBytes, publicKey);
}