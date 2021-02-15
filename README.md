# va-mobile-sampleweb
Sample web app to simulate use of VA Mobile API

# Configuration

Configuration is enabled via the following environment variables:

- `CLIENT_SECRET` - OAuth client secret. Contact mobile app team for this value.
- `API_URL` - VA Mobile API endpoint, defaults to `https://staging-api.va.gov`. 
Change this to a a local API runtime such as `http://localhost:3000` for 
local API development
- `OAUTH_URL` - OAuth authorize URL. Defaults to SSOe SQA environment endpoint.
- `CLIENT_ID` - defaults to `VAMobile`. You probably don't need to change this.
- `PORT` - defaults to  `4001`. Change to run on a different port, but see 
note below about restrictions on callback URLs.
- `CALLBACK_URL` - defaults to `http://localhost:PORT/auth/login-success
- `VERBOSE` - if set to `true`, will log additional details such as the value 
of the API access token

## Callback URLs

The app needs to listen on a specified callback URL that is pre-configured in 
the SSOe OAuth provider. The only values currently configured other than the 
custom mobile callback URL are:

- `http://localhost:4001/auth/login-success`
- The URL for a heroku deployment managed by `patrickvinograd`.

This means that you very likely want to run your app locally on the default 
port 4001.

# Running Locally

```
$ npm install
$ node index.js

```
