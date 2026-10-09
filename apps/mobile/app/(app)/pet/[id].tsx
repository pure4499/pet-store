import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  useHouseholdReports,
  useLinkHousehold,
  useOwners,
  usePet,
  usePetPublishedPhotos,
  useSendReport,
} from "../../../src/api/hooks";

export default function PetProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: pet } = usePet(id);
  const { data: photos } = usePetPublishedPhotos(id);
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  if (!pet) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{pet.name}</Text>
      <Text style={styles.meta}>
        {pet.species} {pet.breed ? `· ${pet.breed}` : ""} {pet.owner_name ? `· Owner: ${pet.owner_name}` : ""}
      </Text>

      <Text style={styles.subHeader}>Household</Text>
      {pet.household ? (
        <HouseholdCard household={pet.household} />
      ) : pet.owner_id ? (
        <TouchableOpacity style={styles.linkButton} onPress={() => setLinkModalOpen(true)}>
          <Text style={styles.linkButtonText}>+ Link to another family member</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.meta}>This pet has no owner on file yet.</Text>
      )}

      <Text style={styles.subHeader}>Stay History</Text>
      <FlatList
        data={pet.sessions ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => router.push(`/session/${item.id}`)}>
            <Text style={styles.rowTitle}>
              {item.session_type} · {new Date(item.check_in_at).toLocaleDateString()}
            </Text>
            <Text style={styles.meta}>{item.status}</Text>
          </TouchableOpacity>
        )}
        style={styles.sessionList}
      />

      <Text style={styles.subHeader}>Photo Album</Text>
      <FlatList
        data={photos ?? []}
        keyExtractor={(item) => item.id}
        numColumns={3}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => (
          <Image source={{ uri: item.viewUrl }} style={styles.thumb} />
        )}
        ListEmptyComponent={<Text style={styles.meta}>No published photos yet.</Text>}
      />

      <LinkHouseholdModal
        visible={linkModalOpen}
        ownerId={pet.owner_id}
        petId={id}
        onClose={() => setLinkModalOpen(false)}
      />
    </View>
  );
}

function HouseholdCard({ household }: { household: any }) {
  const sendReport = useSendReport(household.id);
  const { data: reports } = useHouseholdReports(household.id);

  const handleSendReport = async () => {
    try {
      const result = await sendReport.mutateAsync(undefined);
      Alert.alert("Report sent", `Sent to ${result.recipients.join(", ")}`);
    } catch (err: any) {
      Alert.alert("Couldn't send report", err?.message ?? "Please try again.");
    }
  };

  return (
    <View style={styles.householdCard}>
      {household.members.map((member: any) => (
        <Text key={member.ownerId} style={styles.meta}>
          {member.ownerName}
          {member.pets.length > 0 ? ` — ${member.pets.map((p: any) => p.name).join(", ")}` : ""}
        </Text>
      ))}
      <TouchableOpacity style={styles.linkButton} onPress={handleSendReport} disabled={sendReport.isPending}>
        <Text style={styles.linkButtonText}>{sendReport.isPending ? "Sending…" : "Send Today's Report"}</Text>
      </TouchableOpacity>
      {(reports ?? []).length > 0 && (
        <View style={styles.reportsList}>
          {reports!.map((r: any) => (
            <Text key={r.id} style={styles.reportRow}>
              Sent {new Date(r.sent_at).toLocaleString()} for {r.report_date}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function LinkHouseholdModal({
  visible,
  ownerId,
  petId,
  onClose,
}: {
  visible: boolean;
  ownerId: string | undefined;
  petId: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const { data: owners } = useOwners(search);
  const linkHousehold = useLinkHousehold(petId);

  const handlePick = async (otherOwnerId: string) => {
    if (!ownerId) return;
    try {
      await linkHousehold.mutateAsync({ ownerId, otherOwnerId });
      setSearch("");
      onClose();
    } catch (err: any) {
      Alert.alert("Couldn't link household", err?.message ?? "Please try again.");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.subHeader}>Link to another family member</Text>
          <TextInput
            style={styles.input}
            placeholder="Search owner name or phone"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <FlatList
            data={(owners ?? []).filter((o: any) => o.id !== ownerId)}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.row} onPress={() => handlePick(item.id)}>
                <Text style={styles.rowTitle}>{item.full_name}</Text>
                <Text style={styles.meta}>{item.phone}</Text>
              </TouchableOpacity>
            )}
          />
          <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  header: { fontSize: 24, fontWeight: "700" },
  subHeader: { fontSize: 17, fontWeight: "600", marginTop: 16 },
  meta: { color: "#666" },
  sessionList: { maxHeight: 200 },
  row: { backgroundColor: "#f5f5f5", borderRadius: 10, padding: 12, marginBottom: 6 },
  rowTitle: { fontWeight: "600" },
  grid: { gap: 4 },
  thumb: { width: 110, height: 110, borderRadius: 6, margin: 2, backgroundColor: "#eee" },
  householdCard: { backgroundColor: "#f5f5f5", borderRadius: 10, padding: 12, gap: 4 },
  linkButton: { backgroundColor: "#2f6690", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 8 },
  linkButtonText: { color: "#fff", fontWeight: "600" },
  reportsList: { marginTop: 8, gap: 2 },
  reportRow: { color: "#888", fontSize: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 8 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: "70%" },
  cancelButton: { padding: 14, alignItems: "center" },
  cancelButtonText: { color: "#888" },
});
