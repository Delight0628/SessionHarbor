/**
 * 轻量 E2EE：口令派生密钥 + AES-256-GCM
 * 密钥仅存本地配置，永不上传明文口令（对齐 ADR-002 档 A）
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = 1;

export interface EncryptedBlob {
  v: number;
  alg: string;
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
  aad?: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptJson(obj: unknown, passphrase: string, aad?: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    alg: ALGO,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
    aad,
  };
}

export function decryptJson<T = unknown>(blob: EncryptedBlob, passphrase: string): T {
  const key = deriveKey(passphrase, Buffer.from(blob.salt, "base64"));
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, "base64"));
  if (blob.aad) decipher.setAAD(Buffer.from(blob.aad, "utf8"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(blob.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export function contentFingerprint(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 32);
}

/** 生成/读取本地同步密钥文件内容 */
export function generatePassphrase(): string {
  return randomBytes(24).toString("base64url");
}
