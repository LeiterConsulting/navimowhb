# Navimow for Home Assistant

Monitor and control Navimow robotic mowers in Home Assistant.

## Features

- **Mower control**: Start, pause, resume mowing; send mower to dock
- **Device monitoring**: Real-time state, battery level sensor, dashboards
- **Real-time communication**: MQTT-based, fast state updates
- **Native integration**: `lawn_mower` entity, full automation support

## Prerequisites

- Home Assistant **2026.1.0** or newer
- Navimow account that can sign in to the official app (used for authorization)

## Installation

1. HACS → Integrations → menu → **Custom repositories**
2. Add: `https://github.com/segwaynavimow/NavimowHA`, Category: **Integration**
3. Search **Navimow** in HACS and install
4. Restart Home Assistant
5. Settings → Devices & Services → Add Integration → search **Navimow**

## Documentation

Full documentation and troubleshooting: [README](https://github.com/segwaynavimow/NavimowHA) · [Getting Started](https://github.com/segwaynavimow/NavimowHA/wiki/Getting-Started) · [Issues](https://github.com/segwaynavimow/NavimowHA/issues)

---

*This integration is under active development. More features are being added over time.*
