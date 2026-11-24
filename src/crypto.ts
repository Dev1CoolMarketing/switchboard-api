import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

/**
 * Emails are encrypted before they reach Postgres (AES-256-GCM), so a database dump, a Railway
 * backup or anyone with database access sees ciphertext. The key (DATA_KEY) lives only in the
 * service's environment.
 *
 * Alongside it, an HMAC "blind index" of the normalised address lets the dashboard find an exact
 * email without decrypting every row. It cannot be reversed without the key.
 *
 * Losing DATA_KEY means losing every stored email. Changing it makes existing emails unreadable;
 * there is no rotation tool (quick and dirty), so keep the key with the other production secrets.
 */
export type DataKeys = { encryption: Buffer; index: Buffer }

export function dataKeys(hex: string): DataKeys {
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) throw new Error('DATA_KEY must be 64 hex characters (32 bytes): npm run key')
  return { encryption: key, index: createHmac('sha256', key).update('email-index-v1').digest() }
}

export function encrypt(keys: DataKeys, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), body].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.')
}

/** The plaintext, or null if the value is missing or cannot be decrypted with this key. */
export function decrypt(keys: DataKeys, stored: string | null): string | null {
  if (!stored) return null
  const [version, iv, tag, body] = stored.split('.')
  if (version !== 'v1' || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.encryption, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function emailIndex(keys: DataKeys, email: string): string {
  return createHmac('sha256', keys.index).update(email.trim().toLowerCase()).digest('base64url')
}
