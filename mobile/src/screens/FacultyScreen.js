// Faculty: today's classes from the timetable (start attendance in the first 20 minutes,
// ask the admin to reopen after that), link a PC, manage linked PCs.
import { useCallback, useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { getLocation } from "../location";
import { Button, Card, Header, Message, Row, ampm, styles, colors } from "../ui";
import Scanner from "./Scanner";
import SessionScreen from "./SessionScreen";

export default function FacultyScreen({ me, onLogout }) {
    const [periods, setPeriods] = useState([]);
    const [pcs, setPcs] = useState([]);
    const [alerts, setAlerts] = useState([]);
    const [appeals, setAppeals] = useState([]);
    const [openSession, setOpenSession] = useState(null);
    const [sessionId, setSessionId] = useState(null);
    const [linking, setLinking] = useState(false);
    const [busy, setBusy] = useState(null);
    const [msg, setMsg] = useState(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [today, p, o, a] = await Promise.all([
                api.get("/attendance/today"), api.get("/link/pcs"), api.get("/attendance/open"), api.get("/insights/alerts").catch(() => []),
            ]);
            setAlerts(a);
            setAppeals(await api.get("/appeals").catch(() => []));
            setPeriods(today);
            setPcs(p);
            setOpenSession(o);
        } catch (err) {
            if (err.status === 401) onLogout();
            else setMsg({ text: err.message });
        }
        setLoading(false);
    }, [onLogout]);

    useEffect(() => { load(); }, [load]);

    // start, continue or reopen attendance for a period
    async function start(period) {
        setBusy(period.timetable_id);
        setMsg(null);
        try {
            const loc = await getLocation();
            const s = await api.post("/attendance/sessions", { timetableId: period.timetable_id, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy },
                { signed: true, reason: "Confirm it is you to start attendance" });
            setSessionId(s.id);
        } catch (err) {
            setMsg({ text: err.message });
            load();
        }
        setBusy(null);
    }

    async function requestReopen(period, reason) {
        setBusy(period.timetable_id);
        setMsg(null);
        try {
            await api.post("/attendance/requests", { timetableId: period.timetable_id, reason });
            setMsg({ text: "Request sent. You can reopen the QR once the admin approves it.", kind: "ok" });
            load();
        } catch (err) {
            setMsg({ text: err.message });
        }
        setBusy(null);
    }

    async function approveLink(qr) {
        setLinking(false);
        setMsg(null);
        try {
            await api.post("/link/approve", { qr }, { signed: true, reason: "Confirm it is you to link this PC" });
            setMsg({ text: "PC linked. It will open on the PC in a moment.", kind: "ok" });
            load();
        } catch (err) {
            setMsg({ text: err.message });
        }
    }

    async function handleAlert(alert, status) {
        try {
            await api.post(`/insights/alerts/${alert.id}/handle`, { status });
            load();
        } catch (err) {
            setMsg({ text: err.message });
        }
    }

    async function decideAppeal(appeal, approve) {
        try {
            await api.post(`/appeals/${appeal.id}/decide`, { approve });
            load();
        } catch (err) {
            setMsg({ text: err.message });
        }
    }

    function unlink(pc) {
        Alert.alert("Log out this PC?", pc.user_agent ? pc.user_agent.slice(0, 80) : "", [
            { text: "Cancel", style: "cancel" },
            { text: "Log out", style: "destructive", onPress: async () => { await api.del(`/link/pcs/${pc.id}`).catch(() => {}); load(); } },
        ]);
    }

    if (sessionId) return <SessionScreen sessionId={sessionId} onClose={() => { setSessionId(null); load(); }} />;
    if (linking) return <Scanner title="Scan the QR shown on the PC" onScan={approveLink} onCancel={() => setLinking(false)} />;

    return (
        <View style={styles.screen}>
            <Header title={me.name} right={<Text style={{ color: colors.brand, fontWeight: "600" }} onPress={onLogout}>Log out</Text>} />
            <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
                <Message text={msg && msg.text} kind={msg && msg.kind} />

                {openSession ? (
                    <Card title="Attendance running">
                        <Text>{openSession.class_name} - {openSession.code}</Text>
                        <Button title="Open session" onPress={() => setSessionId(openSession.id)} />
                    </Card>
                ) : null}

                <Card title="Today's classes">
                    <Text style={styles.muted}>Attendance can be taken in the first 20 minutes of each period. After that, ask the admin to reopen it.</Text>
                    {periods.length === 0 ? <Text style={styles.muted}>No classes on your timetable today.</Text> : null}
                    {periods.map((p) => (
                        <PeriodRow key={p.timetable_id} period={p} busy={busy === p.timetable_id} anyOpen={!!openSession}
                            onStart={() => start(p)} onOpen={() => setSessionId(p.session.id)} onRequest={(reason) => requestReopen(p, reason)} />
                    ))}
                </Card>

                <Card title={`Students who may need help (${alerts.length})`}>
                    {alerts.length === 0 ? <Text style={styles.muted}>No open alerts.</Text> : null}
                    {alerts.slice(0, 10).map((a) => (
                        <View key={a.id} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
                            <Text style={styles.rowText}>{a.reg_no} {a.name} - {a.title}</Text>
                            <Text style={styles.muted}>{a.reason}</Text>
                            {a.suggestion ? <Text style={styles.muted}>Next step: {a.suggestion}</Text> : null}
                            <View style={{ flexDirection: "row", gap: 8 }}>
                                <View style={{ flex: 1 }}><Button title="Spoke to student" onPress={() => handleAlert(a, "handled")} /></View>
                                <View style={{ flex: 1 }}><Button title="Not needed" kind="secondary" onPress={() => handleAlert(a, "not_needed")} /></View>
                            </View>
                        </View>
                    ))}
                    {alerts.length > 10 ? <Text style={styles.muted}>See all {alerts.length} on the PC (Alerts tab).</Text> : null}
                </Card>

                {appeals.length ? (
                    <Card title={`Attendance appeals (${appeals.length})`}>
                        {appeals.map((a) => (
                            <View key={a.id} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
                                <Text style={styles.rowText}>{a.reg_no} {a.name} - {a.class_name} {a.code}</Text>
                                <Text style={styles.muted}>{new Date(a.started_at).toLocaleString()} - marked {a.marked}</Text>
                                <Text>{a.reason}</Text>
                                <View style={{ flexDirection: "row", gap: 8 }}>
                                    <View style={{ flex: 1 }}><Button title="Mark present" onPress={() => decideAppeal(a, true)} /></View>
                                    <View style={{ flex: 1 }}><Button title="Reject" kind="danger" onPress={() => decideAppeal(a, false)} /></View>
                                </View>
                            </View>
                        ))}
                    </Card>
                ) : null}

                <Card title="Linked PCs">
                    <Text style={styles.muted}>Use CampusFlow on a PC: open the faculty page on the PC and scan its QR.</Text>
                    <Button title="Link a PC" kind="secondary" onPress={() => setLinking(true)} />
                    {pcs.map((pc) => (
                        <Row key={pc.id} left={shortAgent(pc.user_agent)} sub={`Linked ${new Date(pc.created_at).toLocaleString()}`}
                            right={<Text style={{ color: colors.red }} onPress={() => unlink(pc)}>Log out</Text>} />
                    ))}
                </Card>
            </ScrollView>
        </View>
    );
}

// one period of today, with the action that fits its state
function PeriodRow({ period: p, busy, anyOpen, onStart, onOpen, onRequest }) {
    const [reason, setReason] = useState("");
    const title = `${ampm(p.start)} - ${ampm(p.end)}  ${p.class_name} - ${p.code}`;
    const sub = `${p.subject}, ${p.room}${p.session ? `, present ${p.session.present}` : ""}`;

    let action = null;
    if (p.state === "upcoming") action = <Text style={styles.muted}>Starts at {ampm(p.start)}</Text>;
    if (p.state === "open") action = <Button title="Open session" onPress={onOpen} />;
    if (p.state === "can_start") action = <Button title={p.session ? "Continue attendance" : "Start attendance"} onPress={onStart} busy={busy} disabled={anyOpen} />;
    if (p.state === "request_pending") action = <Message text="Reopen request sent. Waiting for the admin." kind="warn" />;
    if (p.state === "reopen_approved") action = <Button title="Reopen QR (10 minutes)" onPress={onStart} busy={busy} disabled={anyOpen} />;
    if (p.state === "closed") {
        action = (
            <View style={{ gap: 8 }}>
                {p.request && p.request.status === "rejected" ? <Message text={`Last request was rejected${p.request.note ? ": " + p.request.note : ""}`} /> : null}
                <Text style={styles.muted}>The 20-minute attendance time is over.</Text>
                <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="Reason, for example: projector not working" />
                <Button title="Ask admin to reopen" kind="secondary" onPress={() => onRequest(reason)} busy={busy} disabled={!reason.trim()} />
            </View>
        );
    }

    return (
        <View style={{ gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <Text style={styles.rowText}>{title}</Text>
            <Text style={styles.muted}>{sub}</Text>
            {action}
        </View>
    );
}

function shortAgent(ua) {
    if (!ua) return "PC";
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return `${browser}${os ? " on " + os : ""}`;
}
