import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { AuthProvider, useAuth } from "../src/api/authContext";
import { queryClient } from "../src/lib/queryClient";
import { PhotoDraftProvider } from "../src/photos/photoDraftContext";
import { OfflineCheckInSync } from "../src/checkIn/OfflineCheckInSync";

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OfflineCheckInSync />
        <PhotoDraftProvider>
          <RootNavigator />
        </PhotoDraftProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function RootNavigator() {
  const { isSignedIn, isLoading, hasSelectedFacility } = useAuth();

  // Avoids a flash of the login screen while the stored token is still being read.
  if (isLoading) return null;

  return (
    <Stack>
      <Stack.Protected guard={isSignedIn && hasSelectedFacility}>
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={isSignedIn && !hasSelectedFacility}>
        <Stack.Screen name="facility" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}
