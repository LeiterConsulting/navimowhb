# Navimow for Homebridge

![Navimow icon](https://raw.githubusercontent.com/LeiterConsulting/navimowhb/main/homebridge-ui/public/navimow-icon.svg)

See and control your Segway Navimow mowers from Homebridge and HomeKit.

Navimow for Homebridge connects your mower account to Homebridge so you can view status, battery level, and send key mower commands from the Home app.

## Features

### Mower control

Control each mower from HomeKit with:

* `Mowing` switch for start, pause, and resume
* `Dock` switch for return-to-base
* `Stop` switch for immediate stop

### Mower status

View live mower details in Homebridge:

* scheduled cloud refreshes for mower status
* battery level in HomeKit
* command confirmation in the plugin UI
* richer diagnostics and mower metadata in the custom Homebridge page

### Built for simple installs

The plugin runs directly inside Homebridge:

* TypeScript Homebridge dynamic platform in `src/`
* direct Navimow cloud access from the plugin process
* local OAuth callback hosted on the Homebridge machine
* token refresh and device polling managed inside the plugin

## Requirements

* Homebridge 1.8 or newer
* Node.js version supported by Homebridge: 18, 20, 22, or 24
* A Navimow account that can sign in to the official mobile app

## Install For Development

Install Node dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Package it for installation into another Homebridge host:

```bash
npm pack
```

Prepare and validate an npm release locally:

```bash
npm publish --dry-run
```

## Project Links

* Repository: https://github.com/LeiterConsulting/navimowhb
* Issues: https://github.com/LeiterConsulting/navimowhb/issues
* Release checklist: `PUBLISHING.md`

## Homebridge Configuration

The plugin includes a Homebridge settings form and a custom setup page, so most people can complete setup entirely from the Homebridge web interface.

Example `config.json` platform entry:

```json
{
  "platform": "NavimowPlatform",
  "name": "Navimow",
  "authCallbackPort": 47129,
  "authCallbackHost": "192.168.1.71",
  "updateIntervalSeconds": 30
}
```

Configuration fields:

* `authCallbackPort`: local HTTP port used for the OAuth callback
* `authCallbackHost`: optional LAN hostname or IP used instead of `127.0.0.1`
* `authCallbackBaseUrl`: optional full callback base URL override
* `tokenStoragePath`: optional override for persisted OAuth tokens
* `updateIntervalSeconds`: cloud refresh interval for mower state and command follow-up

### Advanced sign-in and network settings

Most setups do not need any changes to the callback settings.

You may need the advanced settings only when:

* the sign-in page opens on a different device than the Homebridge server
* the browser cannot return to Homebridge after Navimow sign-in
* another service is already using the default callback port

If that happens:

* `authCallbackHost` lets you tell Navimow to return to your Homebridge server's LAN IP or hostname
* `authCallbackBaseUrl` lets you provide a full custom return URL for more complex network setups
* `authCallbackPort` lets you change the default callback port if needed

## First Login

On first launch, open the plugin settings page in Homebridge and use the built-in connect flow.

1. Open the Navimow plugin settings page in Homebridge.
2. Sign in with your Navimow account.
3. Allow the browser to redirect back to the callback URL on the Homebridge host.
4. The plugin saves your login and begins mower discovery.

If the browser cannot return to the Homebridge callback page, review the advanced sign-in settings above.

## HomeKit Mapping

Each discovered mower is exposed as:

* `Mowing` switch
* `Dock` switch
* `Stop` switch
* HomeKit battery service

Command behavior:

* turning `Mowing` on sends `start` or `resume`
* turning `Mowing` off sends `pause`
* turning `Dock` on sends `dock` and then resets the switch
* turning `Stop` on sends `stop` and then resets the switch

The custom Homebridge page also shows richer mower details than the Home app, including last command, command result, battery details, signal strength, and mower metrics when Navimow reports them.

## Repository Layout

Key paths in this repository:

* `src/`: Homebridge platform, accessories, and bridge client
* `homebridge-ui/`: custom Homebridge plugin UI
* `config.schema.json`: Homebridge form schema

## Troubleshooting

Check the Homebridge logs first. Most connection problems come from one of these conditions:

* the sign-in return address points to an address the browser cannot reach
* the saved token is missing, expired, or unreadable
* the Navimow cloud API response changed from the current plugin expectations
* the host is running a Node.js version unsupported by Homebridge

Useful log lines to capture when diagnosing issues:

* login callback result
* discovery startup messages
* command failures
* cloud refresh warnings

## Notes

If you run into a setup problem, include the Homebridge logs and the callback address shown in the plugin settings page when opening an issue.
