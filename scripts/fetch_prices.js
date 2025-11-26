import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _fetch = globalThis.fetch;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function getIdsFromEnv() {
  const ids = (process.env.CG_IDS || "bitcoin,ethereum,solana")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    console.warn("No CoinGecko IDs found in CG_IDS.");
  } else {
    console.log(
      `Using ${ids.length} CoinGecko IDs from CG_IDS fallback: ${ids.join(", ")}`
    );
  }

  return ids.map((id) => ({
    id,
    symbol: id.toUpperCase(),
  }));
}

async function loadIdsFromDb() {
  try {
    const { rows } = await pool.query(
      `
      SELECT DISTINCT
        coingecko_id AS id,
        UPPER(symbol) AS symbol
      FROM coins
      WHERE coingecko_id IS NOT NULL AND coingecko_id <> ''
        AND symbol IS NOT NULL AND symbol <> ''
    `
    );

    if (rows.length > 0) {
      console.log(
        `Loaded ${rows.length} coins from DB:`,
        rows.map((r) => `${r.symbol}(${r.id})`).join(", ")
      );
      return rows;
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

async function runTickOnce() {
  const coins = await loadIdsFromDb();

  if (!coins || coins.length === 0) {
    console.warn("No coin IDs configured; skipping tick.");
    return;
  }

  const ids = coins
    .map((c) => (typeof c === "string" ? c : c.id))
    .filter(Boolean);

  if (ids.length === 0) {
    console.warn("No valid CoinGecko IDs after normalization; skipping tick.");
    return;
  }

  const data = await fetchBatch(ids);
  const tsMinSql = "date_trunc('minute', now())";

  for (const coin of coins) {
    const id = typeof coin === "string" ? coin : coin.id;
    const symbol =
      typeof coin === "string"
        ? coin.toUpperCase()
        : (coin.symbol && String(coin.symbol).toUpperCase()) ||
          String(coin.id).toUpperCase();

    const price = data?.[id]?.[CG_VS];
    if (typeof price !== "number" || !Number.isFinite(price)) {
      continue;
    }

    await pool.query(
      `insert into prices_latest (symbol, price_usd, fetched_at)
       values ($1, $2, now())
       on conflict (symbol) do update set price_usd = excluded.price_usd,
                                         fetched_at = excluded.fetched_at`,
      [symbol, price]
    );

    await pool.query(
      `insert into price_points_min (symbol, ts_min, price_usd)
       values ($1, ${tsMinSql}, $2)
       on conflict do nothing`,
      [symbol, price]
    );
  }

  console.log(
    `Tick complete for ${coins.length} coins at ${new Date().toISOString()}`
  );
}

async function tick() {
  try {
    await runTickOnce();
  } catch (err) {
    console.error("tick error:", err.message || err);
  }
}

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
