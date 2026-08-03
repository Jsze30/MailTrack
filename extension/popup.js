// MailTrack configuration only. Status is displayed directly in Gmail.

const element = (id) => document.getElementById(id);

function config() {
  return {
    baseUrl: element("baseUrl").value.trim().replace(/\/+$/, ""),
    secret: element("secret").value.trim(),
  };
}

async function apiFetch(path, options = {}) {
  const { baseUrl, secret } = config();
  if (!baseUrl || !secret) throw new Error("Save the backend settings first");
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      "x-track-secret": secret,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Backend returned ${response.status}`);
  return payload;
}

function scheduledLabel(sendAt) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(sendAt));
}

function renderScheduled(emails) {
  const list = element("scheduled-list");
  list.replaceChildren();
  for (const email of emails.filter((item) => item.status === "pending")) {
    const item = document.createElement("div");
    item.className = "scheduled-item";
    const subject = document.createElement("div");
    subject.className = "scheduled-subject";
    subject.textContent = email.subject || "(no subject)";
    const time = document.createElement("div");
    time.className = "scheduled-time";
    time.textContent = scheduledLabel(email.sendAt);
    const cancel = document.createElement("button");
    cancel.className = "scheduled-cancel";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        await apiFetch(`/api/scheduled-emails/${encodeURIComponent(email.id)}`, {
          method: "DELETE",
        });
        await refreshGoogle();
      } catch (error) {
        element("google-status").textContent = error.message;
        element("google-status").className = "status error";
        cancel.disabled = false;
      }
    });
    item.append(subject, time, cancel);
    list.append(item);
  }
}

async function refreshGoogle() {
  const status = element("google-status");
  const action = element("google-action");
  try {
    const connection = await apiFetch("/api/oauth/google/status");
    action.dataset.connected = connection.connected ? "true" : "false";
    action.textContent = connection.connected ? "Disconnect" : "Connect Gmail";
    status.className = connection.connected ? "status success" : "status";
    status.textContent = connection.connected
      ? `Connected as ${connection.email}`
      : "Connect Gmail to schedule email.";
    if (connection.connected) {
      const scheduled = await apiFetch("/api/scheduled-emails");
      renderScheduled(scheduled.emails || []);
    } else {
      renderScheduled([]);
    }
  } catch (error) {
    status.className = "status error";
    status.textContent = error.message;
    renderScheduled([]);
  }
}

async function initialize() {
  const settings = await chrome.storage.sync.get(["baseUrl", "secret", "trackDefault"]);
  element("baseUrl").value = settings.baseUrl || "";
  element("secret").value = settings.secret || "";
  element("trackDefault").checked = settings.trackDefault !== false;
  element("version").textContent = `v${chrome.runtime.getManifest().version}`;
  await refreshGoogle();
}

element("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    baseUrl: element("baseUrl").value.trim(),
    secret: element("secret").value.trim(),
    trackDefault: element("trackDefault").checked,
  });
  const status = element("settings-status");
  status.className = "status success";
  status.textContent = "Saved. Reload Gmail to apply the setting.";
  await refreshGoogle();
});

element("google-action").addEventListener("click", async () => {
  const action = element("google-action");
  const status = element("google-status");
  action.disabled = true;
  try {
    if (action.dataset.connected === "true") {
      await apiFetch("/api/oauth/google/disconnect", { method: "POST" });
      await refreshGoogle();
    } else {
      const result = await apiFetch("/api/oauth/google/start", { method: "POST" });
      await chrome.tabs.create({ url: result.url });
      status.className = "status";
      status.textContent = "Finish connecting Gmail in the new tab.";
    }
  } catch (error) {
    status.className = "status error";
    status.textContent = error.message;
  } finally {
    action.disabled = false;
  }
});

initialize();
