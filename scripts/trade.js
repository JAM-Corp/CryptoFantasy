// Encapsulate trade page GET logic: build coins list (with latest prices)
// and fetch user's holdings if DB is available.
export default function makeTradeRoutes({
  pool,
  COIN_WHITELIST,
  getOrCreateCurrentLeagueId,
}) {
  return {
    tradeGet: async (req, res) => {
      try {
        let coins = [];
        let holdings = [];
        let balance = "0.00";

        if (pool) {
          const leagueId = await getOrCreateCurrentLeagueId(req);

          await pool.query(
            `insert into portfolios (user_id, league_id)
             values ($1, $2)
             on conflict (user_id, league_id) do nothing`,
            [req.session.userId, leagueId]
          );

          const cashRow = await pool.query(
            "select cash_usd from portfolios where user_id = $1 and league_id = $2",
            [req.session.userId, leagueId]
          );
          if (cashRow.rows.length) {
            balance = Number(cashRow.rows[0].cash_usd).toFixed(2);
          }

          const { rows: hrows } = await pool.query(
            `select symbol, qty::text as qty
             from holdings
             where user_id = $1 and league_id = $2
             order by symbol`,
            [req.session.userId, leagueId]
          );
          holdings = hrows;

          let symbolsForUI = COIN_WHITELIST;
          try {
            const { rows } = await pool.query(
              "select coin_symbols from leagues where id = $1",
              [leagueId]
            );
            if (
              rows.length &&
              Array.isArray(rows[0].coin_symbols) &&
              rows[0].coin_symbols.length
            ) {
              symbolsForUI = rows[0].coin_symbols.map((s) =>
                String(s).toUpperCase()
              );
            }
          } catch (e) {
            console.error("Failed to load coin_symbols for league in tradeGet:", e);
          }

          // Build coin list with latest prices for this league's symbols
          const { rows } = await pool.query(
            "select symbol, price_usd from prices_latest where symbol = any($1)",
            [symbolsForUI]
          );
          const priceMap = Object.fromEntries(
            rows.map((r) => [r.symbol, r.price_usd])
          );
          coins = symbolsForUI.map((s) => ({
            symbol: s,
            price_usd: priceMap[s] ?? null,
          }));
        } else {
          // No DB configured: fallback to global whitelist with null prices
          coins = COIN_WHITELIST.map((s) => ({ symbol: s, price_usd: null }));
        }

        res.render("trade", {
          activePage: "trade",
          coins,
          balance,
          holdings,
        });
      } catch (e) {
        console.error("tradeGet error:", e);
        res.render("trade", {
          activePage: "trade",
          coins: (COIN_WHITELIST || []).map((s) => ({
            symbol: s,
            price_usd: null,
          })),
          balance: "0.00",
          holdings: [],
        });
      }
    },
  };
}
