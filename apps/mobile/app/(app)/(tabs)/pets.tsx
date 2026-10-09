import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePets } from "../../../src/api/hooks";

export default function PetsScreen() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const { data: pets } = usePets(search, { requireSearch: false });

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.header}>Pets</Text>
      <TextInput
        style={styles.input}
        placeholder="Search pets"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />
      <FlatList
        data={pets ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => router.push(`/pet/${item.id}`)}>
            <Text style={styles.petName}>{item.name}</Text>
            <Text style={styles.meta}>
              {item.species} {item.owner_name ? `· ${item.owner_name}` : ""}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 10 },
  header: { fontSize: 22, fontWeight: "700" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  list: { gap: 8, paddingVertical: 8 },
  row: { backgroundColor: "#f5f5f5", borderRadius: 10, padding: 14, gap: 2 },
  petName: { fontSize: 17, fontWeight: "600" },
  meta: { color: "#666" },
});
