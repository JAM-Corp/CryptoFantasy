create table if not exists prices_latest (
  symbol     text primary key,
  price_usd  numeric(20,8) not null,
  fetched_at timestamptz   not null default now()
);

create table if not exists price_points_min (
  symbol     text not null,
  ts_min     timestamptz   not null,
  price_usd  numeric(20,8) not null,
  primary key (symbol, ts_min)
);
