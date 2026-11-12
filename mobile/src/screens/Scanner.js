// A full-screen QR scanner. Calls onScan(text) once.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button, Card, styles } from "../ui";

export default function Scanner({ title, onScan, onCancel }) {
    const [permission, requestPermission] = useCameraPermissions();
    const done = useRef(false);

    if (!permission) return <View style={styles.screen} />;

    if (!permission.granted) {
        return (
            <View style={[styles.screen, styles.body, { justifyContent: "center" }]}>
                <Card title="Camera needed">
                    <Text>CampusFlow needs the camera to scan the QR code.</Text>
                    <Button title="Allow camera" onPress={requestPermission} />
                    <Button title="Cancel" kind="secondary" onPress={onCancel} />
                </Card>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: "black" }}>
            <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => {
                    if (done.current) return; // the camera reports the same code many times
                    done.current = true;
                    onScan(result.data);
                }}
            />
            <View style={local.top}>
                <Text style={local.title}>{title}</Text>
            </View>
            <View style={local.frame} />
            <View style={local.bottom}>
                <Button title="Cancel" kind="secondary" onPress={onCancel} />
            </View>
        </View>
    );
}

const local = StyleSheet.create({
    top: { position: "absolute", top: 60, left: 20, right: 20, alignItems: "center" },
    title: { color: "white", fontSize: 18, fontWeight: "700", textAlign: "center" },
    frame: { position: "absolute", top: "28%", left: "12%", right: "12%", aspectRatio: 1, borderWidth: 3, borderColor: "white", borderRadius: 16 },
    bottom: { position: "absolute", bottom: 50, left: 20, right: 20 },
});
