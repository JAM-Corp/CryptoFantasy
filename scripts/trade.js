// Encapsulate trade page GET logic: build coins list (with latest prices)
// and fetch user's holdings if DB is available.
export default function makeTradeRoutes({ pool, COIN_WHITELIST, getOrCreateCurrentLeagueId }) {
  return {
    tradeGet: async (req, res) => {
      try {
        // Build coin list with latest prices when DB is available
        let coins = COIN_WHITELIST.map((s) => ({ symbol: s, price_usd: null }));
        if (pool) {
          const { rows } = await pool.query(
            "select symbol, price_usd from prices_latest where symbol = any($1)",
            [COIN_WHITELIST]
          );
          const priceMap = Object.fromEntries(
            rows.map((r) => [r.symbol, r.price_usd])
          );
          coins = COIN_WHITELIST.map((s) => ({
            symbol: s,
            price_usd: priceMap[s] ?? null,
          }));
        }

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
        }

        res.render("trade", { coins, balance, holdings });
      } catch (e) {
        console.error("tradeGet error:", e);
        res.render("trade", {
          coins: COIN_WHITELIST.map((s) => ({ symbol: s, price_usd: null })),
          balance: "0.00",
          holdings: [],
        });
      }
    },
  };
}
