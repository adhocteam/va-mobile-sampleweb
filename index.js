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

const secret = 'setec astronomy'
const API_URL = process.env.API_URL || 'https://staging-api.va.gov'
const CLIENT_ID = process.env.CLIENT_ID || 'VAMobile'
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = process.env.PORT || 4001;

const IAM_OAUTH_URL = process.env.OAUTH_URL || 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/authorize';
const IAM_CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/auth/login-success';
const IAM_TOKEN_URL = 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/token'
const SIS_OAUTH_URL='https://staging.va.gov/sign-in'
const SIS_CALLBACK_URL='https://va-mobile-cutter.herokuapp.com/v0/sign_in/callback' // make env var
const SIS_TOKEN_URL = 'https://staging-api.va.gov/v0/sign_in/token'
const SIS_CLIENT_ID = 'mobile_test'

function createClient(type) {
  var oauth_url = null;
  var callback_url = null;
  var token_endpoint = null;
  var client_id = null;

  switch (type) {
    case ('iam'):
      oauth_url = IAM_OAUTH_URL;
      callback_url = IAM_CALLBACK_URL;
      token_endpoint = IAM_TOKEN_URL;
      client_id = CLIENT_ID;
      break;
    case ('sis'):
      oauth_url = SIS_OAUTH_URL;
      callback_url = SIS_CALLBACK_URL;
      token_endpoint = SIS_TOKEN_URL;
      client_id = SIS_CLIENT_ID;
      break;
  }

  Issuer.defaultHttpOptions = { timeout: 5000 };
  const ssoeIssuer = new Issuer({
    issuer: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOPe',
    authorization_endpoint: oauth_url,
    token_endpoint: token_endpoint,
    jwks_uri: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/jwks/ISAMOPeFP',
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
  console.log("configuring", type)

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
        code_challenge: '1BUpxy37SoIPmKw96wbd6MDcvayOYm3ptT-zbe6L_zM',
        code_challenge_method: 'S256',
        oauth: 'true',
        client_id: SIS_CLIENT_ID
      }
      pkce = false;
      break;
  }

  typedPassport.serializeUser(function(user, done) {
    console.log("Serializing user", user)
    done(null, user);
  });

  typedPassport.deserializeUser(function(user, done) {
    console.log("Deserializing user", user)
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

  console.log('configured', type)

  return typedPassport
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    return next();
  } else {
    res.redirect('/');
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
  const sisClient = createClient('sis')
  const sisPassport = configurePassport(sisClient, 'sis');
  app.use(iamPassport.initialize());
  app.use(iamPassport.session());
  app.use(sisPassport.initialize());
  app.use(sisPassport.session());
  app.use((err, req, res, next) => {
    console.error(err.stack)
    res.status(500).send('Something broke!')
  })
  process.on('uncaughtException', err => {
    console.error('There was an uncaught error', err);
    process.exit(1); // mandatory (as per the Node.js docs)
  });

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
      console.log("IAM REQ ", req)
      console.log("IAM RES ", res)
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  app.get('/auth/sis', sisPassport.authenticate('oidc'),
    function(req, res) {
      console.log("SIS REQ ", req)
      console.log("SIS RES ", res)
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  app.get('/auth/login-success', iamPassport.authenticate('oidc'),
    function(req, res) {
      console.log("CALLBACK REQ ", req)
      console.log("CALLBACK RES ", res)
      req.session.user = Object.assign(req.user);
      res.redirect('/');
    }
  );

  app.get('/auth/sis/login-success', async function(req, res, next) {
    console.log("SIS CALLBACK REQ ", req)
    console.log("SIS CALLBACK RES ", res)
    console.log("SIS QUERY IS :", req.query)
    console.log("SIS CODE IS :", req.query.code)
    try {
      const options = {
        url: SIS_TOKEN_URL,
        headers: { 'Content-Type': 'application/json' },
        form: {
          'grant_type': 'authorization_code',
          'code_verifier': '5787d673fb784c90f0e309883241803d',
          'code': req.query.code
        }
      }
      const response = await request.post(options);
      console.log('RESPONSE', response)
      const user = { access_token: req.data.access_token, refresh_token: req.data.refresh_token }
      req.session.user = Object.assign(user);
      next();
    } catch (error) {
      console.log('ERROR', error)
      next()
    }
  }, (req, res, next) => {
    console.log('MADE IT TO NEXT')
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

  app.get('/logout', (req, res, next) => {
    req.session.destroy();
    res.redirect('/');
    next();
  });

  app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`));
}

startApp();
