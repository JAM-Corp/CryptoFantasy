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
const IDS = (process.env.CG_IDS || "bitcoin,ethereum,solana")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const pool = new Pool(dbConfig);

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
  const data = await fetchBatch(IDS);
  const tsMinSql = "date_trunc('minute', now())";

  for (const id of IDS) {
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

  console.log(
    `tick ok ${new Date().toISOString()} :: ${IDS.length} symbols (vs=${CG_VS})`
  );
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
