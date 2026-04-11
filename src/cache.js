class TTLCache {
  constructor(defaultTtlMs = 8000) {
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    const ttl = Number.isFinite(ttlMs) ? ttlMs : this.defaultTtlMs;
    this.map.set(key, { value, expiresAt: Date.now() + ttl });
  }

  del(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

module.exports = {
  TTLCache
};
