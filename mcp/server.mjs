#!/usr/bin/env node

// Skills MCP server — exposes agent-skills/ to any MCP client over stdio.
// Zero dependencies: newline-delimited JSON-RPC 2.0, per the MCP stdio transport.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = { name: "mengto-skills", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const REPO = process.env.SKILLS_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(REPO, "agent-skills");
const GITHUB = process.env.SKILLS_GITHUB_REPO || "jgilio77/MnegtoSkills";
const BRANCH = process.env.SKILLS_GITHUB_BRANCH || "main";
const MAX_TEXT = 200_000;

// ---------- Library index ----------

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    }
    out[kv[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function readSource(demoDir) {
  const raw = readText(path.join(demoDir, "source.json"));
  if (!raw) return { label: "Local" };
  try {
    const s = JSON.parse(raw);
    const views = s.design?.view_count;
    return {
      label: `${s.provider || "Remote"} #${s.ranking?.position ?? 1}${views != null ? ` · ${views.toLocaleString("en-US")} views` : ""}`,
      provider: s.provider,
      title: s.design?.title,
      url: s.design?.url,
      views,
      synced_at: s.synced_at,
    };
  } catch {
    return { label: "Local" };
  }
}

function buildIndex() {
  const skills = new Map();
  if (!existsSync(SKILLS_DIR)) return skills;
  for (const category of readdirSync(SKILLS_DIR).sort()) {
    const catDir = path.join(SKILLS_DIR, category);
    if (!statSync(catDir).isDirectory()) continue;
    for (const slug of readdirSync(catDir).sort()) {
      const dir = path.join(catDir, slug);
      const skillFile = path.join(dir, "SKILL.md");
      if (!statSync(dir).isDirectory() || !existsSync(skillFile)) continue;
      const body = readFileSync(skillFile, "utf8");
      const fm = parseFrontmatter(body);
      const demoDir = path.join(dir, "demo");
      const hasDemo = existsSync(path.join(demoDir, "index.html"));
      const rel = `agent-skills/${category}/${slug}`;
      skills.set(slug, {
        slug,
        category,
        name: fm.name || slug,
        description: fm.description || "",
        path: rel,
        dir,
        demoDir,
        hasDemo,
        body,
      });
    }
  }
  return skills;
}

let index = buildIndex();

function findSkill(ref) {
  if (typeof ref !== "string" || !ref.trim()) throw new UserError("`skill` is required.");
  const key = ref.trim().replace(/^\$/, "").replace(/\/+$/, "").split("/").pop();
  const skill = index.get(key);
  if (!skill) {
    const close = [...index.keys()].filter((s) => s.includes(key) || key.includes(s)).slice(0, 5);
    throw new UserError(`No skill named "${key}".${close.length ? ` Did you mean: ${close.join(", ")}?` : " Use list_skills to see every slug."}`);
  }
  return skill;
}

function links(skill) {
  const base = `${skill.path}/demo/`;
  return skill.hasDemo
    ? {
        live_demo: `https://raw.githack.com/${GITHUB}/${BRANCH}/${base}index.html`,
        preview_image: `https://raw.githubusercontent.com/${GITHUB}/${BRANCH}/${base}preview.jpg`,
        prompt: `https://github.com/${GITHUB}/blob/${BRANCH}/${base}PROMPT.md`,
        skill: `https://github.com/${GITHUB}/blob/${BRANCH}/${skill.path}/SKILL.md`,
      }
    : { skill: `https://github.com/${GITHUB}/blob/${BRANCH}/${skill.path}/SKILL.md` };
}

function summary(skill) {
  return {
    slug: skill.slug,
    category: skill.category,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    has_demo: skill.hasDemo,
    source: skill.hasDemo ? readSource(skill.demoDir).label : null,
  };
}

function clip(text) {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n\n[truncated — ${text.length - MAX_TEXT} more characters]` : text;
}

// ---------- Tools ----------

class UserError extends Error {}

const TOOLS = [
  {
    name: "list_skills",
    title: "List skills",
    description: "List every skill in the library with its category, one-line description, and demo source. Filter by category or by demo source.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Only this category, e.g. web-design, codex, 3d, game-development, media, ui." },
        source: { type: "string", enum: ["any", "neuform", "local", "no-demo"], description: "Filter by where the demo came from. Default any." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run({ category, source = "any" }) {
      let list = [...index.values()];
      if (category) list = list.filter((s) => s.category === category);
      const rows = list.map(summary).filter((s) => {
        if (source === "no-demo") return !s.has_demo;
        if (source === "neuform") return s.has_demo && s.source !== "Local";
        if (source === "local") return s.source === "Local";
        return true;
      });
      const categories = [...new Set([...index.values()].map((s) => s.category))];
      return { total: rows.length, categories, skills: rows };
    },
  },
  {
    name: "search_skills",
    title: "Search skills",
    description: "Find the skills that best match a task, e.g. \"scroll animation with GSAP\" or \"dark glass UI\". Ranks by name, description, and SKILL.md body.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to build or do." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results. Default 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run({ query, limit = 8 }) {
      const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
      if (!terms.length) throw new UserError("`query` needs at least one word.");
      const scored = [];
      for (const s of index.values()) {
        const slug = s.slug.toLowerCase();
        const desc = s.description.toLowerCase();
        const body = s.body.toLowerCase();
        const slugWords = new Set(slug.split("-"));
        let score = 0;
        if (terms.join("-") === slug) score += 20;
        for (const t of terms) {
          if (slug === t) score += 12;
          if (slugWords.has(t)) score += 4;
          if (slug.includes(t)) score += 6;
          if (desc.includes(t)) score += 3;
          if (body.includes(t)) score += 1;
        }
        if (score) scored.push({ score, ...summary(s) });
      }
      scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
      return { query, results: scored.slice(0, Math.min(limit, 50)) };
    },
  },
  {
    name: "get_skill",
    title: "Get skill",
    description: "Return a skill's full SKILL.md (the steps to follow), plus REFERENCES.md when present. Read this before doing the task the skill covers.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill slug, e.g. gsap or web-design/gsap." },
        include_references: { type: "boolean", description: "Append REFERENCES.md. Default true." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run({ skill: ref, include_references = true }) {
      const skill = findSkill(ref);
      let text = skill.body;
      const refs = include_references && readText(path.join(skill.dir, "REFERENCES.md"));
      if (refs) text += `\n\n---\n\n<!-- REFERENCES.md -->\n\n${refs}`;
      return { text: clip(text) };
    },
  },
  {
    name: "get_demo_prompt",
    title: "Get demo prompt",
    description: "Return a skill's demo/PROMPT.md: the exact prompt that recreates its demo and a shorter remix prompt.",
    inputSchema: {
      type: "object",
      properties: { skill: { type: "string", description: "Skill slug." } },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run({ skill: ref }) {
      const skill = findSkill(ref);
      const text = readText(path.join(skill.demoDir, "PROMPT.md"));
      if (!text) throw new UserError(`${skill.slug} has no demo/PROMPT.md.`);
      return { text: clip(text) };
    },
  },
  {
    name: "get_demo",
    title: "Get demo details",
    description: "Return a skill's demo links (live page, preview image, prompt), its source provenance, and local files. Set include_html to also return demo/index.html.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill slug." },
        include_html: { type: "boolean", description: "Also return the demo's index.html source. Default false." },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run({ skill: ref, include_html = false }) {
      const skill = findSkill(ref);
      if (!skill.hasDemo) throw new UserError(`${skill.slug} has no demo yet.`);
      const files = readdirSync(skill.demoDir).sort();
      const assets = existsSync(path.join(skill.demoDir, "assets")) ? readdirSync(path.join(skill.demoDir, "assets")).sort() : [];
      const out = {
        ...summary(skill),
        source: readSource(skill.demoDir),
        links: links(skill),
        files: files.map((f) => `${skill.path}/demo/${f}`),
        assets,
        run_locally: `python3 -m http.server 4173 -d ${skill.path}/demo`,
      };
      if (include_html) out.html = clip(readFileSync(path.join(skill.demoDir, "index.html"), "utf8"));
      return out;
    },
  },
  {
    name: "reload_skills",
    title: "Reload library",
    description: "Rescan agent-skills/ after skills were added or edited on disk.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run() {
      index = buildIndex();
      return { total: index.size };
    },
  },
];

function toolResult(value) {
  const text = typeof value?.text === "string" && Object.keys(value).length === 1 ? value.text : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

// ---------- Resources (each SKILL.md as skill://category/slug) ----------

function listResources() {
  return [...index.values()].map((s) => ({
    uri: `skill://${s.category}/${s.slug}`,
    name: s.slug,
    title: s.name,
    description: s.description.slice(0, 300),
    mimeType: "text/markdown",
  }));
}

function readResource(uri) {
  const m = /^skill:\/\/([^/]+)\/([^/]+)$/.exec(uri || "");
  const skill = m && index.get(m[2]);
  if (!skill || skill.category !== m[1]) throw Object.assign(new Error(`Resource not found: ${uri}`), { code: -32002 });
  return { contents: [{ uri, mimeType: "text/markdown", text: skill.body }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(method, params = {}) {
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          "Designer-focused AgentSkills library. Use search_skills to find the right skill for a task, get_skill to read its steps before acting, and get_demo_prompt / get_demo for a worked example.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ run, ...t }) => t) };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      try {
        return toolResult(tool.run(params.arguments || {}));
      } catch (err) {
        if (err instanceof UserError) return { content: [{ type: "text", text: err.message }], isError: true };
        throw err;
      }
    }
    case "resources/list":
      return { resources: listResources() };
    case "resources/templates/list":
      return { resourceTemplates: [{ uriTemplate: "skill://{category}/{slug}", name: "skill", title: "Skill instructions", mimeType: "text/markdown" }] };
    case "resources/read":
      return readResource(params.uri);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (m.id === undefined) continue; // notification (e.g. notifications/initialized)
    try {
      send({ jsonrpc: "2.0", id: m.id, result: handle(m.method, m.params) });
    } catch (err) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: err.code || -32603, message: err.message } });
    }
  }
});
rl.on("close", () => process.exit(0));
process.stderr.write(`[${SERVER.name}] ${index.size} skills loaded from ${SKILLS_DIR}\n`);
