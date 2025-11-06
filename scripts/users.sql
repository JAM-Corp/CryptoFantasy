create table if not exists users (
  id serial primary key,
  username varchar(50) unique not null,
  email varchar(100) unique not null,
  password_hash varchar(255) not null,
  created_at timestamp default current_timestamp
);
