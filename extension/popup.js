// MailTrack configuration only. Status is displayed directly in Gmail.

const element = (id) => document.getElementById(id);

async function initialize() {
  const settings = await chrome.storage.sync.get(["baseUrl", "secret", "trackDefault"]);
  element("baseUrl").value = settings.baseUrl || "";
  element("secret").value = settings.secret || "";
  element("trackDefault").checked = settings.trackDefault !== false;
  element("version").textContent = `v${chrome.runtime.getManifest().version}`;
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
});

initialize();
