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

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  initDB();
});
