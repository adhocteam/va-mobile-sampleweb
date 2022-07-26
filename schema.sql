CREATE TABLE IF NOT EXISTS tokens (
  id serial PRIMARY KEY,
  email VARCHAR ( 255 ) UNIQUE NOT NULL,
  iam_access_token VARCHAR (50),
  iam_refresh_token VARCHAR (50),
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP
);