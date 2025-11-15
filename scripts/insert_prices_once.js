import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load database config from env.json
const envPath = path.join(__dirname, "..", "env.json");
const envData = JSON.parse(fs.readFileSync(envPath, "utf-8"));

const pool = new Pool({
  user: envData.user,
  host: envData.host,
  database: envData.database,
  password: envData.password,
  port: envData.port,
});

const CG_API_KEY = envData.CG_API_KEY || process.env.CG_API_KEY || "";
// Allow coin list to come from env.json (CG_IDS) or environment (CG_IDS), fallback to three coins
const IDS = (process.env.CG_IDS || envData.CG_IDS || "bitcoin,ethereum,solana")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function fetchAndInsertPrices() {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${IDS.join(
      ","
    )}&vs_currencies=usd`;
    const headers = {};
    if (CG_API_KEY) headers["x-cg-demo-api-key"] = CG_API_KEY;

    console.log("Fetching prices from CoinGecko...");
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    console.log("Received data:", JSON.stringify(data, null, 2));

    for (const id of IDS) {
      const symbol = id.toUpperCase();
      const price = data?.[id]?.usd;

      if (typeof price !== "number") {
        console.log(`No price for ${symbol}`);
        continue;
      }

      await pool.query(
        `INSERT INTO prices_latest (symbol, price_usd, fetched_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (symbol) 
         DO UPDATE SET price_usd = EXCLUDED.price_usd, fetched_at = EXCLUDED.fetched_at`,
        [symbol, price]
      );

      console.log(`✓ Inserted ${symbol}: $${price.toFixed(2)}`);
    }

    console.log("\n✓ Prices inserted successfully!");
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await pool.end();
  }
}

fetchAndInsertPrices();
