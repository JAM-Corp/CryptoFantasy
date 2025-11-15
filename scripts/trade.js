// Encapsulate trade page GET logic: build coins list (with latest prices)
// and fetch user's holdings if DB is available.
export default function makeTradeRoutes({ pool, COIN_WHITELIST }) {
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

        // Fetch user holdings if DB available and user has portfolio
        let holdings = [];
        if (pool) {
          try {
            const { rows: hrows } = await pool.query(
              "select symbol, qty::text as qty from holdings where user_id = $1 order by symbol",
              [req.session.userId]
            );
            holdings = hrows;
          } catch (e) {
            // ignore holdings failure, render page without holdings
            holdings = [];
          }
        }

        // Placeholder balance for now
        res.render("trade", { coins, balance: "10000.00", holdings });
      } catch (e) {
        res.render("trade", {
          coins: COIN_WHITELIST.map((s) => ({ symbol: s, price_usd: null })),
          balance: "10000.00",
          holdings: [],
        });
      }
    },
  };
}
