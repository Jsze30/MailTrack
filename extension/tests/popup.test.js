import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(testDir, "..");

async function popupWindow({ connected, scheduled = [] }) {
  const html = (await fs.readFile(path.join(extensionDir, "popup.html"), "utf8"))
    .replace('<script src="popup.js"></script>', "");
  const script = await fs.readFile(path.join(extensionDir, "popup.js"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "chrome-extension://mailtrack/popup.html",
  });
  const { window } = dom;
  const requests = [];
  const openedTabs = [];
  let currentScheduled = scheduled.slice();

  window.chrome = {
    runtime: { getManifest: () => ({ version: "2.0.37" }) },
    storage: {
      sync: {
        async get() {
          return {
            baseUrl: "https://backend.example",
            secret: "test-secret",
            trackDefault: true,
          };
        },
        async set() {},
      },
    },
    tabs: {
      async create(options) {
        openedTabs.push(options);
      },
    },
  };
  window.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    requests.push({ pathname, options });
    if (pathname === "/api/oauth/google/status") {
      return Response.json({
        connected,
        email: connected ? "sender@example.com" : null,
      });
    }
    if (pathname === "/api/scheduled-emails" && (!options.method || options.method === "GET")) {
      return Response.json({ emails: currentScheduled });
    }
    if (pathname.startsWith("/api/scheduled-emails/") && options.method === "DELETE") {
      const id = decodeURIComponent(pathname.split("/").at(-1));
      currentScheduled = currentScheduled.map((email) =>
        email.id === id ? { ...email, status: "cancelled" } : email
      );
      return Response.json({ ok: true });
    }
    if (pathname === "/api/oauth/google/start" && options.method === "POST") {
      return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=test" });
    }
    throw new Error(`Unexpected popup request: ${pathname}`);
  };

  window.eval(script);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  return { dom, window, requests, openedTabs };
}

test("the popup displays and cancels pending scheduled email", async () => {
  const sendAt = new Date(Date.now() + 3_600_000).toISOString();
  const { dom, window, requests } = await popupWindow({
    connected: true,
    scheduled: [
      {
        id: "scheduled-1",
        subject: "Tomorrow's update",
        sendAt,
        status: "pending",
      },
    ],
  });

  assert.equal(window.document.querySelector("#google-action").textContent, "Disconnect");
  assert.equal(
    window.document.querySelector("#google-status").textContent,
    "Connected as sender@example.com"
  );
  assert.equal(window.document.querySelector(".scheduled-subject").textContent, "Tomorrow's update");

  window.document
    .querySelector(".scheduled-cancel")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.equal(
    requests.some(
      (request) =>
        request.pathname === "/api/scheduled-emails/scheduled-1" &&
        request.options.method === "DELETE"
    ),
    true
  );
  assert.equal(window.document.querySelector(".scheduled-item"), null);
  dom.window.close();
});

test("the popup starts Google OAuth in a new tab", async () => {
  const { dom, window, openedTabs } = await popupWindow({ connected: false });
  const action = window.document.querySelector("#google-action");
  assert.equal(action.textContent, "Connect Gmail");

  action.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.equal(openedTabs.length, 1);
  assert.equal(
    openedTabs[0].url,
    "https://accounts.google.com/o/oauth2/v2/auth?state=test"
  );
  assert.equal(
    window.document.querySelector("#google-status").textContent,
    "Finish connecting Gmail in the new tab."
  );
  dom.window.close();
});
