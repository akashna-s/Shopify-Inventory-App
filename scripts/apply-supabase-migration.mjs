import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseEnvironment(source) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const migrationPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!migrationPath) {
  throw new Error("Pass the migration SQL file path as the first argument.");
}

parseEnvironment(await readFile(resolve(".env"), "utf8"));
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!accessToken || !projectRef) {
  throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.");
}

const migration = await readFile(resolve(migrationPath), "utf8");
const query = dryRun ? `begin;\n${migration}\nrollback;` : migration;
const response = await fetch(
  `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  },
);
if (!response.ok) {
  throw new Error(
    `Supabase migration failed (${response.status}): ${await response.text()}`,
  );
}
console.log(
  `${dryRun ? "Validated" : "Applied"} ${migrationPath} ${dryRun ? "against" : "to"} Supabase project ${projectRef}.`,
);
