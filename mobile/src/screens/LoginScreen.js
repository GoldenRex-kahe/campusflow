// Login: college email -> 6-digit code -> lock the account to this phone.
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { api, getServer, saveTokens, setServer, logout } from "../api";
import { hardwareId, phoneInfo, publicKeyBase64 } from "../device";
import { Button, Card, Header, Message, styles } from "../ui";

export default function LoginScreen({ onLoggedIn }) {
    const [server, setServerText] = useState(getServer());
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [step, setStep] = useState("email");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    async function sendCode() {
        setBusy(true);
        setMsg(null);
        try {
            await setServer(server);
            const r = await api.post("/auth/email/start", { email: email.trim() });
            setStep("code");
            setMsg({ text: r.message, kind: "ok" });
        } catch (err) {
            setMsg({ text: err.message });
        }
        setBusy(false);
    }

    async function verify() {
        setBusy(true);
        setMsg(null);
        try {
            await saveTokens(await api.post("/auth/email/verify", { email: email.trim(), code: code.trim() }));
            const me = await api.get("/me");
            if (me.role === "admin") {
                await logout();
                throw new Error("Admins use the PC website, not the app.");
            }
            // lock the account to this phone (or confirm it is the same phone)
            try {
                await api.post("/devices/register", { publicKey: await publicKeyBase64(), hardwareId: await hardwareId(), ...phoneInfo() });
            } catch (err) {
                await logout();
                throw err;
            }
            onLoggedIn(me);
        } catch (err) {
            setMsg({ text: err.message });
        }
        setBusy(false);
    }

    return (
        <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <Header title="CampusFlow" />
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                <Card title="Log in">
                    {step === "email" ? (
                        <View style={{ gap: 12 }}>
                            <View>
                                <Text style={styles.label}>Server address</Text>
                                <TextInput style={styles.input} value={server} onChangeText={setServerText} autoCapitalize="none" autoCorrect={false} placeholder="http://192.168.1.10:4000" keyboardType="url" />
                            </View>
                            <View>
                                <Text style={styles.label}>College email</Text>
                                <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" />
                            </View>
                            <Button title="Send login code" onPress={sendCode} busy={busy} disabled={!email || !server} />
                        </View>
                    ) : (
                        <View style={{ gap: 12 }}>
                            <View>
                                <Text style={styles.label}>6-digit code from your email</Text>
                                <TextInput style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} textContentType="oneTimeCode" />
                            </View>
                            <Button title="Log in" onPress={verify} busy={busy} disabled={code.length !== 6} />
                            <Button title="Use another email" kind="secondary" onPress={() => { setStep("email"); setCode(""); setMsg(null); }} />
                        </View>
                    )}
                    <Message text={msg && msg.text} kind={msg && msg.kind} />
                </Card>
                <Text style={styles.muted}>
                    Your account will be locked to this phone. If you change phones, ask the admin to reset it.
                </Text>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
