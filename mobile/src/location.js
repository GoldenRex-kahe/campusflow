// Read the phone's location once (only when marking attendance or during a faculty session).
import * as Location from "expo-location";

export async function askLocationPermission() {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) throw new Error("Location permission is needed to check you are in the classroom.");
}

export async function getLocation() {
    await askLocationPermission();
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
    return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? 999,
        mocked: pos.mocked === true, // true when a fake-location app is used
    };
}
