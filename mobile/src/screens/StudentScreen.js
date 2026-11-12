// Student: scan attendance, see own attendance, marks, timetable and mentor.
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { getLocation } from "../location";
import { Button, Card, Header, Message, Row, ampm, styles, colors } from "../ui";
import Scanner from "./Scanner";

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function StudentScreen({ me, onLogout }) {
    const [scanning, setScanning] = useState(false);
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [attendance, marks, timetable, mentor, summary] = await Promise.all([
                api.get("/student/attendance"), api.get("/student/marks"), api.get("/student/timetable"), api.get("/student/mentor"),
                api.get("/insights/student/summary").catch(() => null),
            ]);
            const missed = await api.get("/appeals/mine").catch(() => []);
            setData({ attendance, marks, timetable, mentor, summary, missed });
        } catch (err) {
            if (err.status === 401) onLogout();
        }
        setLoading(false);
    }, [onLogout]);

    useEffect(() => { loadData(); }, [loadData]);

    async function onScan(qr) {
        setScanning(false);
        setBusy(true);
        setResult(null);
        try {
            const loc = await getLocation();
            const r = await api.post("/attendance/mark", { qr, ...loc }, { signed: true, reason: "Confirm it is you to mark attendance" });
            setResult(r);
            loadData();
        } catch (err) {
            setResult({ result: "error", reason: err.message });
        }
        setBusy(false);
    }

    if (scanning) {
        return <Scanner title="Scan the attendance QR on the screen" onScan={onScan} onCancel={() => setScanning(false)} />;
    }

    const resultKind = result && (result.result === "present" ? "ok" : result.result === "flagged" ? "warn" : "error");
    const resultTitle = result && ({ present: "You are marked present", flagged: "Sent to your faculty for review", rejected: "Not marked" }[result.result] || "Not marked");

    return (
        <View style={styles.screen}>
            <Header title={`Hi, ${me.name}`} right={<Text style={{ color: colors.brand, fontWeight: "600" }} onPress={onLogout}>Log out</Text>} />
            <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={loading} onRefresh={loadData} />}>
                <Card>
                    <Button title="Scan attendance" onPress={() => setScanning(true)} busy={busy} />
                    {busy ? <Text style={styles.muted}>Checking your location and confirming it is you...</Text> : null}
                    {result ? <Message text={`${resultTitle}. ${result.reason || ""}`} kind={resultKind} /> : null}
                </Card>

                {data ? (
                    <>
                        {data.summary ? (
                            <Card title="My progress">
                                <Text style={styles.rowText}>{data.summary.text}</Text>
                                {data.summary.nudges.map((n, i) => <Message key={i} text={n} kind="warn" />)}
                            </Card>
                        ) : null}

                        <Card title="My attendance">
                            {data.attendance.length === 0 ? <Text style={styles.muted}>No classes yet.</Text> : null}
                            {data.attendance.map((a) => (
                                <Row key={a.code} left={`${a.code} ${a.subject}`}
                                    sub={a.waiting_review ? `${a.waiting_review} waiting for review` : null}
                                    right={a.held ? `${a.present}/${a.held}  (${Math.round((a.present * 100) / a.held)}%)` : "-"} />
                            ))}
                        </Card>

                        {data.missed && data.missed.length ? (
                            <Card title="Missed classes (last 14 days)">
                                <Text style={styles.muted}>Were you in class but not marked present? Send an appeal within 7 days.</Text>
                                {data.missed.map((m) => <MissedRow key={m.session_id} item={m} onSent={loadData} />)}
                            </Card>
                        ) : null}

                        <Card title="My marks">
                            {data.marks.length === 0 ? <Text style={styles.muted}>No tests yet.</Text> : null}
                            {data.marks.map((m, i) => (
                                <Row key={i} left={`${m.code} ${m.assessment}`} right={m.marks === null ? "-" : `${m.marks} / ${m.max_marks}`} />
                            ))}
                        </Card>

                        <Card title="Timetable">
                            {data.timetable.length === 0 ? <Text style={styles.muted}>No timetable yet.</Text> : null}
                            {data.timetable.map((p, i) => (
                                <Row key={i} left={`${DAYS[p.day]} ${ampm(p.start)} - ${ampm(p.end)}  ${p.code}`} sub={`${p.subject}, ${p.room}${p.faculty_name ? ", " + p.faculty_name : ""}`} />
                            ))}
                        </Card>

                        <Card title="My mentor">
                            <Text>{data.mentor && data.mentor.mentor_name ? `${data.mentor.mentor_name} (${data.mentor.group_name})` : "Not assigned yet"}</Text>
                        </Card>
                    </>
                ) : null}
            </ScrollView>
        </View>
    );
}

// one missed class, with its appeal status or a form to send one
function MissedRow({ item, onSent }) {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const when = new Date(item.started_at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

    async function send() {
        setBusy(true);
        setError(null);
        try {
            await api.post("/appeals", { sessionId: item.session_id, reason });
            onSent();
        } catch (err) {
            setError(err.message);
        }
        setBusy(false);
    }

    let status = null;
    if (item.appeal_status === "pending") status = <Message text="Appeal sent. Waiting for your faculty." kind="warn" />;
    if (item.appeal_status === "approved") status = <Message text="Appeal approved: you are marked present." kind="ok" />;
    if (item.appeal_status === "rejected") status = <Message text={`Appeal rejected${item.appeal_note ? ": " + item.appeal_note : ""}`} />;

    return (
        <View style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <Text style={styles.rowText}>{item.code} {item.subject}</Text>
            <Text style={styles.muted}>{when} - marked {item.status}</Text>
            {status}
            {!item.appeal_status && item.can_appeal && !open ? <Button title="Appeal" kind="secondary" onPress={() => setOpen(true)} /> : null}
            {!item.appeal_status && !item.can_appeal ? <Text style={styles.muted}>Too late to appeal (7 days).</Text> : null}
            {open ? (
                <View style={{ gap: 8 }}>
                    <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="What happened? For example: my phone battery died" multiline />
                    <Button title="Send appeal" onPress={send} busy={busy} disabled={!reason.trim()} />
                    <Message text={error} />
                </View>
            ) : null}
        </View>
    );
}
