import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, CONTRACT_VERSION, v1Routes } from "../index.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openapi", "v1.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(buildOpenApi(v1Routes, { version: CONTRACT_VERSION }), null, 2) + "\n");
console.log(`wrote ${out}`);
