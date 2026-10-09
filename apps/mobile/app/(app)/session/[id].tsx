import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { CARE_LOG_PRESETS, type CareLogPresetId } from "@ucbarkley/shared-types";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  useCheckOut,
  useCreateLogEntry,
  useDailyLogs,
  useSession,
  useSessionPhotos,
} from "../../../src/api/hooks";

type SessionTab = "log" | "photos";

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [view, setView] = useState<SessionTab>("log");
  const { data: session } = useSession(id);
  const checkOut = useCheckOut();

  if (!session) return null;

  const handleCheckOut = () => {
    Alert.alert("Check out", `Check out ${session.pet_name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Check Out",
        onPress: async () => {
          await checkOut.mutateAsync(id);
          router.back();
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.header}>{session.pet_name}</Text>
          <Text style={styles.meta}>
            {session.species} · {session.session_type}
            {session.collar_enabled ? ` · Collar: ${session.collar_label ?? session.collar_color_name ?? "assigned"}` : ""}
          </Text>
        </View>
        {session.status === "active" && (
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.aiButton} onPress={() => router.push(`/identity/${id}`)}>
              <Text style={styles.aiButtonText}>Update AI photos</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.checkOutButton} onPress={handleCheckOut}>
              <Text style={styles.checkOutButtonText}>Check Out</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.segmentRow}>
        <TouchableOpacity
          style={[styles.segment, view === "log" && styles.segmentActive]}
          onPress={() => setView("log")}
        >
          <Text style={view === "log" ? styles.segmentTextActive : styles.segmentText}>Daily Log</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segment, view === "photos" && styles.segmentActive]}
          onPress={() => setView("photos")}
        >
          <Text style={view === "photos" ? styles.segmentTextActive : styles.segmentText}>Photos</Text>
        </TouchableOpacity>
      </View>

      {view === "log" ? <DailyLogView sessionId={id} /> : <SessionPhotosView sessionId={id} />}
    </KeyboardAvoidingView>
  );
}

function DailyLogView({ sessionId }: { sessionId: string }) {
  const logListRef = useRef<FlatList<any>>(null);
  const { data: logs } = useDailyLogs(sessionId);
  const createLog = useCreateLogEntry(sessionId);
  const [details, setDetails] = useState("");
  const [presetId, setPresetId] = useState<CareLogPresetId | null>(null);
  const [entryDate, setEntryDate] = useState(currentDateValue());
  const [entryTime, setEntryTime] = useState(currentTimeValue());

  const revealComposer = () => {
    setTimeout(() => logListRef.current?.scrollToEnd({ animated: true }), 300);
  };

  const saveUpdate = async () => {
    const preset = CARE_LOG_PRESETS.find((item) => item.id === presetId);
    if (!preset && !details.trim()) return;
    await createLog.mutateAsync({
      entryType: preset?.entryType ?? "note",
      entryAt: isoForLocalDateTime(entryDate, entryTime),
      title: preset?.label ?? "Staff note",
      body: details.trim() || preset?.defaultBody,
      structuredData: preset ? { presetId: preset.id, status: "completed", source: "staff_mobile" } : { source: "staff_mobile" },
    });
    setPresetId(null);
    setDetails("");
    setEntryDate(currentDateValue());
    setEntryTime(currentTimeValue());
  };

  return (
    <FlatList
      ref={logListRef}
      style={styles.flex}
      contentContainerStyle={styles.dailyLogContent}
      data={logs ?? []}
      keyExtractor={(item) => item.id}
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{item.title ?? item.entry_type}</Text>
          <Text style={styles.meta}>{item.body ?? item.title}</Text>
          <Text style={styles.timestamp}>{new Date(item.entry_at).toLocaleString()}{item.created_by_name ? ` · ${item.created_by_name}` : ""}</Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.meta}>No log entries yet.</Text>}
      ListFooterComponent={
        <View style={styles.logComposer}>
          <Text style={styles.composerTitle}>Quick care update</Text>
          <Text style={styles.composerHint}>Choose a standard update. Add details only when helpful.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow} keyboardShouldPersistTaps="handled">
            {CARE_LOG_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={[styles.presetButton, presetId === preset.id && styles.presetButtonSelected]}
                onPress={() => setPresetId((current) => current === preset.id ? null : preset.id)}
              >
                <Text style={styles.presetIcon}>{preset.icon}</Text>
                <Text style={[styles.presetText, presetId === preset.id && styles.presetTextSelected]}>{preset.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TextInput
            style={styles.logInput}
            placeholder="Optional details, amount eaten, mood…"
            value={details}
            onChangeText={setDetails}
            onFocus={revealComposer}
            multiline
          />
          <View style={styles.dateTimeSection}>
            <View><Text style={styles.timeLabel}>Date & time</Text><Text style={styles.composerHint}>Change these when recording an earlier activity.</Text></View>
            <View style={styles.dateTimeInputs}>
              <TextInput
                style={[styles.timeInput, styles.dateInput]}
                value={entryDate}
                onChangeText={setEntryDate}
                onFocus={revealComposer}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                maxLength={10}
              />
              <TextInput
                style={styles.timeInput}
                value={entryTime}
                onChangeText={setEntryTime}
                onFocus={revealComposer}
                placeholder="HH:MM"
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                maxLength={5}
              />
            </View>
          </View>
          <TouchableOpacity
            style={[styles.addButton, (!presetId && !details.trim()) && styles.addButtonDisabled]}
            disabled={createLog.isPending || !isValidDate(entryDate) || !isValidTime(entryTime) || (!presetId && !details.trim())}
            onPress={() => void saveUpdate()}
          >
            <Text style={styles.addButtonText}>{createLog.isPending ? "Saving…" : "Save update"}</Text>
          </TouchableOpacity>
        </View>
      }
    />
  );
}

function SessionPhotosView({ sessionId }: { sessionId: string }) {
  const { data: published } = useSessionPhotos(sessionId, "published");
  const { data: candidates } = useSessionPhotos(sessionId, "candidate");
  const { data: pending } = useSessionPhotos(sessionId, "pending");

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.photoSections}>
      <PhotoSection
        title="Approved & published"
        photos={published ?? []}
        emptyMessage="No published photos yet."
      />
      <PhotoSection
        title="Selected for admin review"
        photos={candidates ?? []}
        emptyMessage="No processed selections yet."
      />
      <PhotoSection
        title="Processing or not selected"
        photos={pending ?? []}
        emptyMessage="No photos waiting for processing."
      />
    </ScrollView>
  );
}

function PhotoSection({ title, photos, emptyMessage }: { title: string; photos: any[]; emptyMessage: string }) {
  return <View>
    <Text style={styles.subHeader}>{title} ({photos.length})</Text>
    {photos.length > 0
      ? <View style={styles.grid}>{photos.map((photo) => <Image key={photo.id} source={{ uri: photo.viewUrl }} style={styles.thumb} />)}</View>
      : <Text style={styles.meta}>{emptyMessage}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 10 },
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  header: { fontSize: 24, fontWeight: "700" },
  subHeader: { fontSize: 16, fontWeight: "600", marginTop: 12, marginBottom: 4 },
  meta: { color: "#666" },
  timestamp: { color: "#aaa", fontSize: 12 },
  checkOutButton: { backgroundColor: "#c0392b", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  checkOutButtonText: { color: "#fff", fontWeight: "600" },
  headerActions: { gap: 7, alignItems: "flex-end" },
  aiButton: { backgroundColor: "#dff0e9", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  aiButtonText: { color: "#176b5b", fontWeight: "700", fontSize: 12 },
  segmentRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  segment: { flex: 1, alignItems: "center", padding: 10, borderRadius: 8, backgroundColor: "#f0f0f0" },
  segmentActive: { backgroundColor: "#2f6690" },
  segmentText: { color: "#333" },
  segmentTextActive: { color: "#fff", fontWeight: "600" },
  row: { backgroundColor: "#f5f5f5", borderRadius: 10, padding: 12, marginBottom: 6 },
  rowTitle: { fontWeight: "600", textTransform: "capitalize" },
  dailyLogContent: { paddingBottom: 24 },
  logComposer: { gap: 8, marginTop: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#ddd" },
  composerTitle: { fontSize: 16, fontWeight: "700", color: "#163f38" },
  composerHint: { color: "#687a75", fontSize: 12 },
  presetRow: { gap: 8, paddingVertical: 2 },
  presetButton: { minWidth: 88, alignItems: "center", gap: 3, borderWidth: 1, borderColor: "#cddbd6", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#fff" },
  presetButtonSelected: { borderColor: "#176b5b", backgroundColor: "#e4f3ed" },
  presetIcon: { fontSize: 18 },
  presetText: { color: "#38544d", fontSize: 11, fontWeight: "600" },
  presetTextSelected: { color: "#176b5b", fontWeight: "800" },
  logInput: { minHeight: 52, borderWidth: 1, borderColor: "#cddbd6", borderRadius: 10, padding: 10, textAlignVertical: "top", backgroundColor: "#fff" },
  dateTimeSection: { gap: 7 },
  dateTimeInputs: { flexDirection: "row", alignItems: "center", gap: 8 },
  timeLabel: { color: "#163f38", fontSize: 13, fontWeight: "700" },
  timeInput: { width: 82, borderWidth: 1, borderColor: "#cddbd6", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, color: "#163f38", backgroundColor: "#fff", textAlign: "center", fontWeight: "700" },
  dateInput: { flex: 1, width: undefined },
  addButton: { minHeight: 44, alignItems: "center", backgroundColor: "#176b5b", borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
  addButtonDisabled: { opacity: 0.45 },
  addButtonText: { color: "#fff", fontWeight: "600" },
  photoSections: { paddingBottom: 24, gap: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  thumb: { width: 110, height: 110, borderRadius: 6, margin: 2, backgroundColor: "#eee" },
});

function currentTimeValue(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function currentDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isValidTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isoForLocalDateTime(dateValue: string, timeValue: string) {
  if (!isValidDate(dateValue) || !isValidTime(timeValue)) return new Date().toISOString();
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hours, minutes] = timeValue.split(":").map(Number);
  const timestamp = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return timestamp.toISOString();
}
