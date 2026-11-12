// Talks to the CampusFlow server.
import { load, save, remove } from "./storage";
import { signHeaders, unlock } from "./device";

let serverUrl = process.env.EXPO_PUBLIC_API_URL || "";
let tokens = null;

export async function init() {
    serverUrl = (await load("cf_server")) || serverUrl;
    tokens = await load("cf_tokens");
    return { serverUrl, loggedIn: !!tokens };
}

export function getServer() {
    return serverUrl;
}

export async function setServer(url) {
    serverUrl = url.trim().replace(/\/+$/, "");
    await save("cf_server", serverUrl);
}

export async function saveTokens(t) {
    tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken };
    await save("cf_tokens", tokens);
}

export async function logout() {
    if (tokens) {
        await fetch(serverUrl + "/auth/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        }).catch(() => {});
    }
    tokens = null;
    await remove("cf_tokens");
}

async function refresh() {
    if (!tokens) return false;
    const res = await fetch(serverUrl + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    }).catch(() => null);
    if (!res || !res.ok) return false;
    await saveTokens(await res.json());
    return true;
}

// options.signed: sign with the phone key (needs fingerprint/face unless already unlocked)
async function request(method, path, body, options = {}, retry = true) {
    if (!serverUrl) throw new Error("Set the server address first");
    const raw = body ? JSON.stringify(body) : "";
    const headers = { "Content-Type": "application/json" };
    if (tokens) headers.Authorization = "Bearer " + tokens.accessToken;
    if (options.signed) {
        await unlock(options.reason || "Confirm it is you");
        Object.assign(headers, await signHeaders(method, path, raw));
    }

    let res;
    try {
        res = await fetch(serverUrl + path, { method, headers, body: body ? raw : undefined });
    } catch {
        throw new Error("Cannot reach the server. Check your internet and the server address.");
    }

    if (res.status === 401 && retry && tokens && !path.startsWith("/auth/")) {
        if (await refresh()) return request(method, path, body, options, false);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.result) {
        const err = new Error(data.error || "Something went wrong");
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

export const api = {
    get: (path) => request("GET", path),
    post: (path, body, options) => request("POST", path, body || {}, options),
    del: (path) => request("DELETE", path),
};
