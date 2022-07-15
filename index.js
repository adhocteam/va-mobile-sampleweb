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
const OAUTH_URL = process.env.OAUTH_URL || 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/authorize';
const API_URL = process.env.API_URL || 'https://staging-api.va.gov'
const CLIENT_ID = process.env.CLIENT_ID || 'VAMobile'
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = process.env.PORT || 4001;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:' + PORT + '/auth/login-success';
const SIS_OAUTH_URL='https://staging.va.gov/sign-in'

function createClient(type) {
  var oauth_url = null;

  switch (type) {
    case ('iam'):
      oauth_url = OAUTH_URL
      break;
    case ('sis'):
      oauth_url = SIS_OAUTH_URL
      break;
  }

  Issuer.defaultHttpOptions = { timeout: 5000 };
  const ssoeIssuer = new Issuer({
    issuer: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOPe',
    authorization_endpoint: oauth_url,
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

function configurePassport(type, client, typePassport) {
  console.log("configuring", type)
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
        client_id: 'mobile'
      }
      pkce = false;
      break;
  }

  typePassport.serializeUser(function(user, done) {
    console.log("Serializing user", user)
    done(null, user);
  });

  typePassport.deserializeUser(function(user, done) {
    console.log("Deserializing user", user)
    done(null, user);
  });

  typePassport.use('oidc', new Strategy(
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
      console.log("Token set", tokenset)
      ({ payload } = jose.JWT.decode(tokenset.id_token, { complete: true }));
      console.log('id_token', payload);
      user = Object.assign(payload, tokenset);
      console.log('user', user);

      if (process.env.VERBOSE === 'true') {
        console.log('access_token', tokenset.access_token);
        console.log('id_token', payload);
      } else {
        console.log('user.name', user.email);
        console.log('user.icn', user.fediamMVIICN);
        console.log('access_token digest', new shajs.sha256().update(user.access_token).digest('hex'));
      }
      console.log('DONE')
      return done(null, user);
    }
  ));

  console.log('configured', type)
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
  app.use((err, req, res, next) => {
    console.error(err.stack)
    res.status(500).send('Something broke!')
  })

  const iamClient = createClient('iam')
  const iamPassport = new passport.Authenticator()
  configurePassport('iam', iamClient, iamPassport)
  iamPassport.initialize()
  iamPassport.session()

  // const sisClient = createClient('sis')
  // const sisPassport = new passport.Authenticator()
  // configurePassport('sis', sisClient, sisPassport)
  // sisPassport.initialize()
  // sisPassport.session()

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

  // app.use('/auth/iam', function(req, res, next) {
  //   configurePassport('iam');
  //   next();
  // })
  app.get('/auth/iam', iamPassport.authenticate('oidc'),
    function(req, res) {
      console.log("IAM REQ ", req)
      console.log("IAM RES ", res)
      req.session.user = Object.assign(req.session.user, req.user);
    }
  );

  // app.use('/auth/sis', function(req, res, next) {
  //   configurePassport('sis');
  //   next();
  // })
  // app.get('/auth/sis', sisPassport.authenticate('oidc'),
  //   function(req, res) {
  //     console.log("SIS REQ ", req)
  //     console.log("SIS RES ", res)
  //     req.session.user = Object.assign(req.session.user, req.user);
  //   }
  // );

  app.get('/auth/login-success', iamPassport.authenticate('oidc'),
    function(req, res) {
      req.session.user = Object.assign(req.user);
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

  app.get('/logout', (req, res, next) => {
    req.session.destroy();
    res.redirect('/');
    next();
  });

  app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`));
}

startApp();
