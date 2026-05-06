/**
 * Cloudflare Email Worker — CSIRT Inbound Email Relay
 *
 * Receives emails sent to analyze@cyberseguridadciudadana.cc via
 * Cloudflare Email Routing, parses MIME content, and forwards the
 * relevant data to the Laravel backend at api.cyberseguridadciudadana.cc.
 *
 * Deploy:
 *   1. wrangler deploy
 *
 * Cloudflare Email Routing rule:
 *   Match: analyze@cyberseguridadciudadana.cc
 *   Action: Send to Worker → csirt-email-relay
 *
 * Secrets (set via wrangler secret put):
 *   BACKEND_URL       https://api.cyberseguridadciudadana.cc
 *   WEBHOOK_SECRET    (same value as CSIRT_WEBHOOK_SECRET in Laravel .env)
 */

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    const backendUrl    = env.BACKEND_URL;
    const webhookSecret = env.WEBHOOK_SECRET ?? "";

    // ── Parse the raw MIME email ────────────────────────────────────────────
    const rawEmail = await streamToText(message.raw);
    const parsed   = parseMime(rawEmail);

    // ── Build payload ───────────────────────────────────────────────────────
    const payload = JSON.stringify({
      from:      message.from,
      from_name: parsed.fromName ?? "",
      subject:   message.headers.get("subject") ?? "(sin asunto)",
      body:      parsed.textBody ?? parsed.htmlStripped ?? "(cuerpo vacío)",
      image_b64: parsed.firstImageBase64 ?? null,
    });

    // ── HMAC-SHA256 signature ───────────────────────────────────────────────
    const signature = webhookSecret
      ? "sha256=" + (await hmacSha256(webhookSecret, payload))
      : "";

    // ── Forward to Laravel ──────────────────────────────────────────────────
    const headers = {
      "Content-Type": "application/json",
      Accept:         "application/json",
    };
    if (signature) headers["X-CSIRT-Signature"] = signature;

    const response = await fetch(
      `${backendUrl}/api/csirt/email-analysis/inbound`,
      { method: "POST", headers, body: payload }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[csirt-email-relay] Backend returned ${response.status}: ${body}`
      );
      // Re-throw so Cloudflare marks the delivery as failed
      throw new Error(`Backend error ${response.status}`);
    }

    console.log(
      `[csirt-email-relay] Queued analysis for ${message.from} — ` +
      `"${message.headers.get("subject")}"`
    );
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Convert a ReadableStream<Uint8Array> to a UTF-8 string. */
async function streamToText(stream) {
  const reader  = stream.getReader();
  const chunks  = [];
  let   done    = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (value) chunks.push(value);
    done = d;
  }
  const bytes = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0));
  let   off   = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return new TextDecoder().decode(bytes);
}

/**
 * Very lightweight MIME parser.
 *
 * Handles:
 *   – text/plain  → textBody
 *   – text/html   → htmlStripped (tags removed)
 *   – image/*     → firstImageBase64 (first image attachment only)
 *   – From display name extraction
 *
 * This is intentionally simple. For production you may want to use a full
 * MIME library if you deploy this as an npm Worker project.
 */
function parseMime(raw) {
  const result = {
    fromName:         null,
    textBody:         null,
    htmlStripped:     null,
    firstImageBase64: null,
  };

  // ── Extract From display name ───────────────────────────────────────────
  const fromHeader = headerValue(raw, "From");
  if (fromHeader) {
    const m = fromHeader.match(/^"?([^"<]+)"?\s*</);
    if (m) result.fromName = m[1].trim();
  }

  // ── Detect boundary ─────────────────────────────────────────────────────
  const contentType = headerValue(raw, "Content-Type") ?? "";
  const boundaryM   = contentType.match(/boundary="?([^";\r\n]+)"?/i);

  if (!boundaryM) {
    // Single-part message
    const body = bodyAfterHeaders(raw);
    const encoding = (headerValue(raw, "Content-Transfer-Encoding") ?? "").toLowerCase();
    const decoded  = decodeBody(body, encoding);
    if (contentType.includes("text/plain")) result.textBody    = decoded;
    if (contentType.includes("text/html"))  result.htmlStripped = stripHtml(decoded);
    return result;
  }

  // ── Multi-part: split on boundary ───────────────────────────────────────
  const boundary = boundaryM[1];
  const parts    = raw.split("--" + boundary);

  for (const part of parts) {
    if (!part.includes("\r\n\r\n") && !part.includes("\n\n")) continue;

    const partCt       = headerValue(part, "Content-Type") ?? "";
    const partEncoding = (headerValue(part, "Content-Transfer-Encoding") ?? "7bit").toLowerCase();
    const partBody     = bodyAfterHeaders(part).trim();
    const decoded      = decodeBody(partBody, partEncoding);

    if (partCt.startsWith("text/plain") && !result.textBody) {
      result.textBody = decoded;
    } else if (partCt.startsWith("text/html") && !result.htmlStripped) {
      result.htmlStripped = stripHtml(decoded);
    } else if (partCt.startsWith("image/") && !result.firstImageBase64) {
      // Already base64-encoded in the MIME part — clean whitespace
      result.firstImageBase64 = partBody.replace(/\s+/g, "");
    }
  }

  return result;
}

/** Return the value of the first matching header line (case-insensitive). */
function headerValue(text, name) {
  const re = new RegExp(`^${name}:\\s*(.+)`, "im");
  const m  = text.match(re);
  return m ? m[1].trim() : null;
}

/** Return everything after the first blank line (the MIME body). */
function bodyAfterHeaders(text) {
  const crlfIdx = text.indexOf("\r\n\r\n");
  const lfIdx   = text.indexOf("\n\n");
  const idx     = crlfIdx !== -1 ? crlfIdx + 4 : (lfIdx !== -1 ? lfIdx + 2 : -1);
  return idx !== -1 ? text.slice(idx) : text;
}

/** Decode a MIME body part according to its Content-Transfer-Encoding. */
function decodeBody(body, encoding) {
  if (encoding === "base64") {
    try {
      return atob(body.replace(/\s+/g, ""));
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body; // 7bit / 8bit
}

/** Strip HTML tags and decode common entities. */
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** HMAC-SHA256 using the Web Crypto API (available in CF Workers). */
async function hmacSha256(secret, message) {
  const enc        = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig    = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(message));
  const bytes  = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
