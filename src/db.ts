import pg from "pg";

const { Pool } = pg;

export const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://trackified:trackified@localhost:5432/trackified";

export const pool = new Pool({ connectionString: databaseUrl });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function migrate(): Promise<void> {
  await query(`
    create table if not exists accounts (
      id text primary key,
      name text not null,
      plan_tier text not null default 'free',
      monthly_tracking_limit integer not null default 100,
      rate_limit_per_minute integer not null default 60,
      bulk_limit integer not null default 5,
      realtime_ws boolean not null default false,
      overage_usd_per_tracking numeric(10,4) not null default 0.01,
      stripe_customer_id text,
      stripe_subscription_id text,
      billing_status text not null default 'not_connected',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await query(`alter table accounts add column if not exists stripe_customer_id text;`);
  await query(`alter table accounts add column if not exists stripe_subscription_id text;`);
  await query(`alter table accounts add column if not exists billing_status text not null default 'not_connected';`);

  await query(`
    create table if not exists users (
      id text primary key,
      account_id text not null references accounts(id),
      email text not null unique,
      name text,
      password_hash text not null,
      email_verified_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await query(`alter table users add column if not exists email_verified_at timestamptz;`);
  await query(`create index if not exists users_account_idx on users(account_id);`);

  await query(`
    create table if not exists user_tokens (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      token_hash text not null unique,
      kind text not null check (kind in ('email_verify', 'password_reset')),
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );
  `);
  await query(`create index if not exists user_tokens_user_idx on user_tokens(user_id);`);

  await query(`
    create table if not exists email_outbox (
      id text primary key,
      account_id text references accounts(id),
      to_email text not null,
      subject text not null,
      body text not null,
      provider text not null default 'dev',
      status text not null default 'queued',
      error text,
      sent_at timestamptz,
      created_at timestamptz not null default now()
    );
  `);
  await query(`create index if not exists email_outbox_account_idx on email_outbox(account_id);`);
  await query(`create index if not exists email_outbox_status_idx on email_outbox(status);`);

  await query(`
    create table if not exists team_invites (
      id text primary key,
      account_id text not null references accounts(id),
      email text not null,
      role text not null default 'member',
      token_hash text not null unique,
      invited_by text references users(id),
      accepted_at timestamptz,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
  `);
  await query(`create index if not exists team_invites_account_idx on team_invites(account_id);`);

  await query(`
    create table if not exists billing_events (
      id text primary key,
      account_id text references accounts(id),
      provider_event_id text unique,
      event_type text not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    );
  `);
  await query(`create index if not exists billing_events_account_idx on billing_events(account_id);`);

  await query(`
    create table if not exists sessions (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      account_id text not null references accounts(id),
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      revoked_at timestamptz
    );
  `);
  await query(`create index if not exists sessions_token_hash_idx on sessions(token_hash);`);
  await query(`create index if not exists sessions_account_idx on sessions(account_id);`);

  await query(`
    create table if not exists white_label_settings (
      account_id text primary key references accounts(id),
      domain text,
      brand_name text,
      accent_color text not null default '#08756f',
      support_url text,
      pii_public boolean not null default false,
      updated_at timestamptz not null default now()
    );
  `);
  await query(`
    insert into accounts (id, name)
    values ('acct_dev', 'Development account')
    on conflict (id) do nothing;
  `);

  await query(`
    create table if not exists trackings (
      id text primary key,
      account_id text not null default 'acct_dev' references accounts(id),
      tracking_number text not null,
      carrier text,
      carrier_detected boolean not null default false,
      status text not null,
      delivered_at timestamptz,
      estimated_delivery date,
      origin jsonb,
      destination jsonb,
      events jsonb not null default '[]'::jsonb,
      service_level text,
      weight_grams integer,
      estimated_delivery_window jsonb,
      transit_days_remaining integer,
      exception text,
      last_scraped_at timestamptz,
      next_scrape_at timestamptz,
      custom_id text,
      customer_email text,
      stopped_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
  `);
  await query(`alter table trackings add column if not exists account_id text not null default 'acct_dev' references accounts(id);`);
  await query(`create index if not exists trackings_status_idx on trackings(status);`);
  await query(`create index if not exists trackings_carrier_idx on trackings(carrier);`);
  await query(`create index if not exists trackings_account_idx on trackings(account_id);`);
  await query(`create index if not exists trackings_next_scrape_idx on trackings(next_scrape_at) where stopped_at is null;`);

  await query(`
    create table if not exists api_keys (
      id text primary key,
      account_id text not null default 'acct_dev' references accounts(id),
      name text not null,
      token_hash text not null unique,
      prefix text not null,
      mode text not null check (mode in ('live', 'test')),
      scopes text[] not null,
      created_at timestamptz not null,
      last_used_at timestamptz,
      revoked_at timestamptz
    );
  `);
  await query(`alter table api_keys add column if not exists account_id text not null default 'acct_dev' references accounts(id);`);
  await query(`create index if not exists api_keys_account_idx on api_keys(account_id);`);

  await query(`
    create table if not exists webhooks (
      id text primary key,
      account_id text not null default 'acct_dev' references accounts(id),
      url text not null,
      event_types text[] not null,
      secret text not null,
      enabled boolean not null default true,
      consecutive_failures integer not null default 0,
      created_at timestamptz not null,
      disabled_at timestamptz
    );
  `);
  await query(`alter table webhooks add column if not exists account_id text not null default 'acct_dev' references accounts(id);`);
  await query(`create index if not exists webhooks_account_idx on webhooks(account_id);`);

  await query(`
    create table if not exists webhook_deliveries (
      id text primary key,
      account_id text not null default 'acct_dev' references accounts(id),
      webhook_id text references webhooks(id) on delete cascade,
      event_type text not null,
      status integer,
      attempts integer not null default 0,
      error text,
      payload jsonb,
      delivered_at timestamptz,
      next_attempt_at timestamptz,
      created_at timestamptz not null
    );
  `);
  await query(`alter table webhook_deliveries add column if not exists account_id text not null default 'acct_dev' references accounts(id);`);
  await query(`alter table webhook_deliveries add column if not exists payload jsonb;`);
  await query(`alter table webhook_deliveries add column if not exists delivered_at timestamptz;`);
  await query(`alter table webhook_deliveries add column if not exists next_attempt_at timestamptz;`);
  await query(`create index if not exists webhook_deliveries_account_idx on webhook_deliveries(account_id);`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(async () => {
      console.error("[db] migrations complete");
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
