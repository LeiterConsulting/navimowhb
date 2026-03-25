export const PLUGIN_NAME = 'homebridge-navimow';
export const PLATFORM_NAME = 'NavimowPlatform';

export type NavimowCommand = 'start' | 'pause' | 'resume' | 'dock' | 'stop';
export type NavimowAccessoryRole = 'mowing' | 'dock' | 'stop';

export const NAVIMOW_ACCESSORY_ROLES: NavimowAccessoryRole[] = ['mowing', 'dock', 'stop'];

export interface NavimowPlatformConfig {
  platform: string;
  name?: string;
  authCallbackPort?: number;
  authCallbackHost?: string;
  authCallbackBaseUrl?: string;
  updateIntervalSeconds?: number;
  tokenStoragePath?: string;
}

export interface NavimowDevice {
  id: string;
  name: string;
  model: string;
  firmwareVersion: string;
  serialNumber: string;
  macAddress?: string | null;
  online?: boolean;
}

export interface NavimowState {
  deviceId: string;
  timestamp?: number | null;
  state: string;
  battery?: number | null;
  signalStrength?: number | null;
  position?: Record<string, number> | null;
  error?: Record<string, unknown> | null;
  metrics?: Record<string, unknown> | null;
  attributes?: Record<string, unknown> | null;
  rawCommandResult?: Record<string, unknown> | null;
  source?: string | null;
}

export interface BridgeEventMap {
  devices: { devices: NavimowDevice[] };
  state: { state: NavimowState };
  status: { message: string };
}