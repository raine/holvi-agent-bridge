"use strict";
(() => {
    "use strict";
    const config = _HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
    if (location.origin !== config.accountOrigin ||
        !location.pathname.startsWith(config.groupPathPrefix)) {
        return;
    }
    const readCookie = (name) => {
        const prefix = `${encodeURIComponent(name)}=`;
        for (const part of document.cookie.split(";")) {
            const candidate = part.trim();
            if (candidate.startsWith(prefix)) {
                return decodeURIComponent(candidate.slice(prefix.length));
            }
        }
        return "";
    };
    const port = chrome.runtime.connect({ name: "holvi-tab" });
    port.onMessage.addListener((message) => {
        const request = message;
        if (!request || request.type !== "auth_request") {
            return;
        }
        port.postMessage({
            type: "auth_response",
            requestId: request.requestId,
            href: location.href,
            origin: location.origin,
            pathname: location.pathname,
            token: readCookie("holvi_jwt_auth"),
            csrfToken: readCookie("csrftoken"),
        });
    });
    const sendHello = () => {
        port.postMessage({
            type: "tab_hello",
            href: location.href,
            origin: location.origin,
            pathname: location.pathname,
        });
    };
    let lastHref = location.href;
    sendHello();
    window.setInterval(() => {
        if (location.href !== lastHref) {
            lastHref = location.href;
            sendHello();
        }
    }, 1000);
})();
