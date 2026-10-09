import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../../src/api/authContext";
import { useFacilities, useOrganization } from "../../../src/api/hooks";
import { usePhotoDrafts } from "../../../src/photos/photoDraftContext";

export default function MoreScreen() {
  const { signOut, selectedFacility, selectFacility } = useAuth();
  const { data: organization } = useOrganization();
  const { data: facilities } = useFacilities();
  const { drafts } = usePhotoDrafts();

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>UCBARKLEY STAFF</Text>
      <Text style={styles.header}>Workspace</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Selected facility</Text>
        <Text style={styles.value}>{selectedFacility?.name ?? "…"}</Text>
        {(facilities?.length ?? 0) > 1 && <View style={styles.locationList}>
          {facilities?.map((facility) => {
            const selected = facility.id === selectedFacility?.id;
            return <TouchableOpacity
              key={facility.id}
              style={[styles.locationButton, selected && styles.locationButtonSelected]}
              disabled={selected}
              onPress={() => void selectFacility(facility)}
            >
              <View style={[styles.locationDot, selected && styles.locationDotSelected]} />
              <Text style={[styles.locationName, selected && styles.locationNameSelected]}>{facility.name}</Text>
              <Text style={[styles.locationAction, selected && styles.locationNameSelected]}>{selected ? "Current" : "Switch"}</Text>
            </TouchableOpacity>;
          })}
        </View>}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Photo target per pet</Text>
        <Text style={styles.value}>{organization?.best_photo_count ?? "…"}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Local photo drafts</Text>
        <Text style={styles.value}>{drafts.length}</Text>
      </View>
      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F6F7F3" },
  container: { flexGrow: 1, padding: 18, gap: 12 },
  eyebrow: { color: "#176B5B", fontSize: 11, fontWeight: "800", letterSpacing: 1.3 },
  header: { color: "#173B35", fontSize: 29, fontWeight: "800", marginBottom: 8 },
  card: { backgroundColor: "#FFFFFF", borderRadius: 17, padding: 16, gap: 4, borderWidth: 1, borderColor: "#E7EAE5" },
  label: { color: "#75817E", fontSize: 13 },
  value: { color: "#173B35", fontSize: 17, fontWeight: "700" },
  locationList: { gap: 8, marginTop: 10 },
  locationButton: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: 13, paddingHorizontal: 12, backgroundColor: "#F3F6F4" },
  locationButtonSelected: { backgroundColor: "#E2F1EB", borderWidth: 1, borderColor: "#9FC7BB" },
  locationDot: { width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: "#8AA098" },
  locationDotSelected: { borderColor: "#176B5B", backgroundColor: "#176B5B" },
  locationName: { flex: 1, color: "#52645F", fontSize: 14, fontWeight: "700" },
  locationNameSelected: { color: "#176B5B" },
  locationAction: { color: "#176B5B", fontSize: 12, fontWeight: "800" },
  signOutButton: { padding: 14, alignItems: "center", marginTop: 16 },
  signOutText: { color: "#c0392b", fontSize: 16, fontWeight: "600" },
});
