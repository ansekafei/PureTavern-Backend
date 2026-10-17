/**
 * R2-backed storage for the encrypted sync vault.
 *
 * The Worker is a dumb opaque-blob store by design: everything it holds is ciphertext produced in the
 * browser from a key derived from the user's passphrase. That means a bucket leak, a Worker compromise
 * or a subpoena yields nothing readable — the passphrase never leaves the device.
 *
 * Layout (all keys prefixed so a single bucket can host several deployments):
 *
 *   auth/{accountId}.json         → { accountId, username, verifier, createdAt }
 *   user/{accountId}/index.enc    → encrypted backup index (JSON inside the ciphertext)
 *   user/{accountId}/obj/{id}.enc → encrypted archive blobs
 *
 * `accountId` is derived client-side from the username (SHA-256 of the normalised name), so the server
 * never needs a lookup table keyed by a raw username and the namespace is unguessable without knowing
 * the name.
 */

export interface AccountRecord {
  accountId: string;
  username: string;
  /** SHA-256 of the client-derived verifier. The verifier itself is never stored. */
  verifier: string;
  createdAt: string;
}

export interface SyncStore {
  getAccount(accountId: string): Promise<AccountRecord | null>;
  /** Atomic create. Returns `null` when the account already exists. */
  createAccount(record: AccountRecord): Promise<AccountRecord | null>;
  putIndex(accountId: string, body: ArrayBuffer): Promise<void>;
  getIndex(accountId: string): Promise<ArrayBuffer | null>;
  putObject(accountId: string, objectId: string, body: ArrayBuffer): Promise<void>;
  getObject(accountId: string, objectId: string): Promise<ArrayBuffer | null>;
  deleteObject(accountId: string, objectId: string): Promise<boolean>;
}

export function createSyncStore(bucket: R2Bucket): SyncStore {
  return {
    async getAccount(accountId) {
      const object = await bucket.get(accountKey(accountId));
      if (!object) return null;
      try {
        return (await object.json()) as AccountRecord;
      } catch {
        return null;
      }
    },

    async createAccount(record) {
      // `If-None-Match: *` makes this an atomic create-if-absent, so two devices registering the same
      // name at the same moment cannot both win.
      const existing = await bucket.put(accountKey(record.accountId), JSON.stringify(record), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
      });
      return existing ? record : null;
    },

    async putIndex(accountId, body) {
      await bucket.put(indexKey(accountId), body, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    },

    async getIndex(accountId) {
      const object = await bucket.get(indexKey(accountId));
      return object ? object.arrayBuffer() : null;
    },

    async putObject(accountId, objectId, body) {
      await bucket.put(objectKey(accountId, objectId), body, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    },

    async getObject(accountId, objectId) {
      const object = await bucket.get(objectKey(accountId, objectId));
      return object ? object.arrayBuffer() : null;
    },

    async deleteObject(accountId, objectId) {
      const key = objectKey(accountId, objectId);
      if (!(await bucket.head(key))) return false;
      await bucket.delete(key);
      return true;
    },
  };
}

function accountKey(accountId: string): string {
  return `auth/${accountId}.json`;
}

function indexKey(accountId: string): string {
  return `user/${accountId}/index.enc`;
}

function objectKey(accountId: string, objectId: string): string {
  return `user/${accountId}/obj/${objectId}.enc`;
}

/** Object ids are client-supplied, so they must not be able to escape the account prefix. */
export function isValidObjectId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/u.test(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
