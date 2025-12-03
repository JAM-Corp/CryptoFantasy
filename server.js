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
const FAST_SCHEDULE =
  process.env.FAST_SCHEDULE === "1" || process.env.FAST_SCHEDULE === "true";

function normalizeCoinId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

async function getDefaultLeagueCoinSymbols() {
  // No more dynamic pulling for simplicity and to meet rate limits.
  // Every league just uses the env-driven whitelist.
  // COIN_WHITELIST is already normalized to lowercase IDs.
  return [...COIN_WHITELIST];
}

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
  "bitcoin,ethereum,solana,tether,binancecoin,ripple,usd-coin,tron,dogecoin,cardano"
)
  .split(",")
  .map((s) => normalizeCoinId(s))
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

async function joinLeagueForUserByCode(userId, rawCode) {
  if (!pool) {
    const err = new Error("Database not configured");
    err.status = 500;
    throw err;
  }

  const code = (rawCode || "").trim().toUpperCase();
  if (!code) {
    const err = new Error("League code is required");
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(leagueQueries.getLeagueByJoinCode, [code]);
  if (!rows.length) {
    const err = new Error("League not found");
    err.status = 404;
    throw err;
  }

  const league = rows[0];

  if (league.status === "COMPLETED") {
    const err = new Error("League is already completed");
    err.status = 409;
    throw err;
  }

  if (league.member_limit != null) {
    const countRes = await pool.query(leagueQueries.countLeagueMembers, [
      league.id,
    ]);
    const memberCount = Number(countRes.rows[0].member_count || 0);
    if (memberCount >= league.member_limit) {
      const err = new Error("League is full");
      err.status = 409;
      throw err;
    }
  }

  await ensurePortfolio(userId, league.id);

  return league;
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

  const leagueCoinSymbols = await getDefaultLeagueCoinSymbols();

  let leagueId = null;
  while (!leagueId) {
    const code = generateJoinCode();
    try {
      const result = await pool.query(leagueQueries.createSoloLeague, [
        "Solo League",
        userId,
        code,
        leagueCoinSymbols,
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
  const id = normalizeCoinId(coinId);
  const { rows } = await pool.query(priceQueries.getLatestPrice, [id]);
  return rows[0]?.price_usd ?? null;
}

function validateSymbol(raw) {
  const s = normalizeCoinId(raw);
  if (!s || !COIN_WHITELIST.includes(s)) return null;
  return s;
}

function normalizeLeagueSettings(rawSettings) {
  if (!rawSettings) return {};
  if (typeof rawSettings === "object") return rawSettings;
  try {
    return JSON.parse(rawSettings);
  } catch {
    return {};
  }
}

function computeLeagueSchedule({ league, members }) {
  const settings = normalizeLeagueSettings(league.settings);
  const freq = (settings.matchupFrequency || "WEEKLY").toUpperCase();
  const isDaily = freq === "DAILY";

  const intervalMs = isDaily
    ? FAST_SCHEDULE
      ? 5 * 60 * 1000
      : 24 * 60 * 60 * 1000 // 5 min or 1 day
    : FAST_SCHEDULE
    ? 5 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;

  const startDate = league.created_at
    ? new Date(league.created_at)
    : new Date();

  if (!members || members.length < 2) {
    return [];
  }

  const players = members.map((m) => ({ id: m.id, username: m.username }));

  if (players.length % 2 === 1) {
    players.push({ id: null, username: "BYE" });
  }

  const numPlayers = players.length;
  const baseRounds = numPlayers - 1;

  const baseRoundMatchups = [];
  let arr = players.slice();

  for (let r = 0; r < baseRounds; r++) {
    const matchups = [];
    const half = numPlayers / 2;

    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[numPlayers - 1 - i];

      const homeHasPlayer = home && home.id != null;
      const awayHasPlayer = away && away.id != null;

      if (homeHasPlayer && awayHasPlayer) {
        matchups.push({
          homeUserId: home.id,
          awayUserId: away.id,
          homeUsername: home.username,
          awayUsername: away.username,
        });
      } else if (homeHasPlayer || awayHasPlayer) {
        const bye = homeHasPlayer ? home : away;
        matchups.push({
          byeUserId: bye.id,
          byeUsername: bye.username,
        });
      }
    }

    baseRoundMatchups.push(matchups);

    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }

  let totalRounds;
  const matchupCountSetting = Number(settings.matchupCount);

  if (Number.isInteger(matchupCountSetting) && matchupCountSetting > 0) {
    totalRounds = Math.min(matchupCountSetting, 1000);
  } else {
    totalRounds = baseRounds;
  }

  if (!Number.isInteger(totalRounds) || totalRounds <= 0) {
    totalRounds = baseRounds;
  }

  const schedule = [];

  for (let r = 0; r < totalRounds; r++) {
    const patternIndex = r % baseRounds;
    const roundStart = new Date(startDate.getTime() + r * intervalMs);
    const roundEnd = new Date(roundStart.getTime() + intervalMs - 1);

    const templateMatchups = baseRoundMatchups[patternIndex];
    const matchups = templateMatchups.map((m) => ({ ...m }));

    schedule.push({
      roundIndex: r + 1,
      label: isDaily ? `Day ${r + 1}` : `Week ${r + 1}`,
      start: roundStart.toISOString(),
      end: roundEnd.toISOString(),
      matchups,
    });
  }

  return schedule;
}

async function getPriceAtOrBefore(symbol, asOf) {
  if (!pool) return 0;

  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) {
    throw new Error("Invalid asOf timestamp");
  }
  const asOfIso = asOfDate.toISOString();

  try {
    const histRes = await pool.query(
      `
      SELECT price_usd
      FROM price_points_min
      WHERE symbol = $1
        AND ts_min <= $2
      ORDER BY ts_min DESC
      LIMIT 1
      `,
      [symbol, asOfIso]
    );

    if (histRes.rows.length) {
      return Number(histRes.rows[0].price_usd);
    }
  } catch (e) {
    console.error("getPriceAtOrBefore historical error:", e);
  }

  try {
    const latestRes = await pool.query(
      `
      SELECT price_usd
      FROM prices_latest
      WHERE symbol = $1
      `,
      [symbol]
    );
    if (latestRes.rows.length) {
      return Number(latestRes.rows[0].price_usd);
    }
  } catch (e) {
    console.error("getPriceAtOrBefore latest fallback error:", e);
  }

  return 0;
}

async function getPortfolioValueAtTime({ userId, leagueId, asOf }) {
  if (!pool) {
    const err = new Error("Database not configured");
    err.status = 500;
    throw err;
  }

  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) {
    const err = new Error("Invalid asOf timestamp");
    err.status = 400;
    throw err;
  }

  let cash = 100000;
  const holdings = {}; // symbol -> qty

  const tradesRes = await pool.query(portfolioHistoryQueries.getTrades, [
    userId,
    leagueId,
  ]);

  const asOfMs = asOfDate.getTime();
  const trades = tradesRes.rows.filter(
    (t) => new Date(t.created_at).getTime() <= asOfMs
  );

  for (const trade of trades) {
    const symbol = trade.symbol;
    const qty = Number(trade.qty);
    const price = Number(trade.price_usd);
    const cost = qty * price;

    if (trade.side === "BUY") {
      cash -= cost;
      holdings[symbol] = (holdings[symbol] || 0) + qty;
    } else if (trade.side === "SELL") {
      cash += cost;
      holdings[symbol] = (holdings[symbol] || 0) - qty;
      if (holdings[symbol] <= 0) {
        delete holdings[symbol];
      }
    }
  }

  let cryptoValue = 0;
  const prices = {};
  const symbols = Object.keys(holdings);

  for (const sym of symbols) {
    const px = await getPriceAtOrBefore(sym, asOfDate);
    prices[sym] = px;
    cryptoValue += holdings[sym] * px;
  }

  const totalValue = cash + cryptoValue;

  return {
    userId,
    leagueId,
    asOf: asOfDate.toISOString(),
    cash,
    cryptoValue,
    totalValue,
    holdings,
    prices,
  };
}

async function scoreHeadToHeadMatchup({
  leagueId,
  round,
  homeUserId,
  awayUserId,
}) {
  const roundStart = new Date(round.start);
  const roundEnd = new Date(round.end);

  if (Number.isNaN(roundStart.getTime()) || Number.isNaN(roundEnd.getTime())) {
    const err = new Error("Invalid round start/end");
    err.status = 500;
    throw err;
  }

  const now = new Date();
  const effectiveEnd = now.getTime() < roundEnd.getTime() ? now : roundEnd;

  const [homeStart, homeEnd, awayStart, awayEnd] = await Promise.all([
    getPortfolioValueAtTime({
      userId: homeUserId,
      leagueId,
      asOf: roundStart,
    }),
    getPortfolioValueAtTime({
      userId: homeUserId,
      leagueId,
      asOf: effectiveEnd,
    }),
    getPortfolioValueAtTime({
      userId: awayUserId,
      leagueId,
      asOf: roundStart,
    }),
    getPortfolioValueAtTime({
      userId: awayUserId,
      leagueId,
      asOf: effectiveEnd,
    }),
  ]);

  const homeProfit = homeEnd.totalValue - homeStart.totalValue;
  const awayProfit = awayEnd.totalValue - awayStart.totalValue;

  const EPS = 0.0001;
  const diff = homeProfit - awayProfit;

  let winnerUserId = null;
  let result = "TIE";

  if (Math.abs(diff) > EPS) {
    if (diff > 0) {
      winnerUserId = homeUserId;
      result = "HOME_WIN";
    } else {
      winnerUserId = awayUserId;
      result = "AWAY_WIN";
    }
  } else {
    const valueDiff = homeEnd.totalValue - awayEnd.totalValue;
    if (Math.abs(valueDiff) > EPS) {
      winnerUserId = valueDiff > 0 ? homeUserId : awayUserId;
      result = winnerUserId === homeUserId ? "HOME_WIN" : "AWAY_WIN";
    } else {
      winnerUserId = null;
      result = "TIE";
    }
  }

  return {
    leagueId,
    roundIndex: round.roundIndex,
    label: round.label,
    start: roundStart.toISOString(),
    end: roundEnd.toISOString(),
    effectiveEnd: effectiveEnd.toISOString(),
    home: {
      userId: homeUserId,
      startValue: homeStart.totalValue,
      endValue: homeEnd.totalValue,
      profit: homeProfit,
    },
    away: {
      userId: awayUserId,
      startValue: awayStart.totalValue,
      endValue: awayEnd.totalValue,
      profit: awayProfit,
    },
    winnerUserId,
    result, // "HOME_WIN", "AWAY_WIN", or "TIE"
  };
}

async function computeLeagueStandings({ leagueId, league, members, asOf }) {
  const nowDate = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(nowDate.getTime())) {
    const err = new Error("Invalid asOf timestamp");
    err.status = 400;
    throw err;
  }

  const schedule = computeLeagueSchedule({ league, members });

  const standingsMap = new Map();
  for (const m of members) {
    standingsMap.set(m.id, {
      userId: m.id,
      username: m.username,
      wins: 0,
      losses: 0,
      ties: 0,
      games: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      byes: 0,
    });
  }

  for (const round of schedule) {
    const roundEnd = new Date(round.end);
    if (Number.isNaN(roundEnd.getTime())) continue;

    // Only count fully finished rounds
    if (roundEnd.getTime() > nowDate.getTime()) continue;

    for (const m of round.matchups) {
      // BYE week – track but don't change record
      if (m.byeUserId) {
        const byeEntry = standingsMap.get(m.byeUserId);
        if (byeEntry) byeEntry.byes += 1;
        continue;
      }

      const score = await scoreHeadToHeadMatchup({
        leagueId,
        round,
        homeUserId: m.homeUserId,
        awayUserId: m.awayUserId,
      });

      const homeEntry = standingsMap.get(m.homeUserId);
      const awayEntry = standingsMap.get(m.awayUserId);
      if (!homeEntry || !awayEntry) continue; // safety

      homeEntry.games += 1;
      awayEntry.games += 1;

      const homePoints = score.home.profit;
      const awayPoints = score.away.profit;

      homeEntry.pointsFor += homePoints;
      homeEntry.pointsAgainst += awayPoints;
      awayEntry.pointsFor += awayPoints;
      awayEntry.pointsAgainst += homePoints;

      if (score.result === "TIE" || score.winnerUserId == null) {
        homeEntry.ties += 1;
        awayEntry.ties += 1;
      } else if (score.winnerUserId === m.homeUserId) {
        homeEntry.wins += 1;
        awayEntry.losses += 1;
      } else if (score.winnerUserId === m.awayUserId) {
        awayEntry.wins += 1;
        homeEntry.losses += 1;
      }
    }
  }

  const standings = Array.from(standingsMap.values()).map((e) => ({
    ...e,
    pointsFor: Number(e.pointsFor.toFixed(2)),
    pointsAgainst: Number(e.pointsAgainst.toFixed(2)),
    pointDiff: Number((e.pointsFor - e.pointsAgainst).toFixed(2)),
  }));

  standings.sort((a, b) => {
    // primary: wins
    if (b.wins !== a.wins) return b.wins - a.wins;
    // secondary: point differential
    const bDiff = b.pointDiff;
    const aDiff = a.pointDiff;
    if (bDiff !== aDiff) return bDiff - aDiff;
    // tertiary: points for
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    // final: username
    return a.username.localeCompare(b.username);
  });

  return {
    asOf: nowDate.toISOString(),
    standings,
  };
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
app.get("/matchups", requireAuth, (req, res) =>
  res.render("matchups", { activePage: "matchups" })
);
app.get("/league/join/:code", async (req, res) => {
  const joinCode = req.params.code;
  if (!req.session.userId) {
    return res.redirect(`/login?join=${encodeURIComponent(joinCode)}`);
  }
  try {
    const league = await joinLeagueForUserByCode(req.session.userId, joinCode);
    req.session.currentLeagueId = league.id;
    return res.redirect("/portfolio");
  } catch (e) {
    const status = e.status || 500;
    if (!res.headersSent) {
      return res
        .status(status)
        .send(e.status ? e.message : "Failed to join league");
    }
  }
});
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

    const { name, memberCount, matchupCount, matchupFrequency } = req.body;
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

    let totalMatchups = null;
    if (
      matchupCount !== undefined &&
      matchupCount !== null &&
      matchupCount !== ""
    ) {
      const m = Number(matchupCount);
      if (!Number.isInteger(m) || m <= 0 || m > 1000) {
        return res
          .status(400)
          .json({ error: "Matchup count must be a positive integer" });
      }
      totalMatchups = m;
    }

    let freq = (matchupFrequency || "").toUpperCase();

    if (freq !== "DAILY" && freq !== "WEEKLY") {
      freq = "WEEKLY";
    }

    const settings = {
      matchupCount: totalMatchups,
      matchupFrequency: freq,
    };

    let leagueId = null;
    let joinCode = null;

    const leagueCoinSymbols = await getDefaultLeagueCoinSymbols();

    // Keep trying until we get a unique join code
    while (!leagueId) {
      joinCode = generateJoinCode();
      try {
        const result = await pool.query(
          `insert into leagues (name, owner_user_id, join_code, member_limit, coin_symbols, settings)
           values ($1, $2, $3, $4, $5, $6)
           returning id, coin_symbols, settings`,
          [
            trimmedName,
            req.session.userId,
            joinCode,
            memberLimit,
            leagueCoinSymbols,
            JSON.stringify(settings),
          ]
        );
        leagueId = result.rows[0].id;
        console.log("Created league:", result.rows[0]);
      } catch (e) {
        if (e.code === "23505") continue; // join_code collision
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
        coinSymbols: leagueCoinSymbols,
        settings,
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

    const rawCode = req.body.leagueCode || req.body.code || "";

    const league = await joinLeagueForUserByCode(req.session.userId, rawCode);
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
    if (e.status) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: "Failed to join league" });
  }
});

// Get generated schedule for the current active league
app.get("/api/leagues/schedule", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const leagueId = await getOrCreateCurrentLeagueId(req);

    const leagueRes = await pool.query(
      `
      SELECT id, name, settings, created_at, status, winner_user_id, completed_at, join_code, owner_user_id
      FROM leagues
      WHERE id = $1
      `,
      [leagueId]
    );

    if (!leagueRes.rows.length) {
      return res.status(404).json({ error: "League not found" });
    }

    const league = leagueRes.rows[0];

    const membersRes = await pool.query(
      `
      SELECT u.id, u.username
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE p.league_id = $1
      ORDER BY u.username ASC
      `,
      [leagueId]
    );

    const members = membersRes.rows;

    const settings = normalizeLeagueSettings(league.settings);
    const schedule = computeLeagueSchedule({ league, members });
    const matchupFrequencyResolved = (
      settings.matchupFrequency || "WEEKLY"
    ).toUpperCase();

    // Prefer returning the persisted join code and a canonical invite URL
    const joinCode = league.join_code || null;
    const inviteUrl = joinCode
      ? `${req.protocol}://${req.get("host")}/league/join/${joinCode}`
      : null;

    return res.json({
      league: {
        id: league.id,
        name: league.name,
        settings,
        created_at: league.created_at,
        owner_user_id: league.owner_user_id || null,
        joinCode,
        inviteUrl,
        isOwner:
          req.session.userId && league.owner_user_id === req.session.userId,
      },
      matchupFrequencyResolved,
      memberCount: members.length,
      members,
      schedule,
    });
  } catch (e) {
    console.error("Get league schedule error:", e);
    return res.status(500).json({ error: "Failed to generate schedule" });
  }
});

// Get scores for a specific round in the current active league
app.get(
  "/api/leagues/round/:roundIndex/scores",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(500).json({ error: "Database not configured" });
      }

      const roundIndex = Number(req.params.roundIndex);
      if (!Number.isInteger(roundIndex) || roundIndex <= 0) {
        return res
          .status(400)
          .json({ error: "roundIndex must be a positive integer" });
      }

      const leagueId = await getOrCreateCurrentLeagueId(req);

      const leagueRes = await pool.query(
        `
      SELECT id, name, settings, created_at, status, winner_user_id, completed_at
      FROM leagues
      WHERE id = $1
      `,
        [leagueId]
      );

      if (!leagueRes.rows.length) {
        return res.status(404).json({ error: "League not found" });
      }

      const league = leagueRes.rows[0];

      const membersRes = await pool.query(
        `
      SELECT u.id, u.username
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE p.league_id = $1
      ORDER BY u.username ASC
      `,
        [leagueId]
      );

      const members = membersRes.rows;
      const memberById = new Map(members.map((m) => [m.id, m]));

      const settings = normalizeLeagueSettings(league.settings);
      const schedule = computeLeagueSchedule({ league, members });

      const round = schedule.find((r) => r.roundIndex === roundIndex);
      if (!round) {
        return res.status(404).json({ error: "Round not found in schedule" });
      }

      const scoredMatchups = [];

      for (const m of round.matchups) {
        if (m.byeUserId) {
          const byeMember = memberById.get(m.byeUserId);
          scoredMatchups.push({
            type: "BYE",
            byeUserId: m.byeUserId,
            byeUsername: m.byeUsername,
            byeDisplayName: byeMember ? byeMember.username : m.byeUsername,
          });
          continue;
        }

        const result = await scoreHeadToHeadMatchup({
          leagueId,
          round,
          homeUserId: m.homeUserId,
          awayUserId: m.awayUserId,
        });

        const homeMember = memberById.get(m.homeUserId);
        const awayMember = memberById.get(m.awayUserId);

        scoredMatchups.push({
          type: "HEAD_TO_HEAD",
          homeUserId: m.homeUserId,
          awayUserId: m.awayUserId,
          homeUsername: m.homeUsername,
          awayUsername: m.awayUsername,
          homeDisplayName: homeMember ? homeMember.username : m.homeUsername,
          awayDisplayName: awayMember ? awayMember.username : m.awayUsername,
          score: result,
        });
      }

      return res.json({
        league: {
          id: league.id,
          name: league.name,
          settings,
          created_at: league.created_at,
        },
        round: {
          roundIndex: round.roundIndex,
          label: round.label,
          start: round.start,
          end: round.end,
        },
        matchups: scoredMatchups,
      });
    } catch (e) {
      console.error("Get round scores error:", e);
      return res.status(500).json({ error: "Failed to compute round scores" });
    }
  }
);

app.get("/api/leagues/standings", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const leagueId = await getOrCreateCurrentLeagueId(req);

    const leagueRes = await pool.query(
      `
      SELECT id, name, settings, created_at, status, winner_user_id, completed_at
      FROM leagues
      WHERE id = $1
      `,
      [leagueId]
    );

    if (!leagueRes.rows.length) {
      return res.status(404).json({ error: "League not found" });
    }

    const league = leagueRes.rows[0];

    const membersRes = await pool.query(
      `
      SELECT u.id, u.username
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE p.league_id = $1
      ORDER BY u.username ASC
      `,
      [leagueId]
    );

    const members = membersRes.rows;

    const { asOf, standings } = await computeLeagueStandings({
      leagueId,
      league,
      members,
    });

    let champion = null;
    if (league.status === "COMPLETED" && standings.length > 0) {
      const top = standings[0];

      champion = {
        userId: top.userId,
        username: top.username,
        wins: top.wins,
        losses: top.losses,
        ties: top.ties,
        games: top.games,
        pointsFor: top.pointsFor,
        pointsAgainst: top.pointsAgainst,
        pointDiff: top.pointDiff,
        byes: top.byes,
      };
    }

    return res.json({
      league: {
        id: league.id,
        name: league.name,
        settings: normalizeLeagueSettings(league.settings),
        created_at: league.created_at,
        status: league.status,
        winner_user_id: league.winner_user_id,
        completed_at: league.completed_at,
        owner_user_id: league.owner_user_id || null,
        isOwner:
          req.session.userId && league.owner_user_id === req.session.userId,
      },
      asOf,
      standings,
      champion, // null unless league is completed
    });
  } catch (e) {
    console.error("Get league standings error:", e);
    return res.status(500).json({ error: "Failed to compute standings" });
  }
});

app.get("/api/leagues/leaderboard", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const leagueId = await getOrCreateCurrentLeagueId(req);

    const { rows } = await pool.query(leagueQueries.getLeaderboard, [leagueId]);

    res.json({
      leagueId,
      leaderboard: rows,
    });
  } catch (e) {
    console.error("Get leaderboard error:", e);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

app.post("/api/leagues/complete", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const bodyLeagueId =
      req.body && req.body.leagueId ? Number(req.body.leagueId) : null;
    const leagueId = bodyLeagueId || (await getOrCreateCurrentLeagueId(req));

    const leagueRes = await pool.query(
      `
      SELECT id, name, owner_user_id, settings, created_at, status, winner_user_id, completed_at
      FROM leagues
      WHERE id = $1
      `,
      [leagueId]
    );

    if (!leagueRes.rows.length) {
      return res.status(404).json({ error: "League not found" });
    }

    const league = leagueRes.rows[0];

    if (league.owner_user_id !== req.session.userId) {
      return res
        .status(403)
        .json({ error: "Only the league owner can complete this league" });
    }

    if (league.status === "COMPLETED") {
      return res.status(400).json({
        error: "League is already completed",
        league: {
          id: league.id,
          name: league.name,
          status: league.status,
          completed_at: league.completed_at,
          winner_user_id: league.winner_user_id,
        },
      });
    }

    const membersRes = await pool.query(
      `
      SELECT u.id, u.username
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE p.league_id = $1
      ORDER BY u.username ASC
      `,
      [leagueId]
    );

    const members = membersRes.rows;
    if (!members.length) {
      return res.status(400).json({ error: "League has no members" });
    }

    const schedule = computeLeagueSchedule({ league, members });
    if (!schedule.length) {
      return res
        .status(400)
        .json({ error: "League has no schedule to complete" });
    }

    const lastRound = schedule[schedule.length - 1];
    const lastEnd = new Date(lastRound.end);
    const now = new Date();

    if (Number.isNaN(lastEnd.getTime())) {
      return res.status(500).json({ error: "Invalid last round end time" });
    }

    if (lastEnd.getTime() > now.getTime()) {
      return res.status(400).json({
        error: "Season is not finished yet",
        lastRoundEndsAt: lastEnd.toISOString(),
      });
    }

    const { asOf, standings } = await computeLeagueStandings({
      leagueId,
      league,
      members,
      asOf: now.toISOString(),
    });

    if (!standings.length) {
      return res
        .status(400)
        .json({ error: "No standings available to finalize" });
    }

    const champion = standings[0];

    const finalizeRes = await pool.query(leagueQueries.finalizeLeague, [
      leagueId,
      champion.userId,
    ]);

    const finalized = finalizeRes.rows[0];

    return res.json({
      success: true,
      league: {
        id: finalized.id,
        name: finalized.name,
        status: finalized.status,
        completed_at: finalized.completed_at,
        winner_user_id: finalized.winner_user_id,
        winner_username: champion.username,
      },
      asOf,
      finalStandings: standings,
    });
  } catch (e) {
    console.error("Complete league error:", e);
    return res.status(500).json({ error: "Failed to complete league" });
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

// Get current coin data for the app's configured (env-based) list
app.get("/api/cg/coins", async (req, res) => {
  try {
    if (!COIN_WHITELIST.length) {
      return res.json([]);
    }

    const idsParam = COIN_WHITELIST.join(",");

    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd` +
      `&ids=${encodeURIComponent(idsParam)}` +
      `&order=market_cap_desc&per_page=250&page=1&sparkline=false`;

    const headers = CG_API_KEY ? { "x-cg-demo-api-key": CG_API_KEY } : {};
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`CoinGecko ${response.status}`);

    const data = await response.json();

    const payload = data.map((c) => ({
      id: c.id,          // CoinGecko ID (e.g. "bitcoin")
      symbol: c.id,      // we treat ID as our symbol internally
      acronym: c.symbol.toUpperCase(),
      name: c.name,
      current_price: c.current_price,
      price_change_percentage_24h: c.price_change_percentage_24h,
    }));

    res.json(payload);
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
app.get("/api/price/:id", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const coinId = normalizeCoinId(req.params.id);
  if (!coinId) return res.status(400).json({ error: "id required" });

  try {
    const { rows } = await pool.query(
      "select symbol, price_usd, fetched_at from prices_latest where symbol = $1",
      [coinId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all historical prices for a coin
app.get("/api/prices/:id", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });

  const coinId = normalizeCoinId(req.params.id);
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
    const tradesResult = await getUserTrades(req.session.userId, leagueId);

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

    const { symbol, side, quantity } = req.body;
    const sideU = (side || "").toUpperCase();
    const qty = Number(quantity);

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    // Treat "symbol" from the client as CoinGecko ID,
    // and validate only against the global env whitelist.
    const coinId = validateSymbol(symbol);

    if (!coinId) {
      return res
        .status(400)
        .json({ error: "coin not allowed (not in global whitelist)" });
    }

    if (sideU !== "BUY" && sideU !== "SELL")
      return res.status(400).json({ error: "side must be BUY or SELL" });
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: "quantity must be > 0" });

    // fetch price using CoinGecko ID
    const price = await getCurrentPrice(coinId);
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
      coinId,
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
        coinId,
        curQty + qty,
      ]);
      await pool.query(portfolioQueries.insertTrade, [
        req.session.userId,
        leagueId,
        coinId,
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
          coinId,
        ]);
      } else {
        await pool.query(portfolioQueries.upsertHolding, [
          req.session.userId,
          leagueId,
          coinId,
          newQty,
        ]);
      }
      await pool.query(portfolioQueries.insertTrade, [
        req.session.userId,
        leagueId,
        coinId,
        "SELL",
        qty,
        px,
        cost,
      ]);
    }

    await pool.query("COMMIT");

    // return fresh snapshot for this league (unchanged)
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

app.get("/api/trades/recent", requireAuth, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const leagueId = await getOrCreateCurrentLeagueId(req);
    await ensurePortfolio(req.session.userId, leagueId);

    const tradeResult = await getUserTrades(req.session.userId, leagueId);
    const recent = tradeResult.rows.slice(-4).reverse();

    res.json({ trades: recent });
  } catch (e) {
    console.error("recent trades error:", e);
    res.status(500).json({ error: "Failed to load recent trades" });
  }
})

async function getUserTrades (userId, leagueId) {
  if (!pool) {
    const err = new Error("Database not configured");
    err.status = 500;
    throw err;
  }

  const res = await pool.query(portfolioHistoryQueries.getTrades, [
    userId,
    leagueId,
  ]);

  return res;
}


app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  initDB();
});
