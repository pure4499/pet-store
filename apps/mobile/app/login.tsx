import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/api/authContext";
import { ApiError } from "../src/api/client";
import { API_URL } from "../src/api/config";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown network error";
      Alert.alert("Sign in failed", `${message}\n\nAPI: ${API_URL}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brand}>
            <View style={styles.mark}>
              <Text style={styles.markText}>TT</Text>
            </View>
            <Text style={styles.eyebrow}>UCBARKLEY</Text>
            <Text style={styles.title}>Staff sign in</Text>
            <Text style={styles.subtitle}>Capture the moments pet families are waiting for.</Text>
          </View>
          <View style={styles.form}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@facility.com"
              placeholderTextColor="#98A39F"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              returnKeyType="next"
              value={email}
              onChangeText={setEmail}
            />
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your password"
              placeholderTextColor="#98A39F"
              autoComplete="current-password"
              returnKeyType="done"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => {
                if (!isSubmitting && email && password) void handleSubmit();
              }}
            />
            <TouchableOpacity
              style={[styles.button, (isSubmitting || !email || !password) && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={isSubmitting || !email || !password}
            >
              {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F4F1E8" },
  keyboardAvoider: { flex: 1 },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#F4F1E8",
  },
  brand: { alignItems: "center", marginBottom: 34 },
  mark: {
    width: 64,
    height: 64,
    borderRadius: 21,
    backgroundColor: "#176B5B",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  markText: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", letterSpacing: -1 },
  eyebrow: { color: "#176B5B", fontSize: 11, fontWeight: "800", letterSpacing: 1.6 },
  title: { color: "#173B35", fontSize: 31, fontWeight: "800", marginTop: 5 },
  subtitle: { color: "#65736F", fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8, maxWidth: 290 },
  form: { backgroundColor: "#FFFFFF", borderRadius: 22, padding: 18, gap: 8 },
  label: { color: "#344B46", fontSize: 13, fontWeight: "700", marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#DDE3DE",
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontSize: 16,
    color: "#173B35",
    backgroundColor: "#FAFBF8",
  },
  button: { backgroundColor: "#176B5B", borderRadius: 14, padding: 15, alignItems: "center", marginTop: 10 },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
