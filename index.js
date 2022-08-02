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
const API_URL = process.env.API_URL || 'https://staging-api.va.gov'
const CLIENT_ID = process.env.CLIENT_ID || 'VAMobile'
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = process.env.PORT || 4001;
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD;

const IAM_OAUTH_URL = process.env.OAUTH_URL || 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/authorize';
const IAM_CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/auth/login-success';
const IAM_TOKEN_URL = 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/token'
const SIS_OAUTH_URL='https://staging.va.gov/sign-in'
const SIS_CALLBACK_URL='https://va-mobile-cutter.herokuapp.com/v0/sign_in/callback';
const SIS_TOKEN_URL = `${API_URL}/v0/sign_in/token`;
const SIS_REFRESH_URL = `${API_URL}/v0/sign_in/refresh`
const SIS_INTROSPECT_URL = `${API_URL}/v0/sign_in/introspect`
const SIS_CLIENT_ID = 'mobile_test';
const CODE_CHALLENGE = process.env.CODE_CHALLENGE;
const CODE_VERIFIER = process.env.CODE_VERIFIER;


function createClient(type) {
  var oauth_url = null;
  var callback_url = null;
  var client_id = null;
  var issuer_token_url = {};

  switch (type) {
    case ('iam'):
      oauth_url = IAM_OAUTH_URL;
      callback_url = IAM_CALLBACK_URL;
      client_id = CLIENT_ID;
      issuer_token_url = { token_endpoint: IAM_TOKEN_URL }
      break;
    case ('sis'):
      oauth_url = SIS_OAUTH_URL;
      callback_url = SIS_CALLBACK_URL;
      client_id = SIS_CLIENT_ID;
      break;
  }

  Issuer.defaultHttpOptions = { timeout: 5000 };
  const ssoeIssuer = new Issuer({
    issuer: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOPe',
    authorization_endpoint: oauth_url,
    jwks_uri: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/jwks/ISAMOPeFP',
    ...issuer_token_url
    //Advertised in  metadata but seemingly not supported
    // userinfo_endpoint: 'https://sqa.fed.eauth.va.gov/oauthi/sps/oauth/oauth20/userinfo',
  });
  return new ssoeIssuer.Client({
    client_id: client_id,
    client_secret: CLIENT_SECRET,
    redirect_uris: [
      callback_url,
    ],
    response_types: ['code'],
  });
}

function configurePassport(client, type) {
  const typedPassport = new passport.Authenticator()

  var params = null;
  var pkce = null;

  switch (type) {
    case ('iam'):
      params = {
        scope: 'openid',
        response_mode: 'query'
      }
      pkce = true;
      break;
    case ('sis'):
      params = {
        application: 'vamobile',
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: 'S256',
        oauth: 'true',
        client_id: SIS_CLIENT_ID
      }
      pkce = false;
      break;
  }

  typedPassport.serializeUser(function(user, done) {
    done(null, user);
  });

  typedPassport.deserializeUser(function(user, done) {
    done(null, user);
  });

  typedPassport.use('oidc', new Strategy(
    {
      client,
      params: params,
      usePKCE: pkce,
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

  return typedPassport;
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect('/');
  }
}

function createDbClient() {
  const dbClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
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

function saveUserRecord(type, email, accessToken, refreshToken) {
  const timestamp = new Date().toISOString();
  const statement = `INSERT INTO tokens (email, ${type}_access_token, ${type}_refresh_token, created_at) VALUES ($1, $2, $3, $4);`;
  const values = [email, accessToken, refreshToken, timestamp];

  writeToDb(statement, values);
}

function updateUserRecord(type, email, accessToken, refreshToken) {
  const timestamp = new Date().toISOString();
  const statement = `UPDATE tokens SET ${type}_access_token = $1, ${type}_refresh_token = $2, updated_at = $3 WHERE email = $4;`;
  const values = [accessToken, refreshToken, timestamp, email];

  writeToDb(statement, values);
}

async function createOrUpdateRecord(type, email, accessToken, refreshToken) {
  const record = await findUserRecord(email);

  if (record) {
    updateUserRecord(type, email, accessToken, refreshToken);
  } else {
    saveUserRecord(type, email, accessToken, refreshToken);
  }
}

function startApp() {
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

  const iamClient = createClient('iam')
  const iamPassport = configurePassport(iamClient, 'iam');
  app.use(iamPassport.initialize());
  app.use(iamPassport.session());
  const sisClient = createClient('sis')
  const sisPassport = configurePassport(sisClient, 'sis');
  app.use(sisPassport.initialize());
  app.use(sisPassport.session());

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

  app.get('/auth/iam', iamPassport.authenticate('oidc'),
    function(req, res) {
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  app.get('/auth/sis', sisPassport.authenticate('oidc'),
    function(req, res) {
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  app.get('/auth/login-success', iamPassport.authenticate('oidc'),
    function(req, res) {
      req.session.user = Object.assign(req.user);

      const email = req.session.user.email;
      const accessToken = req.session.user.access_token;
      const refreshToken = req.session.user.refresh_token;

      createOrUpdateRecord('iam', email, accessToken, refreshToken)

      res.redirect('/');
    }
  );

  app.get('/auth/sis/login-success', async function(req, res, next) {
    try {
      const tokenOptions = {
        url: SIS_TOKEN_URL,
        headers: { 'Content-Type': 'application/json' },
        form: {
          'grant_type': 'authorization_code',
          'code_verifier': CODE_VERIFIER,
          'code': req.query.code
        }
      }
      const tokenResponse = await request.post(tokenOptions);
      const tokenOutput = JSON.parse(tokenResponse);
      const accessToken = tokenOutput.data.access_token;
      const refreshToken = tokenOutput.data.refresh_token;

      const userData = { access_token: accessToken, refresh_token: refreshToken }
      const introspectOptions = {
        url: SIS_INTROSPECT_URL,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userData.access_token}`
         }
      }
      const introspectResponse = await request(introspectOptions);
      const instrospectOutput = JSON.parse(introspectResponse);
      const email = instrospectOutput.data.attributes.email;

      userData['email'] = email;
      req.session.user = Object.assign(userData);

      createOrUpdateRecord('sis', email, accessToken, refreshToken);

      next();
    } catch (error) {
      console.log('ERROR', error);
      next();
    }
  }, (req, res, next) => {
    res.redirect('/');
  });

  app.get('/auth/refresh', async (req, res, next) => {
    try {
      const extras = {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: IAM_CALLBACK_URL,
        }
      }
      console.log('Refreshing with', req.session.user['refresh_token']);
      var tokenset = await iamClient.refresh(req.session.user['refresh_token'], extras);
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
  app.get('/auth/iam/token/:email', async (req, res) => {
    try {
      const email = req.params.email;
      const record = await findUserRecord(email);

      if (!record) {
        res.send({ message: 'manual login required' }).status(404);
        return null;
      }

      const extras = {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: IAM_CALLBACK_URL,
        }
      }
      console.log('Refreshing with', email);
      var tokenset = await iamClient.refresh(record.iam_refresh_token, extras);
      updateUserRecord('iam', email, tokenset.access_token, tokenset.refresh_token);

      res.send({ access_token: tokenset.access_token }).status(200);
    } catch (error) {
      console.log('ERROR REFRESHING IAM TOKEN', error)
      res.send({ error: error }).status(500);
    }
  });

  app.use('/auth/sis/token/:email', basicAuth({
    users: { [BASIC_AUTH_USER]: BASIC_AUTH_PASSWORD }
  }));
  app.get('/auth/sis/token/:email', async (req, res) => {
    try {
      const email = req.params.email;
      const record = await findUserRecord(email);

      if (!record) {
        res.send({ message: 'manual login required' }).status(404);
        return null;
      }

      const options = {
        url: SIS_REFRESH_URL,
        headers: {
          'Content-Type': 'application/json'
         },
         form: {
          'refresh_token': record.sis_refresh_token
         }
      }

      console.log('Refreshing with', email);

      const response = await request.post(options);
      const output = JSON.parse(response);

      updateUserRecord('sis', email, output.data.access_token, output.data.refresh_token);

      res.send({ access_token: output.data.access_token }).status(200);
    } catch (error) {
      console.log('ERROR REFRESHING SIS TOKEN', error)
      res.send({ error: error }).status(500);
    }
  });

  app.get('/logout', (req, res, next) => {
    req.session.destroy();
    res.redirect('/');
    next();
  });

  app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`));
}

startApp();
