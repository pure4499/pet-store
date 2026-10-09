import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/api/authContext";
import { useFacilities } from "../src/api/hooks";

export default function FacilityScreen() {
  const { selectFacility, signOut } = useAuth();
  const { data: facilities, isLoading, isError, refetch } = useFacilities();

  return (
    <SafeAreaView style={styles.container}>
      <View>
        <Text style={styles.eyebrow}>UCBARKLEY STAFF</Text>
        <Text style={styles.title}>Choose your facility</Text>
        <Text style={styles.description}>
          Your active pets and photo queue will be scoped to this location.
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#176B5B" />
      ) : isError ? (
        <View style={styles.messageCard}>
          <Text style={styles.messageTitle}>Couldn&apos;t load your facility</Text>
          <TouchableOpacity onPress={() => refetch()}>
            <Text style={styles.link}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.facilityList}>
          {(facilities ?? []).map((facility) => <TouchableOpacity key={facility.id} style={styles.facilityCard} onPress={() => void selectFacility(facility)}>
            <View style={styles.facilityMark}>
              <Text style={styles.facilityMarkText}>{facility.name.slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.facilityCopy}>
              <Text style={styles.facilityName}>{facility.name}</Text>
              <Text style={styles.facilityMeta}>{facility.is_default ? "Primary location" : "Staff workspace"} · Tap to continue</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>)}
          {facilities?.length === 0 && <View style={styles.messageCard}><Text style={styles.messageTitle}>No locations assigned</Text><Text style={styles.facilityMeta}>Ask an owner administrator to assign this account to a location.</Text></View>}
        </View>
      )}

      <TouchableOpacity style={styles.signOut} onPress={signOut}>
        <Text style={styles.signOutText}>Sign in with another account</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F4F1E8",
    paddingHorizontal: 24,
    paddingTop: 40,
    paddingBottom: 24,
    justifyContent: "space-between",
  },
  eyebrow: { color: "#176B5B", fontSize: 12, fontWeight: "800", letterSpacing: 1.6 },
  title: { color: "#173B35", fontSize: 34, fontWeight: "800", marginTop: 12 },
  description: { color: "#52645F", fontSize: 16, lineHeight: 23, marginTop: 10, maxWidth: 320 },
  facilityCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 18,
    shadowColor: "#173B35",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  facilityList: { gap: 12 },
  facilityMark: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "#DDF0E8",
    alignItems: "center",
    justifyContent: "center",
  },
  facilityMarkText: { color: "#176B5B", fontSize: 22, fontWeight: "800" },
  facilityCopy: { flex: 1, paddingHorizontal: 14 },
  facilityName: { color: "#173B35", fontSize: 18, fontWeight: "700" },
  facilityMeta: { color: "#71807C", fontSize: 13, marginTop: 4 },
  arrow: { color: "#176B5B", fontSize: 34, fontWeight: "300" },
  messageCard: { backgroundColor: "#FFFFFF", borderRadius: 18, padding: 20, gap: 12 },
  messageTitle: { color: "#173B35", fontSize: 17, fontWeight: "700" },
  link: { color: "#176B5B", fontWeight: "700" },
  signOut: { alignItems: "center", padding: 12 },
  signOutText: { color: "#65736F", fontSize: 14, fontWeight: "600" },
});
