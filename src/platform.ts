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
import { PLATFORM_NAME, PLUGIN_NAME, type NavimowDevice, type NavimowPlatformConfig } from './settings';

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

    this.cachedAccessories.set(deviceId, accessory);
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

    for (const device of devices) {
      seenDeviceIds.add(device.id);
      const existingAccessory = this.cachedAccessories.get(device.id);
      if (existingAccessory) {
        existingAccessory.context.device = device;
        existingAccessory.displayName = device.name;
        const navimowAccessory = this.accessories.get(device.id);
        if (navimowAccessory) {
          navimowAccessory.updateDevice(device);
        } else {
          this.accessories.set(device.id, new NavimowAccessory(this, existingAccessory, device));
        }
        this.api.updatePlatformAccessories([existingAccessory]);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.id}`);
      const accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;

      const navimowAccessory = new NavimowAccessory(this, accessory, device);
      this.cachedAccessories.set(device.id, accessory);
      this.accessories.set(device.id, navimowAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    for (const [deviceId, accessory] of this.cachedAccessories.entries()) {
      if (seenDeviceIds.has(deviceId)) {
        continue;
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.delete(deviceId);
      this.accessories.delete(deviceId);
    }
  }
}

const APIEvent = {
  DID_FINISH_LAUNCHING: 'didFinishLaunching',
  SHUTDOWN: 'shutdown',
} as const;