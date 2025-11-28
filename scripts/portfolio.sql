create table if not exists leagues (
  id             bigserial primary key,
  name           text        not null,
  owner_user_id  integer     not null references users(id) on delete cascade,
  join_code      text        not null unique,
  member_limit   integer     check (member_limit is null OR member_limit between 2 and 1000),
  coin_symbols   text[],
  settings       jsonb,
  created_at     timestamptz not null default now(),
  status         text        not null default 'ACTIVE',
  winner_user_id integer     references users(id) on delete set null,
  completed_at   timestamptz
);


create table if not exists portfolios (
  user_id    integer      not null references users(id) on delete cascade,
  league_id  bigint       not null references leagues(id) on delete cascade,
  cash_usd   numeric(20,8) not null default 100000.0,
  created_at timestamptz   not null default now(),
  primary key (user_id, league_id)
);

create table if not exists holdings (
  user_id   integer       not null references users(id) on delete cascade,
  league_id bigint        not null references leagues(id) on delete cascade,
  symbol    text          not null,
  qty       numeric(30,12) not null default 0,
  primary key (user_id, league_id, symbol),
  check (qty >= 0)
);

create table if not exists trades (
  id         bigserial primary key,
  user_id    integer       not null references users(id) on delete cascade,
  league_id  bigint        not null references leagues(id) on delete cascade,
  symbol     text          not null,
  side       text          not null check (side in ('BUY','SELL')),
  qty        numeric(30,12) not null check (qty > 0),
  price_usd  numeric(20,8)  not null check (price_usd > 0),
  cost_usd   numeric(28,8)  not null,
  created_at timestamptz    not null default now()
);

create index if not exists idx_trades_user_league_time
  on trades (user_id, league_id, created_at desc);
