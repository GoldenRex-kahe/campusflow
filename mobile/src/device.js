// Phone lock.
// The app makes a key pair once. The private key never leaves this phone;
// the server only gets the public key. Before each signed request the owner
// must unlock with fingerprint / face (or the phone's passcode).
//
// Note for the Expo Go pilot: the fingerprint check is done by the app (LocalAuthentication).
// A custom app build (later) can make the phone's secure chip enforce it as well.
import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import nacl from "tweetnacl";
import { load, save } from "./storage";

const KEY_NAME = "cf_device_key";

function toBase64(bytes) {
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
}

function fromBase64(text) {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// the key pair of this phone (made the first time)
export async function getKeyPair() {
    let saved = await load(KEY_NAME);
    if (!saved) {
        const seed = Crypto.getRandomBytes(32);
        saved = { seed: toBase64(seed) };
        await save(KEY_NAME, saved);
    }
    return nacl.sign.keyPair.fromSeed(fromBase64(saved.seed));
}

export async function publicKeyBase64() {
    return toBase64((await getKeyPair()).publicKey);
}

// an id that is the same for every account on this phone
export async function hardwareId() {
    if (Platform.OS === "android") return "android:" + Application.getAndroidId();
    const id = await Application.getIosIdForVendorAsync();
    return "ios:" + (id || "unknown");
}

export function phoneInfo() {
    return { platform: Platform.OS, model: Device.modelName || "" };
}

// ---------- fingerprint / face unlock ----------

let unlockedUntil = 0;

// ask for fingerprint/face. keepSeconds > 0 keeps it unlocked for a while (used by the faculty session screen)
export async function unlock(reason, keepSeconds = 0) {
    if (Date.now() < unlockedUntil) return;
    const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: "Cancel",
    });
    if (!result.success) {
        throw new Error(result.error === "not_enrolled" || result.error === "passcode_not_set"
            ? "Set up a fingerprint, face unlock or screen lock on this phone first."
            : "Fingerprint / face check was cancelled.");
    }
    if (keepSeconds > 0) unlockedUntil = Date.now() + keepSeconds * 1000;
}

export function lock() {
    unlockedUntil = 0;
}

// ---------- signing ----------

// headers that prove "this request comes from the registered phone"
export async function signHeaders(method, path, rawBody) {
    const keyPair = await getKeyPair();
    const time = Date.now();
    const bodyHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawBody || "");
    const text = `${method}\n${path}\n${time}\n${bodyHash}`;
    const signature = nacl.sign.detached(new TextEncoder().encode(text), keyPair.secretKey);
    return { "X-Device-Time": String(time), "X-Device-Signature": toBase64(signature) };
}
