// Builds a static portal from the repository's docs and OpenAPI document.
// No dependencies: markdown, diagrams and the API reference render in the
// browser from pinned CDN builds. Runs on Vercel for every push.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(here, "dist");
mkdirSync(out, { recursive: true });

const order = ["IMPLEMENTATION_STATUS", "ARCHITECTURE", "CONNECTION_CODES", "MODULE_OWNERSHIP", "API_CONVENTIONS", "DATABASE", "SECURITY_AND_TENANCY", "REPOSITORY_ASSESSMENT"];
const files = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
const docs = [...order.filter((d) => files.includes(d)), ...files.filter((d) => !order.includes(d)).sort()].map((id) => {
  const md = readFileSync(join(root, "docs", `${id}.md`), "utf8");
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? id).trim();
  return { id, title, md };
});
docs.push({ id: "README", title: "Repository README", md: readFileSync(join(root, "README.md"), "utf8") });

let commits = [];
try {
  commits = execSync("git log -n 30 --date=iso-strict --pretty=format:%h%x1f%ad%x1f%s", { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).map((l) => { const [sha, date, subject] = l.split("\x1f"); return { sha, date, subject }; });
} catch { /* shallow or missing git history */ }

const build = {
  sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? commits[0]?.sha ?? "local",
  branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
  message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? commits[0]?.subject ?? "",
  env: process.env.VERCEL_ENV ?? "local",
  builtAt: new Date().toISOString(),
  repo: process.env.VERCEL_GIT_REPO_OWNER ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : "saymddle/togiva-core",
};

copyFileSync(join(root, "packages", "api-contracts", "openapi", "v1.json"), join(out, "openapi-v1.json"));
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const template = readFileSync(join(here, "index.template.html"), "utf8");
writeFileSync(join(out, "index.html"), template.replace("/*__DATA__*/", `window.PORTAL = ${json({ docs, commits, build })};`));
writeFileSync(join(out, "api.html"), readFileSync(join(here, "api.html"), "utf8"));
console.log(`portal: ${docs.length} docs, ${commits.length} commits, build ${build.sha}`);
