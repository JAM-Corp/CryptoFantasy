import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env.json if DATABASE_URL not set
let dbConfig = null;
let CG_API_KEY = process.env.CG_API_KEY || "";

if (process.env.DATABASE_URL) {
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  };
} else {
  try {
    const envPath = path.join(__dirname, "..", "env.json");
    if (fs.existsSync(envPath)) {
      const envData = JSON.parse(fs.readFileSync(envPath, "utf-8"));
      if (!CG_API_KEY && envData.CG_API_KEY) CG_API_KEY = envData.CG_API_KEY;
      dbConfig = {
        user: envData.user,
        host: envData.host,
        database: envData.database,
        password: envData.password,
        port: envData.port,
      };
      console.log(
        `Using database config from env.json (database: ${envData.database})`
      );
    }
  } catch (e) {
    console.error("Error loading env.json:", e.message);
  }
}

if (!dbConfig) {
  console.error("DATABASE_URL or env.json is required for the worker");
  process.exit(1);
}

const CG_VS = (process.env.CG_VS || "usd").trim();

const pool = new Pool(dbConfig);

/**
 * Fallback: get IDs from environment variable CG_IDS
 */
function getIdsFromEnv() {
  const ids = (process.env.CG_IDS || "bitcoin,ethereum,solana")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    console.warn(
      "No CoinGecko IDs found in CG_IDS and DB query failed/returned none."
    );
  } else {
    console.log(
      `Using ${ids.length} CoinGecko IDs from CG_IDS fallback: ${ids.join(", ")}`
    );
  }

  return ids;
}

/**
 * Load CoinGecko IDs from the DB.
 * Assumes there is a `coins` table with a `coingecko_id` column.
 * Adjust table/column names if your schema is different.
 */
async function loadIdsFromDb() {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT coingecko_id AS id, symbol
      FROM coins
      WHERE coingecko_id IS NOT NULL AND coingecko_id <> ''
        AND symbol IS NOT NULL AND symbol <> ''
    `);

    const ids = rows
      .map((r) => (r.id || "").trim())
      .filter(Boolean);

    if (ids.length > 0) {
      console.log(
        `Loaded ${ids.length} CoinGecko IDs from DB: ${ids.join(", ")}`
      );
      return ids;
    } else {
      console.warn("No CoinGecko IDs found in DB; falling back to CG_IDS.");
      return getIdsFromEnv();
    }
  } catch (err) {
    console.error(
      "Error loading CoinGecko IDs from DB; falling back to CG_IDS:",
      err.message || err
    );
    return getIdsFromEnv();
  }
}

async function fetchBatch(ids) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    ids.join(",")
  )}&vs_currencies=${encodeURIComponent(CG_VS)}`;
  const headers = {};
  if (CG_API_KEY) headers["x-cg-demo-api-key"] = CG_API_KEY;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`CoinGecko ${r.status} ${await r.text()}`);
  return r.json();
}

async function tick() {
  const ids = await loadIdsFromDb();

  if (!ids || ids.length === 0) {
    console.warn("No coin IDs configured; skipping tick.");
    return;
  }

  const data = await fetchBatch(ids);
  const tsMinSql = "date_trunc('minute', now())";

  for (const id of ids) {
    const symbol = id.toUpperCase();
    const price = data?.[id]?.[CG_VS];
    if (typeof price !== "number" || !Number.isFinite(price)) continue;

    // Insert latest
    await pool.query(
      `insert into prices_latest (symbol, price_usd, fetched_at)
       values ($1, $2, now())
       on conflict (symbol) do update set price_usd = excluded.price_usd,
                                         fetched_at = excluded.fetched_at`,
      [symbol, price]
    );

    // Insert 1-minute bucket
    await pool.query(
      `insert into price_points_min (symbol, ts_min, price_usd)
       values ($1, ${tsMinSql}, $2)
       on conflict do nothing`,
      [symbol, price]
    );
  }
}

// Main loop: run now, then every minute
let timer;
function start() {
  tick().catch((err) => console.error("tick error:", err.message || err));
  timer = setInterval(() => {
    tick().catch((err) => console.error("tick error:", err.message || err));
  }, 60_000);
}

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (timer) clearInterval(timer);
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  });
}

start();
