#!/usr/bin/env bun
// ework-issue — command-line issue browser/editor for ework webs.
// Sync-directory mode: `pull` materializes issues as files; `push` applies local edits.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const USAGE = `ework-issue — command-line issue tool (sync-directory mode)

Usage:
  ework-issue init <baseUrl> <owner/repo> [--save-token]   set up sync dir in cwd
  ework-issue pull [--state open|closed|all]               sync remote issues into ./issues/
  ework-issue list                                          list locally synced issues
  ework-issue open <number>                                 print a full thread
  ework-issue comment <number> -m "text" [--close|--reopen] post a comment directly
  ework-issue push                                          apply local edits (new comment files, meta state changes)
  ework-issue status                                        show sync state summary

Auth: --token flag > EWORK_ISSUE_TOKEN env > token saved by init --save-token.
Exit codes: 0 ok · 1 usage · 2 conflict/unsupported · 3 network/auth.`;

const EXIT = { OK: 0, USAGE: 1, CONFLICT: 2, NET: 3 };

function die(msg, code = EXIT.USAGE) { console.error("ework-issue: " + msg); process.exit(code); }
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
function pad4(n) { return String(n).padStart(4, "0"); }
function slugify(t) {
  const s = String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "issue";
}

// ---------- state ----------
function rootDir(args) { return args.root || process.cwd(); }
function statePath(root) { return path.join(root, ".ework-issue.json"); }
function loadState(root) {
  const p = statePath(root);
  if (!fs.existsSync(p)) die("not initialized — run: ework-issue init <baseUrl> <owner/repo>", EXIT.USAGE);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveState(root, st) { fs.writeFileSync(statePath(root), JSON.stringify(st, null, 2) + "\n"); }
function tokenFor(args, st) {
  return args.token || process.env.EWORK_ISSUE_TOKEN || st.token || die("no token — pass --token or set EWORK_ISSUE_TOKEN", EXIT.USAGE);
}

// ---------- http ----------
async function api(st, args, pathname, init) {
  const base = (args.url || st.baseUrl).replace(/\/+$/, "");
  const token = tokenFor(args, st);
  const res = await fetch(base + pathname, {
    ...init,
    headers: {
      authorization: `token ${token}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) die(`auth failed (${res.status}) for ${pathname}`, EXIT.NET);
  if (!res.ok) die(`${init?.method || "GET"} ${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, EXIT.NET);
  return res.json();
}

// ---------- file layout ----------
function issueDir(root, number, title) {
  return path.join(root, "issues", `${pad4(number)}-${slugify(title)}`);
}
function findIssueDir(root, number) {
  const dir = path.join(root, "issues");
  if (!fs.existsSync(dir)) return null;
  const m = fs.readdirSync(dir).find((d) => d.startsWith(pad4(number) + "-"));
  return m ? path.join(dir, m) : null;
}
function writeIssueFiles(root, issue, comments) {
  const dir = issueDir(root, issue.number, issue.title);
  fs.mkdirSync(path.join(dir, "comments"), { recursive: true });
  const meta = {
    number: issue.number, title: issue.title, state: issue.state, author: issue.author,
    ai_status: issue.ai_status, model: issue.model, comment_count: comments.length,
    created_at: issue.created_at, updated_at: issue.updated_at,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "body.md"), issue.body + "\n");
  // rewrite comments from scratch (remote is the source of truth on pull)
  for (const f of fs.readdirSync(path.join(dir, "comments"))) fs.unlinkSync(path.join(dir, "comments", f));
  const map = {};
  for (const c of comments) {
    const fname = `${pad4(c.id)}-${c.author}.md`;
    const fm = [
      "---",
      `id: ${c.id}`,
      `author: ${c.author}`,
      `author_kind: ${c.author_kind}`,
      `model: ${c.model}`,
      `upstream_comment_id: ${c.upstream_comment_id ?? ""}`,
      `created_at: ${c.created_at}`,
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "comments", fname), fm + c.body + "\n");
    map[fname] = { id: c.id, sha: sha(c.body) };
  }
  return { dir, map, metaSha: sha(JSON.stringify(meta)), bodySha: sha(issue.body) };
}
function parseFrontMatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text };
  const fmBlock = text.slice(4, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const fm = {};
  for (const line of fmBlock.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body };
}

// ---------- commands ----------
async function cmdPull(args) {
  const root = rootDir(args), st = loadState(root);
  const state = args.state || "all";
  const data = await api(st, args, `/api/v1/issues?owner=${st.owner}&repo=${st.name}&state=${state}`, {});
  let changed = 0, unchanged = 0;
  for (const it of data.issues) {
    const prev = st.issues?.[String(it.number)];
    if (prev && prev.updatedAt === it.updated_at && findIssueDir(root, it.number)) { unchanged++; continue; }
    const d = await api(st, args, `/api/v1/issues/${it.number}?owner=${st.owner}&repo=${st.name}`, {});
    const w = writeIssueFiles(root, d.issue, d.comments);
    st.issues = st.issues || {};
    st.issues[String(it.number)] = {
      updatedAt: d.issue.updated_at, state: d.issue.state, dir: path.relative(root, w.dir),
      metaSha: w.metaSha, bodySha: w.bodySha, comments: w.map,
    };
    changed++;
  }
  saveState(root, st);
  console.log(`pull: ${changed} updated, ${unchanged} unchanged (repo ${st.owner}/${st.name} @ ${(args.url || st.baseUrl)})`);
}

async function cmdOpen(args, number) {
  const root = rootDir(args), st = loadState(root);
  const d = await api(st, args, `/api/v1/issues/${number}?owner=${st.owner}&repo=${st.name}`, {});
  const line = "─".repeat(72);
  console.log(line);
  console.log(`#${d.issue.number} [${d.issue.state}] ${d.issue.title}`);
  console.log(`by ${d.issue.author} · ${d.issue.created_at} · ai:${d.issue.ai_status || "-"} · model:${d.issue.model || "-"}`);
  console.log(line);
  console.log(d.issue.body.trim());
  for (const c of d.comments) {
    console.log("\n" + line);
    console.log(`💬 #${c.id} ${c.author} (${c.author_kind || "?"})${c.model ? " · " + c.model : ""} · ${c.created_at}`);
    console.log(line);
    console.log(c.body.trim());
  }
  console.log(line);
}

async function postComment(st, args, number, body, opts = {}) {
  const payload = { body };
  if (opts.close) payload.close = true;
  if (opts.reopen) payload.reopen = true;
  return api(st, args, `/api/${st.owner}/${st.name}/issues/${number}/comment`, { method: "POST", body: JSON.stringify(payload) });
}

async function cmdComment(args, number, text) {
  const root = rootDir(args), st = loadState(root);
  const r = await postComment(st, args, number, text, args);
  console.log(`commented on #${number} (id ${r.comment?.id ?? "?"}${r.closed ? ", closed" : ""}${r.reopened ? ", reopened" : ""})`);
  // refresh that issue locally if we track it
  if (st.issues?.[String(number)]) await cmdPull(args);
}

async function cmdPush(args) {
  const root = rootDir(args), st = loadState(root);
  const issuesDir = path.join(root, "issues");
  if (!fs.existsSync(issuesDir)) die("no issues/ dir — run pull first", EXIT.USAGE);
  let pushed = 0, skipped = 0, conflicts = [];
  for (const entry of fs.readdirSync(issuesDir)) {
    const dir = path.join(issuesDir, entry);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const rec = st.issues?.[String(meta.number)];
    if (!rec) { console.log(`skip ${entry}: not tracked — run pull`); skipped++; continue; }

    // 1) new comment files → post
    const cdir = path.join(dir, "comments");
    if (fs.existsSync(cdir)) {
      for (const f of fs.readdirSync(cdir).sort()) {
        if (rec.comments?.[f]) continue;
        const { fm, body } = parseFrontMatter(fs.readFileSync(path.join(cdir, f), "utf8"));
        if (!body.trim()) { console.log(`skip ${entry}/comments/${f}: empty body`); skipped++; continue; }
        const r = await postComment(st, args, meta.number, body.trim(), {});
        const id = r.comment?.id;
        console.log(`pushed comment ${f} → #${meta.number} (id ${id})`);
        rec.comments = rec.comments || {};
        rec.comments[f] = { id, sha: sha(body.trim()) };
        // normalize filename to remote id if it was a local draft (draft- prefix)
        pushed++;
      }
    }

    // 2) meta.json state change → close/reopen (with conflict check)
    if (rec.state !== meta.state) {
      const d = await api(st, args, `/api/v1/issues/${meta.number}?owner=${st.owner}&repo=${st.name}`, {});
      if (d.issue.state !== rec.state) {
        console.log(`CONFLICT #${meta.number}: server state is "${d.issue.state}", local base was "${rec.state}" — pull first`);
        conflicts.push(meta.number); skipped++;
      } else {
        const want = meta.state === "closed";
        await postComment(st, args, meta.number, "", want ? { close: true } : { reopen: true });
        console.log(`state #${meta.number}: ${rec.state} → ${meta.state}`);
        rec.state = meta.state; pushed++;
      }
    }

    // 3) title/body edits: unsupported via API in MVP
    if (rec.bodySha && sha(fs.readFileSync(path.join(dir, "body.md"), "utf8").replace(/\n$/, "")) !== rec.bodySha) {
      console.log(`CONFLICT/unsupported #${meta.number}: body.md edited — title/body editing not supported yet (use web UI)`);
      conflicts.push(meta.number); skipped++;
    }
  }
  saveState(root, st);
  if (conflicts.length) die(`${pushed} pushed, ${skipped} skipped, conflicts: ${conflicts.join(", ")}`, EXIT.CONFLICT);
  console.log(`push: ${pushed} applied, ${skipped} skipped`);
}

async function cmdList(args) {
  const root = rootDir(args), st = loadState(root);
  const rows = Object.entries(st.issues || {}).map(([n, r]) => {
    const metaPath = path.join(root, r.dir, "meta.json");
    const m = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
    return { n: Number(n), state: m.state ?? r.state, title: (m.title ?? "").slice(0, 48), updated: (m.updated_at ?? r.updatedAt ?? "").slice(0, 16).replace("T", " ") };
  }).sort((a, b) => b.n - a.n);
  for (const r of rows) console.log(`${pad4(r.n)}  ${r.state === "open" ? "○" : "●"} ${r.updated}  ${r.title}`);
}

function cmdInit(args, baseUrl, repo) {
  const root = rootDir(args);
  const [owner, name] = String(repo).split("/");
  if (!owner || !name) die("repo must be owner/name", EXIT.USAGE);
  const st = { baseUrl: String(baseUrl).replace(/\/+$/, ""), owner, name, repo: `${owner}/${name}`, issues: {} };
  if (args["save-token"]) {
    const t = args.token || process.env.EWORK_ISSUE_TOKEN;
    if (!t) die("--save-token needs --token or EWORK_ISSUE_TOKEN", EXIT.USAGE);
    st.token = t;
  }
  fs.mkdirSync(path.join(root, "issues"), { recursive: true });
  saveState(root, st);
  console.log(`initialized ${path.relative(process.cwd(), statePath(root))} → ${st.baseUrl} ${owner}/${name}${st.token ? " (token saved)" : ""}`);
}

// ---------- arg parse ----------
function parseArgs(argv) {
  const args = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      const k = a.replace(/^-+/, "");
      if (k === "close" || k === "reopen" || k === "save-token" || k === "fresh") args[k] = true;
      else { args[k] = argv[++i]; }
    } else pos.push(a);
  }
  args._ = pos;
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;
try {
  switch (cmd) {
    case "init": cmdInit(args, rest[0], rest[1]); break;
    case "pull": await cmdPull(args); break;
    case "list": await cmdList(args); break;
    case "open": rest[0] ? await cmdOpen(args, Number(rest[0])) : die("open needs a number"); break;
    case "comment": (rest[0] && args.m) ? await cmdComment(args, Number(rest[0]), args.m) : die("comment needs <number> and -m"); break;
    case "push": await cmdPush(args); break;
    case "status": { const st = loadState(rootDir(args)); console.log(`${st.baseUrl} ${st.owner}/${st.name}: ${Object.keys(st.issues || {}).length} issues tracked`); break; }
    default: console.log(USAGE); process.exit(cmd ? EXIT.USAGE : EXIT.OK);
  }
} catch (e) {
  if (e && e.message && e.message.startsWith("ework-issue:")) process.exit(EXIT.NET);
  throw e;
}
