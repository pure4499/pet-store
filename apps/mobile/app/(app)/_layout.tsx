import { Stack } from "expo-router";

export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="pet/[id]" options={{ title: "Pet Profile" }} />
      <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
      <Stack.Screen name="identity/[id]" options={{ title: "Pet Photo Setup" }} />
    </Stack>
  );
}
