import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import type { API, Logger } from 'homebridge';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import {
  AuthRequiredError,
  commandResultsComplete,
  extractTrackedCommandDevices,
  NavimowApiClient,
  NavimowApiError,
  normalizeState,
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
  private readonly realtimeSubscriptions = new Set<string>();
  private apiClient?: NavimowApiClient;
  private mqttClient?: MqttClient;
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
  await this.startRealtimeUpdates();

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

    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = undefined;
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

    if (trackedDevices.length) {
      const commandResults = await this.waitForCommandResults(client, trackedDevices, command);
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

    this.syncRealtimeSubscriptions();

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
    const nextState = mergeState(this.states.get(deviceId), {
      ...state,
      rawCommandResult: this.lastCommandResult.get(deviceId) ?? state.rawCommandResult ?? null,
    });
    this.states.set(deviceId, nextState);
    this.emit('state', { state: nextState });
  }

  private async startRealtimeUpdates(): Promise<void> {
    const client = this.requireApiClient();
    const connection = await client.getMqttConnectionInfo();
    if (!connection) {
      this.emit('status', { message: 'Navimow realtime telemetry unavailable; continuing with HTTP polling only.' });
      return;
    }

    const options: IClientOptions = {
      clean: true,
      connectTimeout: 15_000,
      password: connection.password,
      reconnectPeriod: 5_000,
      username: connection.username,
    };

    if (connection.websocketHeaders) {
      options.wsOptions = {
        headers: connection.websocketHeaders,
      };
    }

    this.mqttClient = mqtt.connect(connection.brokerUrl, options);
    this.mqttClient.on('connect', () => {
      this.emit('status', { message: 'Navimow realtime telemetry connected.' });
      this.syncRealtimeSubscriptions();
    });
    this.mqttClient.on('message', (topic, payload) => {
      this.handleRealtimeMessage(topic, payload);
    });
    this.mqttClient.on('error', (error) => {
      this.log.warn(`Navimow realtime telemetry error: ${error.message}`);
    });
    this.mqttClient.on('close', () => {
      this.emit('status', { message: 'Navimow realtime telemetry disconnected; HTTP polling remains active.' });
    });
  }

  private syncRealtimeSubscriptions(): void {
    if (!this.mqttClient?.connected) {
      return;
    }

    const targetTopics = new Set<string>();
    for (const deviceId of this.devices.keys()) {
      for (const topic of buildRealtimeTopics(deviceId)) {
        targetTopics.add(topic);
      }
    }

    if (!targetTopics.size) {
      for (const topic of buildRealtimeTopics('+')) {
        targetTopics.add(topic);
      }
    }

    for (const topic of targetTopics) {
      if (this.realtimeSubscriptions.has(topic)) {
        continue;
      }
      this.mqttClient.subscribe(topic, (error?: Error | null) => {
        if (error) {
          this.log.warn(`Navimow realtime subscribe failed for ${topic}: ${error.message}`);
          return;
        }
        this.realtimeSubscriptions.add(topic);
        this.log.info(`Navimow realtime subscribed to ${topic}`);
      });
    }

    for (const topic of [...this.realtimeSubscriptions]) {
      if (targetTopics.has(topic)) {
        continue;
      }
      this.mqttClient.unsubscribe(topic, (error?: Error | null) => {
        if (error) {
          this.log.warn(`Navimow realtime unsubscribe failed for ${topic}: ${error.message}`);
          return;
        }
        this.realtimeSubscriptions.delete(topic);
      });
    }
  }

  private handleRealtimeMessage(topic: string, payload: Buffer): void {
    const parsedTopic = parseRealtimeTopic(topic);
    if (!parsedTopic) {
      return;
    }

    const payloadText = payload.toString('utf8');
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      this.log.debug(`Ignoring non-JSON Navimow realtime payload for ${topic}`);
      return;
    }

    data.device_id ??= parsedTopic.deviceId;

    if (parsedTopic.channel === 'state' || parsedTopic.channel === 'attributes') {
      const source = parsedTopic.channel === 'state' ? 'mqtt_push' : 'mqtt_attributes';
      this.storeState(parsedTopic.deviceId, normalizeState(data, source));
    }
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

function buildRealtimeTopics(deviceId: string): string[] {
  return [
    `/downlink/vehicle/${deviceId}/realtimeDate/state`,
    `/downlink/vehicle/${deviceId}/realtimeDate/event`,
    `/downlink/vehicle/${deviceId}/realtimeDate/attributes`,
  ];
}

function mergeState(previous: NavimowState | undefined, incoming: NavimowState): NavimowState {
  return {
    attributes: mergeRecord(previous?.attributes, incoming.attributes),
    battery: incoming.battery ?? previous?.battery ?? null,
    deviceId: incoming.deviceId || previous?.deviceId || '',
    error: incoming.error !== undefined ? incoming.error : (previous?.error ?? null),
    metrics: mergeRecord(previous?.metrics, incoming.metrics),
    position: incoming.position ?? previous?.position ?? null,
    rawCommandResult: incoming.rawCommandResult ?? previous?.rawCommandResult ?? null,
    signalStrength: incoming.signalStrength ?? previous?.signalStrength ?? null,
    source: incoming.source ?? previous?.source ?? null,
    state: incoming.state !== 'unknown' ? incoming.state : (previous?.state ?? incoming.state),
    timestamp: incoming.timestamp ?? previous?.timestamp ?? null,
  };
}

function mergeRecord(
  previous: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!previous && !incoming) {
    return null;
  }

  return {
    ...(previous ?? {}),
    ...(incoming ?? {}),
  };
}

function parseRealtimeTopic(topic: string): { channel: string; deviceId: string } | null {
  const parts = topic.split('/').filter(Boolean);
  if (parts.length !== 5) {
    return null;
  }

  if (parts[0] !== 'downlink' || parts[1] !== 'vehicle' || parts[3] !== 'realtimeDate') {
    return null;
  }

  return {
    channel: parts[4],
    deviceId: parts[2],
  };
}