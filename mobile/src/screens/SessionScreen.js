// Faculty session: shows the rotating QR, keeps sending this phone's location,
// lists flagged scans to accept or reject, and stops the session.
// The screen stays awake, and the phone stays unlocked for signing while it is open.
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { lock, unlock } from "../device";
import { getLocation } from "../location";
import { Button, Card, Header, Message, Row, styles } from "../ui";

const LOCATION_EVERY_MS = 10000;
const REFRESH_EVERY_MS = 4000;

export default function SessionScreen({ sessionId, onClose }) {
    useKeepAwake();
    const [qr, setQr] = useState(null);
    const [info, setInfo] = useState(null);
    const [error, setError] = useState(null);
    const active = useRef(true);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        active.current = true;
        let locationTimer;
        let refreshTimer;

        async function sendLocation() {
            try {
                const loc = await getLocation();
                await api.post(`/attendance/sessions/${sessionId}/location`, { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy }, { signed: true });
                if (active.current) setError(null);
            } catch (err) {
                if (active.current) setError(err.message);
            }
        }

        async function refresh() {
            try {
                const [q, s] = await Promise.all([api.get(`/attendance/sessions/${sessionId}/qr`), api.get(`/attendance/sessions/${sessionId}`)]);
                if (!active.current) return;
                if (q.ended) return closeRef.current();
                setQr(q);
                setInfo(s);
            } catch (err) {
                if (active.current) setError(err.message);
            }
        }

        (async () => {
            try {
                // one fingerprint check for the whole session (up to 3 hours)
                await unlock("Confirm it is you to run attendance", 3 * 60 * 60);
            } catch (err) {
                setError(err.message);
                return;
            }
            await sendLocation();
            await refresh();
            locationTimer = setInterval(sendLocation, LOCATION_EVERY_MS);
            refreshTimer = setInterval(refresh, REFRESH_EVERY_MS);
        })();

        return () => {
            active.current = false;
            clearInterval(locationTimer);
            clearInterval(refreshTimer);
            lock();
        };
    }, [sessionId]);

    function stop() {
        Alert.alert("Stop attendance?", "Students will not be able to scan any more.", [
            { text: "Cancel", style: "cancel" },
            { text: "Stop", style: "destructive", onPress: async () => { await api.post(`/attendance/sessions/${sessionId}/stop`).catch(() => {}); onClose(); } },
        ]);
    }

    function cancel() {
        Alert.alert("Cancel this session?", "Use this only if you started attendance by mistake. It will not count as a class.", [
            { text: "Keep it", style: "cancel" },
            { text: "Cancel session", style: "destructive", onPress: async () => {
                try {
                    await api.post(`/attendance/sessions/${sessionId}/cancel`);
                    onClose();
                } catch (err) {
                    setError(err.message);
                }
            } },
        ]);
    }

    async function decide(recordId, status) {
        await api.post(`/attendance/records/${recordId}/decide`, { status }).catch((e) => setError(e.message));
    }

    const flagged = info ? info.students.filter((s) => s.status === "flagged") : [];

    return (
        <View style={styles.screen}>
            <Header title={info ? `${info.class_name} - ${info.code}` : "Attendance"} />
            <ScrollView contentContainerStyle={styles.body}>
                <Message text={error} />
                <Card>
                    {qr && !qr.paused && qr.qr ? (
                        <>
                            <Image source={{ uri: qr.qr }} style={{ width: "100%", aspectRatio: 1 }} />
                            <Text style={[styles.muted, { textAlign: "center" }]}>New code in {qr.validFor} s. You can also show this on a linked PC.</Text>
                        </>
                    ) : (
                        <Message text={qr && qr.paused ? qr.reason : "Getting your location..."} kind="warn" />
                    )}
                    {qr && qr.closesIn !== null && qr.closesIn !== undefined ? (
                        <Text style={[styles.rowRight, { textAlign: "center" }]}>QR closes in {formatTime(qr.closesIn)}</Text>
                    ) : null}
                    {info ? <Text style={styles.big}>Present {info.counts.present} / {info.counts.total}</Text> : null}
                    <Text style={[styles.muted, { textAlign: "center" }]}>Keep this screen open. It sends your location so the app can check students are near you.</Text>
                </Card>

                {flagged.length ? (
                    <Card title={`Needs review (${flagged.length})`}>
                        {flagged.map((s) => (
                            <View key={s.student_id} style={{ gap: 6 }}>
                                <Row left={`${s.reg_no} ${s.name}`} sub={s.reason} />
                                <View style={{ flexDirection: "row", gap: 8 }}>
                                    <View style={{ flex: 1 }}><Button title="Accept" onPress={() => decide(s.record_id, "present")} /></View>
                                    <View style={{ flex: 1 }}><Button title="Reject" kind="danger" onPress={() => decide(s.record_id, "absent")} /></View>
                                </View>
                            </View>
                        ))}
                    </Card>
                ) : null}

                <Button title="Stop attendance" kind="danger" onPress={stop} />
                {info && info.can_cancel ? <Button title="Cancel (started by mistake)" kind="secondary" onPress={cancel} /> : null}
                <Button title="Back" kind="secondary" onPress={onClose} />
                <Text style={[styles.muted, { textAlign: "center" }]}>While you are away from this screen the QR pauses. Open the session again to continue.</Text>
            </ScrollView>
        </View>
    );
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const sec = String(seconds % 60).padStart(2, "0");
    return `${m}:${sec}`;
}
