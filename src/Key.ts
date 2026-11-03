import { Effect } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { Base64Url } from "effect/encoding"

const keyBytes = 32

/** `prefix` and 32 random bytes in base64url, 43 characters. */
export const generateKey = (prefix: string) =>
  Effect.map(SecureRandom.SecureRandom.use((random) => random.randomBytes(keyBytes)), (bytes) => `${prefix}${Base64Url.encode(bytes)}`)

/** The SHA-256 of `key`. */
export const hashKey = (key: string) => Digest.Digest.use((digest) => digest.digest(Digest.sha256, new TextEncoder().encode(key)))

/** The SHA-256 of `key` in hex, what the table stores in its place. */
export const hashKeyHex = (key: string) => Digest.Digest.use((digest) => digest.digestHex(Digest.sha256, new TextEncoder().encode(key)))
