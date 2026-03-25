import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import type { API, Logger } from 'homebridge';

import {
  AuthRequiredError,
  commandResultsComplete,
  extractTrackedCommandDevices,
  NavimowApiClient,
  NavimowApiError,
  NavimowTokenStore,
} from './navimow-api';
import type {
  BridgeEventMap,
  NavimowCommand,
  NavimowDevice,
  NavimowPlatformConfig,
  NavimowState,
} from './settings';

export class NavimowBridgeClient extends EventEmitter {
  private readonly devices = new Map<string, NavimowDevice>();
  private readonly states = new Map<string, NavimowState>();
  private readonly lastCommandResult = new Map<string, Record<string, unknown> | null>();
  private apiClient?: NavimowApiClient;
  private pollTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<void>;
  private started = false;

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly config: NavimowPlatformConfig,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const tokenStoragePath = this.resolveTokenStoragePath();
    const tokenStore = new NavimowTokenStore(tokenStoragePath);
    if (!tokenStore.hasTokenFile()) {
      throw new AuthRequiredError();
    }

    this.apiClient = new NavimowApiClient(tokenStore);
    await this.refreshAll('http_bootstrap');

    const intervalMs = Math.max(this.config.updateIntervalSeconds ?? 30, 5) * 1000;
    this.pollTimer = setInterval(() => {
      void this.refreshAll('http_poll').catch((error: unknown) => {
        this.log.warn(`Navimow refresh failed: ${String(error)}`);
      });
    }, intervalMs);

    this.started = true;
    this.emit('status', { message: `Connected Navimow bridge for ${this.devices.size} device(s)` });
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.started = false;
  }

  async listDevices(): Promise<NavimowDevice[]> {
    return [...this.devices.values()];
  }

  async sendCommand(deviceId: string, command: NavimowCommand): Promise<void> {
    const client = this.requireApiClient();
    const commandResponse = await client.sendCommand(deviceId, command);
    const trackedDevices = extractTrackedCommandDevices(commandResponse, deviceId);
    let commandResults: Array<Record<string, unknown>> = [];

    if (trackedDevices.length) {
      commandResults = await this.waitForCommandResults(client, trackedDevices, command);
      const deviceResult = commandResults.find((result) => String(result.id ?? '') === deviceId) ?? commandResults[0] ?? null;
      this.lastCommandResult.set(deviceId, deviceResult ? { ...deviceResult, command } : null);
    } else {
      this.lastCommandResult.set(deviceId, { command, status: 'accepted' });
    }

    await this.refreshDevice(deviceId, `http_command_${command}`);
  }

  async getState(deviceId: string): Promise<NavimowState | null> {
    return this.states.get(deviceId) ?? null;
  }

  override on<T extends keyof BridgeEventMap>(
    eventName: T,
    listener: (payload: BridgeEventMap[T]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  private resolveTokenStoragePath(): string {
    if (this.config.tokenStoragePath) {
      return this.config.tokenStoragePath;
    }

    const pluginStorage = path.join(this.api.user.storagePath(), 'navimow');
    fs.mkdirSync(pluginStorage, { recursive: true });
    return path.join(pluginStorage, 'tokens.json');
  }

  private async refreshAll(source: string): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshAll(source).finally(() => {
      this.refreshPromise = undefined;
    });

    return this.refreshPromise;
  }

  private async doRefreshAll(source: string): Promise<void> {
    const client = this.requireApiClient();
    const devices = await client.getDevices();
    const seenDeviceIds = new Set(devices.map((device) => device.id));

    for (const device of devices) {
      this.devices.set(device.id, device);
    }

    for (const deviceId of [...this.devices.keys()]) {
      if (seenDeviceIds.has(deviceId)) {
        continue;
      }
      this.devices.delete(deviceId);
      this.states.delete(deviceId);
      this.lastCommandResult.delete(deviceId);
    }

    this.emit('devices', { devices: [...this.devices.values()] });

    const states = await client.getDeviceStates(devices.map((device) => device.id), source);
    for (const [deviceId, state] of states) {
      this.storeState(deviceId, state);
    }
  }

  private async refreshDevice(deviceId: string, source: string): Promise<void> {
    const client = this.requireApiClient();
    const states = await client.getDeviceStates([deviceId], source);
    const state = states.get(deviceId);
    if (!state) {
      return;
    }
    this.storeState(deviceId, state);
  }

  private storeState(deviceId: string, state: NavimowState): void {
    const nextState: NavimowState = {
      ...state,
      rawCommandResult: this.lastCommandResult.get(deviceId) ?? state.rawCommandResult ?? null,
    };
    this.states.set(deviceId, nextState);
    this.emit('state', { state: nextState });
  }

  private async waitForCommandResults(
    client: NavimowApiClient,
    devices: Array<{ id: string; cmdNum: string }>,
    command: NavimowCommand,
  ): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + 20_000;
    let lastResults: Array<Record<string, unknown>> = [];

    while (Date.now() < deadline) {
      const results = await client.queryCommandResults(devices);
      lastResults = results;
      if (commandResultsComplete(results)) {
        this.emit('status', { message: `Navimow command '${command}' confirmed for ${results.length} device(s)` });
        return results;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    this.emit('status', { message: `Navimow command '${command}' still pending after 20s` });
    return lastResults;
  }

  private requireApiClient(): NavimowApiClient {
    if (!this.apiClient) {
      throw new NavimowApiError('Navimow bridge is not running');
    }
    return this.apiClient;
  }
}