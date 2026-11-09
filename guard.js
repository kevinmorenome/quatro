'use strict';
// Abuse protection helpers (no dependencies): client IP detection, fixed-window rate limiter,
// security headers and name sanitising.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Client IP ----------
// Behind a proxy (Render, Cloudflare, nginx...) the socket address is the proxy's, so per-IP limits
// would hit everybody at once. TRUST_PROXY = number of proxy hops in front of us; the client IP is the
// Nth entry from the RIGHT of X-Forwarded-For (entries to the left can be forged by the client).
// Unset = auto: trust one hop only when the connection comes from a private/loopback address.
const isPrivate = (a) =>
  /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80)/i.test(a) || a === '::ffff:127.0.0.1';

function normalizeIp(ip) {
  ip = String(ip || 'unknown').replace(/^::ffff:/i, '');
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':'); // IPv6: one /64 is one "user"
  return ip;
}

function clientIp(req, trustProxy) {
  const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  let hops = trustProxy;
  if (hops === undefined || hops === null || hops === '') hops = isPrivate(remote) ? 1 : 0;
  hops = Number(hops) || 0;
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return normalizeIp(xff[Math.max(0, xff.length - hops)]);
  }
  return normalizeIp(remote);
}

// ---------- Rate limiter ----------
class RateLimiter {
  constructor(maxKeys = 50000) {
    this.map = new Map();
    this.maxKeys = maxKeys;
    this.disabled = false;
  }
  // Returns true if allowed. `limit` events per `windowMs` for this key.
  hit(key, limit, windowMs, now = Date.now()) {
    if (this.disabled) return true;
    const e = this.map.get(key);
    if (!e || now - e.start >= windowMs) {
      if (!e && this.map.size >= this.maxKeys) {
        this.sweep(now);
        if (this.map.size >= this.maxKeys) this.map.clear(); // flood of fake keys: forget, memory stays bounded
      }
      this.map.set(key, { start: now, n: 1, windowMs });
      return true;
    }
    e.n++;
    return e.n <= limit;
  }
  sweep(now = Date.now()) {
    for (const [k, e] of this.map) if (now - e.start >= e.windowMs) this.map.delete(k);
  }
}

// ---------- Names ----------
// Removes control characters, zero-width and bidi-override characters, collapses spaces, max 16 characters.
const BAD_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff0-\\uffff]',
  'g'
);
function cleanName(n, fallback) {
  const s = String(n == null ? '' : n).replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 16).join('').trim() || fallback;
}

// ---------- Security headers ----------
// The only inline <script> is the theme snippet in index.html; allow exactly that by hash so that any
// injected script is refused by the browser. If you add an ad network, extend script-src/connect-src/img-src/frame-src.
function inlineScriptHashes(publicDir) {
  try {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const out = [];
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      out.push("'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'");
    }
    return out;
  } catch (e) {
    return [];
  }
}

function buildHeaders(publicDir, extra) {
  const x = extra || {};
  const csp = [
    "default-src 'self'",
    ['script-src', "'self'"].concat(inlineScriptHashes(publicDir), x.script || []).join(' '),
    "style-src 'self' 'unsafe-inline'", // card/tutorial markup uses a few style="" attributes
    "img-src 'self' data:" + (x.img && x.img.length ? ' ' + x.img.join(' ') : ''),
    "connect-src 'self'" + (x.connect && x.connect.length ? ' ' + x.connect.join(' ') : ''),
    x.frame && x.frame.length ? 'frame-src ' + x.frame.join(' ') : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

module.exports = { clientIp, normalizeIp, RateLimiter, cleanName, buildHeaders };
