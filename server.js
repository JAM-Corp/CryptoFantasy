import express from "express";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import session from "express-session";
import fs from "node:fs";
import makeTradeRoutes from "./scripts/trade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 8080;
let CG_API_KEY = process.env.CG_API_KEY || null;

const cgChartCache = new Map();
const CG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 mins

// Load database config
let dbConfig = null;
if (process.env.DATABASE_URL) {
  // Use DATABASE_URL if provided (for production/Fly.io)
  dbConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  };
} else {
  // Try to load from env.json for local development
  try {
    const envPath = path.join(__dirname, "env.json");
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

const pool = dbConfig ? new Pool(dbConfig) : null;

const COIN_WHITELIST = (
  process.env.COIN_WHITELIST ||
  process.env.CG_IDS ||
  "bitcoin,ethereum,solana"
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect("/login");
  }
}

// Helpers
function generateJoinCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function ensurePortfolio(userId, leagueId) {
  if (!pool) return;
  await pool.query(
    `insert into portfolios (user_id, league_id)
     values ($1, $2)
     on conflict (user_id, league_id) do nothing`,
    [userId, leagueId]
  );
}

async function ensureSoloLeagueForUser(userId) {
  if (!pool) return { leagueId: null };

  const existing = await pool.query(
    "select id from leagues where owner_user_id = $1 order by created_at asc limit 1",
    [userId]
  );
  if (existing.rows.length) {
    const leagueId = existing.rows[0].id;
    await ensurePortfolio(userId, leagueId);
    return { leagueId };
  }

  let leagueId = null;
  while (!leagueId) {
    const code = generateJoinCode();
    try {
      const result = await pool.query(
        `insert into leagues (name, owner_user_id, join_code)
         values ($1, $2, $3)
         returning id`,
        ["Solo League", userId, code]
      );
      leagueId = result.rows[0].id;
    } catch (e) {
      if (e.code === "23505") continue;
      throw e;
    }
  }

  await ensurePortfolio(userId, leagueId);
  return { leagueId };
}

async function getOrCreateCurrentLeagueId(req) {
  if (!pool) return null;

  if (req.session.currentLeagueId) {
    return req.session.currentLeagueId;
  }

  const existing = await pool.query(
    `select league_id
     from portfolios
     where user_id = $1
     order by created_at asc
     limit 1`,
    [req.session.userId]
  );

  if (existing.rows.length) {
    const leagueId = existing.rows[0].league_id;
    req.session.currentLeagueId = leagueId;
    return leagueId;
  }

  const { leagueId } = await ensureSoloLeagueForUser(req.session.userId);
  req.session.currentLeagueId = leagueId;
  return leagueId;
}

async function getCurrentPrice(symbolU) {
  const { rows } = await pool.query(
    "select price_usd from prices_latest where symbol = $1",
    [symbolU]
  );
  return rows[0]?.price_usd ?? null;
}

function validateSymbol(raw) {
  const s = (raw || "").trim().toUpperCase();
  if (!s || !COIN_WHITELIST.includes(s)) return null;
  return s;
}

// Redirect root to login if not authenticated, otherwise to dashboard
app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/index");
  } else {
    return res.redirect("/login");
  }
});

// Public routes (no auth required)
app.get("/login", (_req, res) => res.render("login"));
app.get("/register", (_req, res) => res.render("register"));

// Protected routes - require authentication
app.get("/index", requireAuth, (req, res) => res.render("index", { activePage: "index" }));
app.get("/league", requireAuth, (req, res) => res.render("league", { activePage: "league" }));
app.get("/coins", requireAuth, (req, res) => res.render("coins", { activePage: "coins" }));
app.get("/coin-detail", requireAuth, (req, res) => res.render("coin-detail", { activePage: "coin-detail" }));
app.get("/portfolio", requireAuth, (req, res) => res.render("portfolio", { activePage: "portfolio" }));


// use trade routes module to keep logic out of server.js
const tradeRoutes = makeTradeRoutes({ pool, COIN_WHITELIST, getOrCreateCurrentLeagueId });
app.get("/trade", requireAuth, tradeRoutes.tradeGet);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/db/ping", async (_req, res) => {
  try {
    if (!pool) return res.status(200).json({ db: "not-configured" });
    const { rows } = await pool.query("select 1 as ok");
    res.json({ db: "ok", rows });
  } catch (e) {
    res.status(500).json({ db: "error", error: String(e) });
  }
});

// Initialize database tables
async function initDB() {
  if (!pool) {
    console.log("Database not configured");
    return;
  }

  try {
    const usersSqlPath = path.join(__dirname, "scripts", "users.sql");
    if (fs.existsSync(usersSqlPath)) {
      const sql = fs.readFileSync(usersSqlPath, "utf8");
      await pool.query(sql);
      console.log("Users table initialized");
    }

    // Price tables from scripts/prices.sql
    const pricesSqlPath = path.join(__dirname, "scripts", "prices.sql");
    if (fs.existsSync(pricesSqlPath)) {
      const sql = fs.readFileSync(pricesSqlPath, "utf8");
      await pool.query(sql);
      console.log("Price tables initialized");
    }

    // Portfolio tables from scripts/portfolio.sql
    const portfolioSqlPath = path.join(__dirname, "scripts", "portfolio.sql");
    if (fs.existsSync(portfolioSqlPath)) {
      const sql2 = fs.readFileSync(portfolioSqlPath, "utf8");
      await pool.query(sql2);
      console.log("Portfolio tables initialized");
    }

    console.log("Database tables initialized");
  } catch (e) {
    console.error("Error initializing database:", e);
  }
}

// Register endpoint
app.post("/api/register", async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert user
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email",
      [username, email, password_hash]
    );

    const user = result.rows[0];
    req.session.userId = user.id;

    res.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (e) {
    if (e.code === "23505") {
      // Unique violation
      res.status(400).json({ error: "Username or email already exists" });
    } else {
      res.status(500).json({ error: "Registration failed" });
    }
  }
});

// Login endpoint
app.post("/api/login", async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    // Find user
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.rows[0];

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.userId = user.id;

    res.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (e) {
    res.status(500).json({ error: "Login failed" });
  }
});

// Logout endpoint
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get current user
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const result = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "Failed to get user" });
  }
});

app.post("/api/leagues", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const { name, memberCount } = req.body;
    const trimmedName = (name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ error: "League name is required" });
    }

    let memberLimit = null;
    if (memberCount !== undefined && memberCount !== null && memberCount !== "") {
      const n = Number(memberCount);
      if (!Number.isInteger(n) || n < 2 || n > 32) {
        return res
          .status(400)
          .json({ error: "Member count must be a reasonable integer" });
      }
      memberLimit = n;
    }

    let leagueId = null;
    let joinCode = null;

    // Keep trying until we get a unique join code
    while (!leagueId) {
      joinCode = generateJoinCode();
      try {
        const result = await pool.query(
          `insert into leagues (name, owner_user_id, join_code, member_limit)
           values ($1, $2, $3, $4)
           returning id`,
          [trimmedName, req.session.userId, joinCode, memberLimit]
        );
        leagueId = result.rows[0].id;
        console.log("Created league:", result.rows[0]);
      } catch (e) {
        // 23505 = unique_violation (likely join_code collision)
        if (e.code === "23505") {
          continue;
        }
        throw e;
      }
    }

    // Make sure the creator has a portfolio in this league
    await ensurePortfolio(req.session.userId, leagueId);

    // Set as current league in session
    req.session.currentLeagueId = leagueId;

    const inviteUrl = `${req.protocol}://${req.get("host")}/league/join/${joinCode}`;

    return res.json({
      success: true,
      league: {
        id: leagueId,
        name: trimmedName,
        joinCode,
        memberLimit,
        inviteUrl,
      },
    });

  } catch (e) {
    console.error("Create league error:", e);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to create league" });
    }
  }
});

app.post("/api/leagues/join", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const rawCode = (req.body.leagueCode || req.body.code || "").trim().toUpperCase();
    if (!rawCode) {
      return res.status(400).json({ error: "League code is required" });
    }

    const { rows } = await pool.query(
      "select id, name, member_limit from leagues where join_code = $1",
      [rawCode]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "League not found" });
    }

    const league = rows[0];

    await ensurePortfolio(req.session.userId, league.id);

    req.session.currentLeagueId = league.id;

    res.json({
      success: true,
      league: {
        id: league.id,
        name: league.name,
      },
    });
  } catch (e) {
    console.error("Join league error:", e);
    res.status(500).json({ error: "Failed to join league" });
  }
});

app.get("/api/leagues/mine", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const { rows } = await pool.query(
      `select l.id,
              l.name,
              l.join_code,
              l.owner_user_id = $1 as is_owner
       from leagues l
       join portfolios p
         on p.league_id = l.id
       where p.user_id = $1
       order by l.created_at asc`,
      [req.session.userId]
    );

    const currentLeagueId = req.session.currentLeagueId || null;

    res.json({
      leagues: rows,
      currentLeagueId,
    });
  } catch (e) {
    console.error("Get my leagues error:", e);
    res.status(500).json({ error: "Failed to load leagues" });
  }
});

app.get("/api/leagues/active", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const { rows } = await pool.query(
      `select l.id,
              l.name,
              l.join_code,
              l.owner_user_id = $1 as is_owner
       from leagues l
       join portfolios p
         on p.league_id = l.id
       where p.user_id = $1
       order by l.created_at asc`,
      [req.session.userId]
    );

    // Ensure there is an active league
    let activeLeagueId = req.session.currentLeagueId || null;
    if (!activeLeagueId && rows.length) {
      activeLeagueId = rows[0].id;
      req.session.currentLeagueId = activeLeagueId;
    }

    const activeLeague =
      rows.find(l => String(l.id) === String(activeLeagueId)) || null;

    res.json({
      leagues: rows,
      activeLeagueId,
      activeLeague,
    });
  } catch (e) {
    console.error("Get active leagues error:", e);
    res.status(500).json({ error: "Failed to load active leagues" });
  }
});

app.post("/api/leagues/active", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const { leagueId } = req.body;
    if (!leagueId) {
      return res.status(400).json({ error: "leagueId required" });
    }

    // Make sure this user actually belongs to that league
    const { rows } = await pool.query(
      `select 1
       from portfolios
       where user_id = $1
         and league_id = $2`,
      [req.session.userId, leagueId]
    );

    if (!rows.length) {
      return res.status(403).json({ error: "You are not in that league" });
    }

    req.session.currentLeagueId = Number(leagueId);
    res.json({ success: true });
  } catch (e) {
    console.error("Set active league error:", e);
    res.status(500).json({ error: "Failed to set active league" });
  }
});


// Get current coin data
app.get("/api/cg/coins", async (req, res) => {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false";

    const headers = CG_API_KEY ? { "x-cg-demo-api-key": CG_API_KEY } : {};
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`CoinGecko ${response.status}`);

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error("Error fetching CoinGecko coins:", err);
    res.status(500).json({ error: "Failed to fetch coins" });
  }
});

// Get historical coin chart data
app.get("/api/cg/coins/:id/market_chart", async (req, res) => {
  try {
    const id = req.params.id;
    const days = req.query.days;
    const key = `${id}|${days}`;
    const now = Date.now();

    const cached = cgChartCache.get(key);
    if (cached && now - cached.ts < CG_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
    const headers = CG_API_KEY ? { "x-cg-demo-api-key": CG_API_KEY } : {};

    const response = await fetch(url, { headers });
    const txt = await response.text();

    if (!response.ok) {
      console.error("CG market_chart error:", response.status, txt);
      return res
        .status(response.status)
        .json({ error: `CoinGecko ${response.status}`, details: txt });
    }

    const data = JSON.parse(txt);

    cgChartCache.set(key, { ts: now, data });

    res.json(data);
  } catch (err) {
    console.error("Error fetching CoinGecko market_chart:", err);
    res.status(500).json({ error: "Failed to fetch market data" });
  }
});

// Get current price for a coin
app.get("/api/price/:symbol", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const symbol = (req.params.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  try {
    const { rows } = await pool.query(
      "select symbol, price_usd, fetched_at from prices_latest where symbol = $1",
      [symbol]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all historical prices for a coin
app.get("/api/prices/:symbol", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const symbol = (req.params.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  try {
    const { rows } = await pool.query(
      "select symbol, ts_min, price_usd from price_points_min where symbol = $1 order by ts_min asc",
      [symbol]
    );
    if (rows.length === 0) return res.status(404).json({ error: "no data" });
    res.json({ symbol, count: rows.length, points: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get portfolio: cash, holdings with live value, totals
app.get("/api/portfolio", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // cash
    const cashRow = await pool.query(
      "select cash_usd from portfolios where user_id = $1 and league_id = $2",
      [req.session.userId, leagueId]
    );
    const cash = cashRow.rows.length ? Number(cashRow.rows[0].cash_usd) : 0;

    // holdings joined to latest price for THIS league
    const { rows } = await pool.query(
      `select h.symbol,
              h.qty::text as qty,
              pl.price_usd::text as price_usd,
              (h.qty * pl.price_usd)::text as market_value
       from holdings h
       left join prices_latest pl on pl.symbol = h.symbol
       where h.user_id = $1
         and h.league_id = $2
       order by h.symbol`,
      [req.session.userId, leagueId]
    );

    const cryptoValue = rows.reduce(
      (sum, r) => sum + Number(r.market_value || 0),
      0
    );
    const totalValue = cash + cryptoValue;

    res.json({
      league_id: leagueId,
      cash_usd: cash.toFixed(2),
      crypto_value_usd: cryptoValue.toFixed(2),
      total_value_usd: totalValue.toFixed(2),
      holdings: rows,
    });
  } catch (e) {
    console.error("portfolio error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/trade", requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: "Database not configured" });

    const { symbol, side, quantity } = req.body;
    const symbolU = validateSymbol(symbol);
    const sideU = (side || "").toUpperCase();
    const qty = Number(quantity);

    if (!symbolU) return res.status(400).json({ error: "symbol not allowed" });
    if (sideU !== "BUY" && sideU !== "SELL")
      return res.status(400).json({ error: "side must be BUY or SELL" });
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: "quantity must be > 0" });

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // fetch price
    const price = await getCurrentPrice(symbolU);
    if (!price)
      return res.status(400).json({ error: "no current price; try later" });
    const px = Number(price);
    const cost = +(px * qty).toFixed(8); // positive number

    await pool.query("BEGIN");

    // load current cash & qty with FOR UPDATE
    const cashRow = await pool.query(
      "select cash_usd from portfolios where user_id = $1 and league_id = $2 for update",
      [req.session.userId, leagueId]
    );
    const cash = cashRow.rows.length ? Number(cashRow.rows[0].cash_usd) : 0;

    const hRow = await pool.query(
      "select qty from holdings where user_id = $1 and league_id = $2 and symbol = $3 for update",
      [req.session.userId, leagueId, symbolU]
    );
    const curQty = hRow.rows[0] ? Number(hRow.rows[0].qty) : 0;

    if (sideU === "BUY") {
      if (cash < cost) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient cash" });
      }
      await pool.query(
        "update portfolios set cash_usd = cash_usd - $1 where user_id = $2 and league_id = $3",
        [cost, req.session.userId, leagueId]
      );
      await pool.query(
        `insert into holdings (user_id, league_id, symbol, qty)
         values ($1, $2, $3, $4)
         on conflict (user_id, league_id, symbol)
         do update set qty = holdings.qty + excluded.qty`,
        [req.session.userId, leagueId, symbolU, qty]
      );
      await pool.query(
        `insert into trades (user_id, league_id, symbol, side, qty, price_usd, cost_usd)
         values ($1,$2,$3,'BUY',$4,$5,$6)`,
        [req.session.userId, leagueId, symbolU, qty, px, cost]
      );
    } else {
      // SELL
      if (curQty < qty) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient quantity" });
      }
      await pool.query(
        "update portfolios set cash_usd = cash_usd + $1 where user_id = $2 and league_id = $3",
        [cost, req.session.userId, leagueId]
      );
      await pool.query(
        "update holdings set qty = qty - $1 where user_id = $2 and league_id = $3 and symbol = $4",
        [qty, req.session.userId, leagueId, symbolU]
      );
      await pool.query(
        "delete from holdings where user_id = $1 and league_id = $2 and symbol = $3 and qty <= 0",
        [req.session.userId, leagueId, symbolU]
      );
      await pool.query(
        `insert into trades (user_id, league_id, symbol, side, qty, price_usd, cost_usd)
         values ($1,$2,$3,'SELL',$4,$5,$6)`,
        [req.session.userId, leagueId, symbolU, qty, px, cost]
      );
    }

    await pool.query("COMMIT");

    // return fresh snapshot for this league
    const { rows } = await pool.query(
      `select h.symbol, h.qty::text as qty, pl.price_usd::text as price_usd,
              (h.qty * pl.price_usd)::text as market_value
       from holdings h
       left join prices_latest pl on pl.symbol = h.symbol
       where h.user_id = $1
         and h.league_id = $2
       order by h.symbol`,
      [req.session.userId, leagueId]
    );
    const cash2Row = await pool.query(
      "select cash_usd from portfolios where user_id = $1 and league_id = $2",
      [req.session.userId, leagueId]
    );
    const cash2 = cash2Row.rows.length ? Number(cash2Row.rows[0].cash_usd) : 0;
    const cryptoValue = rows.reduce(
      (s, r) => s + Number(r.market_value || 0),
      0
    );

    res.json({
      success: true,
      league_id: leagueId,
      price_used_usd: px.toFixed(8),
      cash_usd: cash2.toFixed(2),
      crypto_value_usd: cryptoValue.toFixed(2),
      total_value_usd: (cash2 + cryptoValue).toFixed(2),
      holdings: rows,
    });
  } catch (e) {
    try {
      await pool.query("ROLLBACK");
    } catch {}
    console.error("trade error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  initDB();
});
