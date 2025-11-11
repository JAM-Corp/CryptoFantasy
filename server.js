import express from "express";
import { Pool } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import session from "express-session";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
let CG_API_KEY = process.env.CG_API_KEY || null;

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

// Allowed coins for PoC (coingecko ids, e.g., BITCOIN, ETHEREUM)
const COIN_WHITELIST = (process.env.COIN_WHITELIST || process.env.CG_IDS || "bitcoin,ethereum,solana")
  .split(",")
  .map(s => s.trim().toUpperCase())
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
    res.redirect("/login.html");
  }
}

// Helpers
async function ensurePortfolio(userId) {
  await pool.query(
    `insert into portfolios (user_id) values ($1)
     on conflict (user_id) do nothing`,
    [userId]
  );
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
    res.redirect("/index.html");
  } else {
    res.redirect("/login.html");
  }
});

// Public routes (no auth required)
app.use(
  "/login.html",
  express.static(path.join(__dirname, "public", "login.html"))
);
app.use(
  "/register.html",
  express.static(path.join(__dirname, "public", "register.html"))
);

// Protected routes - require authentication
app.use(
  "/index.html",
  requireAuth,
  express.static(path.join(__dirname, "public"))
);

app.get("/coins.html", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "coins.html"));
});

app.get("/portfolio.html", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "portfolio.html"));
});
app.get("/trade.html", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "trade.html"));
});


// All other static files require auth
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, path) => {
      if (!path.endsWith("login.html") && !path.endsWith("register.html")) {
      }
    },
  })
);

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




// Get current coin data
app.get("/api/cg/coins", async (req, res) => {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false";

    const headers = CG_API_KEY ? { "x_cg_demo_api_key": CG_API_KEY } : {};
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
    const days = req.query.days

    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
    const headers = CG_API_KEY ? { "x_cg_demo_api_key": CG_API_KEY } : {};
    
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error(`CoinGecko ${response.status}`);

    const data = await response.json();
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
    await ensurePortfolio(req.session.userId);

    // cash
    const cashRow = await pool.query(
      "select cash_usd from portfolios where user_id = $1",
      [req.session.userId]
    );
    const cash = Number(cashRow.rows[0].cash_usd);

    // holdings joined to latest price
    const { rows } = await pool.query(
      `select h.symbol,
              h.qty::text as qty,                -- return as text to avoid JS float issues
              pl.price_usd::text as price_usd,
              (h.qty * pl.price_usd)::text as market_value
       from holdings h
       left join prices_latest pl on pl.symbol = h.symbol
       where h.user_id = $1
       order by h.symbol`,
      [req.session.userId]
    );

    const cryptoValue = rows.reduce((sum, r) => sum + Number(r.market_value || 0), 0);
    const totalValue = cash + cryptoValue;

    res.json({
      cash_usd: cash.toFixed(2),
      crypto_value_usd: cryptoValue.toFixed(2),
      total_value_usd: totalValue.toFixed(2),
      holdings: rows
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});





// Trade ({ symbol, side: "BUY"|"SELL", quantity })
app.post("/api/trade", requireAuth, async (req, res) => {
  try {
    const { symbol, side, quantity } = req.body;
    const symbolU = validateSymbol(symbol);
    const sideU = (side || "").toUpperCase();
    const qty = Number(quantity);

    if (!symbolU) return res.status(400).json({ error: "symbol not allowed" });
    if (sideU !== "BUY" && sideU !== "SELL") return res.status(400).json({ error: "side must be BUY or SELL" });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "quantity must be > 0" });

    await ensurePortfolio(req.session.userId);

    // fetch price
    const price = await getCurrentPrice(symbolU);
    if (!price) return res.status(400).json({ error: "no current price; try later" });
    const px = Number(price);
    const cost = +(px * qty).toFixed(8); // positive number

    await pool.query("BEGIN");

    // load current cash & qty with FOR UPDATE
    const cashRow = await pool.query("select cash_usd from portfolios where user_id = $1 for update", [req.session.userId]);
    const cash = Number(cashRow.rows[0].cash_usd);

    const hRow = await pool.query(
      "select qty from holdings where user_id = $1 and symbol = $2 for update",
      [req.session.userId, symbolU]
    );
    const curQty = hRow.rows[0] ? Number(hRow.rows[0].qty) : 0;

    if (sideU === "BUY") {
      if (cash < cost) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient cash" });
      }
      await pool.query("update portfolios set cash_usd = cash_usd - $1 where user_id = $2", [cost, req.session.userId]);
      await pool.query(
        `insert into holdings (user_id, symbol, qty)
         values ($1, $2, $3)
         on conflict (user_id, symbol) do update set qty = holdings.qty + excluded.qty`,
        [req.session.userId, symbolU, qty]
      );
      await pool.query(
        `insert into trades (user_id, symbol, side, qty, price_usd, cost_usd)
         values ($1,$2,'BUY',$3,$4,$5)`,
        [req.session.userId, symbolU, qty, px, cost]
      );
    } else {
      // SELL
      if (curQty < qty) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient quantity" });
      }
      await pool.query("update portfolios set cash_usd = cash_usd + $1 where user_id = $2", [cost, req.session.userId]);
      await pool.query("update holdings set qty = qty - $1 where user_id = $2 and symbol = $3", [qty, req.session.userId, symbolU]);
      await pool.query("delete from holdings where user_id = $1 and symbol = $2 and qty <= 0", [req.session.userId, symbolU]);
      await pool.query(
        `insert into trades (user_id, symbol, side, qty, price_usd, cost_usd)
         values ($1,$2,'SELL',$3,$4,$5)`,
        [req.session.userId, symbolU, qty, px, cost]
      );
    }

    await pool.query("COMMIT");

    // return fresh snapshot
    const { rows } = await pool.query(
      `select h.symbol, h.qty::text as qty, pl.price_usd::text as price_usd,
              (h.qty * pl.price_usd)::text as market_value
       from holdings h left join prices_latest pl on pl.symbol = h.symbol
       where h.user_id = $1 order by h.symbol`,
      [req.session.userId]
    );
    const cash2 = Number((await pool.query("select cash_usd from portfolios where user_id = $1", [req.session.userId])).rows[0].cash_usd);
    const cryptoValue = rows.reduce((s, r) => s + Number(r.market_value || 0), 0);

    res.json({
      success: true,
      price_used_usd: px.toFixed(8),
      cash_usd: cash2.toFixed(2),
      crypto_value_usd: cryptoValue.toFixed(2),
      total_value_usd: (cash2 + cryptoValue).toFixed(2),
      holdings: rows
    });
  } catch (e) {
    try { await pool.query("ROLLBACK"); } catch { }
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  initDB();
});
