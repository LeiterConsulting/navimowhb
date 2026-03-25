import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import fs from 'node:fs';
import path from 'node:path';

import { NavimowAccessory } from './accessory';
import { NavimowBridgeClient } from './bridge-client';
import {
  NAVIMOW_ACCESSORY_ROLES,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type NavimowAccessoryRole,
  type NavimowDevice,
  type NavimowPlatformConfig,
} from './settings';

export class NavimowPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly bridge: NavimowBridgeClient;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly accessories = new Map<string, NavimowAccessory>();
  private readonly authSessionPath: string;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.authSessionPath = path.join(this.api.user.storagePath(), 'navimow', 'auth-session.json');
    this.bridge = new NavimowBridgeClient(
      this.log,
      this.api,
      this.config as NavimowPlatformConfig,
    );

    this.bridge.on('status', ({ message }) => this.log.info(message));
    this.bridge.on('devices', ({ devices }) => this.syncDevices(devices));
    this.bridge.on('state', ({ state }) => {
      const accessory = this.accessories.get(state.deviceId);
      accessory?.updateState(state);
    });

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      await this.startBridge();
    });

    this.api.on(APIEvent.SHUTDOWN, async () => {
      await this.bridge.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    const deviceId = accessory.context.device?.id as string | undefined;
    if (!deviceId) {
      return;
    }

    const role = accessory.context.role as NavimowAccessoryRole | undefined;
    this.cachedAccessories.set(buildAccessoryKey(deviceId, role), accessory);
  }

  private async startBridge(): Promise<void> {
    try {
      await this.bridge.start();
      this.clearAuthSession();
      const devices = await this.bridge.listDevices();
      this.syncDevices(devices);
      for (const device of devices) {
        const state = await this.bridge.getState(device.id);
        if (!state) {
          continue;
        }
        this.accessories.get(device.id)?.updateState(state);
      }
    } catch (error) {
      this.log.error(`Failed to start Navimow platform: ${String(error)}`);
      this.log.error('Open the Navimow plugin settings page in Homebridge and complete account sign-in if tokens are missing or expired.');
    }
  }

  private clearAuthSession(): void {
    if (!fs.existsSync(this.authSessionPath)) {
      return;
    }

    fs.rmSync(this.authSessionPath, { force: true });
  }

  private syncDevices(devices: NavimowDevice[]): void {
    const seenDeviceIds = new Set<string>();
    const seenAccessoryKeys = new Set<string>();

    for (const device of devices) {
      seenDeviceIds.add(device.id);
      for (const role of NAVIMOW_ACCESSORY_ROLES) {
        const accessoryKey = buildAccessoryKey(device.id, role);
        seenAccessoryKeys.add(accessoryKey);

        const existingAccessory = this.cachedAccessories.get(accessoryKey);
        if (existingAccessory) {
          existingAccessory.context.device = device;
          existingAccessory.context.role = role;
          const navimowAccessory = this.accessories.get(accessoryKey);
          if (navimowAccessory) {
            navimowAccessory.updateDevice(device);
          } else {
            this.accessories.set(accessoryKey, new NavimowAccessory(this, existingAccessory, device, role));
          }
          this.api.updatePlatformAccessories([existingAccessory]);
          continue;
        }

        const name = buildAccessoryName(device.name, role);
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.id}:${role}`);
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.device = device;
        accessory.context.role = role;

        const navimowAccessory = new NavimowAccessory(this, accessory, device, role);
        this.cachedAccessories.set(accessoryKey, accessory);
        this.accessories.set(accessoryKey, navimowAccessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const [accessoryKey, accessory] of this.cachedAccessories.entries()) {
      if (seenAccessoryKeys.has(accessoryKey)) {
        continue;
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.delete(accessoryKey);
      this.accessories.delete(accessoryKey);
    }
  }
}

function buildAccessoryKey(deviceId: string, role?: NavimowAccessoryRole): string {
  return `${deviceId}:${role ?? 'legacy'}`;
}

function buildAccessoryName(deviceName: string, role: NavimowAccessoryRole): string {
  switch (role) {
    case 'mowing':
      return `${deviceName} Mowing`;
    case 'dock':
      return `${deviceName} Dock`;
    case 'stop':
      return `${deviceName} Stop`;
  }
}

const APIEvent = {
  DID_FINISH_LAUNCHING: 'didFinishLaunching',
  SHUTDOWN: 'shutdown',
} as const;