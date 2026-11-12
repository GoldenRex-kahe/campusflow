// Everything the app remembers is kept in SecureStore (encrypted by the phone).
import * as SecureStore from "expo-secure-store";

// THIS_DEVICE_ONLY: never copied to another phone through backups
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function load(key) {
    const text = await SecureStore.getItemAsync(key, options);
    return text ? JSON.parse(text) : null;
}

export async function save(key, value) {
    await SecureStore.setItemAsync(key, JSON.stringify(value), options);
}

export async function remove(key) {
    await SecureStore.deleteItemAsync(key, options);
}
