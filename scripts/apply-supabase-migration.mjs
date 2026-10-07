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
const migration = await readFile(resolve(migrationPath), "utf8");
const query = dryRun ? `begin;\n${migration}\nrollback;` : migration;

async function applyWithDirectConnection() {
  const connectionString =
    process.env.SUPABASE_DIRECT_URL || process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Supabase API authorization failed and no direct database URL is configured.",
    );
  }
  const pg = await import("pg");
  const Client = pg.Client || pg.default?.Client;
  if (!Client) throw new Error("The PostgreSQL client could not be loaded.");
  const parts = connectionString.match(
    /^postgres(?:ql)?:\/\/([^:]+):(.*)@([^:/?#]+)(?::(\d+))?\/([^?]+)(?:\?.*)?$/,
  );
  if (!parts) throw new Error("The configured Supabase database URL is invalid.");
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const client = new Client({
    user: decode(parts[1]),
    password: decode(parts[2]),
    host: parts[3],
    port: Number(parts[4] || 5432),
    database: decode(parts[5]),
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.query(query);
  } finally {
    await client.end().catch(() => {});
  }
}

let appliedWith = "direct database connection";
if (accessToken && projectRef) {
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
  if (response.ok) {
    appliedWith = "Supabase Management API";
  } else if (response.status === 401 || response.status === 403) {
    await applyWithDirectConnection();
  } else {
    throw new Error(
      `Supabase migration failed (${response.status}): ${await response.text()}`,
    );
  }
} else {
  await applyWithDirectConnection();
}
console.log(
  `${dryRun ? "Validated" : "Applied"} ${migrationPath} ${dryRun ? "against" : "to"} Supabase using ${appliedWith}.`,
);
