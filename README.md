# Navimow for Home Assistant

<p align="center">
  <img src="https://fra-navimow-prod.s3.eu-central-1.amazonaws.com/img/navimowhomeassistant.png" width="600">
</p>

Monitor and control Navimow robotic mowers in Home Assistant.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=segwaynavimow&repository=NavimowHA&category=Integration)

## Features ✨

### Mower Control

Control your mower directly from Home Assistant:

* Start mowing
* Pause mowing
* Resume mowing
* Send mower to dock

### Device Monitoring

Keep track of mower status and health:

* Real-time mower state
* Battery level sensor
* Integration with Home Assistant dashboards

### Real-Time Communication

* **MQTT-based real-time communication**
* Fast state updates and reliable device synchronization

### Native Home Assistant Integration

* Native **`lawn_mower` entity**
* Fully compatible with **Home Assistant automations**
* Device and entity model aligned with HA standards

### Continuous Development

This integration is **under active development**.

**More features are being added all the time**, including additional sensors, diagnostics, and deeper Home Assistant automation support.

## Prerequisites 📋

- **Warning**: Home Assistant minimum version **2026.1.0**
- **Account**: your Navimow account can sign in to the official app (used for authorization)

## Installation 🛠️

This integration is not in the default HACS store. You must add it as a custom repository.

This integration will be installed as a custom repository in HACS:

1. HACS → Integrations → top-right menu → **Custom repositories**
2. Repository: `https://github.com/segwaynavimow/NavimowHA`
3. Category: Integration
4. Search for `Navimow` in HACS and install it
5. Restart Home Assistant
6. Settings → Devices & Services → Add Integration → search `Navimow`

## Usage 🎮

See the [Getting Started](https://github.com/segwaynavimow/NavimowHA/wiki/Getting-Started).

Once the integration is set up, you can control and monitor your Navimow mower using Home Assistant! 🎉

After setup, you should see:

- A `lawn_mower` entity (start/pause/dock/resume)
- A battery `sensor`

## Troubleshooting 🔧

If you encounter any issues with the Navimow integration, please check the Home Assistant logs for error messages. You can also try the following steps:

- Ensure that your mower is connected to your home network and accessible from Home Assistant.
- Restart Home Assistant and check if the issue persists.
- Make sure you are not blocking network access to services in China (if applicable to your environment).
- If you are using DNS filtering/ad-blocking, try disabling it temporarily.

If the problem continues, please file an issue on GitHub and include relevant log snippets:

- `https://github.com/segwaynavimow/NavimowHA/issues`

## Navimow SDK Library 📚

This integration uses `navimow-sdk` to communicate with Navimow mowers. `navimow-sdk` provides the Python API used by this integration (details will be expanded in the SDK documentation).

## Core plugin pieces to reuse for a Homebridge port 🔌

If we want to port this integration to Homebridge, the current Home Assistant plugin already gives us a clear platform-agnostic core:

### Reusable core logic

1. **Authentication and API session bootstrap**
   - `custom_components/navimow/config_flow.py`
   - `custom_components/navimow/auth.py`
   - `custom_components/navimow/__init__.py`
   - Handles OAuth2 token acquisition/refresh and creates the authenticated `MowerAPI` client.

2. **Device discovery**
   - `custom_components/navimow/__init__.py`
   - Calls `api.async_get_devices()` to discover mowers tied to the authenticated account.

3. **Real-time connectivity**
   - `custom_components/navimow/__init__.py`
   - Calls `api.async_get_mqtt_user_info()` and builds the `NavimowSDK` MQTT/WebSocket connection used for live mower updates.

4. **Device state aggregation**
   - `custom_components/navimow/coordinator.py`
   - Combines:
     - MQTT push updates
     - SDK cached state/attributes
     - HTTP fallback when MQTT data becomes stale
   - Produces a normalized runtime data shape containing `device`, `state`, `attributes`, and update metadata.

5. **Command execution**
   - `custom_components/navimow/lawn_mower.py`
   - Uses `api.async_send_command(...)` for the mower actions we would also need in Homebridge:
     - `START`
     - `PAUSE`
     - `RESUME`
     - `DOCK`

6. **Simple telemetry extraction**
   - `custom_components/navimow/sensor.py`
   - Demonstrates how battery data is read from the shared coordinator state and exposed as a platform entity.

### Home Assistant-specific wrapper layer

These parts are useful as references, but would need to be replaced by Homebridge-specific equivalents:

- Home Assistant config entry lifecycle in `custom_components/navimow/__init__.py`
- Home Assistant OAuth flow wiring in `custom_components/navimow/config_flow.py`
- Home Assistant `lawn_mower` entity implementation in `custom_components/navimow/lawn_mower.py`
- Home Assistant sensor entity implementation in `custom_components/navimow/sensor.py`

### Suggested extraction boundary

The best first step for a Homebridge port is to treat the following as the shared integration core:

- OAuth token handling
- `MowerAPI` client creation
- device discovery
- MQTT/WebSocket connection setup through `NavimowSDK`
- merged mower state model
- mower command methods

Then keep only the entity/accessory presentation layer platform-specific:

- **Home Assistant:** entities, config entry lifecycle, coordinator wiring
- **Homebridge:** accessories/services/characteristics, Homebridge auth/session wiring

In short: the reusable core is the Navimow cloud login, device discovery, MQTT state pipeline, normalized mower state, and mower command execution. The Home Assistant entities are mostly an adapter around that core.
