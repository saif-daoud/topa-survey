export type Env = {
  DB: D1Database;
  TOKEN_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated origins like https://USER.github.io
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function cors(origin: string) {
  return {
    ...JSON_HEADERS,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function originAllowed(env: Env, origin: string) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origin && allowed.includes(origin);
}

function base64UrlEncode(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(s: string) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSign(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

function b64Json(obj: any) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fromB64Json(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function makeToken(env: Env, payload: any) {
  const body = b64Json(payload);
  const sig = await hmacSign(env.TOKEN_SECRET, body);
  return `${body}.${sig}`;
}

async function verifyToken(env: Env, token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Bad token format");
  const expected = await hmacSign(env.TOKEN_SECRET, body);
  if (expected !== sig) throw new Error("Bad token signature");
  const payload = fromB64Json(body);
  if (payload.exp && Date.now() > payload.exp) throw new Error("Token expired");
  return payload;
}

// ---- D1 helpers ----
type AccessCodeRow = {
  code_hash: string;
  active: number;
  uses_remaining: number | null;
  expires_at: string | null;
};

async function dbGetAccessCode(env: Env, codeHash: string): Promise<AccessCodeRow | null> {
  const row = await env.DB
    .prepare("SELECT code_hash, active, uses_remaining, expires_at FROM access_codes WHERE code_hash = ?")
    .bind(codeHash)
    .first<AccessCodeRow>();
  return row ?? null;
}

async function dbDecrementUsesRemaining(env: Env, codeHash: string): Promise<void> {
  await env.DB
    .prepare(
      "UPDATE access_codes SET uses_remaining = uses_remaining - 1 WHERE code_hash = ? AND uses_remaining IS NOT NULL AND uses_remaining > 0"
    )
    .bind(codeHash)
    .run();
}

async function allocateParticipantId(env: Env): Promise<string> {
  const createdAt = new Date().toISOString();
  const res = await env.DB
    .prepare("INSERT INTO participants (created_at) VALUES (?)")
    .bind(createdAt)
    .run();

  const n = Number(res?.meta?.last_row_id || 0);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Failed to allocate participant id");
  return formatParticipantId(n);
}

function formatParticipantId(n: number): string {
  return `P${String(n).padStart(5, "0")}`;
}

async function dbFindParticipantIdByEmail(env: Env, email: string): Promise<string | null> {
  const norm = String(email || "").trim();
  if (!norm) return null;

  const row = await env.DB
    .prepare(
      "SELECT p.id AS id FROM participants p LEFT JOIN votes v ON v.participant_id = printf('P%05d', p.id) WHERE p.email IS NOT NULL AND TRIM(p.email) != '' AND lower(p.email) = lower(?) GROUP BY p.id ORDER BY COUNT(v.id) DESC, COALESCE(p.updated_at, p.created_at) DESC, p.id DESC LIMIT 1"
    )
    .bind(norm)
    .first<{ id: number }>();

  const idNum = Number(row?.id || 0);
  if (!Number.isFinite(idNum) || idNum <= 0) return null;
  return formatParticipantId(idNum);
}

function sanitizeText(v: any, maxLen: number): string {
  const s = String(v ?? "").trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseParticipantId(pid: string): number {
  const m = /^P(\d+)$/.exec(String(pid || ""));
  if (!m) throw new Error("Invalid participant_id");
  return parseInt(m[1], 10);
}

async function dbUpdateParticipantProfile(env: Env, participantId: string, profile: any): Promise<void> {
  const idNum = parseParticipantId(participantId);

  const name = sanitizeText(profile?.name, 200);
  const email = sanitizeText(profile?.email, 320);
  const job = sanitizeText(profile?.job_title, 200);
  const inst = sanitizeText(profile?.institution, 250);
  const degree = sanitizeText(profile?.latest_degree, 200);

  const yearsRaw = profile?.years_experience;
  const years = typeof yearsRaw === "number" ? yearsRaw : Number(String(yearsRaw ?? "").trim());
  if (!Number.isFinite(years) || years < 0 || years > 80) throw new Error("Invalid years_experience");

  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE participants
     SET name=?, email=?, job_title=?, institution=?, latest_degree=?, years_experience=?, updated_at=?
     WHERE id=?`
  )
    .bind(name, email, job, inst, degree, years, now, idNum)
    .run();
}


type VoteRow = {
  id: string;
  participant_id: string;
  component: string;
  trial_id: number;
  left_method_id: string;
  right_method_id: string;
  preferred: "left" | "right" | "tie";
  resolved_preferred: "left" | "right";
  feedback?: string | null;
  timestamp_utc: string;
  user_agent?: string;
  page_url?: string;
  received_at: string;
};

function normalizePreferred(p: string): "left" | "right" | "tie" {
  const v = (p || "").toLowerCase().trim();
  if (v === "left" || v === "top") return "left";
  if (v === "right" || v === "bottom") return "right";
  if (v === "tie" || v === "none" || v === "no_preference" || v === "nopreference") return "tie";
  throw new Error("preferred must be one of: left/right/tie (or top/bottom)");
}

function normalizeResolvedPreferred(p: string): "left" | "right" {
  const v = (p || "").toLowerCase().trim();
  if (v === "left" || v === "top") return "left";
  if (v === "right" || v === "bottom") return "right";
  throw new Error("resolved_preferred must be one of: left/right (or top/bottom)");
}

async function dbUpsertVote(env: Env, row: VoteRow): Promise<void> {
  const stmt = `
    INSERT INTO votes (
      id, participant_id, component, trial_id,
      left_method_id, right_method_id,
      preferred, resolved_preferred, feedback,
      timestamp_utc, user_agent, page_url, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      participant_id=excluded.participant_id,
      component=excluded.component,
      trial_id=excluded.trial_id,
      left_method_id=excluded.left_method_id,
      right_method_id=excluded.right_method_id,
      preferred=excluded.preferred,
      resolved_preferred=excluded.resolved_preferred,
      feedback=excluded.feedback,
      timestamp_utc=excluded.timestamp_utc,
      user_agent=excluded.user_agent,
      page_url=excluded.page_url,
      received_at=excluded.received_at
  `;
  await env.DB.prepare(stmt)
    .bind(
      row.id,
      row.participant_id,
      row.component,
      row.trial_id,
      row.left_method_id,
      row.right_method_id,
      row.preferred,
      row.resolved_preferred,
      row.feedback ?? null,
      row.timestamp_utc,
      row.user_agent ?? null,
      row.page_url ?? null,
      row.received_at
    )
    .run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin") || "";
    const allowed = originAllowed(env, origin);

    // For allowed origins, reuse the same CORS headers everywhere.
    // (For disallowed origins, we intentionally do NOT emit CORS headers.)
    const headers = cors(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: allowed ? cors(origin) : {} });
    }
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: JSON_HEADERS });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors(origin) });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // POST /api/start
    if (path.endsWith("/api/start")) {
      const body = await req.json().catch(() => ({}));
      const code = String(body.code || "").trim();
      if (!code) return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers });

      const codeHash = await sha256Hex(code);
      const doc = await dbGetAccessCode(env, codeHash);
      if (!doc) return new Response(JSON.stringify({ error: "Invalid code" }), { status: 403, headers });
      if (doc.active !== 1) return new Response(JSON.stringify({ error: "Code inactive" }), { status: 403, headers });

      if (doc.uses_remaining !== null && doc.uses_remaining <= 0) {
        return new Response(JSON.stringify({ error: "Code has no remaining uses" }), { status: 403, headers });
      }

      if (doc.expires_at) {
        const expMs = Date.parse(doc.expires_at);
        if (!Number.isFinite(expMs)) return new Response(JSON.stringify({ error: "Bad expires_at format in DB" }), { status: 500, headers });
        if (Date.now() > expMs) return new Response(JSON.stringify({ error: "Code expired" }), { status: 403, headers });
      }

      if (doc.uses_remaining !== null) await dbDecrementUsesRemaining(env, codeHash);

      const participant_id = await allocateParticipantId(env);
      const token = await makeToken(env, {
        codeHash,
        participant_id,
        exp: Date.now() + 12 * 60 * 60 * 1000,
      });

      return new Response(JSON.stringify({ ok: true, token, participant_id }), { status: 200, headers: cors(origin) });
    }

    

    // POST /api/profile
    if (path.endsWith("/api/profile")) {
      const body: any = await req.json().catch(() => ({}));
      if (!body?.token || !body?.profile) {
        return new Response(JSON.stringify({ error: "Missing token or profile" }), { status: 400, headers });
      }

      let payload: any;
      try {
        payload = await verifyToken(env, String(body.token));
      } catch {
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers });
      }

      const current_participant_id = String(payload.participant_id || "");
      const codeHash = String(payload.codeHash || "");
      if (!current_participant_id || !codeHash) {
        return new Response(JSON.stringify({ error: "Invalid token payload" }), { status: 401, headers });
      }

      // If this email already exists in the DB, reuse the original participant_id so the
      // participant sees their previous progress when they re-enter with the same email.
      const email = sanitizeText(body.profile?.email, 320);
      const existing = await dbFindParticipantIdByEmail(env, email);

      const participant_id = existing || current_participant_id;

      try {
        await dbUpdateParticipantProfile(env, participant_id, body.profile);
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e?.message || "Invalid profile" }), { status: 400, headers });
      }

      // If we switched participant_id, mint a fresh token bound to the reused participant_id.
      let tokenOut = String(body.token);
      const reused = participant_id !== current_participant_id;
      if (reused) {
        tokenOut = await makeToken(env, {
          codeHash,
          participant_id,
          exp: Date.now() + 12 * 60 * 60 * 1000,
        });
      }

      return new Response(JSON.stringify({ ok: true, participant_id, token: tokenOut, reused }), { headers });
    }


    // POST /api/history
    if (path.endsWith("/api/history")) {
      const body: any = await req.json().catch(() => ({}));
      if (!body?.token) {
        return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers });
      }

      let payload: any;
      try {
        payload = await verifyToken(env, String(body.token));
      } catch {
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers });
      }

      const participant_id = String(payload.participant_id || "");
      if (!participant_id) return new Response(JSON.stringify({ error: "Invalid token payload" }), { status: 401, headers });

      const rows = await env.DB
        .prepare(
          `SELECT
             id, participant_id, component, trial_id,
             left_method_id, right_method_id,
             preferred, resolved_preferred, feedback,
             timestamp_utc, user_agent, page_url, received_at
           FROM votes
           WHERE participant_id = ?
           ORDER BY component ASC, trial_id ASC`
        )
        .bind(participant_id)
        .all<VoteRow>();

      return new Response(JSON.stringify({ ok: true, votes: rows?.results || [] }), { headers });
    }


    // POST /api/vote
    if (path.endsWith("/api/vote")) {
      const body: any = await req.json().catch(() => ({}));
      if (!body?.token || !body?.vote) {
        return new Response(JSON.stringify({ error: "Missing token or vote" }), { status: 400, headers });
      }

      let payload: any;
      try {
        payload = await verifyToken(env, String(body.token));
      } catch {
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers });
      }

      const vote = body.vote as any;

      const participant_id = String(payload.participant_id || "");
      if (!participant_id) return new Response(JSON.stringify({ error: "Invalid token payload" }), { status: 401, headers });

      if (String(vote.participant_id || "") !== participant_id) {
        return new Response(JSON.stringify({ error: "participant_id mismatch" }), { status: 403, headers });
      }

      const required = ["component", "trial_id", "left_method_id", "right_method_id", "preferred", "timestamp_utc"];
      for (const k of required) {
        if (vote[k] == null || String(vote[k]).trim() === "") {
          return new Response(JSON.stringify({ error: `Missing field: ${k}` }), { status: 400, headers });
        }
      }

      const preferred = normalizePreferred(String(vote.preferred));
      const resolved_preferred =
        vote.resolved_preferred != null && String(vote.resolved_preferred).trim() !== ""
          ? normalizeResolvedPreferred(String(vote.resolved_preferred))
          : preferred === "tie"
          ? (() => {
              throw new Error("Missing resolved_preferred for tie");
            })()
          : (preferred as "left" | "right");

      const row: VoteRow = {
        id: String(vote.id || crypto.randomUUID()),
        participant_id,
        component: String(vote.component),
        trial_id: Number(vote.trial_id),
        left_method_id: String(vote.left_method_id),
        right_method_id: String(vote.right_method_id),
        preferred,
        resolved_preferred,
        feedback: vote.feedback == null ? null : sanitizeText(vote.feedback, 5000),
        timestamp_utc: String(vote.timestamp_utc),
        user_agent: vote.user_agent ? String(vote.user_agent) : req.headers.get("user-agent") || "",
        page_url: vote.page_url ? String(vote.page_url) : "",
        received_at: new Date().toISOString(),
      };

      await dbUpsertVote(env, row);

      return new Response(JSON.stringify({ ok: true, id: row.id }), { headers });
    }


    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors(origin) });
  },
};
