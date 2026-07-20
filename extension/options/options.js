const DEFAULT_BACKEND_URL = "http://localhost:8787";
const form = document.querySelector("#settingsForm");
const input = document.querySelector("#backendUrl");
const status = document.querySelector("#status");

const settings = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND_URL });
input.value = settings.backendUrl;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.classList.remove("error");

  try {
    const url = new URL(input.value);
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("The backend URL must use http or https.");
    }

    const originPattern = `${url.origin}/*`;
    const alreadyAllowed = await chrome.permissions.contains({ origins: [originPattern] });
    if (!alreadyAllowed) {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("Permission to connect to that backend origin was not granted.");
    }

    const normalized = url.origin + url.pathname.replace(/\/$/, "");
    await chrome.storage.local.set({ backendUrl: normalized });
    input.value = normalized;
    status.textContent = "Settings saved.";
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  }
});
