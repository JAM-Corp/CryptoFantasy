import express from "express";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.get("/db/ping", async (_req, res) => {
  try {
    if (!pool) return res.status(200).json({ db: "not-configured" });
    const { rows } = await pool.query("select 1 as ok");
    res.json({ db: "ok", rows });
  } catch (e) {
    res.status(500).json({ db: "error", error: String(e) });
  }
});

app.listen(PORT, () => console.log(`listening on :${PORT}`));
