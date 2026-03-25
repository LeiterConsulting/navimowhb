import type { API } from 'homebridge';

import { NavimowPlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NavimowPlatform);
};