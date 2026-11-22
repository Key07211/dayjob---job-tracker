-- Dayjob's tables in PostgreSQL, the same shape as the SQLite database at schema 8 plus assistant_conversations,
-- so the SQLite file can be imported as it is. Later files tidy the tables up; never edit a released file.
-- Times stay ISO text and flags stay 0/1 integers for now, so the app reads the same values from either database.

CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE searches (
  id text PRIMARY KEY,
  name text NOT NULL,
  keywords text NOT NULL,
  location text NOT NULL DEFAULT '',
  distance integer,
  sites text NOT NULL,
  hours_old integer,
  job_type text,
  is_remote integer NOT NULL DEFAULT 0,
  results_wanted integer NOT NULL DEFAULT 25,
  country text NOT NULL DEFAULT 'usa',
  title_include text NOT NULL DEFAULT '[]',
  exclude_keywords text NOT NULL DEFAULT '[]',
  enabled integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_run_at text
);

CREATE TABLE companies (
  id text PRIMARY KEY,
  name text NOT NULL,
  ats text NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby')),
  slug text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  UNIQUE (ats, slug)
);

CREATE TABLE postings (
  id text PRIMARY KEY,
  site text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  company text,
  company_url text,
  company_logo text,
  location text,
  city text,
  state text,
  country text,
  is_remote integer,
  job_type text,
  job_level text,
  job_function text,
  department text,
  salary_min double precision,
  salary_max double precision,
  salary_interval text,
  salary_currency text,
  salary_source text,
  description text,
  emails text,
  job_url text NOT NULL,
  apply_url text,
  date_posted text,
  first_seen_at text NOT NULL,
  last_seen_at text NOT NULL,
  closed_at text,
  last_checked_at text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'dismissed', 'applied')),
  dedupe_key text,
  duplicate_of text,
  resume_id text,
  resume_overlap double precision,
  UNIQUE (site, external_id)
);
CREATE INDEX postings_status ON postings (status, first_seen_at);
CREATE INDEX postings_dedupe ON postings (dedupe_key);

CREATE TABLE posting_searches (
  posting_id text NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
  search_id text NOT NULL,
  matched_at text NOT NULL,
  PRIMARY KEY (posting_id, search_id)
);

CREATE TABLE runs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  trigger text NOT NULL,
  started_at text NOT NULL,
  finished_at text,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  found integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  scored integer NOT NULL DEFAULT 0,
  detail text NOT NULL DEFAULT '[]'
);

CREATE TABLE resumes (
  id text PRIMARY KEY,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  text text NOT NULL,
  uploaded_at text NOT NULL,
  active integer NOT NULL DEFAULT 0,
  file bytea
);

CREATE TABLE scores (
  posting_id text NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
  resume_id text NOT NULL REFERENCES resumes (id) ON DELETE CASCADE,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict text NOT NULL,
  summary text NOT NULL,
  strengths text NOT NULL DEFAULT '[]',
  gaps text NOT NULL DEFAULT '[]',
  missing_keywords text NOT NULL DEFAULT '[]',
  provider text NOT NULL,
  model text,
  created_at text NOT NULL,
  PRIMARY KEY (posting_id, resume_id)
);

CREATE TABLE applications (
  id text PRIMARY KEY,
  posting_id text UNIQUE REFERENCES postings (id) ON DELETE SET NULL,
  company text NOT NULL,
  title text NOT NULL,
  job_url text,
  status text NOT NULL,
  applied_at text NOT NULL,
  status_changed_at text NOT NULL,
  next_follow_up_at text,
  resume_id text,
  contact text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  flags text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE application_events (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  at text NOT NULL,
  type text NOT NULL,
  from_status text,
  to_status text,
  note text NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('user', 'auto', 'mcp'))
);
CREATE INDEX events_application ON application_events (application_id, at);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  ref_id text,
  created_at text NOT NULL,
  read integer NOT NULL DEFAULT 0
);

CREATE TABLE goals (
  id text PRIMARY KEY,
  month text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('applications', 'interviews', 'custom')),
  name text NOT NULL DEFAULT '',
  target integer NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);
CREATE INDEX goals_month ON goals (month, position);

CREATE TABLE goal_logs (
  id text PRIMARY KEY,
  goal_id text NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  at text NOT NULL,
  amount integer NOT NULL
);
CREATE INDEX goal_logs_goal ON goal_logs (goal_id, at);

CREATE TABLE ai_usage (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at text NOT NULL,
  kind text NOT NULL,
  posting_id text,
  provider text NOT NULL,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  turns integer,
  chars integer,
  duration_ms integer,
  key_id text,
  cost_usd double precision
);
CREATE INDEX ai_usage_at ON ai_usage (at);

CREATE TABLE assistant_steps (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at text NOT NULL,
  conversation_id text NOT NULL,
  reply_at text NOT NULL,
  step integer NOT NULL,
  kind text NOT NULL,
  posting_id text,
  provider text NOT NULL,
  model text,
  tools text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  cost_usd double precision
);
CREATE INDEX assistant_steps_at ON assistant_steps (at);
CREATE INDEX assistant_steps_reply ON assistant_steps (conversation_id, reply_at, step);

CREATE TABLE cover_letters (
  id text PRIMARY KEY,
  posting_id text,
  company text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  text text NOT NULL,
  file text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX cover_letters_posting ON cover_letters (posting_id) WHERE posting_id IS NOT NULL;

CREATE TABLE assistant_conversations (
  id text PRIMARY KEY,
  title text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  archived_at text,
  turns text NOT NULL
);
