CREATE TABLE IF NOT EXISTS tokens (
  id serial PRIMARY KEY,
  email VARCHAR ( 255 ) UNIQUE NOT NULL,
  iam_access_token VARCHAR (50),
  iam_refresh_token VARCHAR (50),
  sis_access_token TEXT,
  sis_refresh_token TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP
);