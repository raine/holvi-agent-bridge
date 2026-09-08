import type { StaticBridgeConfig } from "./background-types.js";
import { CommandService } from "./commands.js";
import { HolviApi } from "./holvi-api.js";
import { NativeBridge } from "./native-bridge.js";
import {
  SessionHeartbeat,
  heartbeatAlarm,
  pageHeartbeat,
} from "./session-heartbeat.js";
import { BridgeSession } from "./session.js";
import { TabRegistry } from "./tab-registry.js";
import { UploadWorkflow } from "./upload-workflow.js";

declare function importScripts(...urls: string[]): void;

importScripts("config.js");

const staticConfig: StaticBridgeConfig = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
const session = new BridgeSession(staticConfig);
const api = new HolviApi(staticConfig, session);

let nativeBridge: NativeBridge;
let tabs: TabRegistry;

tabs = new TabRegistry(staticConfig, session, {
  connectionAvailable: () => nativeBridge.connect(),
  stateChanged: () => nativeBridge.reportTabState(),
});
const commands = new CommandService(session, api, () => tabs.requestAuth());
const uploads = new UploadWorkflow(session, api);
nativeBridge = new NativeBridge(
  staticConfig,
  session,
  tabs,
  commands,
  uploads,
  api,
  () => heartbeat.recordActivity(),
);

chrome.runtime.onConnect.addListener((port) => tabs.register(port));

const heartbeat = new SessionHeartbeat(
  () => {
    const tab = tabs.configuredTab();
    const config = session.optionalConfig;
    return tab && config
      ? {
          tabId: tab[0],
          origin: staticConfig.accountOrigin,
          group: config.groupPathSegment,
        }
      : null;
  },
  (tabId, origin, group) =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: pageHeartbeat,
      args: [origin, group],
    }),
);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === heartbeatAlarm) void heartbeat.run();
});
// Recreate the alarm on worker startup because Chrome may clear alarms on restart.
void chrome.alarms.create(heartbeatAlarm, {
  delayInMinutes: 2,
  periodInMinutes: 2,
});
