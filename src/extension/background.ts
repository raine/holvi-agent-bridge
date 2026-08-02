import type { StaticBridgeConfig } from "./background-types.js";
import { CommandService } from "./commands.js";
import { HolviApi } from "./holvi-api.js";
import { NativeBridge } from "./native-bridge.js";
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
nativeBridge = new NativeBridge(staticConfig, session, tabs, commands, uploads);

chrome.runtime.onConnect.addListener((port) => tabs.register(port));
