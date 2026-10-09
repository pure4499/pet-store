import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, Image, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useActiveSessions, useOrganization } from "../../../src/api/hooks";
import { usePhotoDrafts } from "../../../src/photos/photoDraftContext";

export default function CoverageScreen() {
  const router = useRouter();
  const { data: sessions, refetch, isRefetching } = useActiveSessions();
  const { data: facility } = useOrganization();
  const { drafts } = usePhotoDrafts();
  const [failedThumbnailUrls, setFailedThumbnailUrls] = useState<Record<string, string>>({});
  const target = Number(facility?.best_photo_count ?? 8);

  const coverage = (sessions ?? []).map((session) => {
    const confirmedCount = Number(session.photo_count ?? 0);
    const localDraftCount = drafts.filter(
      (draft) => draft.mediaType === "image" && draft.selected && draft.assignedSessionIds.includes(session.id)
    ).length;
    const count = confirmedCount + localDraftCount;
    return { ...session, confirmedCount, localDraftCount, count, remaining: Math.max(target - count, 0) };
  });
  const covered = coverage.filter((item) => item.remaining === 0).length;
  const needsPhotos = coverage.filter((item) => item.remaining > 0);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>PHOTO COVERAGE</Text>
        <Text style={styles.title}>Who needs photos?</Text>
        <Text style={styles.subtitle}>Confirmed photos from all staff, plus selected photos in this phone’s unsent batch.</Text>
      </View>

      <View style={styles.summaryCard}>
        <View>
          <Text style={styles.summaryNumber}>{covered}/{coverage.length}</Text>
          <Text style={styles.summaryLabel}>pets at target</Text>
        </View>
        <View style={styles.targetPill}>
          <Ionicons name="flag-outline" size={16} color="#176B5B" />
          <Text style={styles.targetText}>Target {target} each</Text>
        </View>
      </View>

      <View style={styles.listHeader}>
        <Text style={styles.sectionTitle}>Needs more photos</Text>
        <Text style={styles.sectionCount}>{needsPhotos.length}</Text>
      </View>

      <FlatList
        data={coverage.sort((a, b) => b.remaining - a.remaining)}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#176B5B" />}
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Ionicons name="checkmark-circle" size={38} color="#176B5B" />
            <Text style={styles.emptyTitle}>No active pets</Text>
          </View>
        }
        renderItem={({ item }) => {
          const complete = item.remaining === 0;
          const progress = Math.min(item.count / target, 1);
          const thumbnailUrl = item.photo_thumbnail_url as string | null | undefined;
          const showThumbnail = Boolean(thumbnailUrl) && failedThumbnailUrls[item.id] !== thumbnailUrl;
          return (
            <View style={styles.petCard}>
              <View style={styles.petRow}>
                <View style={[styles.avatar, complete && styles.avatarComplete]}>
                  <Text style={[styles.avatarText, complete && styles.avatarTextComplete]}>
                    {item.pet_name?.slice(0, 1).toUpperCase()}
                  </Text>
                  {showThumbnail && (
                    <Image
                      source={{ uri: thumbnailUrl! }}
                      style={styles.avatarImage}
                      resizeMode="cover"
                      accessibilityLabel={`Current photo of ${item.pet_name}`}
                      onError={() =>
                        setFailedThumbnailUrls((current) => ({ ...current, [item.id]: thumbnailUrl! }))
                      }
                    />
                  )}
                </View>
                <View style={styles.petCopy}>
                  <Text style={styles.petName}>{item.pet_name}</Text>
                  <Text style={[styles.status, complete && styles.statusComplete]}>
                    {complete ? "Target reached" : `${item.remaining} more needed`}
                    {item.localDraftCount > 0 ? ` · ${item.localDraftCount} in this batch` : ""}
                  </Text>
                </View>
                <Text style={styles.count}>{item.count}/{target}</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.progress, { width: `${progress * 100}%` }]} />
              </View>
            </View>
          );
        }}
      />

      <TouchableOpacity style={styles.captureButton} onPress={() => router.push("/photos")}>
        <Ionicons name="camera" size={20} color="#FFFFFF" />
        <Text style={styles.captureButtonText}>Continue capturing</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F7F3", paddingHorizontal: 18 },
  header: { paddingTop: 12, paddingBottom: 18 },
  eyebrow: { color: "#176B5B", fontSize: 11, fontWeight: "800", letterSpacing: 1.3 },
  title: { color: "#173B35", fontSize: 29, fontWeight: "800", marginTop: 4 },
  subtitle: { color: "#6E7D79", fontSize: 13, lineHeight: 19, marginTop: 6 },
  summaryCard: {
    backgroundColor: "#173B35",
    borderRadius: 20,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  summaryNumber: { color: "#FFFFFF", fontSize: 28, fontWeight: "800" },
  summaryLabel: { color: "#BFD2CC", fontSize: 13, marginTop: 2 },
  targetPill: {
    backgroundColor: "#DDF0E8",
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  targetText: { color: "#176B5B", fontSize: 12, fontWeight: "800" },
  listHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 10 },
  sectionTitle: { color: "#173B35", fontSize: 17, fontWeight: "800" },
  sectionCount: {
    color: "#A45A4C",
    backgroundColor: "#F8ECE8",
    borderRadius: 9,
    paddingHorizontal: 7,
    paddingVertical: 2,
    fontSize: 12,
    fontWeight: "800",
  },
  list: { gap: 10, paddingBottom: 100 },
  petCard: { backgroundColor: "#FFFFFF", borderRadius: 17, padding: 13, borderWidth: 1, borderColor: "#E7EAE5" },
  petRow: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "#F8ECE8",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarComplete: { backgroundColor: "#DDF0E8" },
  avatarText: { color: "#A45A4C", fontSize: 16, fontWeight: "800" },
  avatarTextComplete: { color: "#176B5B" },
  avatarImage: { position: "absolute", inset: 0 },
  petCopy: { flex: 1, paddingHorizontal: 11 },
  petName: { color: "#173B35", fontSize: 16, fontWeight: "800" },
  status: { color: "#A45A4C", fontSize: 12, marginTop: 3, fontWeight: "600" },
  statusComplete: { color: "#176B5B" },
  count: { color: "#52645F", fontSize: 14, fontWeight: "800" },
  track: { height: 5, borderRadius: 3, backgroundColor: "#E8ECE7", marginTop: 12, overflow: "hidden" },
  progress: { height: "100%", borderRadius: 3, backgroundColor: "#48A285" },
  emptyCard: { alignItems: "center", padding: 28, backgroundColor: "#FFFFFF", borderRadius: 18 },
  emptyTitle: { color: "#173B35", fontSize: 16, fontWeight: "800", marginTop: 8 },
  captureButton: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 14,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: "#176B5B",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  captureButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
});
