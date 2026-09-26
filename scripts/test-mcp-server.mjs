#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

const server = spawn(process.execPath, [path.resolve("mcp/server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const json = (result) => JSON.parse(result.content[0].text);

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ["list_skills", "search_skills", "get_skill", "get_demo_prompt", "get_demo", "reload_skills"]);

  const all = json(await call("list_skills", {}));
  assert.ok(all.total > 50, "library should load");
  const web = json(await call("list_skills", { category: "web-design" }));
  assert.ok(web.skills.every((s) => s.category === "web-design"));
  const neuform = json(await call("list_skills", { source: "neuform" }));
  assert.ok(neuform.skills.length > 0 && neuform.skills.every((s) => s.source.startsWith("Neuform")));

  const search = json(await call("search_skills", { query: "gsap scroll", limit: 3 }));
  assert.ok(search.results.some((r) => r.slug === "gsap"));

  const skill = await call("get_skill", { skill: "web-design/gsap" });
  assert.match(skill.content[0].text, /^---\nname: gsap/);

  const prompt = await call("get_demo_prompt", { skill: "$gsap" });
  assert.match(prompt.content[0].text, /GSAP/);

  const demo = json(await call("get_demo", { skill: "gsap" }));
  assert.match(demo.links.live_demo, /raw\.githack\.com\/.+\/agent-skills\/web-design\/gsap\/demo\/index\.html$/);
  assert.match(demo.source.label, /^Neuform #1/);

  const missing = await call("get_skill", { skill: "../../etc/passwd" });
  assert.equal(missing.isError, true, "path traversal must resolve to an unknown slug");

  const resources = (await rpc("resources/list")).result.resources;
  assert.ok(resources.some((r) => r.uri === "skill://web-design/gsap"));
  const read = (await rpc("resources/read", { uri: "skill://web-design/gsap" })).result;
  assert.match(read.contents[0].text, /name: gsap/);
  assert.equal((await rpc("resources/read", { uri: "skill://codex/gsap" })).error.code, -32002);

  assert.equal((await rpc("nope/nope")).error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "nope" })).error.code, -32602);

  console.log(`MCP server OK: ${all.total} skills, ${tools.length} tools, ${resources.length} resources.`);
} finally {
  server.stdin.end();
}
