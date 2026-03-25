const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CLIENT_ID = 'homeassistant';
const CLIENT_SECRET = '57056e15-722e-42be-bbaa-b0cbfb208a52';
const AUTHORIZE_URL = 'https://navimow-h5-fra.willand.com/smartHome/login?channel=homeassistant';
const TOKEN_URL = 'https://navimow-fra.ninebot.com/openapi/oauth/getAccessToken';

const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  if (args[0] === 'Incoming Request:' && args[1] === '/auth/status') {
    return;
  }
  originalConsoleLog(...args);
};

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.authSession = null;

    this.onRequest('/auth/status', this.handleAuthStatus.bind(this));
    this.onRequest('/auth/start', this.handleAuthStart.bind(this));
    this.onRequest('/auth/cancel', this.handleAuthCancel.bind(this));

    this.ready();
  }

  async processRequest(request) {
    if (!this.handlers[request.path]) {
      console.error('No Registered Handler:', request.path);
      return this.sendResponse(request, { message: 'Not Found', path: request.path }, false);
    }

    try {
      if (request.path !== '/auth/status') {
        console.log('Incoming Request:', request.path);
      }
      const response = await this.handlers[request.path](request.body || {});
      return this.sendResponse(request, response, true);
    } catch (error) {
      if (error instanceof RequestError) {
        return this.sendResponse(
          request,
          { message: error.message, error: error.requestError },
          false,
        );
      }

      console.error(error);
      return this.sendResponse(request, { message: error.message }, false);
    }
  }

  async handleAuthStatus(payload = {}) {
    const config = this.normalizeConfig(payload.config);
    return this.buildAuthStatus(config);
  }

  async handleAuthStart(payload = {}) {
    const config = this.normalizeConfig(payload.config);
    const requestedCallbackPort = Number(config.authCallbackPort || 47129);
    const tokenStoragePath = this.resolveTokenStoragePath(config);

    if (this.authSession && this.authSession.status === 'waiting') {
      const samePort = this.authSession.callbackPort === requestedCallbackPort;
      const sameStorage = this.authSession.tokenStoragePath === tokenStoragePath;
      if (samePort && sameStorage) {
        return this.buildAuthStatus(config);
      }
      await this.closeAuthSession();
    } else if (this.authSession) {
      await this.closeAuthSession();
    }

    const server = http.createServer((request, response) => {
      void this.handleCallbackRequest(request, response);
    });
    let callbackPort = requestedCallbackPort;
    let usingTemporaryPort = false;

    try {
      await this.listenOnPort(server, callbackPort);
    } catch (error) {
      if (error && error.code === 'EADDRINUSE' && !config.authCallbackBaseUrl) {
        usingTemporaryPort = true;
        await this.listenOnPort(server, 0);
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new RequestError('Homebridge could not choose a temporary return port for Navimow sign-in.');
        }
        callbackPort = address.port;
      } else if (error && error.code === 'EADDRINUSE') {
        throw new RequestError(
          `Port ${requestedCallbackPort} is already in use. Close any other Navimow sign-in window or change the advanced callback port in Settings.`,
          { code: error.code },
        );
      } else {
        throw error;
      }
    }

    const state = crypto.randomBytes(18).toString('hex');
    const redirectUri = this.buildRedirectUri(config, callbackPort);
    const authorizeUrl = this.buildAuthorizeUrl(state, redirectUri);

    this.authSession = {
      authorizeUrl,
      callbackPort,
      config,
      createdAt: Date.now(),
      error: usingTemporaryPort
        ? `Port ${requestedCallbackPort} was already in use, so Homebridge is using temporary port ${callbackPort} for this sign-in.`
        : null,
      redirectUri,
      server,
      state,
      status: 'waiting',
      tokenStoragePath,
    };

    this.pushEvent('navimow-auth-state', this.buildAuthStatus(config));
    return this.buildAuthStatus(config);
  }

  async handleAuthCancel() {
    await this.closeAuthSession();
    return { ok: true };
  }

  normalizeConfig(config) {
    if (config && typeof config === 'object') {
      return config;
    }

    return {
      authCallbackPort: 47129,
      browserBaseUrl: null,
      name: 'Navimow',
      platform: 'NavimowPlatform',
    };
  }

  resolveTokenStoragePath(config) {
    if (config.tokenStoragePath) {
      return config.tokenStoragePath;
    }

    const storageRoot = this.homebridgeStoragePath || process.cwd();
    return path.join(storageRoot, 'navimow', 'tokens.json');
  }

  resolveAccessoriesPath() {
    const storageRoot = this.homebridgeStoragePath || process.cwd();
    return path.join(storageRoot, 'accessories');
  }

  listenOnPort(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  buildRedirectUri(config, portOverride) {
    if (config.authCallbackBaseUrl) {
      return `${String(config.authCallbackBaseUrl).replace(/\/$/, '')}/callback`;
    }

    if (config.browserBaseUrl) {
      const browserBaseUrl = new URL(String(config.browserBaseUrl));
      const callbackPort = Number(portOverride || config.authCallbackPort || browserBaseUrl.port || 47129);
      browserBaseUrl.port = String(callbackPort);
      browserBaseUrl.pathname = '/callback';
      browserBaseUrl.search = '';
      browserBaseUrl.hash = '';
      return browserBaseUrl.toString();
    }

    const callbackHost = config.authCallbackHost || '127.0.0.1';
    const callbackPort = Number(portOverride || config.authCallbackPort || 47129);
    return `http://${callbackHost}:${callbackPort}/callback`;
  }

  buildAuthorizeUrl(state, redirectUri) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    return url.toString();
  }

  readTokenInfo(tokenStoragePath) {
    if (!fs.existsSync(tokenStoragePath)) {
      return {
        expiresAt: null,
        hasRefreshToken: false,
        hasToken: false,
        tokenExpired: false,
      };
    }

    try {
      const token = JSON.parse(fs.readFileSync(tokenStoragePath, 'utf8'));
      const expiresAt = token.expires_at || null;
      const tokenExpired = expiresAt ? Number(expiresAt) <= Math.floor(Date.now() / 1000) : false;

      return {
        expiresAt,
        hasRefreshToken: Boolean(token.refresh_token),
        hasToken: Boolean(token.access_token),
        tokenExpired,
      };
    } catch (error) {
      return {
        error: `Saved token file is unreadable: ${error.message}`,
        expiresAt: null,
        hasRefreshToken: false,
        hasToken: false,
        tokenExpired: false,
      };
    }
  }

  readCachedStateInfo() {
    const accessoriesPath = this.resolveAccessoriesPath();
    if (!fs.existsSync(accessoriesPath)) {
      return {
        hasCachedAccessories: false,
      };
    }

    try {
      const filenames = fs.readdirSync(accessoriesPath)
        .filter((name) => name.startsWith('cachedAccessories'));
      for (const filename of filenames) {
        const filePath = path.join(accessoriesPath, filename);
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('"navimow"') || content.includes('Brutus') || content.includes('Navimow')) {
          return {
            hasCachedAccessories: true,
          };
        }
      }
    } catch (error) {
      return {
        cacheError: `Accessory cache could not be inspected: ${error.message}`,
        hasCachedAccessories: false,
      };
    }

    return {
      hasCachedAccessories: false,
    };
  }

  buildAuthStatus(config) {
    const tokenStoragePath = this.resolveTokenStoragePath(config);
    const tokenInfo = this.readTokenInfo(tokenStoragePath);
    const cachedStateInfo = this.readCachedStateInfo();
    const redirectUri = this.buildRedirectUri(config);
    const hasConfig = typeof config.hasSavedConfig === 'boolean'
      ? config.hasSavedConfig
      : Boolean(config.platform === 'NavimowPlatform');
    const hasPreviousState = Boolean(tokenInfo.hasToken || cachedStateInfo.hasCachedAccessories);

    if (this.authSession && this.authSession.tokenStoragePath === tokenStoragePath) {
      return {
        authorizeUrl: this.authSession.authorizeUrl,
        hasCachedAccessories: cachedStateInfo.hasCachedAccessories,
        expiresAt: tokenInfo.expiresAt,
        hasConfig,
        hasRefreshToken: tokenInfo.hasRefreshToken,
        hasToken: tokenInfo.hasToken,
        message: this.authSession.error
          ? `${this.authSession.error} Finish signing in with Navimow, then return to Homebridge.`
          : 'Finish signing in with Navimow, then return to Homebridge.',
        redirectUri: this.authSession.redirectUri,
        state: this.authSession.status,
        tokenExpired: tokenInfo.tokenExpired,
        tokenStoragePath,
      };
    }

    if (tokenInfo.error) {
      return {
        authorizeUrl: null,
        expiresAt: null,
        hasCachedAccessories: cachedStateInfo.hasCachedAccessories,
        hasConfig,
        hasRefreshToken: false,
        hasToken: false,
        message: tokenInfo.error,
        redirectUri,
        state: 'error',
        tokenExpired: false,
        tokenStoragePath,
      };
    }

    if (!hasConfig && hasPreviousState) {
      return {
        authorizeUrl: null,
        expiresAt: tokenInfo.expiresAt,
        hasCachedAccessories: cachedStateInfo.hasCachedAccessories,
        hasConfig,
        hasRefreshToken: tokenInfo.hasRefreshToken,
        hasToken: tokenInfo.hasToken,
        message: tokenInfo.hasToken
          ? 'A previous Navimow sign-in was found on this Homebridge server. Reconnect if you want to refresh or replace that account link.'
          : 'Saved Navimow mower details were found on this Homebridge server. Connect your account again if you want to refresh them.',
        redirectUri,
        state: 'previous_state',
        tokenExpired: tokenInfo.tokenExpired,
        tokenStoragePath,
      };
    }

    if (tokenInfo.hasToken && (!tokenInfo.tokenExpired || tokenInfo.hasRefreshToken)) {
      return {
        authorizeUrl: null,
        expiresAt: tokenInfo.expiresAt,
        hasCachedAccessories: cachedStateInfo.hasCachedAccessories,
        hasConfig,
        hasRefreshToken: tokenInfo.hasRefreshToken,
        hasToken: true,
        message: 'Your Navimow account is connected. Reconnect only if you want to switch accounts or refresh the sign-in.',
        redirectUri,
        state: 'connected',
        tokenExpired: tokenInfo.tokenExpired,
        tokenStoragePath,
      };
    }

    return {
      authorizeUrl: null,
      expiresAt: tokenInfo.expiresAt,
      hasCachedAccessories: cachedStateInfo.hasCachedAccessories,
      hasConfig,
      hasRefreshToken: tokenInfo.hasRefreshToken,
      hasToken: tokenInfo.hasToken,
      message: 'Connect your Navimow account to finish setup. Your mowers will appear in Homebridge after sign-in completes.',
      redirectUri,
      state: 'needs_login',
      tokenExpired: tokenInfo.tokenExpired,
      tokenStoragePath,
    };
  }

  async handleCallbackRequest(request, response) {
    if (!this.authSession) {
      response.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('This Navimow login session is no longer active. Start the login flow again from Homebridge.');
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (requestUrl.pathname !== '/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing code parameter.');
      return;
    }

    if (state !== this.authSession.state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid state parameter.');
      return;
    }

    try {
      this.authSession.status = 'exchanging';
      this.pushEvent('navimow-auth-state', this.buildAuthStatus(this.authSession.config));

      const token = await this.exchangeCode(code, this.authSession.redirectUri);
      fs.mkdirSync(path.dirname(this.authSession.tokenStoragePath), { recursive: true });
      fs.writeFileSync(this.authSession.tokenStoragePath, JSON.stringify(token, null, 2), 'utf8');

      this.authSession.status = 'connected';
      this.authSession.error = null;
      this.pushEvent('navimow-auth-state', this.buildAuthStatus(this.authSession.config));

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Navimow Connected</title><body style="font-family: sans-serif; padding: 2rem;"><h2>Navimow authorization completed.</h2><p>You can return to Homebridge. The token has been saved.</p></body>');
    } catch (error) {
      this.authSession.status = 'error';
      this.authSession.error = error.message;
      this.pushEvent('navimow-auth-state', this.buildAuthStatus(this.authSession.config));

      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Navimow authorization failed: ${error.message}`);
      return;
    } finally {
      if (this.authSession?.server) {
        this.authSession.server.close();
        this.authSession.server = null;
      }
    }
  }

  async exchangeCode(code, redirectUri) {
    const response = await fetch(TOKEN_URL, {
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
      method: 'POST',
    });

    const body = await response.json();
    const token = body && typeof body.data === 'object' ? body.data : body;
    const accessToken = token.access_token || token.accessToken;
    if (!response.ok || !accessToken) {
      throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
    }

    const expiresIn = token.expires_in || token.expiresIn;
    if (expiresIn != null) {
      token.expires_at = Math.floor(Date.now() / 1000) + Number(expiresIn) - 60;
    }

    return token;
  }

  async closeAuthSession() {
    if (!this.authSession) {
      return;
    }

    const { server } = this.authSession;
    this.authSession = null;

    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

(() => new PluginUiServer())();