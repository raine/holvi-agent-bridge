import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { pageHeartbeat, SessionHeartbeat } from "./session-heartbeat.js";

describe("session heartbeat", () => {
  test("only injects with a configured tab and suppresses overlapping runs", async () => {
    let target: { tabId: number; origin: string; group: string } | null = null;
    let calls = 0;
    let finish = (): void => {};
    const heartbeat = new SessionHeartbeat(
      () => target,
      () => {
        calls++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    await heartbeat.run();
    expect(calls).toBe(0);
    target = {
      tabId: 7,
      origin: "https://account.app.holvi.com",
      group: "example+uuid",
    };
    heartbeat.recordActivity();
    const pending = heartbeat.run();
    await heartbeat.run();
    expect(calls).toBe(1);
    finish();
    await pending;
    const next = heartbeat.run();
    expect(calls).toBe(2);
    finish();
    await next;
  });

  test("injection failure does not stop subsequent heartbeats", async () => {
    let calls = 0;
    const heartbeat = new SessionHeartbeat(
      () => ({
        tabId: 7,
        origin: "https://account.app.holvi.com",
        group: "example",
      }),
      () => {
        calls++;
        return Promise.reject(new Error("tab closed"));
      },
    );
    heartbeat.recordActivity();
    await heartbeat.run();
    await heartbeat.run();
    expect(calls).toBe(2);
  });

  test("only commands enable and extend the 30-minute window", async () => {
    let now = 1000;
    let calls = 0;
    const heartbeat = new SessionHeartbeat(
      () => ({
        tabId: 7,
        origin: "https://account.app.holvi.com",
        group: "example",
      }),
      () => {
        calls++;
        return Promise.resolve();
      },
      () => now,
    );
    await heartbeat.run();
    expect(calls).toBe(0);
    heartbeat.recordActivity();
    now += 29 * 60 * 1000;
    await heartbeat.run();
    expect(calls).toBe(1);
    now += 60 * 1000;
    await heartbeat.run();
    expect(calls).toBe(1);
    heartbeat.recordActivity();
    now += 20 * 60 * 1000;
    heartbeat.recordActivity();
    now += 20 * 60 * 1000;
    await heartbeat.run();
    expect(calls).toBe(2);
    now += 10 * 60 * 1000;
    await heartbeat.run();
    expect(calls).toBe(2);
  });

  test("page function is self-contained and checks the live company URL", async () => {
    const origin = "https://account.app.holvi.com";
    for (const path of [
      "/group/example%2Buuid/feed",
      "/group/other/feed",
      "/login",
      "/group/%ZZ/feed",
    ]) {
      const events: string[] = [];
      const requests: RequestInit[] = [];
      class Event {
        constructor(public type: string) {}
      }
      await runInNewContext(
        `(${pageHeartbeat.toString()})(origin, 'example+uuid')`,
        {
          origin,
          URL,
          AbortSignal,
          window: { location: { href: origin + path }, PointerEvent: Event },
          document: {
            documentElement: {
              dispatchEvent: (event: Event) => events.push(event.type),
            },
          },
          PointerEvent: Event,
          MouseEvent: Event,
          fetch: (_url: string, options: RequestInit) => {
            requests.push(options);
            return Promise.resolve({});
          },
        },
      );
      if (path.includes("example")) {
        expect(events).toEqual(["pointermove", "mousemove"]);
        expect(requests[0]).toMatchObject({
          method: "GET",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
        });
      } else {
        expect(events).toEqual([]);
        expect(requests).toEqual([]);
      }
    }
  });
});
