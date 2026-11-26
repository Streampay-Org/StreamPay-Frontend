import { createECDH } from "node:crypto";

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushEnvironment {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

function isValidVapidKeyPair(publicKey: string, privateKey: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey) || !/^[A-Za-z0-9_-]+$/.test(privateKey)) {
    return false;
  }

  const decodedPublicKey = Buffer.from(publicKey, "base64url");
  const decodedPrivateKey = Buffer.from(privateKey, "base64url");
  if (
    decodedPublicKey.toString("base64url") === publicKey &&
    decodedPrivateKey.toString("base64url") === privateKey &&
    decodedPublicKey.length === 65 &&
    decodedPublicKey[0] === 4 &&
    decodedPrivateKey.length === 32
  ) {
    try {
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(decodedPrivateKey);
      return ecdh.getPublicKey().equals(decodedPublicKey);
    } catch {
      return false;
    }
  }
  return false;
}

function isValidSubject(subject: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(subject)) return true;

  try {
    const url = new URL(subject);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Returns null unless the complete VAPID configuration is present and valid.
 * Push remains disabled rather than preventing the rest of the app from booting.
 */
export function getPushConfig(env: PushEnvironment = process.env): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();

  if (
    !publicKey ||
    !privateKey ||
    !subject ||
    !isValidVapidKeyPair(publicKey, privateKey) ||
    !isValidSubject(subject)
  ) {
    return null;
  }

  return { publicKey, privateKey, subject };
}
