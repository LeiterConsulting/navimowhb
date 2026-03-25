import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { NavimowPlatform } from './platform';
import type { NavimowDevice, NavimowState } from './settings';

const ACTIVE_STATES = new Set(['mowing', 'returning']);
const CHARGING_STATES = new Set(['charging']);
const DOCKED_STATES = new Set(['docked', 'charging']);
const PAUSED_STATES = new Set(['paused']);

export class NavimowAccessory {
  private readonly informationService: Service;
  private readonly mowerService: Service;
  private readonly dockService: Service;
  private readonly stopService: Service;
  private readonly batteryService: Service;
  private currentState: NavimowState | null = null;
  private dockSwitchArmed = false;
  private stopSwitchArmed = false;

  constructor(
    private readonly platform: NavimowPlatform,
    private readonly accessory: PlatformAccessory,
    private device: NavimowDevice,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.category = this.platform.api.hap.Categories.SWITCH;

    this.informationService =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);

    this.mowerService =
      this.accessory.getServiceById(Service.Switch, 'mowing') ??
      this.accessory.addService(Service.Switch, 'Mowing', 'mowing');

    this.dockService =
      this.accessory.getServiceById(Service.Switch, 'dock') ??
      this.accessory.addService(Service.Switch, 'Dock', 'dock');

    this.stopService =
      this.accessory.getServiceById(Service.Switch, 'stop') ??
      this.accessory.addService(Service.Switch, 'Stop', 'stop');

    this.batteryService =
      this.accessory.getService(Service.Battery) ??
      this.accessory.addService(Service.Battery);

    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Navimow')
      .setCharacteristic(Characteristic.Model, device.model || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, device.serialNumber || device.id)
      .setCharacteristic(
        Characteristic.FirmwareRevision,
        device.firmwareVersion || 'Unknown',
      );

    this.mowerService
      .setCharacteristic(Characteristic.Name, `${device.name} Mowing`)
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleMowingGet.bind(this))
      .onSet(this.handleMowingSet.bind(this));

    this.dockService
      .setCharacteristic(Characteristic.Name, `${device.name} Dock`)
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleDockGet.bind(this))
      .onSet(this.handleDockSet.bind(this));

    this.stopService
      .setCharacteristic(Characteristic.Name, `${device.name} Stop`)
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleStopGet.bind(this))
      .onSet(this.handleStopSet.bind(this));

    this.updateContext();
    this.refreshReachability();
    this.refreshBatteryService();
  }

  updateDevice(device: NavimowDevice): void {
    this.device = device;
    this.accessory.displayName = device.name;
    this.accessory.context.device = device;
    this.updateContext();
    this.refreshReachability();
    this.persistAccessoryContext();
  }

  updateState(state: NavimowState): void {
    this.currentState = state;
    this.updateContext();
    this.refreshReachability();
    this.refreshBatteryService();
    this.persistAccessoryContext();
  }

  private handleMowingGet(): CharacteristicValue {
    return this.isActivelyMowing();
  }

  private async handleMowingSet(value: CharacteristicValue): Promise<void> {
    const nextValue = Boolean(value);
    const currentState = this.currentState?.state ?? 'unknown';

    if (nextValue) {
      const command = currentState === 'paused' ? 'resume' : 'start';
      await this.platform.bridge.sendCommand(this.device.id, command);
      return;
    }

    await this.platform.bridge.sendCommand(this.device.id, 'pause');
  }

  private handleStopGet(): CharacteristicValue {
    return this.stopSwitchArmed;
  }

  private async handleStopSet(value: CharacteristicValue): Promise<void> {
    if (!value) {
      this.stopSwitchArmed = false;
      return;
    }

    this.stopSwitchArmed = true;
    this.stopService.updateCharacteristic(this.platform.Characteristic.On, true);

    try {
      await this.platform.bridge.sendCommand(this.device.id, 'stop');
    } finally {
      setTimeout(() => {
        this.stopSwitchArmed = false;
        this.stopService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 1000);
    }
  }

  private handleDockGet(): CharacteristicValue {
    return this.dockSwitchArmed;
  }

  private async handleDockSet(value: CharacteristicValue): Promise<void> {
    if (!value) {
      this.dockSwitchArmed = false;
      return;
    }

    this.dockSwitchArmed = true;
    this.dockService.updateCharacteristic(this.platform.Characteristic.On, true);

    try {
      await this.platform.bridge.sendCommand(this.device.id, 'dock');
    } finally {
      setTimeout(() => {
        this.dockSwitchArmed = false;
        this.dockService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 1000);
    }
  }

  private isActivelyMowing(): boolean {
    const state = this.currentState?.state;
    if (!state) {
      return false;
    }

    return ACTIVE_STATES.has(state);
  }

  private isDocked(): boolean {
    const state = this.currentState?.state;
    return state ? DOCKED_STATES.has(state) : false;
  }

  private isCharging(): boolean {
    const state = this.currentState?.state;
    return state ? CHARGING_STATES.has(state) : false;
  }

  private isPaused(): boolean {
    const state = this.currentState?.state;
    return state ? PAUSED_STATES.has(state) : false;
  }

  private refreshReachability(): void {
    this.mowerService.updateCharacteristic(this.platform.Characteristic.On, this.isActivelyMowing());
    this.stopService.updateCharacteristic(this.platform.Characteristic.On, this.stopSwitchArmed);
    this.dockService.updateCharacteristic(this.platform.Characteristic.On, this.dockSwitchArmed);
  }

  private refreshBatteryService(): void {
    const { Characteristic } = this.platform;
    const batteryLevel = this.getBatteryLevel();
    const charging = this.currentState?.state === 'charging'
      ? Characteristic.ChargingState.CHARGING
      : Characteristic.ChargingState.NOT_CHARGING;

    if (batteryLevel !== null) {
      const lowBattery = batteryLevel > 20
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, batteryLevel);
      this.batteryService.updateCharacteristic(Characteristic.StatusLowBattery, lowBattery);
    } else {
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
    this.batteryService.updateCharacteristic(Characteristic.ChargingState, charging);
  }

  private updateContext(): void {
    const previous = (this.accessory.context.navimow ?? {}) as Record<string, unknown>;
    const error = this.currentState?.error;
    const metrics = this.currentState?.metrics;

    this.accessory.context.navimow = {
      battery: this.getBatteryLevel(previous),
      deviceId: this.device.id,
      errorCode: typeof error?.code === 'string' ? error.code : null,
      errorMessage: typeof error?.message === 'string' ? error.message : null,
      firmwareVersion: this.device.firmwareVersion || null,
      hasError: this.currentState?.error != null || this.currentState?.state === 'error',
      isActive: this.isActivelyMowing(),
      isCharging: this.isCharging(),
      isDocked: this.isDocked(),
      isPaused: this.isPaused(),
      lastSource: this.currentState?.source ?? previous.lastSource ?? null,
      lastUpdatedAt: this.currentState?.timestamp ?? previous.lastUpdatedAt ?? null,
      macAddress: this.device.macAddress ?? null,
      metrics: metrics ?? previous.metrics ?? null,
      model: this.device.model || null,
      online: this.currentState ? true : (this.device.online ?? null),
      position: this.currentState?.position ?? previous.position ?? null,
      rawCommandResult:
        this.currentState?.rawCommandResult ?? previous.rawCommandResult ?? null,
      serialNumber: this.device.serialNumber || this.device.id,
      signalStrength: this.currentState?.signalStrength ?? previous.signalStrength ?? null,
      state: this.currentState?.state ?? null,
    };
  }

  private getBatteryLevel(previous = (this.accessory.context.navimow ?? {}) as Record<string, unknown>): number | null {
    const candidates = [this.currentState?.battery, previous.battery];
    for (const candidate of candidates) {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        continue;
      }
      return Math.max(0, Math.min(100, Math.round(candidate)));
    }
    return null;
  }

  private persistAccessoryContext(): void {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
}