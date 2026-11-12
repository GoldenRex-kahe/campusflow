// CampusFlow mobile app (students and faculty).
// Opens the right screen: login, student home or faculty home.
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { api, init, logout } from "./src/api";
import FacultyScreen from "./src/screens/FacultyScreen";
import LoginScreen from "./src/screens/LoginScreen";
import StudentScreen from "./src/screens/StudentScreen";
import { colors, styles } from "./src/ui";

export default function App() {
    const [me, setMe] = useState(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        (async () => {
            const { loggedIn } = await init();
            if (loggedIn) {
                try {
                    setMe(await api.get("/me"));
                } catch {
                    await logout();
                }
            }
            setReady(true);
        })();
    }, []);

    const onLogout = useCallback(async () => {
        await logout();
        setMe(null);
    }, []);

    if (!ready) {
        return (
            <View style={[styles.screen, { justifyContent: "center" }]}>
                <ActivityIndicator color={colors.brand} size="large" />
            </View>
        );
    }

    return (
        <>
            <StatusBar style="dark" />
            {!me ? <LoginScreen onLoggedIn={setMe} /> : null}
            {me && me.role === "student" ? <StudentScreen me={me} onLogout={onLogout} /> : null}
            {me && me.role === "faculty" ? <FacultyScreen me={me} onLogout={onLogout} /> : null}
        </>
    );
}
