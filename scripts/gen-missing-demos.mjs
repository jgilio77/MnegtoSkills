#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = "/home/user/MnegtoSkills";

const skillFiles = execFileSync("git", ["ls-files", "agent-skills/**/SKILL.md"], { cwd: root, encoding: "utf8" })
  .trim().split("\n").filter(Boolean).sort();

function parseSkill(src) {
  const fm = src.match(/^---\s*\n([\s\S]*?)\n---/);
  const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { name, desc };
}

function displayName(slug) {
  const map = { "3d":"3D", ai:"AI", api:"API", cobejs:"COBE.js", css:"CSS", gsap:"GSAP",
    html:"HTML", js:"JS", matterjs:"Matter.js", mcp:"MCP", pdf:"PDF", svg:"SVG",
    threejs:"Three.js", tts:"TTS", ui:"UI", ux:"UX", vantajs:"Vanta.js", webgl:"WebGL" };
  return slug.split("-").map(p => map[p] || (p ? p[0].toUpperCase() + p.slice(1) : p)).join(" ");
}

function makeHtml(slug, category, desc) {
  const title = displayName(slug);
  const cat = displayName(category);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  width:1280px;height:720px;overflow:hidden;
  background:#0d0d0d;color:#e8e6e0;
  font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
  display:flex;align-items:center;justify-content:center;
}
.card{
  max-width:640px;padding:52px 56px;
  border:1px solid #2a2a28;border-radius:16px;
  background:#141412;
}
.eyebrow{
  font:600 10px/1.2 "SF Mono",monospace;
  letter-spacing:.12em;text-transform:uppercase;
  color:#5a5a56;margin-bottom:22px;
}
h1{
  font-size:42px;font-weight:400;letter-spacing:-.04em;line-height:1.05;
  font-family:"Iowan Old Style",Georgia,serif;
  margin-bottom:20px;
}
p{font-size:15px;line-height:1.65;color:#888880;max-width:480px;}
.tag{
  display:inline-block;margin-top:28px;
  padding:5px 11px;border-radius:999px;
  background:#1e1e1c;border:1px solid #2e2e2a;
  font:600 10px/1.2 "SF Mono",monospace;
  letter-spacing:.1em;text-transform:uppercase;color:#5a5a56;
}
</style>
</head>
<body>
<div class="card">
  <div class="eyebrow">${cat} · AgentSkill</div>
  <h1>${title}</h1>
  <p>${desc.slice(0, 220)}${desc.length > 220 ? "…" : ""}</p>
  <div class="tag">$${slug}</div>
</div>
</body>
</html>`;
}

const missing = skillFiles.filter(f => {
  const dir = path.join(root, path.dirname(f));
  return !existsSync(path.join(dir, "demo", "preview.jpg"));
});

console.log(`Generating demos for ${missing.length} skills…`);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 720 });

for (const skillFile of missing) {
  const parts = skillFile.split("/");
  const category = parts[1];
  const slug = parts[2];
  const skillDir = path.join(root, path.dirname(skillFile));
  const demoDir = path.join(skillDir, "demo");
  const indexPath = path.join(demoDir, "index.html");
  const previewPath = path.join(demoDir, "preview.jpg");

  await mkdir(demoDir, { recursive: true });

  // Generate index.html if missing
  if (!existsSync(indexPath)) {
    const src = readFileSync(path.join(root, skillFile), "utf8");
    const { desc } = parseSkill(src);
    const html = makeHtml(slug, category, desc || "Reusable workflow and implementation guidance.");
    await writeFile(indexPath, html);
  }

  // Screenshot
  await page.goto("file://" + indexPath);
  await page.waitForTimeout(300);
  await page.screenshot({ path: previewPath, type: "jpeg", quality: 90 });
  console.log(`  ✓ ${slug}`);
}

await browser.close();
console.log("Done.");
