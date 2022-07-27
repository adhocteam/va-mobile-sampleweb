const express = require('express');
const { Issuer, Strategy } = require('openid-client');
const passport = require('passport');
const process = require('process');
const session = require('express-session');
const sessionStore = require('express-session-rsdb');
const request = require('request-promise-native');
const hbs = require('hbs');
const shajs = require('sha.js');
const jose = require('jose');
const { Client } = require('pg');
const basicAuth = require('express-basic-auth')

const secret = 'setec astronomy'
const OAUTH_URL = process.env.OAUTH_URL || 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/authorize';
const API_URL = process.env.API_URL || 'https://staging-api.va.gov'
const CLIENT_ID = process.env.CLIENT_ID || 'VAMobile'
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = process.env.PORT || 4001;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/auth/login-success';
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;

function createClient() {
  Issuer.defaultHttpOptions = { timeout: 5000 };
  const ssoeIssuer = new Issuer({
    issuer: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOPe',
    authorization_endpoint: OAUTH_URL,
    token_endpoint: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/token',
    jwks_uri: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/jwks/ISAMOPeFP',
    //Advertised in  metadata but seemingly not supported
    // userinfo_endpoint: 'https://sqa.fed.eauth.va.gov/oauthi/sps/oauth/oauth20/userinfo',
  });
  return new ssoeIssuer.Client({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uris: [
      CALLBACK_URL,
    ],
    response_types: ['code'],
  });
}

function configurePassport(client) {
  passport.serializeUser(function(user, done) {
    done(null, user);
  });

  passport.deserializeUser(function(user, done) {
    done(null, user);
  });

  passport.use('oidc', new Strategy(
    {
      client,
      params: {
        scope: 'openid',
        response_mode: 'query',
      },
      usePKCE: true,
      // SSOE oAuth seems to require these parameters for token exchange
      // even in PKCE mode, so add them here
      extras: {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        },
      }
    },
    (tokenset, done) => {
      ({ payload } = jose.JWT.decode(tokenset.id_token, { complete: true }));
      user = Object.assign(payload, tokenset);
      if (process.env.VERBOSE === 'true') {
        console.log('access_token', tokenset.access_token);
        console.log('id_token', payload);
      } else {
        console.log('user.name', user.email);
        console.log('user.icn', user.fediamMVIICN);
        console.log('access_token digest', new shajs.sha256().update(user.access_token).digest('hex'));
      }
      return done(null, user);
    }
  ));

  return client;
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect('/auth');
  }
}

function createDbClient() {
  const dbClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true
    }
  });
  dbClient.connect();

  return dbClient;
}

function writeToDb(statement, values) {
  const db = createDbClient();
  db.query(statement, values, (err, res) => {
    if (err) throw err;
    for (let row of res.rows) {
      console.log(JSON.stringify(row));
    }
    db.end();
  });
}

async function findUserRecord(email) {
  const db = createDbClient();
  const { rows } = await db.query('SELECT * FROM tokens WHERE email = $1 LIMIT 1', [email]);

  return rows[0];
}

function saveUserRecord(email, accessToken, refreshToken) {
  const timestamp = new Date().toISOString();
  const statement = 'INSERT INTO tokens (email, iam_access_token, iam_refresh_token, created_at) VALUES ($1, $2, $3, $4);';
  const values = [email, accessToken, refreshToken, timestamp];

  writeToDb(statement, values);
}

function updateUserRecord(email, accessToken, refreshToken) {
  const timestamp = new Date().toISOString();
  const statement = 'UPDATE tokens SET iam_access_token = $1, iam_refresh_token = $2, updated_at = $3 WHERE email = $4;';
  const values = [accessToken, refreshToken, timestamp, email];

  writeToDb(statement, values);
}

function startApp(client) {
  const app = express();
  app.set('view engine', 'hbs');
  app.set('view options', { layout: 'layout' });
  app.engine('handlebars', hbs.__express);
  app.use(express.static('assets'));
  app.use(session({
    store: new sessionStore(),
    secret: secret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 60 * 60000 },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/', (req, res) => {
    console.log('session id', req.session.id);
    res.render('index', { user: req.session.user, activeIndex: true, header: "Welcome" });
  });

  app.get('/user', requireLogin, async (req, res, next) => {
    const options = {
      url: API_URL + '/mobile/v0/user',
      headers: { 'Authorization': 'Bearer ' + req.session.user['access_token'] }
    };
    try {
      const response = await request(options);
      const output = JSON.stringify(JSON.parse(response), undefined, 2);
      const locals = { userinfo: output, user: req.session.user, header: 'User Info' };
      locals['activeUser'] = true;
      res.render('user', locals);
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" });
    }
  });

  app.get('/messaging', requireLogin, async (req, res, next) => {
    const options = {
      url: API_URL + '/mobile/v0/messaging/health/folders',
      headers: { 'Authorization': 'Bearer ' + req.session.user['access_token'] }
    };
    try {
      console.log('folders request', options);
      const response = await request(options);
      const raw = JSON.stringify(JSON.parse(response), undefined, 2);
      const { data } = JSON.parse(response);
      const locals = { folders: data, raw: raw, user: req.session.user, header: 'Messaging' };
      locals['activeMessaging'] = true;
      res.render('folders', locals);
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" });
    }
  });

  app.get('/messaging/:folderId', requireLogin, async (req, res, next) => {
    const options = {
      url: API_URL + `/mobile/v0/messaging/health/folders/${req.params.folderId}/messages`,
      headers: { 'Authorization': 'Bearer ' + req.session.user['access_token'] }
    };
    try {
      console.log('folder request', options);
      const response = await request(options);
      const raw = JSON.stringify(JSON.parse(response), undefined, 2);
      const { data } = JSON.parse(response)
      const locals = { messages: data, raw: raw, user: req.session.user, header: 'Messaging' };
      locals['activeMessaging'] = true;
      res.render('messages', locals);
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" });
    }
  });

  app.get('/auth', passport.authenticate('oidc'),
    function(req, res) {
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  app.get('/auth/login-success', passport.authenticate('oidc'),
    async function(req, res) {
      req.session.user = Object.assign(req.user);

      const email = req.session.user.email;
      const accessToken = req.session.user.access_token;
      const refreshToken = req.session.user.refresh_token;

      const record = await findUserRecord(email);

      if (record) {
        updateUserRecord(email, accessToken, refreshToken);
      } else {
        saveUserRecord(email, accessToken, refreshToken);
      }

      res.redirect('/');
    }
  );

  app.get('/auth/refresh', async (req, res, next) => {
    try {
      const extras = {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CALLBACK_URL,
        }
      }
      console.log('Refreshing with', req.session.user['refresh_token']);
      var tokenset = await client.refresh(req.session.user['refresh_token'], extras);
      req.session.user = Object.assign(req.session.user, tokenset);
      console.log('post-refresh req.session.user', req.session.user);
      await req.session.save();
      console.log('post-refresh session id', req.session.id);
      next();
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" });
      next(error);
    }
  }, (req, res, next) => {
    res.redirect('/');
  });

  app.use('/auth/iam/token/:email', basicAuth({
    users: { [BASIC_AUTH_USER]: BASIC_AUTH_PASSWORD }
  }));
  app.get('/auth/iam/token/:email', async (req, res, next) => {
    try {
      const extras = {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CALLBACK_URL,
        }
      }
      console.log('Refreshing with', req.params.email);

      const email = req.params.email;
      const record = await findUserRecord(email);

      if (!record) {
        res.send({message: 'manual login required'}).status(404);
        next();
      }

      var tokenset = await client.refresh(record.iam_refresh_token, extras);
      updateUserRecord(email, tokenset.access_token, tokenset.refresh_token);

      res.send({ access_token: tokenset.access_token }).status(200);
      next();
    } catch (error) {
      res.render('error', { error: error, header: "Error" });
      next(error);
    }
  });

  app.get('/logout', (req, res, next) => {
    req.session.destroy();
    res.redirect('/');
    next();
  });

  app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`));
}

const client = createClient();
configurePassport(client);
startApp(client);
