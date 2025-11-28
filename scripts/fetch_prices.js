import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _fetch = globalThis.fetch;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeId(raw) {
  return String(raw || "").trim().toLowerCase();
}

// ----------------------
// DB CONFIG + ENV LOADING
// ----------------------
let dbConfig = null;
let CG_API_KEY = process.env.CG_API_KEY || "";

if (process.env.DATABASE_URL) {
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  };
  console.log("Using DATABASE_URL for DB connection");
} else {
  try {
    const envPath = path.join(__dirname, "..", "env.json");
    if (fs.existsSync(envPath)) {
      const envData = JSON.parse(fs.readFileSync(envPath, "utf-8"));

      if (!CG_API_KEY && envData.CG_API_KEY) {
        CG_API_KEY = envData.CG_API_KEY;
      }

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
    } else {
      console.error("env.json not found and DATABASE_URL is not set.");
    }
  } catch (e) {
    console.error("Error loading env.json:", e.message || e);
  }
}

if (!dbConfig) {
  console.error("DATABASE_URL or env.json is required for the worker");
  process.exit(1);
}

const CG_VS = (process.env.CG_VS || "usd").trim();
const pool = new Pool(dbConfig);

// ----------------------
// HELPER: ENV-ONLY IDS
// ----------------------
function getIdsFromEnv() {
  const raw =
    process.env.COIN_WHITELIST ||
    process.env.CG_IDS ||
    "bitcoin,ethereum,solana";

  const ids = raw
    .split(",")
    .map((s) => normalizeId(s))
    .filter(Boolean);

  if (!ids.length) {
    console.warn("No CoinGecko IDs found in env (COIN_WHITELIST/CG_IDS).");
  } else {
    console.log(
      `Using ${ids.length} CoinGecko IDs from env: ${ids.join(", ")}`
    );
  }

  // lowercase CoinGecko IDs
  return ids;
}

// ----------------------
// COINGECKO FETCH
// ----------------------
async function fetchBatch(ids) {
  if (!ids || ids.length === 0) return {};

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    ids.join(",")
  )}&vs_currencies=${encodeURIComponent(CG_VS)}`;

  const headers = {};
  if (CG_API_KEY) headers["x-cg-demo-api-key"] = CG_API_KEY;

  const r = await _fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => "<no body>");
    throw new Error(`CoinGecko ${r.status}: ${body}`);
  }

  return r.json();
}

// ----------------------
// SINGLE TICK
// ----------------------
async function runTickOnce() {
  // 🔒 Single source of truth: env
  const ids = getIdsFromEnv();

  if (!ids || ids.length === 0) {
    console.warn("No coin IDs configured; skipping tick.");
    return;
  }

  const data = await fetchBatch(ids);
  const tsMinSql = "date_trunc('minute', now())";

  for (const rawId of ids) {
    const id = normalizeId(rawId);
    const symbol = id; // lowercase CoinGecko id

    const price = data?.[id]?.[CG_VS];
    if (typeof price !== "number" || !Number.isFinite(price)) {
      // silently skip if CG didn't return anything for this ID
      continue;
    }

    // latest
    await pool.query(
      `insert into prices_latest (symbol, price_usd, fetched_at)
       values ($1, $2, now())
       on conflict (symbol) do update set price_usd = excluded.price_usd,
                                         fetched_at = excluded.fetched_at`,
      [symbol, price]
    );

    // minute bucket
    await pool.query(
      `insert into price_points_min (symbol, ts_min, price_usd)
       values ($1, ${tsMinSql}, $2)
       on conflict do nothing`,
      [symbol, price]
    );
  }

  console.log(
    `Tick complete for ${ids.length} coins at ${new Date().toISOString()}`
  );
}

async function tick() {
  try {
    await runTickOnce();
  } catch (err) {
    console.error("tick error:", err.message || err);
  }
}

// ----------------------
// MAIN LOOP + SHUTDOWN
// ----------------------
let timer;

function start() {
  tick();
  timer = setInterval(tick, 60_000);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down worker...`);
    if (timer) clearInterval(timer);
    try {
      await pool.end();
    } catch {
      // ignore
    }
    process.exit(0);
  });
}

start();
