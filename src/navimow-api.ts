import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { NavimowCommand, NavimowDevice, NavimowState } from './settings';

const CLIENT_ID = 'homeassistant';
const CLIENT_SECRET = '57056e15-722e-42be-bbaa-b0cbfb208a52';
const API_BASE_URL = 'https://navimow-fra.ninebot.com';
const TOKEN_URL = 'https://navimow-fra.ninebot.com/openapi/oauth/getAccessToken';

const RAW_STATE_TO_CANONICAL: Record<string, string> = {
  Error: 'error',
  Offline: 'unknown',
  'Self-Checking': 'idle',
  'Self-checking': 'idle',
  error: 'error',
  inSoftwareUpdate: 'paused',
  isDocked: 'docked',
  isDocking: 'returning',
  isIdel: 'idle',
  isIdle: 'idle',
  isLifted: 'error',
  isMapping: 'mowing',
  isPaused: 'paused',
  isRunning: 'mowing',
  offline: 'unknown',
};

type TokenPayload = {
  access_token?: string;
  accessToken?: string;
  expires_at?: number;
  expiresIn?: number;
  expires_in?: number;
  refresh_token?: string;
  refreshToken?: string;
  [key: string]: unknown;
};

type NavimowApiResponse<T> = {
  code?: number;
  data?: T;
  desc?: string;
};

type DeviceListResponse = {
  payload?: {
    devices?: unknown[];
  };
};

type DeviceStatusResponse = {
  payload?: {
    devices?: unknown[];
  };
};

type CommandResponse = {
  payload?: {
    commands?: Array<Record<string, unknown>>;
    devices?: Array<Record<string, unknown>>;
  };
};

export class AuthRequiredError extends Error {
  constructor(message = 'Navimow authentication required. Open the plugin settings page and connect your account.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class NavimowApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavimowApiError';
  }
}

export class NavimowTokenStore {
  constructor(private readonly tokenStoragePath: string) {}

  hasTokenFile(): boolean {
    return fs.existsSync(this.tokenStoragePath);
  }

  async getAccessToken(): Promise<string> {
    const token = this.readToken();
    if (!token) {
      throw new AuthRequiredError();
    }

    const accessToken = this.extractAccessToken(token);
    if (accessToken && !this.isExpired(token)) {
      return accessToken;
    }

    const refreshToken = this.extractRefreshToken(token);
    if (!refreshToken) {
      throw new AuthRequiredError();
    }

    const refreshed = await this.refresh(refreshToken);
    const refreshedAccessToken = this.extractAccessToken(refreshed);
    if (!refreshedAccessToken) {
      throw new AuthRequiredError();
    }

    return refreshedAccessToken;
  }

  private readToken(): TokenPayload | null {
    if (!this.hasTokenFile()) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.tokenStoragePath, 'utf8');
      return JSON.parse(raw) as TokenPayload;
    } catch (error) {
      throw new AuthRequiredError(`Saved Navimow token file is unreadable: ${String(error)}`);
    }
  }

  private async refresh(refreshToken: string): Promise<TokenPayload> {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });

    const payload = await response.json() as TokenPayload | { data?: TokenPayload };
    const normalized = this.normalizeTokenResponse(payload, refreshToken);
    this.writeToken(normalized);
    return normalized;
  }

  private normalizeTokenResponse(
    payload: TokenPayload | { data?: TokenPayload },
    refreshTokenOverride?: string,
  ): TokenPayload {
    const token = this.unwrapTokenData(payload);
    const accessToken = this.extractAccessToken(token);
    if (!accessToken) {
      throw new AuthRequiredError(`Navimow token refresh failed: ${JSON.stringify(payload)}`);
    }

    const normalized: TokenPayload = {
      ...token,
      access_token: accessToken,
      refresh_token: this.extractRefreshToken(token) ?? refreshTokenOverride,
    };

    const expiresIn = this.extractExpiresIn(token);
    if (typeof expiresIn === 'number') {
      normalized.expires_at = Math.floor(Date.now() / 1000) + expiresIn - 60;
    }

    return normalized;
  }

  private writeToken(token: TokenPayload): void {
    fs.mkdirSync(path.dirname(this.tokenStoragePath), { recursive: true });
    fs.writeFileSync(this.tokenStoragePath, JSON.stringify(token, null, 2), 'utf8');
  }

  private unwrapTokenData(payload: TokenPayload | { data?: TokenPayload }): TokenPayload {
    if ('data' in payload && payload.data && typeof payload.data === 'object') {
      return payload.data as TokenPayload;
    }
    return payload;
  }

  private extractAccessToken(token: TokenPayload): string | null {
    const accessToken = token.access_token ?? token.accessToken;
    return typeof accessToken === 'string' && accessToken.length > 0 ? accessToken : null;
  }

  private extractRefreshToken(token: TokenPayload): string | null {
    const refreshToken = token.refresh_token ?? token.refreshToken;
    return typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null;
  }

  private extractExpiresIn(token: TokenPayload): number | null {
    const raw = token.expires_in ?? token.expiresIn;
    const expiresIn = Number(raw);
    return Number.isFinite(expiresIn) ? expiresIn : null;
  }

  private isExpired(token: TokenPayload): boolean {
    const expiresAt = Number(token.expires_at);
    if (!Number.isFinite(expiresAt)) {
      return false;
    }
    return expiresAt <= Math.floor(Date.now() / 1000);
  }
}

export class NavimowApiClient {
  constructor(private readonly tokenStore: NavimowTokenStore) {}

  async getDevices(): Promise<NavimowDevice[]> {
    const response = await this.request<DeviceListResponse>('GET', '/openapi/smarthome/authList');
    const devices = response.data?.payload?.devices ?? [];
    return devices
      .filter((device): device is Record<string, unknown> => typeof device === 'object' && device !== null)
      .map((device) => normalizeDevice(device));
  }

  async getDeviceStates(deviceIds: string[], source: string): Promise<Map<string, NavimowState>> {
    if (!deviceIds.length) {
      return new Map();
    }

    const response = await this.request<DeviceStatusResponse>('POST', '/openapi/smarthome/getVehicleStatus', {
      devices: deviceIds.map((deviceId) => ({ id: deviceId })),
    });

    const result = new Map<string, NavimowState>();
    for (const status of response.data?.payload?.devices ?? []) {
      if (!status || typeof status !== 'object') {
        continue;
      }
      const normalized = normalizeState(status as Record<string, unknown>, source);
      result.set(normalized.deviceId, normalized);
    }
    return result;
  }

  async sendCommand(deviceId: string, command: NavimowCommand): Promise<CommandResponse> {
    const execution = mapCommand(command);
    const response = await this.request<CommandResponse>('POST', '/openapi/smarthome/sendCommands', {
      commands: [
        {
          devices: [{ id: deviceId }],
          execution,
        },
      ],
    });

    const results = response.data?.payload?.commands ?? [];
    for (const result of results) {
      if (result.status !== 'ERROR') {
        continue;
      }

      const errorCode = String(result.errorCode ?? 'COMMAND_FAILED');
      if (errorCode === 'alreadyInState') {
        continue;
      }
      throw new NavimowApiError(`Navimow command failed: ${errorCode}`);
    }

    return response.data ?? {};
  }

  async queryCommandResults(devices: Array<{ id: string; cmdNum: string }>): Promise<Array<Record<string, unknown>>> {
    if (!devices.length) {
      return [];
    }

    const response = await this.request<CommandResponse>('POST', '/openapi/smarthome/responseCommands', {
      devices,
    });

    return (response.data?.payload?.devices ?? [])
      .filter((device): device is Record<string, unknown> => typeof device === 'object' && device !== null);
  }

  private async request<T>(method: 'GET' | 'POST', endpoint: string, body?: Record<string, unknown>): Promise<NavimowApiResponse<T>> {
    const accessToken = await this.tokenStore.getAccessToken();
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        requestId: crypto.randomUUID(),
      },
      method,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new NavimowApiError(`Navimow API request failed: HTTP ${response.status} ${errorText}`);
    }

    const payload = await response.json() as NavimowApiResponse<T>;
    if (payload.code !== 1) {
      throw new NavimowApiError(`Navimow API request failed: ${payload.desc ?? 'Unknown error'}`);
    }

    return payload;
  }
}

export function extractTrackedCommandDevices(
  commandResponse: CommandResponse,
  fallbackDeviceId: string,
): Array<{ id: string; cmdNum: string }> {
  const trackedDevices: Array<{ id: string; cmdNum: string }> = [];
  for (const command of commandResponse.payload?.commands ?? []) {
    const devices = Array.isArray(command.devices) ? command.devices : [];
    for (const trackedDevice of devices) {
      if (!trackedDevice || typeof trackedDevice !== 'object') {
        continue;
      }
      const cmdNum = trackedDevice.cmdNum ?? trackedDevice.cmd_num;
      if (typeof cmdNum !== 'string' && typeof cmdNum !== 'number') {
        continue;
      }
      trackedDevices.push({
        cmdNum: String(cmdNum),
        id: String(trackedDevice.id ?? fallbackDeviceId),
      });
    }
  }
  return trackedDevices;
}

export function commandResultsComplete(results: Array<Record<string, unknown>>): boolean {
  if (!results.length) {
    return false;
  }

  for (const result of results) {
    const status = String(result.status ?? '').trim().toLowerCase();
    if (status === 'error' || status === 'failed') {
      const errorCode = String(result.errorCode ?? result.code ?? 'COMMAND_FAILED');
      throw new NavimowApiError(`Navimow command failed: ${errorCode}`);
    }

    if (['', 'accepted', 'in_progress', 'inprogress', 'pending', 'processing', 'queued', 'running'].includes(status)) {
      return false;
    }
  }

  return true;
}

function mapCommand(command: NavimowCommand): { command: string; params?: Record<string, unknown> } {
  switch (command) {
    case 'start':
      return { command: 'action.devices.commands.StartStop', params: { on: true } };
    case 'stop':
      return { command: 'action.devices.commands.StartStop', params: { on: false } };
    case 'pause':
      return { command: 'action.devices.commands.PauseUnpause', params: { on: false } };
    case 'resume':
      return { command: 'action.devices.commands.PauseUnpause', params: { on: true } };
    case 'dock':
      return { command: 'action.devices.commands.Dock' };
  }
}

function normalizeDevice(device: Record<string, unknown>): NavimowDevice {
  return {
    firmwareVersion: stringValue(device.firmwareVersion) ?? stringValue(device.firmware_version) ?? '',
    id: stringValue(device.id) ?? '',
    macAddress: stringValue(device.macAddress) ?? stringValue(device.mac_address),
    model: stringValue(device.model) ?? '',
    name: stringValue(device.name) ?? '',
    online: booleanValue(device.online),
    serialNumber: stringValue(device.serialNumber) ?? stringValue(device.serial_number) ?? stringValue(device.id) ?? '',
  };
}

function normalizeState(status: Record<string, unknown>, source: string): NavimowState {
  const rawState = stringValue(status.state) ?? stringValue(status.status) ?? stringValue(status.vehicleState);
  const normalizedState = rawState ? (RAW_STATE_TO_CANONICAL[rawState] ?? rawState) : 'unknown';
  const errorCode = stringValue(status.error_code) ?? stringValue(status.errorCode);
  const errorMessage = stringValue(status.error_message) ?? stringValue(status.errorMessage);
  const metrics: Record<string, unknown> = {};

  const mowingTime = numberValue(status.mowing_time) ?? numberValue(status.mowingTime);
  if (mowingTime !== null) {
    metrics.mowing_time = mowingTime;
  }

  const totalMowingTime = numberValue(status.total_mowing_time) ?? numberValue(status.totalMowingTime);
  if (totalMowingTime !== null) {
    metrics.total_mowing_time = totalMowingTime;
  }

  if (rawState && rawState !== normalizedState) {
    metrics.raw_state = rawState;
  }

  const extra = objectValue(status.extra);
  if (extra) {
    metrics.extra = extra;
  }

  return {
    attributes: null,
    battery: extractBatteryValue(status),
    deviceId: stringValue(status.device_id) ?? stringValue(status.id) ?? '',
    error: errorCode && errorCode !== 'none'
      ? {
          code: errorCode,
          message: errorMessage,
        }
      : null,
    metrics: Object.keys(metrics).length ? metrics : null,
    position: objectValue(status.position) as Record<string, number> | null,
    rawCommandResult: null,
    signalStrength: numberValue(status.signal_strength) ?? numberValue(status.signalStrength),
    source,
    state: normalizedState,
    timestamp: numberValue(status.timestamp),
  };
}

function extractBatteryValue(data: Record<string, unknown>): number | null {
  const direct = numberValue(data.battery) ?? numberValue(data.batteryLevel) ?? numberValue(data.capacityRemaining);
  if (direct !== null) {
    return normalizeBatteryValue(direct);
  }

  const descriptive = data.descriptiveCapacityRemaining;
  if (typeof descriptive === 'string') {
    const match = descriptive.match(/\d+/);
    if (match) {
      return normalizeBatteryValue(Number(match[0]));
    }
  }

  return null;
}

function normalizeBatteryValue(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}