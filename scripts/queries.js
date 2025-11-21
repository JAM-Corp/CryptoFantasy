// SQL queries organized by feature

export const portfolioQueries = {
  getCash: `
    SELECT cash_usd 
    FROM portfolios 
    WHERE user_id = $1 AND league_id = $2
  `,

  getHoldings: `
    SELECT h.symbol,
           h.qty::text AS qty,
           pl.price_usd::text AS price_usd,
           (h.qty * pl.price_usd)::text AS market_value
    FROM holdings h
    LEFT JOIN prices_latest pl ON pl.symbol = h.symbol
    WHERE h.user_id = $1
      AND h.league_id = $2
    ORDER BY h.symbol
  `,

  getHoldingsWithPrices: `
    SELECT h.symbol, h.qty::numeric, pl.price_usd::numeric
    FROM holdings h
    LEFT JOIN prices_latest pl ON pl.symbol = h.symbol
    WHERE h.user_id = $1 AND h.league_id = $2
  `,

  getCashForUpdate: `
    SELECT cash_usd 
    FROM portfolios 
    WHERE user_id = $1 AND league_id = $2 
    FOR UPDATE
  `,

  getHoldingForUpdate: `
    SELECT qty 
    FROM holdings 
    WHERE user_id = $1 AND league_id = $2 AND symbol = $3 
    FOR UPDATE
  `,

  updateCash: `
    UPDATE portfolios 
    SET cash_usd = $3 
    WHERE user_id = $1 AND league_id = $2
  `,

  upsertHolding: `
    INSERT INTO holdings (user_id, league_id, symbol, qty)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, league_id, symbol)
    DO UPDATE SET qty = excluded.qty
  `,

  deleteHolding: `
    DELETE FROM holdings 
    WHERE user_id = $1 AND league_id = $2 AND symbol = $3
  `,

  insertTrade: `
    INSERT INTO trades (user_id, league_id, symbol, side, qty, price_usd, cost_usd)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
};

export const portfolioHistoryQueries = {
  getTrades: `
    SELECT symbol, side, qty::numeric, price_usd::numeric, created_at
    FROM trades
    WHERE user_id = $1 AND league_id = $2
    ORDER BY created_at ASC
  `,

  getCurrentPrices: `
    SELECT symbol, price_usd::numeric AS price
    FROM prices_latest
  `,

  getCurrentPricesForSymbols: `
    SELECT symbol, price_usd::numeric AS price
    FROM prices_latest
    WHERE symbol = ANY($1)
  `,

  getCurrentCash: `
    SELECT cash_usd 
    FROM portfolios 
    WHERE user_id = $1 AND league_id = $2
  `,

  getCurrentHoldings: `
    SELECT h.symbol, h.qty::numeric, pl.price_usd::numeric
    FROM holdings h
    LEFT JOIN prices_latest pl ON pl.symbol = h.symbol
    WHERE h.user_id = $1 AND h.league_id = $2
  `,
};

export const priceQueries = {
  getLatestPrice: `
    SELECT price_usd 
    FROM prices_latest 
    WHERE symbol = $1
  `,

  getPriceWithTimestamp: `
    SELECT symbol, price_usd, fetched_at 
    FROM prices_latest 
    WHERE symbol = $1
  `,
};

export const leagueQueries = {
  getLeagueById: `
    SELECT id, name, owner_user_id, join_code, member_limit, created_at
    FROM leagues
    WHERE id = $1
  `,

  getUserFirstLeague: `
    SELECT id 
    FROM leagues 
    WHERE owner_user_id = $1 
    ORDER BY created_at ASC 
    LIMIT 1
  `,

  getFirstPortfolioLeague: `
    SELECT league_id
    FROM portfolios
    WHERE user_id = $1
    ORDER BY created_at ASC
    LIMIT 1
  `,

  getLeaguesByUser: `
    SELECT DISTINCT l.id, l.name, l.owner_user_id, l.join_code, l.member_limit, l.created_at
    FROM leagues l
    INNER JOIN portfolios p ON p.league_id = l.id
    WHERE p.user_id = $1
    ORDER BY l.created_at DESC
  `,

  getActiveLeagues: `
    SELECT l.id, l.name, l.join_code, l.member_limit,
           COUNT(DISTINCT p.user_id) AS member_count
    FROM leagues l
    LEFT JOIN portfolios p ON p.league_id = l.id
    WHERE l.owner_user_id = $1
       OR p.user_id = $1
    GROUP BY l.id, l.name, l.join_code, l.member_limit
    ORDER BY l.created_at ASC
  `,

  getLeaderboard: `
    SELECT p.user_id, u.username,
           p.cash_usd::numeric AS cash,
           COALESCE(SUM(h.qty * pl.price_usd), 0)::numeric AS crypto_value,
           (p.cash_usd + COALESCE(SUM(h.qty * pl.price_usd), 0))::numeric AS total_value
    FROM portfolios p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN holdings h ON h.user_id = p.user_id AND h.league_id = p.league_id
    LEFT JOIN prices_latest pl ON pl.symbol = h.symbol
    WHERE p.league_id = $1
    GROUP BY p.user_id, u.username, p.cash_usd
    ORDER BY total_value DESC
  `,

  getActiveLeague: `
    SELECT active_league_id 
    FROM users 
    WHERE id = $1
  `,

  setActiveLeague: `
    UPDATE users 
    SET active_league_id = $2 
    WHERE id = $1
  `,

  createLeague: `
    INSERT INTO leagues (name, owner_user_id, join_code, member_limit)
    VALUES ($1, $2, $3, $4)
    RETURNING id, name, owner_user_id, join_code, member_limit, created_at
  `,

  createSoloLeague: `
    INSERT INTO leagues (name, owner_user_id, join_code)
    VALUES ($1, $2, $3)
    RETURNING id
  `,

  getLeagueByJoinCode: `
    SELECT id, name, member_limit
    FROM leagues
    WHERE join_code = $1
  `,

  checkMembership: `
    SELECT 1 
    FROM portfolios 
    WHERE user_id = $1 AND league_id = $2
  `,

  countLeagueMembers: `
    SELECT COUNT(*) AS member_count
    FROM portfolios
    WHERE league_id = $1
  `,

  createPortfolio: `
    INSERT INTO portfolios (user_id, league_id, cash_usd)
    VALUES ($1, $2, 100000)
    ON CONFLICT (user_id, league_id) DO NOTHING
  `,

  ensurePortfolio: `
    INSERT INTO portfolios (user_id, league_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, league_id) DO NOTHING
  `,
};

export const userQueries = {
  getUserByUsername: `
    SELECT * 
    FROM users 
    WHERE username = $1
  `,

  getUserById: `
    SELECT id, username, email, created_at 
    FROM users 
    WHERE id = $1
  `,

  createUser: `
    INSERT INTO users (username, password_hash, email)
    VALUES ($1, $2, $3)
    RETURNING id, username, email
  `,
};

export const coinQueries = {
  getPriceHistory: `
    SELECT symbol, ts_min, price_usd 
    FROM price_points_min 
    WHERE symbol = $1 
    ORDER BY ts_min ASC
  `,
};
