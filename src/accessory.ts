import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { NavimowPlatform } from './platform';
import type { NavimowAccessoryRole, NavimowDevice, NavimowState } from './settings';

const ACTIVE_STATES = new Set(['mowing', 'returning']);
const CHARGING_STATES = new Set(['charging']);
const DOCKED_STATES = new Set(['docked', 'charging']);
const PAUSED_STATES = new Set(['paused']);

export class NavimowAccessory {
  private readonly informationService: Service;
  private readonly switchService: Service;
  private readonly batteryService: Service | null;
  private currentState: NavimowState | null = null;
  private actionSwitchArmed = false;

  constructor(
    private readonly platform: NavimowPlatform,
    private readonly accessory: PlatformAccessory,
    private device: NavimowDevice,
    private readonly role: NavimowAccessoryRole,
  ) {
    const { Service, Characteristic } = this.platform;
    const accessoryName = buildAccessoryName(device.name, role);

    this.accessory.category = this.platform.api.hap.Categories.SWITCH;
    this.accessory.displayName = accessoryName;
    this.accessory.context.device = device;
    this.accessory.context.role = role;

    this.informationService =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);

    this.switchService =
      this.accessory.getServiceById(Service.Switch, role) ??
      this.accessory.addService(Service.Switch, accessoryName, role);

    this.batteryService = role === 'mowing'
      ? (this.accessory.getService(Service.Battery) ?? this.accessory.addService(Service.Battery))
      : null;

    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Navimow')
      .setCharacteristic(Characteristic.Model, device.model || 'Unknown')
      .setCharacteristic(Characteristic.SerialNumber, device.serialNumber || device.id)
      .setCharacteristic(
        Characteristic.FirmwareRevision,
        device.firmwareVersion || 'Unknown',
      );

    setServiceLabel(this.switchService, Characteristic, accessoryName);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleSwitchGet.bind(this))
      .onSet(this.handleSwitchSet.bind(this));

    this.updateContext();
    this.refreshReachability();
    this.refreshBatteryService();
  }

  updateDevice(device: NavimowDevice): void {
    this.device = device;
    const accessoryName = buildAccessoryName(device.name, this.role);
    this.accessory.displayName = accessoryName;
    this.accessory.context.device = device;
    setServiceLabel(this.switchService, this.platform.Characteristic, accessoryName);
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

  private handleSwitchGet(): CharacteristicValue {
    if (this.role === 'mowing') {
      return this.isActivelyMowing();
    }

    return this.actionSwitchArmed;
  }

  private async handleSwitchSet(value: CharacteristicValue): Promise<void> {
    if (this.role === 'mowing') {
      await this.handleMowingSet(value);
      return;
    }

    await this.handleMomentarySwitchSet(value);
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
    const onValue = this.role === 'mowing' ? this.isActivelyMowing() : this.actionSwitchArmed;
    this.switchService.updateCharacteristic(this.platform.Characteristic.On, onValue);
  }

  private refreshBatteryService(): void {
    if (!this.batteryService) {
      return;
    }

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
    const attributes = (this.currentState?.attributes ?? {}) as Record<string, unknown>;
    const error = this.currentState?.error;
    const metrics = this.currentState?.metrics;

    this.accessory.context.navimow = {
      attributes: Object.keys(attributes).length ? attributes : (previous.attributes ?? null),
      battery: this.getBatteryLevel(previous),
      deviceName: this.device.name,
      deviceId: this.device.id,
      errorCode: typeof error?.code === 'string' ? error.code : null,
      errorMessage: typeof error?.message === 'string' ? error.message : null,
      firmwareVersion: this.getDeviceString([
        this.device.firmwareVersion,
        getStringAtPath(attributes, ['firmwareVersion']),
        getStringAtPath(attributes, ['firmware_version']),
        getStringAtPath(attributes, ['firmware', 'version']),
        getStringAtPath(attributes, ['deviceInfo', 'firmwareVersion']),
        previous.firmwareVersion,
      ]),
      hasError: this.currentState?.error != null || this.currentState?.state === 'error',
      isActive: this.isActivelyMowing(),
      isCharging: this.isCharging(),
      isDocked: this.isDocked(),
      isPaused: this.isPaused(),
      lastSource: this.currentState?.source ?? previous.lastSource ?? null,
      lastUpdatedAt: this.currentState?.timestamp ?? previous.lastUpdatedAt ?? null,
      macAddress: this.getDeviceString([
        this.device.macAddress,
        getStringAtPath(attributes, ['macAddress']),
        getStringAtPath(attributes, ['mac_address']),
        getStringAtPath(attributes, ['deviceInfo', 'macAddress']),
        previous.macAddress,
      ]),
      metrics: metrics ?? previous.metrics ?? null,
      model: this.getDeviceString([
        this.device.model,
        getStringAtPath(attributes, ['model']),
        getStringAtPath(attributes, ['deviceModel']),
        getStringAtPath(attributes, ['deviceInfo', 'model']),
        previous.model,
      ]),
      online: this.currentState ? true : (this.device.online ?? null),
      position: this.currentState?.position ?? previous.position ?? null,
      rawCommandResult:
        this.currentState?.rawCommandResult ?? previous.rawCommandResult ?? null,
      serialNumber: this.getDeviceString([
        this.device.serialNumber,
        getStringAtPath(attributes, ['serialNumber']),
        getStringAtPath(attributes, ['serial_number']),
        getStringAtPath(attributes, ['deviceInfo', 'serialNumber']),
        this.device.id,
        previous.serialNumber,
      ]) ?? this.device.id,
      signalStrength: this.currentState?.signalStrength ?? previous.signalStrength ?? null,
      state: this.currentState?.state ?? null,
    };
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

  private async handleMomentarySwitchSet(value: CharacteristicValue): Promise<void> {
    if (!value) {
      this.actionSwitchArmed = false;
      return;
    }

    this.actionSwitchArmed = true;
    this.switchService.updateCharacteristic(this.platform.Characteristic.On, true);

    try {
      const command = this.role === 'dock' ? 'dock' : 'stop';
      await this.platform.bridge.sendCommand(this.device.id, command);
    } finally {
      setTimeout(() => {
        this.actionSwitchArmed = false;
        this.switchService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 1000);
    }
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

  private getDeviceString(candidates: Array<unknown>): string | null {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  private persistAccessoryContext(): void {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }
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

function setServiceLabel(
  service: Service,
  characteristic: NavimowPlatform['Characteristic'],
  label: string,
): void {
  service.setCharacteristic(characteristic.Name, label);
  if ('ConfiguredName' in characteristic) {
    service.setCharacteristic(characteristic.ConfiguredName, label);
  }
}

function getStringAtPath(record: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' && current.length > 0 ? current : null;
}