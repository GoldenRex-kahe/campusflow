// Small shared pieces of the app's look (colours from the college logo).
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";

export const colors = {
    brand: "#367d43",
    brandDark: "#2a6234",
    brandSoft: "#eef6ef",
    ink: "#535353",
    text: "#1f2937",
    muted: "#6b7280",
    line: "#e5e7eb",
    bg: "#f6f8f6",
    red: "#b91c1c",
    redSoft: "#fef2f2",
    amber: "#b45309",
    amberSoft: "#fffbeb",
};

// "13:05" -> "1:05 PM"
export function ampm(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function Header({ title, right }) {
    return (
        <View style={styles.header}>
            <Image source={require("../assets/emblem.png")} style={styles.emblem} resizeMode="contain" />
            <View style={{ flex: 1 }}>
                <Text style={styles.college}>KARPAGAM ACADEMY OF HIGHER EDUCATION</Text>
                <Text style={styles.title}>{title}</Text>
            </View>
            {right}
        </View>
    );
}

export function Button({ title, onPress, kind = "primary", disabled, busy }) {
    const style = [styles.button, kind === "secondary" && styles.secondary, kind === "danger" && styles.danger, (disabled || busy) && { opacity: 0.5 }];
    const textStyle = [styles.buttonText, kind !== "primary" && { color: kind === "danger" ? colors.red : colors.brand }];
    return (
        <Pressable style={style} onPress={onPress} disabled={disabled || busy}>
            {busy ? <ActivityIndicator color={kind === "primary" ? "white" : colors.brand} /> : <Text style={textStyle}>{title}</Text>}
        </Pressable>
    );
}

export function Card({ title, children }) {
    return (
        <View style={styles.card}>
            {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
            {children}
        </View>
    );
}

export function Message({ text, kind = "error" }) {
    if (!text) return null;
    const bg = kind === "ok" ? colors.brandSoft : kind === "warn" ? colors.amberSoft : colors.redSoft;
    const fg = kind === "ok" ? colors.brandDark : kind === "warn" ? colors.amber : colors.red;
    return (
        <View style={[styles.message, { backgroundColor: bg }]}>
            <Text style={{ color: fg }}>{text}</Text>
        </View>
    );
}

export function Row({ left, right, sub }) {
    return (
        <View style={styles.row}>
            <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{left}</Text>
                {sub ? <Text style={styles.muted}>{sub}</Text> : null}
            </View>
            {typeof right === "string" || typeof right === "number" ? <Text style={styles.rowRight}>{right}</Text> : right}
        </View>
    );
}

export const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    body: { padding: 16, gap: 14 },
    header: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "white", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
    emblem: { width: 46, height: 30 },
    college: { fontSize: 9, letterSpacing: 0.5, color: colors.ink },
    title: { fontSize: 18, fontWeight: "700", color: colors.brand },
    button: { backgroundColor: colors.brand, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" },
    secondary: { backgroundColor: "white", borderWidth: 1, borderColor: colors.brand },
    danger: { backgroundColor: "white", borderWidth: 1, borderColor: "#fecaca" },
    buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
    card: { backgroundColor: "white", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.line, gap: 10 },
    cardTitle: { fontSize: 17, fontWeight: "700", color: colors.brandDark },
    message: { padding: 12, borderRadius: 8 },
    row: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line, gap: 8 },
    rowText: { fontSize: 15, color: colors.text },
    rowRight: { fontSize: 15, fontWeight: "600", color: colors.text },
    muted: { fontSize: 13, color: colors.muted },
    label: { fontSize: 13, color: colors.muted, marginBottom: 4 },
    input: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: "white" },
    big: { fontSize: 22, fontWeight: "700", color: colors.text, textAlign: "center" },
});
