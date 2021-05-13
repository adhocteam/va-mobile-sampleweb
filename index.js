import express from 'express'
import { Issuer, Strategy } from 'openid-client'
import passport from 'passport'
import session from 'express-session'
import sessionStore from 'express-session-rsdb'
import request from 'request-promise-native'
import hbs from 'hbs'
import shajs from 'sha.js'
import jose from 'jose'

const secret = 'setec astronomy'
const OAUTH_URL = process.env.OAUTH_URL || 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/authorize'
const REVOKE_URL = process.env.REVOKE_URL || 'https://sqa.fed.eauth.va.gov/oauthi/sps/oauth/oauth20/revoke'
const API_URL = process.env.API_URL || 'https://staging-api.va.gov'
const CLIENT_ID = process.env.CLIENT_ID || 'VAMobile'
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = process.env.PORT || 4001
const CALLBACK_URL = process.env.CALLBACK_URL || `http://localhost:${PORT}/auth/login-success`

function createClient() {
  Issuer.defaultHttpOptions = { timeout: 5000 }
  let ssoeIssuer = new Issuer({
    issuer: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOP',
    authorization_endpoint: OAUTH_URL,
    revocation_endpoint: REVOKE_URL,
    token_endpoint: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/token',
    jwks_uri: 'https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/jwks/ISAMOP',
    //Advertised in  metadata but seemingly not supported
    // userinfo_endpoint: 'https://sqa.fed.eauth.va.gov/oauthi/sps/oauth/oauth20/userinfo',
  })
  return new ssoeIssuer.Client({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uris: [
      CALLBACK_URL,
    ],
    response_types: ['code'],
  })
}

function configurePassport(client) {
  passport.serializeUser((user, done) => {
    done(null, user)
  })

  passport.deserializeUser((user, done) => {
    done(null, user)
  })

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
      let { payload } = jose.JWT.decode(tokenset.id_token, { complete: true })
      let user = { ...payload, ...tokenset }
      if (process.env.VERBOSE === 'true') {
        console.log('access_token', tokenset.access_token)
        console.log('id_token', payload)
      } else {
        console.log('user.name', user.email)
        console.log('user.icn', user.fediamMVIICN)
        console.log('access_token digest', new shajs.sha256().update(user.access_token).digest('hex'))
      }
      return done(null, user)
    }
  ))

  return client
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    return next()
  } else {
    res.redirect('/auth')
  }
}

function startApp(client) {
  const app = express()
  app.set('view engine', 'hbs')
  app.set('view options', { layout: 'layout' })
  app.engine('handlebars', hbs.__express)
  app.use(express.static('assets'))
  app.use(session({
    store: new sessionStore(),
    secret: secret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 60 * 60000 },
  }))
  app.use(passport.initialize())
  app.use(passport.session())

  app.get('/', (req, res) => {
    console.log('session id', req.session.id)
    res.render('index', { user: req.session.user, activeIndex: true, header: "Welcome" })
  })

  app.get('/user', requireLogin, async (req, res, next) => {
    let options = {
      url: `${API_URL}/mobile/v0/user`,
      headers: { 'Authorization': `Bearer ${req.session.user.access_token}` }
    }
    try {
      let response = await request(options)
      let output = JSON.stringify(JSON.parse(response), undefined, 2)
      let locals = { userinfo: output, user: req.session.user, header: 'User Info' }
      locals.activeUser = true
      res.render('user', locals)
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" })
    }
  })
  
  app.get('/messaging', requireLogin, async (req, res, next) => {
    let options = {
      url: `${API_URL}/mobile/v0/messaging/health/folders`,
      headers: { 'Authorization': `Bearer ${req.session.user.access_token}` }
    }
    try {
      console.log('folders request', options)
      let response = await request(options)
      let raw = JSON.stringify(JSON.parse(response), undefined, 2)
      let { data } = JSON.parse(response)
      let locals = { folders: data, raw: raw, user: req.session.user, header: 'Messaging' }
      locals.activeMessaging = true
      res.render('folders', locals)
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" })
    }
  })

  app.get('/messaging/:folderId', requireLogin, async (req, res, next) => {
    debugger
    const options = {
      url: `${API_URL}/mobile/v0/messaging/health/folders/${req.params.folderId}/messages`,
      headers: { 'Authorization': `Bearer ${req.session.user.access_token}` }
    }
    try {
      console.log('folder request', options)
      let response = await request(options)
      let raw = JSON.stringify(JSON.parse(response), undefined, 2)
      let { data } = JSON.parse(response)
      let locals = { messages: data, raw: raw, user: req.session.user, header: 'Messaging' }
      locals.activeMessaging = true
      res.render('messages', locals)
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" })
    }
  })

  app.get('/auth', passport.authenticate('oidc'),
    (req, res) => {
      req.session.user = { ...req.session.user, ...req.user }
    }
  )
  app.get('/auth/login-success', passport.authenticate('oidc'),
    (req, res) => {
      req.session.user = { ...req.user }
      res.redirect('/')
    }
  )
  
  app.get('/auth/refresh', async (req, res, next) => {
    if (!req.session.user) res.redirect('/auth')
    try {
      const extras = {
        exchangeBody: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: CALLBACK_URL,
        },
      }
      console.log('Refreshing with', req.session.user.refresh_token)
      let tokenset = await client.refresh(req.session.user.refresh_token, extras)
      req.session.user = { ...req.session.user, ...tokenset }
      console.log('post-refresh req.session.user', req.session.user)
      req.session.save()
      console.log('post-refresh session id', req.session.id)
      res.render('index', { user: req.session.user, activeIndex: true, header: "Welcome" })
    } catch (error) {
      res.render('error', { error: error, user: req.session.user, header: "Error" })
    }
  })

  // TODO: Make this actually exoire the token server-side. Right now it just kills local session
  app.get('/logout', async (req, res, next) => {
    await client.revoke(req.session.user.access_token)
    req.logout()
    req.session.destroy()
    res.render('index', { user: null, activeIndex: true })
  })

  app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`))
}

const client = createClient()
configurePassport(client)
startApp(client)
