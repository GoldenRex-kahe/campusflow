// Shared code for the PC pages.

// Build page elements safely: h("button", { onclick: fn }, "Save")
// Text is always added as text, never as HTML, so data from the database cannot inject code.
export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (key === "class") el.className = value;
        else if (key in el && key !== "list") el[key] = value;
        else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

export function message(text, type = "error", list = []) {
    return h("div", { class: `msg ${type}` }, text, list.length ? h("ul", {}, list.map((x) => h("li", {}, x))) : null);
}

// Page header with the college emblem. right = things shown on the right (name, log out)
export function topBar(title, ...right) {
    return h("header", {},
        h("div", { class: "brand" },
            h("img", { src: "/img/emblem.png", alt: "Karpagam Academy of Higher Education" }),
            h("div", { class: "names" }, h("div", { class: "college" }, "Karpagam Academy of Higher Education"), h("h1", {}, title))),
        right.length ? h("div", { class: "who" }, ...right) : null);
}

// the full college logo, for login cards
export function logo() {
    return h("img", { class: "logo", src: "/img/logo.png", alt: "Karpagam Academy of Higher Education" });
}

// "13:05" -> "1:05 PM"
export function ampm(hhmm) {
    if (!hhmm) return "";
    const [hr, mn] = hhmm.split(":").map(Number);
    return `${hr % 12 || 12}:${String(mn).padStart(2, "0")} ${hr < 12 ? "AM" : "PM"}`;
}

// A clear time picker: hour (1-12), minute, AM/PM.
// It keeps a hidden input with the 24-hour value ("13:05") so forms send that.
export function timePicker(name, value = "09:00") {
    const hidden = h("input", { type: "hidden", name });
    const hour = h("select", { "aria-label": "Hour" }, [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((x) => h("option", { value: x }, x)));
    const minute = h("select", { "aria-label": "Minute" });
    const half = h("select", { "aria-label": "AM or PM" }, h("option", { value: "AM" }, "AM"), h("option", { value: "PM" }, "PM"));

    function update() {
        let hr = Number(hour.value) % 12;
        if (half.value === "PM") hr += 12;
        hidden.value = `${String(hr).padStart(2, "0")}:${minute.value}`;
    }

    function set(hhmm) {
        const [hr, mn] = hhmm.split(":").map(Number);
        const mm = String(mn).padStart(2, "0");
        // minutes in steps of 5, plus the exact minute if it is not one of them
        const steps = [...Array(12).keys()].map((i) => String(i * 5).padStart(2, "0"));
        if (!steps.includes(mm)) steps.push(mm);
        minute.replaceChildren(...steps.sort().map((m) => h("option", { value: m }, m)));
        hour.value = String(hr % 12 || 12);
        minute.value = mm;
        half.value = hr < 12 ? "AM" : "PM";
        update();
    }

    for (const el of [hour, minute, half]) el.addEventListener("change", update);
    set(value);
    return { el: h("div", { class: "timepick" }, hour, h("span", {}, ":"), minute, half, hidden), set };
}

export const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Talks to the server. Keeps the login tokens for this browser tab only.
export function createApi(storageKey) {
    function tokens() {
        try { return JSON.parse(sessionStorage.getItem(storageKey)) || null; } catch { return null; }
    }

    async function refresh() {
        const t = tokens();
        if (!t) return false;
        const res = await fetch("/auth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: t.refreshToken }),
        });
        if (!res.ok) { sessionStorage.removeItem(storageKey); return false; }
        sessionStorage.setItem(storageKey, JSON.stringify(await res.json()));
        return true;
    }

    async function request(method, path, body, retry = true) {
        const t = tokens();
        const res = await fetch(path, {
            method,
            headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t.accessToken } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        // access token expired: get a new one once, then try again
        if (res.status === 401 && retry && t && !path.startsWith("/auth/")) {
            if (await refresh()) return request(method, path, body, false);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || "Something went wrong");
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    return {
        loggedIn: () => !!tokens(),
        save: (t) => sessionStorage.setItem(storageKey, JSON.stringify(t)),
        async logout() {
            const t = tokens();
            sessionStorage.removeItem(storageKey);
            if (t) await fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
        },
        get: (p) => request("GET", p),
        post: (p, b) => request("POST", p, b || {}),
        put: (p, b) => request("PUT", p, b || {}),
        patch: (p, b) => request("PATCH", p, b || {}),
        del: (p) => request("DELETE", p),
    };
}

// read all named inputs of a form into an object
export function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
}
