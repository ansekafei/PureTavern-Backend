/**
 * In-memory R2 stand-in for the sync tests.
 *
 * Only the subset the store actually touches is implemented: `get`, `head`, `put` (with the
 * `If-None-Match: *` conditional that registration relies on) and `delete`.
 */

interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

export class FakeR2Bucket {
  readonly #objects = new Map<string, StoredObject>();

  async get(key: string): Promise<FakeR2Object | null> {
    const stored = this.#objects.get(key);
    if (!stored) return null;
    return new FakeR2Object(key, stored.body);
  }

  async head(key: string): Promise<{ key: string } | null> {
    return this.#objects.has(key) ? { key } : null;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { onlyIf?: Headers; httpMetadata?: { contentType?: string } },
  ): Promise<{ key: string } | null> {
    const onlyIf = options?.onlyIf;
    if (onlyIf && onlyIf.get('if-none-match') === '*' && this.#objects.has(key)) {
      return null;
    }
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.#objects.set(key, {
      body: bytes,
      contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
    });
    return { key };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  /** Test helper: every key currently held, for assertions about isolation. */
  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }
}

class FakeR2Object {
  readonly key: string;
  readonly #body: Uint8Array;

  constructor(key: string, body: Uint8Array) {
    this.key = key;
    this.#body = body;
  }

  async json<T>(): Promise<T> {
    return JSON.parse(new TextDecoder().decode(this.#body)) as T;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#body.buffer.slice(
      this.#body.byteOffset,
      this.#body.byteOffset + this.#body.byteLength,
    ) as ArrayBuffer;
  }
}
