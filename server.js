import express from "express";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import session from "express-session";
import fs from "node:fs";
import makeTradeRoutes from "./scripts/trade.js";
import {
  portfolioQueries,
  portfolioHistoryQueries,
  priceQueries,
  leagueQueries,
  userQueries,
  coinQueries,
} from "./scripts/queries.js";

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
  .map((s) => s.trim().toLowerCase())
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
  await pool.query(leagueQueries.ensurePortfolio, [userId, leagueId]);
}

async function ensureSoloLeagueForUser(userId) {
  if (!pool) return { leagueId: null };

  const existing = await pool.query(leagueQueries.getUserFirstLeague, [userId]);
  if (existing.rows.length) {
    const leagueId = existing.rows[0].id;
    await ensurePortfolio(userId, leagueId);
    return { leagueId };
  }

  let leagueId = null;
  while (!leagueId) {
    const code = generateJoinCode();
    try {
      const result = await pool.query(leagueQueries.createSoloLeague, [
        "Solo League",
        userId,
        code,
      ]);
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

  const existing = await pool.query(leagueQueries.getFirstPortfolioLeague, [
    req.session.userId,
  ]);

  if (existing.rows.length) {
    const leagueId = existing.rows[0].league_id;
    req.session.currentLeagueId = leagueId;
    return leagueId;
  }

  const { leagueId } = await ensureSoloLeagueForUser(req.session.userId);
  req.session.currentLeagueId = leagueId;
  return leagueId;
}

async function getCurrentPrice(coinId) {
  // coinId is a CoinGecko id like "bitcoin"
  const { rows } = await pool.query(priceQueries.getLatestPrice, [coinId]);
  return rows[0]?.price_usd ?? null;
}

function validateCoinId(raw) {
  const id = (raw || "").trim().toLowerCase();
  if (!id || !COIN_WHITELIST.includes(id)) return null;
  return id;
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
app.get("/index", requireAuth, (req, res) =>
  res.render("index", { activePage: "index" })
);
app.get("/league", requireAuth, (req, res) =>
  res.render("league", { activePage: "league" })
);
app.get("/coins", requireAuth, (req, res) =>
  res.render("coins", { activePage: "coins" })
);
app.get("/coin-detail", requireAuth, (req, res) =>
  res.render("coin-detail", { activePage: "coin-detail" })
);
app.get("/portfolio", requireAuth, (req, res) =>
  res.render("portfolio", { activePage: "portfolio" })
);

// use trade routes module to keep logic out of server.js
const tradeRoutes = makeTradeRoutes({
  pool,
  COIN_WHITELIST,
  getOrCreateCurrentLeagueId,
});
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
    const result = await pool.query(userQueries.createUser, [
      username,
      email,
      password_hash,
    ]);

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
    const result = await pool.query(userQueries.getUserByUsername, [username]);

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

    const result = await pool.query(userQueries.getUserById, [
      req.session.userId,
    ]);

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
    if (
      memberCount !== undefined &&
      memberCount !== null &&
      memberCount !== ""
    ) {
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

    const inviteUrl = `${req.protocol}://${req.get(
      "host"
    )}/league/join/${joinCode}`;

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
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const rawCode = (req.body.leagueCode || req.body.code || "")
      .trim()
      .toUpperCase();
    if (!rawCode) {
      return res.status(400).json({ error: "League code is required" });
    }

    const { rows } = await pool.query(leagueQueries.getLeagueByJoinCode, [
      rawCode,
    ]);
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
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { rows } = await pool.query(leagueQueries.getActiveLeagues, [
      req.session.userId,
    ]);

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
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { rows } = await pool.query(leagueQueries.getActiveLeagues, [
      req.session.userId,
    ]);

    // Ensure there is an active league
    let activeLeagueId = req.session.currentLeagueId || null;
    if (!activeLeagueId && rows.length) {
      activeLeagueId = rows[0].id;
      req.session.currentLeagueId = activeLeagueId;
    }

    const activeLeague =
      rows.find((l) => String(l.id) === String(activeLeagueId)) || null;

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
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { leagueId } = req.body;
    if (!leagueId) {
      return res.status(400).json({ error: "leagueId required" });
    }

    // Make sure this user actually belongs to that league
    const { rows } = await pool.query(leagueQueries.checkMembership, [
      req.session.userId,
      leagueId,
    ]);

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

// Get current price for a coin by CoinGecko id
app.get("/api/price/:id", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const coinId = (req.params.id || "").trim().toLowerCase();
  if (!coinId) return res.status(400).json({ error: "id required" });

  try {
    const { rows } = await pool.query(
      "select coin_id as id, price_usd, fetched_at from prices_latest where coin_id = $1",
      [coinId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all historical prices for a coin by CoinGecko id
app.get("/api/prices/:id", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const coinId = (req.params.id || "").trim().toLowerCase();
  if (!coinId) return res.status(400).json({ error: "id required" });

  try {
    const { rows } = await pool.query(coinQueries.getPriceHistory, [coinId]);
    if (rows.length === 0) return res.status(404).json({ error: "no data" });
    res.json({ id: coinId, count: rows.length, points: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get portfolio: cash, holdings with live value, totals
app.get("/api/portfolio", requireAuth, async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // cash
    const cashRow = await pool.query(portfolioQueries.getCash, [
      req.session.userId,
      leagueId,
    ]);
    const cash = cashRow.rows.length ? Number(cashRow.rows[0].cash_usd) : 0;

    // holdings joined to latest price for THIS league
    const { rows } = await pool.query(portfolioQueries.getHoldings, [
      req.session.userId,
      leagueId,
    ]);

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

app.get("/api/portfolio/history", requireAuth, async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // Get all trades for this user in this league
    const tradesResult = await pool.query(portfolioHistoryQueries.getTrades, [
      req.session.userId,
      leagueId,
    ]);

    if (tradesResult.rows.length === 0) {
      // No trades yet - return starting balance
      return res.json({
        history: [
          { timestamp: Date.now() - 24 * 60 * 60 * 1000, value: 100000 },
          { timestamp: Date.now(), value: 100000 },
        ],
      });
    }

    // Get the first trade timestamp
    const firstTradeTime = new Date(tradesResult.rows[0].created_at).getTime();
    const now = Date.now();

    // Get all unique symbols from trades
    const trades = tradesResult.rows;
    const symbols = [...new Set(trades.map((t) => t.symbol))];

    // Get current prices for all symbols
    const pricesResult = await pool.query(
      portfolioHistoryQueries.getCurrentPricesForSymbols,
      [symbols]
    );

    const currentPrices = {};
    pricesResult.rows.forEach((row) => {
      currentPrices[row.symbol] = Number(row.price);
    });

    // Build portfolio value over time by replaying trades
    let cash = 100000;
    const holdings = {};
    const history = [];

    // Starting point - before any trades
    history.push({
      timestamp: firstTradeTime - 1000, // 1 second before first trade
      value: 100000,
    });

    // Process each trade and calculate portfolio value at that moment
    for (const trade of trades) {
      const symbol = trade.symbol;
      const qty = Number(trade.qty);
      const price = Number(trade.price_usd);
      const cost = qty * price;

      if (trade.side === "BUY") {
        cash -= cost;
        holdings[symbol] = (holdings[symbol] || 0) + qty;
      } else {
        cash += cost;
        holdings[symbol] = (holdings[symbol] || 0) - qty;
        if (holdings[symbol] <= 0) {
          delete holdings[symbol];
        }
      }

      // Calculate portfolio value using current market prices
      let cryptoValue = 0;
      for (const [sym, holdQty] of Object.entries(holdings)) {
        const currentPrice = currentPrices[sym] || 0;
        cryptoValue += holdQty * currentPrice;
      }

      const tradeTime = new Date(trade.created_at).getTime();
      history.push({
        timestamp: tradeTime,
        value: cash + cryptoValue,
      });
    }

    // Add current state
    const cashNow = await pool.query(portfolioQueries.getCash, [
      req.session.userId,
      leagueId,
    ]);
    const holdingsNow = await pool.query(
      portfolioQueries.getHoldingsWithPrices,
      [req.session.userId, leagueId]
    );

    const currentCash = cashNow.rows.length
      ? Number(cashNow.rows[0].cash_usd)
      : cash;
    let currentCrypto = 0;
    holdingsNow.rows.forEach((h) => {
      currentCrypto += Number(h.qty) * Number(h.price_usd || 0);
    });

    history.push({
      timestamp: now,
      value: currentCash + currentCrypto,
    });

    res.json({ history });
  } catch (e) {
    console.error("portfolio history error:", e);
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/trade", requireAuth, async (req, res) => {
  try {
    if (!pool)
      return res.status(500).json({ error: "Database not configured" });

    const { coinId, side, quantity } = req.body;

    const coinIdSafe = validateCoinId(coinId);
    const sideU = (side || "").toUpperCase();
    const qty = Number(quantity);

    if (!coinIdSafe)
      return res.status(400).json({ error: "coin id not allowed" });
    if (sideU !== "BUY" && sideU !== "SELL")
      return res.status(400).json({ error: "side must be BUY or SELL" });
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: "quantity must be > 0" });

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // fetch price
    const price = await getCurrentPrice(coinIdSafe);
    if (!price)
      return res.status(400).json({ error: "no current price; try later" });
    const px = Number(price);
    const cost = +(px * qty).toFixed(8); // positive number

    await pool.query("BEGIN");

    // load current cash & qty with FOR UPDATE
    const cashRow = await pool.query(portfolioQueries.getCashForUpdate, [
      req.session.userId,
      leagueId,
    ]);
    const cash = cashRow.rows.length ? Number(cashRow.rows[0].cash_usd) : 0;

    const hRow = await pool.query(portfolioQueries.getHoldingForUpdate, [
      req.session.userId,
      leagueId,
      coinIdSafe,      // <- CG id
    ]);
    const curQty = hRow.rows[0] ? Number(hRow.rows[0].qty) : 0;

    if (sideU === "BUY") {
      if (cash < cost) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient cash" });
      }
      await pool.query(portfolioQueries.updateCash, [
        req.session.userId,
        leagueId,
        cash - cost,
      ]);
      await pool.query(portfolioQueries.upsertHolding, [
        req.session.userId,
        leagueId,
        coinIdSafe,
        curQty + qty,
      ]);
      await pool.query(portfolioQueries.insertTrade, [
        req.session.userId,
        leagueId,
        coinIdSafe,
        "BUY",
        qty,
        px,
        cost,
      ]);
    } else {
      // SELL
      if (curQty < qty) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient quantity" });
      }
      await pool.query(portfolioQueries.updateCash, [
        req.session.userId,
        leagueId,
        cash + cost,
      ]);
      const newQty = curQty - qty;
      if (newQty <= 0) {
        await pool.query(portfolioQueries.deleteHolding, [
          req.session.userId,
          leagueId,
          coinIdSafe,
        ]);
      } else {
        await pool.query(portfolioQueries.upsertHolding, [
          req.session.userId,
          leagueId,
          coinIdSafe,
          newQty,
        ]);
      }
      await pool.query(portfolioQueries.insertTrade, [
        req.session.userId,
        leagueId,
        coinIdSafe,
        "SELL",
        qty,
        px,
        cost,
      ]);
    }

    await pool.query("COMMIT");

    // return fresh snapshot for this league
    const { rows } = await pool.query(portfolioQueries.getHoldings, [
      req.session.userId,
      leagueId,
    ]);
    const cash2Row = await pool.query(portfolioQueries.getCash, [
      req.session.userId,
      leagueId,
    ]);
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
