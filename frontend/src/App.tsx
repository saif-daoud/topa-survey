import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import "./App.css";

type Manifest = {
  components: string[];
  methods: { id: string; name: string; file: string }[];
};

type Descriptions = Record<string, string>;

const API_BASE = import.meta.env.VITE_API_BASE as string;

// For GH Pages: BASE_URL is like "/topa-survey/"
const BASE_URL = import.meta.env.BASE_URL; // ends with "/"
const BASENAME = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;

const APP_DESC = `
<div className="intro">

<strong>Welcome, and thank you for contributing your expertise to this study.</strong><br><br>
We are developing an AI system designed to <strong>simulate a mental health provider delivering Cognitive Behavioral Therapy (CBT).</strong><br>
To do this responsibly, we automatically extract key components of CBT interventions from clinical textbooks. Your role is to help us evaluate the quality of these extracted components.<br><br>
In this study, you will review three types of outputs the system generates:<br>
    <strong>1. Macro Actions –</strong> high-level therapeutic moves (e.g., cognitive restructuring, problem-solving, agenda setting).<br>
    <strong>2. Micro Actions –</strong> are directly actionable at the utterance level and realize the underlying macro action.<br>
    <strong>3. Conversation State –</strong> the system’s moment-to-moment understanding of the client’s thoughts, feelings, behaviors, and therapeutic progress.<br>
    <strong>4. Knowledge Graph –</strong> structured clinical concepts and their relationships, used to guide the AI’s reasoning and intervention planning.<br>
    <strong>5. Cautions –</strong> warnings or risks that describe what the therapist should *not* do during a cognitive behavioral therapy session with the patient.<br>
    <strong>6. User Profile –</strong> stable patient attributes that shape how the patient typically thinks, feels, behaves, and engages in cognitive behavioral therapy session with the therapist that help simulate realistic responses.<br><br>
For each of these components, you will see <strong>side-by-side results produced by different extraction methods.</strong><br>
Your task is to <strong>choose the option that best reflects accurate, clinically meaningful CBT practice.</strong> There are no right or wrong answers — we are seeking your clinical judgment.<br><br>
Your evaluations will help us refine an AI agent that behaves in a way that is safer, more consistent, and more aligned with real CBT interventions.<br>
Thank you for reading through the description details to make an informed judgement.<br><br>
When you’re ready, click <strong>Start</strong> to begin.

</div>
`;

function nowUtc() {
  return new Date().toISOString();
}

async function postJSON(url: string, payload: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(txt);
  } catch {}
  if (!r.ok) throw new Error(j?.error || txt || `HTTP ${r.status}`);
  return j;
}


// ---------- history helpers (merge local + server) ----------
function historyKey(r: any) {
  return `${r?.participant_id ?? ""}::${r?.component ?? ""}::${r?.trial_id ?? ""}`;
}

function mergeHistory(localRows: any[], remoteRows: any[]) {
  const m = new Map<string, any>();

  // Remote first (authoritative), then keep any local-only offline rows.
  for (const r of remoteRows || []) m.set(historyKey(r), r);
  for (const r of localRows || []) {
    const k = historyKey(r);
    if (!m.has(k)) m.set(k, r);
  }

  return Array.from(m.values()).sort((a, b) => {
    const ca = String(a?.component ?? "");
    const cb = String(b?.component ?? "");
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return Number(a?.trial_id ?? 0) - Number(b?.trial_id ?? 0);
  });
}

function makeVoteId(pid: string, component: string, trialId: number) {
  const c = String(component || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_\-]/g, "");
  return `${pid}__${c}__${trialId}`;
}


// ---------- small deterministic RNG for stable pairs ----------
function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function stableShuffle<T>(arr: T[], seedStr: string) {
  const a = [...arr];
  const rnd = mulberry32(hash32(seedStr));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// champion vs unseen challengers (simple tournament)
const TOPA_FAVORITES = new Set<string>(["G", "H", "I"]);
const TOPA_FAVORITE_ORDER: Record<string, number> = { H: 0, I: 1, G: 2 };

/**
 * If the expert selects a tie, we still need to eliminate one option so the
 * tournament can proceed. The rule is:
 * - If neither method is in {G,H,I} -> eliminate one "randomly" (deterministic seed)
 * - If exactly one is in {G,H,I} -> keep it, eliminate the other
 * - If both are in {G,H,I} -> prefer H > I > G
 */
function resolveTiePreferred(
  pid: string,
  component: string,
  trialId: number,
  leftId: string,
  rightId: string
): "left" | "right" {
  const l = String(leftId || "");
  const r = String(rightId || "");
  const lFav = TOPA_FAVORITES.has(l);
  const rFav = TOPA_FAVORITES.has(r);

  if (lFav && rFav) {
    const lr = TOPA_FAVORITE_ORDER[l] ?? 999;
    const rr = TOPA_FAVORITE_ORDER[r] ?? 999;
    return lr <= rr ? "left" : "right";
  }
  if (lFav && !rFav) return "left";
  if (!lFav && rFav) return "right";

  // deterministic "random" elimination (stable across reloads)
  const rnd = mulberry32(hash32(`${pid}::${component}::${trialId}::tie::${l}::${r}`));
  return rnd() < 0.5 ? "left" : "right";
}

function nextPair(pid: string, component: string, methodIds: string[], history: any[]) {
  if (!pid || methodIds.length < 2) return null;

  const rows = history
    .filter((r) => r.participant_id === pid && r.component === component)
    .sort((a, b) => (a.trial_id ?? 0) - (b.trial_id ?? 0));

  if (rows.length === 0) {
    const shuffled = stableShuffle(methodIds, `${pid}::${component}`);
    return [shuffled[0], shuffled[1]];
  }

  const last = rows[rows.length - 1];
  const pref = String((last as any).resolved_preferred ?? last.preferred ?? "").toLowerCase();

  let champion = "";
  if (pref === "left") champion = last.left_method_id;
  else if (pref === "right") champion = last.right_method_id;
  else if (pref === "tie") {
    const resolved = resolveTiePreferred(
      pid,
      component,
      Number(last.trial_id ?? rows.length),
      String(last.left_method_id),
      String(last.right_method_id)
    );
    champion = resolved === "left" ? last.left_method_id : last.right_method_id;
  } else {
    champion = last.left_method_id;
  }

  const appeared = new Set<string>();
  for (const r of rows) {
    appeared.add(r.left_method_id);
    appeared.add(r.right_method_id);
  }

  const unseen = methodIds.filter((m) => !appeared.has(m) && m !== champion);
  if (unseen.length === 0) return null;

  const rnd = mulberry32(hash32(`${pid}::${component}::${appeared.size}`));
  const challenger = unseen[Math.floor(rnd() * unseen.length)];
  return [champion, challenger];
}

function prettify(s: string) {
  return (s || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function normKey(s: string) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function stripPlural(s: string) {
  return s.endsWith("s") ? s.slice(0, -1) : s;
}

function bestMatchingKey(obj: any, desired: string): string | null {
  if (!obj || typeof obj !== "object") return null;

  const target = normKey(desired);
  const targetS = stripPlural(target);

  let best: { key: string; score: number } | null = null;

  for (const k of Object.keys(obj)) {
    const nk = normKey(k);
    const nkS = stripPlural(nk);

    let score = 0;
    if (nk === target) score = 100;
    else if (nkS === targetS) score = 95;
    else if (nk.includes(target) || target.includes(nk)) score = 70;
    else if (nkS.includes(targetS) || targetS.includes(nkS)) score = 60;

    if (score > 0 && (!best || score > best.score)) best = { key: k, score };
  }

  return best?.key ?? null;
}

function getComponentValue(methodData: any, component: string) {
  const k = bestMatchingKey(methodData, component);
  return k ? methodData[k] : null;
}

function getDescription(descs: Record<string, string>, component: string) {
  if (!descs) return "";
  if (descs[component]) return descs[component];
  const k = bestMatchingKey(descs, component);
  return k ? descs[k] : "";
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// minimal markdown: **bold** + newlines
function renderMiniMarkdown(md: string) {
  const safe = escapeHtml(md || "");
  const withBold = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return withBold.replace(/\n/g, "<br/>");
}

function isRecord(x: any): x is Record<string, any> {
  return x && typeof x === "object" && !Array.isArray(x);
}

function clipText(x: any, max = 500) {
  if (typeof x !== "string") return x;
  return x.length > max ? x.slice(0, max - 1) + "…" : x;
}

function isPrimitive(v: any) {
  return v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isEmptyValue(v: any): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    return v.every(isEmptyValue);
  }
  if (isRecord(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return true;
    return keys.every((k) => isEmptyValue((v as any)[k]));
  }
  return false;
}

function parseListString(s: string): string[] | null {
  if (typeof s !== "string") return null;
  const lines = s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const isBullet = (x: string) => /^(\-|\*|•)\s+/.test(x);
  const isNumbered = (x: string) => /^\d+[\)\.]\s+/.test(x);
  const looksList = (x: string) => isBullet(x) || isNumbered(x);

  const listish = lines.filter(looksList).length / lines.length;
  if (listish < 0.6) return null;

  return lines.map((x) => x.replace(/^(\-|\*|•)\s+/, "").replace(/^\d+[\)\.]\s+/, ""));
}

function NestedBullets({ value, depth = 0 }: { value: any; depth?: number }) {
  const MAX_DEPTH = 7;
  const MAX_ITEMS = 120;

  if (depth > MAX_DEPTH) return <span className="note">…</span>;

  if (isPrimitive(value)) {
    const s = value == null ? "" : String(value);
    const parsed = typeof value === "string" ? parseListString(value) : null;
    if (parsed) {
      return (
        <ul className="bullets">
          {parsed.slice(0, MAX_ITEMS).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      );
    }
    return <span className="textInline" dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(String(clipText(s, 4000))) }} />;
  }

  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ITEMS);
    return (
      <ul className="bullets">
        {arr.map((it, i) => (
          <li key={i}>
            <NestedBullets value={it} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, MAX_ITEMS);
    return (
      <ul className="bullets">
        {entries.map(([k, v]) => (
          <li key={k}>
            <span className="bulletKey">{prettify(k)}:</span> <NestedBullets value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }

  return <pre className="pre">{JSON.stringify(value, null, 2)}</pre>;
}

function ValueView({ value }: { value: any }) {
  if (isPrimitive(value)) {
    const s = value == null ? "" : String(value);
    const parsed = typeof value === "string" ? parseListString(value) : null;
    if (parsed) {
      return (
        <ul className="bullets">
          {parsed.slice(0, 200).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      );
    }
    return <div className="text" dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(String(clipText(s, 7000))) }} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="note">Empty list.</div>;
    const primitive = value.every(isPrimitive);
    if (primitive) return <NestedBullets value={value} />;
    // If it's an array of objects, always render as a table for consistency
    // (prevents left/right options from appearing in different formats).
    if (value.every(isRecord)) return <TableView data={value} />;

    // Otherwise keep a compact list view for short mixed arrays.
    if (value.length <= 12) {
      return (
        <ul className="bullets">
          {value.map((it, i) => (
            <li key={i}>{isRecord(it) ? <KeyValueView data={it} /> : <NestedBullets value={it} />}</li>
          ))}
        </ul>
      );
    }
    return <TableView data={value} />;
  }

  if (isRecord(value)) return <KeyValueView data={value} />;

  return <pre className="pre">{JSON.stringify(value, null, 2)}</pre>;
}

function TableView({ data }: { data: any }) {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return <div className="note">No rows.</div>;

  if (rows.every(isPrimitive)) return <NestedBullets value={rows} />;

  const MAX_ROWS = 220;
  const shown = rows.slice(0, MAX_ROWS);

  const cols: string[] = [];
  for (const r of shown.slice(0, 80)) {
    if (isRecord(r)) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  }
  const finalCols = cols.length ? cols : ["value"];

  return (
    <div className="tableWrap">
      {rows.length > MAX_ROWS && (
        <div className="note">
          Showing first <b>{MAX_ROWS}</b> rows out of <b>{rows.length}</b>.
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            {finalCols.map((c) => (
              <th key={c}>{prettify(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r: any, i: number) => (
            <tr key={i}>
              {finalCols.map((c) => {
                const v = isRecord(r) ? r[c] : c === "value" ? r : undefined;
                const cell =
                  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null
                    ? String(clipText(v ?? "", 600))
                    : JSON.stringify(v);
                return <td key={c}>{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueView({ data }: { data: any }) {
  if (!isRecord(data)) return <div className="note">Unexpected format.</div>;
  const entries = Object.entries(data);
  return (
    <div className="kv">
      {entries.map(([k, v]) => (
        <div key={k} className="kvRow">
          <div className="kvKey">{prettify(k)}</div>
          <div className="kvVal">
            <ValueView value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- specialized viewers ----------
function normalizeForTableRow(x: any): Record<string, any> {
  if (!isRecord(x)) return { value: String(clipText(x ?? "", 1200)) };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(x)) {
    if (Array.isArray(v)) out[k] = v.map((z) => String(z)).join(", ");
    else if (isRecord(v)) out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function ConversationStateView({ data }: { data: any }) {
  let arr: any[] | null = null;

  if (Array.isArray(data)) arr = data;
  else if (isRecord(data)) {
    const candidates = ["states", "variables", "dimensions", "items", "conversation_states", "conversation_state"];
    for (const c of candidates) {
      const k = bestMatchingKey(data, c);
      if (k && Array.isArray((data as any)[k])) {
        arr = (data as any)[k];
        break;
      }
    }
    if (!arr) {
      const arrKeys = Object.keys(data).filter((k) => Array.isArray((data as any)[k]));
      if (arrKeys.length === 1) arr = (data as any)[arrKeys[0]];
    }
  }

  if (!arr) return <ValueView value={data} />;
  const rows = arr.map(normalizeForTableRow);
  return <TableView data={rows} />;
}

function removeConfidence(x: any): any {
  if (Array.isArray(x)) return x.map(removeConfidence);
  if (isRecord(x)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(x)) {
      const nk = normKey(k);
      if (nk.includes("confidence")) continue;
      out[k] = removeConfidence(v);
    }
    return out;
  }
  return x;
}

function CautionsView({ data }: { data: any }) {
  const cleaned = removeConfidence(data);
  return <ValueView value={cleaned} />;
}

function ActionSpaceView({ data }: { data: any }) {
  const macros = Array.isArray(data) ? data : [];
  const MAX = 80;
  const shown = macros.slice(0, MAX);

  return (
    <div className="stack">
      {macros.length > MAX && (
        <div className="note">
          Showing first <b>{MAX}</b> macro actions out of <b>{macros.length}</b>.
        </div>
      )}

      {shown.map((m: any, idx: number) => {
        const name = m?.name ?? m?.macro_action ?? `Macro ${idx + 1}`;
        const goal = m?.goal ?? m?.objective ?? m?.intent ?? null;
        const desc = m?.description ?? m?.definition ?? null;

        const micro = Array.isArray(m?.micro_actions)
          ? m.micro_actions
          : Array.isArray(m?.microActions)
          ? m.microActions
          : [];

        const states =
          m?.states ?? m?.state ?? m?.conversation_states ?? m?.conversation_state ?? m?.conversationStates ?? null;

        // show extra fields (so list fields aren't silently dropped)
        const extra: Record<string, any> = {};
        if (isRecord(m)) {
          for (const [k, v] of Object.entries(m)) {
            // Drop any confidence fields everywhere (macro-level)
            if (normKey(k).includes("confidence")) continue;
            if (
              [
                "name",
                "macro_action",
                "goal",
                "objective",
                "intent",
                "description",
                "definition",
                "micro_actions",
                "microActions",
                "states",
                "state",
                "conversation_states",
                "conversation_state",
                "conversationStates",
              ].includes(k)
            )
              continue;
            if (isEmptyValue(v)) continue;
            extra[k] = v;
          }
        }

        const goalSummary =
          goal == null
            ? ""
            : typeof goal === "string"
            ? goal
            : String(goal?.objective ?? goal?.goal ?? goal?.name ?? JSON.stringify(goal));

        return (
          <details key={idx} className="accordion">
            <summary className="accordionSummary">
              <div className="accTitle">{clipText(name, 220)}</div>
              {goal || desc ? (
                <div className="accMeta">{clipText(goalSummary || String(desc || ""), 220)}</div>
              ) : (
                <div className="accMeta">Click to expand micro actions</div>
              )}
            </summary>

            <div className="accordionBody">
              {(goal || desc || states || Object.keys(extra).length > 0) && (
                <div className="stack">
                  {goal && (
                    <div>
                      <div className="label">Goal</div>
                      {typeof goal === "string" ? (
                        <div className="text" dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(String(clipText(goal, 8000))) }} />
                      ) : (
                        <NestedBullets value={goal} />
                      )}
                    </div>
                  )}

                  {desc && (
                    <div>
                      <div className="label">Description</div>
                      <div className="text" dangerouslySetInnerHTML={{ __html: renderMiniMarkdown(String(clipText(desc, 8000))) }} />
                    </div>
                  )}

                  {!isEmptyValue(states) && (
                    <div>
                      <div className="label">States</div>
                      <ValueView value={states} />
                    </div>
                  )}

                  {Object.keys(extra).length > 0 && (
                    <div>
                      <div className="label">Other fields</div>
                      <KeyValueView data={extra} />
                    </div>
                  )}
                </div>
              )}

              <div className="label">Micro actions ({micro.length})</div>
              {micro.length === 0 ? (
                <div className="note">No micro actions.</div>
              ) : (
                <ul className="bullets">
                  {micro.slice(0, 220).map((mi: any, i: number) => {
                    const miName = mi?.name ?? mi?.micro_action ?? `Micro ${i + 1}`;
                    const miDesc = mi?.description ?? mi?.definition;

                    const miExtras: Record<string, any> = {};
                    if (isRecord(mi)) {
                      for (const [k, v] of Object.entries(mi)) {
                        // Drop any confidence fields everywhere (micro-level)
                        if (normKey(k).includes("confidence")) continue;
                        if (["name", "micro_action", "description", "definition"].includes(k)) continue;
                        if (isEmptyValue(v)) continue;
                        miExtras[k] = v;
                      }
                    }

                    return (
                      <li key={i}>
                        <div className="microName">{clipText(miName, 220)}</div>
                        {miDesc && <div className="microDesc">{clipText(String(miDesc), 1200)}</div>}
                        {Object.keys(miExtras).length > 0 && <KeyValueView data={miExtras} />}
                      </li>
                    );
                  })}
                </ul>
              )}
              {micro.length > 220 && (
                <div className="note">
                  Showing first <b>220</b> micro actions.
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ComponentViewer({ component, value }: { component: string; value: any }) {
  const nc = normKey(component);

  // Globally remove confidence-related fields to avoid clutter
  // (e.g., "Confidence score", "confidence_score") across all components.
  const cleaned = removeConfidence(value);

  if (nc === "actionspace") return <ActionSpaceView data={cleaned} />;
  if (nc === "conversationstate" || nc === "conversationstates") return <ConversationStateView data={cleaned} />;
  if (nc.includes("caution")) return <CautionsView data={cleaned} />;

  return <ValueView value={cleaned} />;
}

function OptionCard({
  side,
  method,
  component,
  value,
}: {
  side: "left" | "right";
  method: { id: string; name: string; file: string };
  component: string;
  value: any;
}) {
  return (
    <div className="card optionCard">
      <div className="optionHeader">
        <div>
          <div className="optionTitle">{side === "left" ? "LEFT" : "RIGHT"} — Option {method.id}</div>
          <div className="optionSub">{method.name}</div>
        </div>
      </div>

      <div className="optionBody">
        <ComponentViewer component={component} value={value} />
      </div>
    </div>
  );
}

// ------------------ ROUTED PAGES ------------------

function GatePage() {
  const nav = useNavigate();

  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [pid, setPid] = useState(() => localStorage.getItem("pid") || "");
  const [step, setStep] = useState<"code" | "profile">(() => {
    const t = localStorage.getItem("token");
    const p = localStorage.getItem("pid");
    return t && p ? "profile" : "code";
  });

  const [profile, setProfile] = useState({
    name: "",
    email: "",
    job_title: "",
    institution: "",
    latest_degree: "",
    years_experience: "",
  });

  useEffect(() => {
    const t = localStorage.getItem("token");
    const p = localStorage.getItem("pid");
    const done = localStorage.getItem("profile_done") === "1";
    if (t && p && done) nav("/survey", { replace: true });
    if (t && p && !done) setStep("profile");
  }, [nav]);

  async function startSurvey() {
    try {
      setSubmitting(true);
      setStatus("Checking access code…");
      const res = await postJSON(`${API_BASE}/start`, { code });

      localStorage.setItem("token", res.token);
      localStorage.setItem("pid", res.participant_id);
      localStorage.removeItem("profile_done");

      setToken(res.token);
      setPid(res.participant_id);
      setStep("profile");

      setStatus("✅ Access granted. Please fill in your details to continue.");
    } catch (e: any) {
      setStatus(`❌ ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitProfile() {
    try {
      if (!token || !pid) throw new Error("Missing session. Please enter your access code again.");

      const years = Number(profile.years_experience);
      if (!profile.name.trim()) throw new Error("Please provide your name.");
      if (!profile.email.trim()) throw new Error("Please provide your email.");
      if (!profile.job_title.trim()) throw new Error("Please provide your job title.");
      if (!profile.institution.trim()) throw new Error("Please provide your institution.");
      if (!profile.latest_degree.trim()) throw new Error("Please provide your latest degree.");
      if (!Number.isFinite(years) || years < 0 || years > 80) throw new Error("Please provide a valid number of experience years.");

      setSubmitting(true);
      setStatus("Saving your details…");

      const res = await postJSON(`${API_BASE}/profile`, {
        token,
        profile: {
          name: profile.name.trim(),
          email: profile.email.trim(),
          job_title: profile.job_title.trim(),
          institution: profile.institution.trim(),
          latest_degree: profile.latest_degree.trim(),
          years_experience: years,
        },
      });

      // If the server detected this email already exists, it will return the
      // original participant_id (and a new token bound to it).
      if (res?.token && typeof res.token === "string") {
        localStorage.setItem("token", res.token);
        setToken(res.token);
      }
      if (res?.participant_id && typeof res.participant_id === "string") {
        localStorage.setItem("pid", res.participant_id);
        setPid(res.participant_id);
      }

      localStorage.setItem("profile_done", "1");
      setStatus(res?.reused ? "✅ Welcome back — your previous progress was restored. Redirecting…" : "✅ Saved. Redirecting…");
nav("/survey", { replace: true });
    } catch (e: any) {
      setStatus(`❌ ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app">
      <div className="container narrow">
        <div className="card">
          <div className="title">TOPA Expert Survey</div>
          <div className="intro" dangerouslySetInnerHTML={{ __html: APP_DESC }} />

          {step === "code" ? (
            <form
              className="formRow"
              onSubmit={(e) => {
                e.preventDefault();
                startSurvey();
              }}
            >
              <input
                className="input"
                placeholder="Access code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
              />
              <button className="btn btnPrimary" type="submit" disabled={!code || submitting}>
                {submitting ? "Starting…" : "Start"}
              </button>
            </form>
          ) : (
            <>
              <div className="noteBox">
                <b>Participant details</b> (required). This information is stored with your responses for analysis.
              </div>

              <form
                className="formGrid"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitProfile();
                }}
              >
                <input className="input" placeholder="Full name" value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
                <input className="input" placeholder="Email" value={profile.email} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} />
                <input className="input" placeholder="Job title" value={profile.job_title} onChange={(e) => setProfile((p) => ({ ...p, job_title: e.target.value }))} />
                <input className="input" placeholder="Institution" value={profile.institution} onChange={(e) => setProfile((p) => ({ ...p, institution: e.target.value }))} />
                <input className="input" placeholder="Latest degree" value={profile.latest_degree} onChange={(e) => setProfile((p) => ({ ...p, latest_degree: e.target.value }))} />
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={80}
                  step={1}
                  placeholder="Years of experience"
                  value={profile.years_experience}
                  onChange={(e) => setProfile((p) => ({ ...p, years_experience: e.target.value }))}
                />

                <div className="formActions">
                  <button className="btn btnPrimary" type="submit" disabled={submitting}>
                    {submitting ? "Saving…" : "Continue to survey"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      localStorage.removeItem("token");
                      localStorage.removeItem("pid");
                      localStorage.removeItem("profile_done");
                                            localStorage.removeItem("votes");
setToken("");
                      setPid("");
                      setStep("code");
                      setStatus("Session cleared. Please enter your access code again.");
                    }}
                  >
                    Restart
                  </button>
                </div>
              </form>
            </>
          )}

          {status && <div className="status">{status}</div>}
        </div>
      </div>
    </div>
  );
}

function SurveyPage() {
  const nav = useNavigate();

  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [participantId, setParticipantId] = useState(() => localStorage.getItem("pid") || "");

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [descriptions, setDescriptions] = useState<Descriptions>({});
  const [methods, setMethods] = useState<Record<string, any>>({});
  const [activeComponent, setActiveComponent] = useState<string>("");

  const [history, setHistory] = useState<any[]>(() => {
    const raw = localStorage.getItem("votes");
    return raw ? JSON.parse(raw) : [];
  });

  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [feedback, setFeedback] = useState<string>("");

  useEffect(() => localStorage.setItem("votes", JSON.stringify(history)), [history]);

  useEffect(() => {
    const done = localStorage.getItem("profile_done") === "1";
    if (!token || !participantId || !done) nav("/", { replace: true });
  }, [token, participantId, nav]);

  // Pull prior votes from the server so progress is restored even if localStorage is empty
  // (e.g., new device, cleared browser data).
  useEffect(() => {
    if (!token || !participantId) return;
    (async () => {
      try {
        const res = await postJSON(`${API_BASE}/history`, { token });
        const remote = Array.isArray(res?.votes) ? res.votes : [];
        if (remote.length) setHistory((prev) => mergeHistory(prev, remote));
      } catch {
        // ignore (offline, token expired, etc.)
      }
    })();
  }, [token, participantId]);

  useEffect(() => {
    (async () => {
      const m: Manifest = await (await fetch(`${BASE_URL}data/manifest.json`)).json();
      setManifest(m);

      const desc: Descriptions = await (await fetch(`${BASE_URL}data/component_descriptions.json`)).json().catch(() => ({}));
      setDescriptions(desc);

      const loaded: Record<string, any> = {};
      for (const method of m.methods) loaded[method.id] = await (await fetch(`${BASE_URL}data/${method.file}`)).json();
      setMethods(loaded);

      setActiveComponent(m.components?.[0] || "");
    })().catch((e) => setStatus(`⚠️ Failed to load data: ${e.message}`));
  }, []);

  
const validMethodIds = useMemo(() => {
  if (!manifest) return [];
  // filter out methods where the current component is empty (so we don't compare empty vs non-empty)
  return manifest.methods
    .map((m) => m.id)
    .filter((id) => {
      const md = methods[id];
      if (!md) return false;
      const v = getComponentValue(md, activeComponent);
      return !isEmptyValue(v);
    });
}, [manifest, methods, activeComponent]);

  if (!token || !participantId) return null;

  if (!manifest) {
  return (
    <div className="app">
      <div className="container narrow">
        <div className="card">
          <div className="title">Loading…</div>
          <div className="note">Fetching survey data.</div>
          {status && <div className="status">{status}</div>}
        </div>
      </div>
    </div>
  );
}

const hasEnoughMethods = validMethodIds.length >= 2;

  const pair = hasEnoughMethods && activeComponent ? nextPair(participantId, activeComponent, validMethodIds, history) : null;
  const leftId = pair?.[0] ?? "";
  const rightId = pair?.[1] ?? "";

  const leftVal = leftId ? getComponentValue(methods[leftId], activeComponent) : null;
  const rightVal = rightId ? getComponentValue(methods[rightId], activeComponent) : null;

  const seen = history.filter((r) => r.participant_id === participantId && r.component === activeComponent).length;
  const total = Math.max(0, validMethodIds.length - 1);

  const isDone = hasEnoughMethods ? pair === null : false;
  const compDesc = getDescription(descriptions, activeComponent);

  async function vote(preferred: "left" | "right" | "tie") {
    if (!pair || !token || !participantId) return;

    const trialId =
      history
        .filter((r) => r.participant_id === participantId && r.component === activeComponent)
        .reduce((mx, r) => Math.max(mx, r.trial_id ?? 0), 0) + 1;

    const resolved_preferred = preferred === "tie" ? resolveTiePreferred(participantId, activeComponent, trialId, leftId, rightId) : preferred;

    const voteObj: any = {
      id: makeVoteId(participantId, activeComponent, trialId),
      participant_id: participantId,
      component: activeComponent,
      trial_id: trialId,
      left_method_id: leftId,
      right_method_id: rightId,
      preferred,
      resolved_preferred,
      feedback: feedback.trim() || null,
      timestamp_utc: nowUtc(),
      user_agent: navigator.userAgent,
      page_url: window.location.href,
    };

    setHistory((prev) => [...prev, voteObj]);
    setFeedback("");

    try {
      setSubmitting(true);
      setStatus("Submitting…");
      await postJSON(`${API_BASE}/vote`, { token, vote: voteObj });

      if (preferred === "tie") {
        const kept = resolved_preferred === "left" ? leftId : rightId;
        setStatus(`✅ Submitted. (Tie recorded — keeping ${kept} for subsequent comparisons.)`);
      } else {
        setStatus("✅ Submitted.");
      }
    } catch (e: any) {
      setStatus(`⚠️ Submit failed (saved locally): ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("pid");
    localStorage.removeItem("profile_done");
    localStorage.removeItem("votes");
    setHistory([]);
    setToken("");
    setParticipantId("");
    setStatus("Logged out.");
    nav("/", { replace: true });
  }

  return (
    <div className="app">
      <div className="container">
        <div className="topbar">
          <div>
            <div className="title">TOPA Expert Survey</div>
            {/* <div className="sub">
              Participant: <b>{participantId}</b>
            </div> */}
          </div>

          <div className="topbarRight">
            <button className="btn" onClick={logout}>
              Logout
            </button>
          </div>
        </div>

        {status && <div className="status">{status}</div>}

        <div className="toolbar">
          <div className="toolbarBlock">
            <div className="label">Component</div>
            <select className="select" value={activeComponent} onChange={(e) => setActiveComponent(e.target.value)}>
              {manifest.components.map((c) => (
                <option key={c} value={c}>
                  {prettify(c)}
                </option>
              ))}
            </select>
          </div>

          <div className="toolbarBlock">
            <div className="label">Progress</div>
            <div className="pill">
              {seen}/{total} comparisons
            </div>
          </div>

          <div className="toolbarBlock grow">
            <div className="label">Description</div>
            <div
              className="descBox"
              dangerouslySetInnerHTML={{
                __html: compDesc ? renderMiniMarkdown(compDesc) : "<span class='note'>No description found for this component.</span>",
              }}
            />
          </div>
        </div>

        {activeComponent === "action_space" && (
          <div className="callout">
            <div className="calloutBody">
              <b>Tip:</b> In <b>Action Space</b>, click a <b>macro action</b> to expand and view its <b>micro actions</b>.
            </div>
          </div>
        )}

        {!hasEnoughMethods && (
          <div className="card">
            <div className="note">Not enough methods with non-empty output for this component to run comparisons.</div>
          </div>
        )}

        {hasEnoughMethods && isDone && (
          <div className="card">
            <div className="titleSm">Done 🎉</div>
            <div className="note">
              You have completed all pairwise comparisons for <b>{prettify(activeComponent)}</b>.
            </div>
          </div>
        )}

        {hasEnoughMethods && !isDone && (
          <>
            <div className="grid2">
              <OptionCard
                side="left"
                method={manifest.methods.find((m) => m.id === leftId)!}
                component={activeComponent}
                value={leftVal}
              />
              <OptionCard
                side="right"
                method={manifest.methods.find((m) => m.id === rightId)!}
                component={activeComponent}
                value={rightVal}
              />
            </div>

            <div className="card voteCard">
              <div className="note">
                If there is a clear reason for preferring one method over the other, please provide your feedback (optional).
              </div>

              <textarea
                className="textarea"
                placeholder="Optional feedback (not required)"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
              />

              <div className="voteBar">
                <button className="btn btnPrimary" onClick={() => vote("left")} disabled={submitting}>
                  Prefer LEFT
                </button>
                <button className="btn btnPrimary" onClick={() => vote("right")} disabled={submitting}>
                  Prefer RIGHT
                </button>
                <button className="btn btnGhost" onClick={() => vote("tie")} disabled={submitting}>
                  Tie / No preference
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <Routes>
        <Route path="/" element={<GatePage />} />
        <Route path="/survey" element={<SurveyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
