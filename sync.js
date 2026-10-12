/**
 * Hail Scheduler — Cloud Sync Engine
 *
 * Since we're on Netlify (static hosting, no server), we use a combination of:
 * 1. localStorage   — saves data on the current device
 * 2. JSONBin.io     — free cloud JSON storage, no account needed for reads
 * 3. BroadcastChannel — instant sync between tabs on the same device
 * 4. Polling        — checks cloud every 60 seconds for updates from other devices
 *
 * Each shop gets a unique 6-character shop code.
 * The PDR tech enters all shop codes to aggregate their data.
 * Data is stored per-shop in JSONBin bins (free tier: 10,000 requests/day).
 *
 * SETUP: Replace JSONBIN_MASTER_KEY below with a free key from jsonbin.io
 */

const SYNC = {
  // ── Config ────────────────────────────────────────────────────────────────
  // Free JSONBin.io API key — get one free at jsonbin.io (no credit card)
  // Replace this with your own key after signing up
  JSONBIN_API: 'https://api.jsonbin.io/v3',
  MASTER_KEY: '$2a$10$REPLACE_WITH_YOUR_JSONBIN_KEY',  // set in setup
  POLL_INTERVAL: 60 * 1000,  // 60 seconds

  // ── State ─────────────────────────────────────────────────────────────────
  shopCode: null,
  binId: null,
  lastSync: null,
  pollTimer: null,
  onUpdate: null,  // callback when remote data arrives

  // ── Init ──────────────────────────────────────────────────────────────────
  init(shopCode, onUpdate) {
    this.shopCode = shopCode.toUpperCase();
    this.onUpdate = onUpdate;
    this.binId = localStorage.getItem('hailsync_bin_' + this.shopCode) || null;
    this.setupBroadcast();
    this.startPolling();
  },

  // ── BroadcastChannel (instant sync between tabs) ──────────────────────────
  setupBroadcast() {
    try {
      this.bc = new BroadcastChannel('hailsync_' + this.shopCode);
      this.bc.onmessage = (e) => {
        if (e.data && e.data.type === 'update' && this.onUpdate) {
          this.onUpdate(e.data.payload, 'broadcast');
        }
      };
    } catch(e) {}
  },

  broadcast(payload) {
    try { this.bc && this.bc.postMessage({type: 'update', payload}); } catch(e) {}
  },

  // ── Save to cloud ─────────────────────────────────────────────────────────
  async push(payload) {
    payload._shopCode = this.shopCode;
    payload._savedAt  = new Date().toISOString();

    // Always save to localStorage first (instant, offline-safe)
    localStorage.setItem('hailsync_data_' + this.shopCode, JSON.stringify(payload));
    this.broadcast(payload);

    // Then push to JSONBin
    try {
      const key = localStorage.getItem('hailsync_master_key') || this.MASTER_KEY;
      const headers = {
        'Content-Type': 'application/json',
        'X-Master-Key': key,
        'X-Bin-Name': 'hailsync_' + this.shopCode.toLowerCase(),
      };

      if (this.binId) {
        // Update existing bin
        await fetch(`${this.JSONBIN_API}/b/${this.binId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload)
        });
      } else {
        // Create new bin
        const res = await fetch(`${this.JSONBIN_API}/b`, {
          method: 'POST',
          headers: {...headers, 'X-Bin-Private': 'false'},
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const data = await res.json();
          this.binId = data.metadata?.id;
          if (this.binId) {
            localStorage.setItem('hailsync_bin_' + this.shopCode, this.binId);
            localStorage.setItem('hailsync_bin_pub_' + this.shopCode, this.binId);
          }
        }
      }
      this.lastSync = new Date();
      return true;
    } catch(e) {
      console.warn('Cloud push failed (offline?):', e.message);
      return false;
    }
  },

  // ── Read from cloud ───────────────────────────────────────────────────────
  async pull(shopCode) {
    const code = (shopCode || this.shopCode).toUpperCase();
    const binId = localStorage.getItem('hailsync_bin_' + code);
    if (!binId) return null;

    try {
      const key = localStorage.getItem('hailsync_master_key') || this.MASTER_KEY;
      const res = await fetch(`${this.JSONBIN_API}/b/${binId}/latest`, {
        headers: {'X-Master-Key': key}
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.record || null;
    } catch(e) {
      // Offline — return cached local data
      const cached = localStorage.getItem('hailsync_data_' + code);
      return cached ? JSON.parse(cached) : null;
    }
  },

  // ── Polling ───────────────────────────────────────────────────────────────
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollOnce(), this.POLL_INTERVAL);
  },

  async pollOnce() {
    const data = await this.pull();
    if (data && this.onUpdate) {
      const localRaw = localStorage.getItem('hailsync_data_' + this.shopCode);
      const local = localRaw ? JSON.parse(localRaw) : null;
      // Only update if remote is newer
      if (!local || data._savedAt > (local._savedAt || '')) {
        this.onUpdate(data, 'poll');
      }
    }
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  },

  // ── Register bin ID (for tech to connect to a shop) ───────────────────────
  registerBin(shopCode, binId) {
    localStorage.setItem('hailsync_bin_' + shopCode.toUpperCase(), binId);
  },

  // ── Last sync time display ─────────────────────────────────────────────────
  syncAgo() {
    if (!this.lastSync) return 'not yet';
    const s = Math.round((Date.now() - this.lastSync) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    return Math.round(s/60) + 'm ago';
  }
};
