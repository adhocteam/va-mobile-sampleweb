# va-mobile-sampleweb

This app is run on a heroku deployment managed by `patrickvinograd`. This web app was initially developed to simulate use of VA Mobile API but has evolved into a utility app used by the mobile team to fetch API tokens.

# Use

While this app has several endpoints, many are no longer in active use. The app is now primarily used for fetching API tokens via two methods:

1. Manual: Accessible via web from the root url, this process allows users to log in with test user credentials. It reveals an api token and also stores the refresh token for later use.

2. Automated: This process uses the stored refresh tokens from the manual sign-in process and will only work if the database contains a valid refresh token for the user. These requests use basic auth (go to heroku dashboard for values). The routes for this identify the user by email address and can fetch both IAM tokens:

`GET https://va-mobile-cutter.herokuapp.com/auth/iam/token/judy.morrison@id.me`

And SIS tokens:

`GET https://va-mobile-cutter.herokuapp.com/auth/sis/token/judy.morrison@id.me`

These routes are intended to make API tokens more easily accessible to developers and to enable test automation.

# Configuration

## Environment Variables

Configuration is enabled via the following environment variables:

- `API_URL` - VA Mobile API endpoint, defaults to `https://staging-api.va.gov`. Change this to a a local API runtime such as `http://localhost:3000` for local API development
- `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` - used for API endpoints that are protected by basic auth
- `CALLBACK_URL` - defaults to `http://localhost:PORT/auth/login-success
- `CLIENT_ID` - defaults to `VAMobile`. You probably don't need to change this.
- `CLIENT_SECRET` - OAuth client secret. Contact mobile app team for this value.
- `CODE_CHALLENGE` and `CODE_VERIFIER` - used in SIS token generation. Ideally, these should be generated per request, The pattern of setting up the passport client per request has proven challenging to work with, but we should work toward this goal.
- `DATABASE_URL` - the location of the heroku postgres database
- `OAUTH_URL` - OAuth authorize URL. Defaults to SSOe SQA environment endpoint.
- `PORT` - defaults to  `4001`. Change to run on a different port, but see note below about restrictions on callback URLs.
- `VERBOSE` - if set to `true`, will log additional details such as the value of the API access token

## Database

The database is used to store refresh tokens, which allows us to fetch api tokens without manually logging in every time. The database schema can be found in schema.sql. To create the table, run:

`$ heroku pg:psql DATABASE < schema.sql`

# Methods of Working on This App

## Local Development

Running this app locally is possible but there are issues with doing so both for IAM and SIS. Therefore, it is not advised for most purposes. SIS should work locally and this document will be updated later with instructions for doing so. In the meantime, it's better to [work on a branch](#push-branch-to-heroku) or using [heroku live debugging](#debugging-in-heroku)

### IAM Local Setup and Limitations

At one time, it was possible to run this app locally without issue by running the vets-api rails server locally and using the IAM callback url `http://localhost:4001/auth/login-success`. That appears to no longer be possible, probably because the IAM team removed the localhost url from their whitelist.

The IAM service maintains a whitelist of valid callback URLs. The heroku URL of this app is whitelisted, as is `vamobile://login-success`. Using the heroku callback URL will fail locally when you enter the IAM login flow, presumably due to some IAM cross-site constraint. Before running the app locally, change:
- the callback url to `vamobile://login-success`
- the client id and client secret (ask around for these values; they differ from what's used by heroku)
These values will allow you to sign in with IAM but it will stall out on the callback to `vamobile://login-success` because that is not your local node app.

If you do not change these values, the app will crash before you can sign in.

### SIS Local Setup and Limitations

The SIS service manages the callback URL dependent upon the rails environment and client_id. The SIS OAUTH client in this app is configured to call back to the staging rails app with the client_id `mobile_test`. When the staging rails app receives the callback with that client id, it is configured to GET to `https://va-mobile-cutter.herokuapp.com/auth/sis/login-success` with a code that is then used to fetch an access token.

Before running the app locally:

- set the CODE_CHALLENGE (see heroku settings for value)
- set the CODE_VERIFIER (see heroku settings for value)
- change the SIS_CALLBACK_URL to `http://localhost:3000/auth/sis/login-success`

If you do not change the default SIS_CALLBACK_URL, the app will callback to the heroku app rather than your local app. Everything will work, but everything after the callback will occur on heroku, not on your local development environment.

Local SIS sign-in is most likely possible by running a local copy of the rails server and pointing all calls from this app at it rather than at staging. The SIS team configured the callback url to point to localhost in development. But there are some difficulties in getting the two apps working correctly together. *TODO*: get this working and update this documentation.

### Run Locally

```
$ npm install
$ node index.js
```

## Push Branch to Heroku

Once you've been given access to this app on Heroku, you will need to add the heroku remote to your local copy of this repo:

`$ git remote add heroku https://git.heroku.com/va-mobile-cutter.git`

Then you will have the ability to deploy branches to heroku, like:

`$ git push heroku my-experimental-branch:main`

After your work is done, you can reset the branch by:
```
$ git checkout main
$ git pull
$ git push -f heroku main
```

## Debugging in Heroku

A VSCode debugging configuration is checked in under .vscode/launch.json that configures VSCode to attach a debugger on port 9229. It is possible to debug the app while it is running in Heroku by running the following commands from the root project directory:
```
$ heroku ps:exec
# In a separate terminal window
$ heroku ps:forward 9229
```
then using VSCode's normal debugging functionality by adding a VSCode breakpoint. When the breakpointed line is reached, VSCode should open a debugging session in its built-in terminal. If the breakpoint is never reached, it could indicate that the failure is happening within a library (like the Passport library). You should be able to use the stacktrace to determine where in the library the failure is occurring, open the file in your node modules, and set a breakpoint there.

# Debugging Issuer Changes

If this app starts crashing with ambiguous errors, it's possible the IAM team has changed the OAUTH configs. The first step in debugging this is to go to the issuer url used within this app. The URL is currently (see the issuer url used in the app):
https://sqa.fed.eauth.va.gov/oauthe/sps/oauth/oauth20/metadata/ISAMOPe

Update the issuer values–such as `authorization_endpoint`, `token_endpoint`, and `jwks_uri`–to reflect the newest values in the issuer metadata found on that page.

If the values appear to be correct or updating them doesn't fix the issue, it may be necessary to contact the IAM team. It's possible they've changed the issuer URL. The current contact for this is Damien.DeAntonio@va.gov.