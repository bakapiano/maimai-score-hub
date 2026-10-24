/** Bounded by both payload bytes and entry count; never stores raw SVG strings. */
export class ByteLru<T> {
  private readonly entries = new Map<
    string,
    { value: T; bytes: number; expires: number }
  >();
  private usedBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries = 512,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  get bytes() {
    return this.usedBytes;
  }
  get size() {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBytes) {
      return;
    }
    while (
      this.entries.size &&
      (this.usedBytes + bytes > this.maxBytes ||
        this.entries.size >= this.maxEntries)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes, expires: Date.now() + this.ttlMs });
    this.usedBytes += bytes;
  }

  delete(key: string): void {
    const old = this.entries.get(key);
    if (old) {
      this.usedBytes -= old.bytes;
    }
    this.entries.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key);
      }
    }
  }
}
