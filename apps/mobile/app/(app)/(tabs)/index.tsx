import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useActiveSessions } from "../../../src/api/hooks";
import { useAuth } from "../../../src/api/authContext";

export default function ActivePetsScreen() {
  const router = useRouter();
  const { data: sessions, isLoading, refetch, isRefetching } = useActiveSessions();
  const { selectedFacility } = useAuth();
  const [failedThumbnailUrls, setFailedThumbnailUrls] = useState<Record<string, string>>({});

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>{selectedFacility?.name.toUpperCase() ?? "UCBARKLEY"}</Text>
          <Text style={styles.title}>Checked-in pets</Text>
          <Text style={styles.subtitle}>{sessions?.length ?? 0} pets currently in your care</Text>
        </View>
        <TouchableOpacity style={styles.cameraButton} onPress={() => router.push("/photos")}>
          <Ionicons name="camera" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <FlatList
        data={sessions ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#176B5B" />}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.emptyCard}>
              <Ionicons name="paw-outline" size={36} color="#8AA098" />
              <Text style={styles.emptyTitle}>No pets checked in</Text>
              <Text style={styles.emptyCopy}>Pull down to refresh when a new stay begins.</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const photoCount = Number(item.photo_count ?? 0);
          const thumbnailUrl = item.photo_thumbnail_url as string | null | undefined;
          const showThumbnail = Boolean(thumbnailUrl) && failedThumbnailUrls[item.id] !== thumbnailUrl;
          return (
            <TouchableOpacity style={styles.petCard} onPress={() => router.push(`/session/${item.id}`)}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.pet_name?.slice(0, 1).toUpperCase()}</Text>
                {showThumbnail && (
                  <Image
                    source={{ uri: thumbnailUrl! }}
                    style={styles.avatarImage}
                    resizeMode="cover"
                    accessibilityLabel={`Latest photo of ${item.pet_name}`}
                    onError={() =>
                      setFailedThumbnailUrls((current) => ({ ...current, [item.id]: thumbnailUrl! }))
                    }
                  />
                )}
              </View>
              <View style={styles.petCopy}>
                <View style={styles.nameRow}>
                  <Text style={styles.petName}>{item.pet_name}</Text>
                  {item.collar_enabled && (
                    <View style={styles.collarChip}>
                      <View
                        style={[
                          styles.collarSwatch,
                          { backgroundColor: item.collar_color_hex ?? "#D1D8D5" },
                        ]}
                      />
                      <Text style={styles.collarText}>
                        {item.collar_label ?? item.collar_color_name ?? "Collar assigned"}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.meta}>
                  {item.species} · {item.session_type}
                </Text>
              </View>
              <View style={[styles.photoBadge, photoCount === 0 && styles.photoBadgeEmpty]}>
                <Ionicons name="images-outline" size={15} color={photoCount === 0 ? "#A45A4C" : "#176B5B"} />
                <Text style={[styles.photoCount, photoCount === 0 && styles.photoCountEmpty]}>{photoCount}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F7F3" },
  header: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrow: { color: "#176B5B", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#173B35", fontSize: 29, fontWeight: "800", marginTop: 4 },
  subtitle: { color: "#6E7D79", fontSize: 14, marginTop: 5 },
  cameraButton: {
    width: 50,
    height: 50,
    borderRadius: 16,
    backgroundColor: "#176B5B",
    alignItems: "center",
    justifyContent: "center",
  },
  list: { paddingHorizontal: 18, paddingBottom: 32, gap: 10 },
  petCard: {
    minHeight: 82,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E7EAE5",
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 17,
    backgroundColor: "#DDF0E8",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: { color: "#176B5B", fontSize: 19, fontWeight: "800" },
  avatarImage: { position: "absolute", inset: 0 },
  petCopy: { flex: 1, paddingHorizontal: 12 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  petName: { color: "#173B35", fontSize: 17, fontWeight: "800" },
  meta: { color: "#75817E", fontSize: 13, marginTop: 4, textTransform: "capitalize" },
  collarChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#F1F5F3", paddingHorizontal: 7, paddingVertical: 4, borderRadius: 8 },
  collarSwatch: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: "rgba(0,0,0,0.16)" },
  collarText: { color: "#38524B", fontSize: 10, fontWeight: "800" },
  photoBadge: {
    minWidth: 46,
    height: 34,
    paddingHorizontal: 9,
    borderRadius: 12,
    backgroundColor: "#EAF5F0",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  photoBadgeEmpty: { backgroundColor: "#F8ECE8" },
  photoCount: { color: "#176B5B", fontSize: 13, fontWeight: "800" },
  photoCountEmpty: { color: "#A45A4C" },
  emptyCard: { alignItems: "center", padding: 36, backgroundColor: "#FFFFFF", borderRadius: 20, marginTop: 12 },
  emptyTitle: { color: "#173B35", fontSize: 17, fontWeight: "800", marginTop: 12 },
  emptyCopy: { color: "#75817E", fontSize: 13, marginTop: 5, textAlign: "center" },
});
