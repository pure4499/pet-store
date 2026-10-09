import { useRouter } from "expo-router";
import { MAX_SOURCE_VIDEO_DURATION_SECONDS } from "@ucbarkley/shared-types";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useActiveSessions,
  useBatchCheckIn,
  useCheckIn,
  useCollarPalette,
  useCreateOwner,
  useCreatePet,
  usePets,
  usePendingCheckIns,
  useReservedSessions,
  useStartReservation,
} from "../../../src/api/hooks";
import { retryCurrentPendingCheckIns } from "../../../src/checkIn/offlineCheckInQueue";
import { apiFetch } from "../../../src/api/client";
import { uploadIdentityPhotoBatch, type PickedPhoto } from "../../../src/api/photoUpload";
import { uploadVideo, type PickedVideo } from "../../../src/api/videoUpload";
import { MAX_VIDEO_UPLOAD_BYTES } from "../../../src/photos/mediaPolicy";
import { preparePickedImage } from "../../../src/photos/preparePickedImage";

type Mode = "search" | "registerPet" | "checkIn" | "identity";

const COLLAR_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function collarIdFromQr(data: string) {
  return data.trim().match(COLLAR_ID_PATTERN)?.[0]?.toLowerCase() ?? null;
}

function formatScheduledArrival(value: string) {
  const scheduled = new Date(value);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const dateKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const day = dateKey(scheduled) === dateKey(today)
    ? "Today"
    : dateKey(scheduled) === dateKey(tomorrow)
      ? "Tomorrow"
      : scheduled.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
  return {
    day,
    time: scheduled.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

export default function CheckInScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("search");
  const [search, setSearch] = useState("");
  const [selectedPet, setSelectedPet] = useState<any>(null);
  const [selectedReservation, setSelectedReservation] = useState<any>(null);
  const [registrationOwner, setRegistrationOwner] = useState<any>(null);
  const [checkedInTargets, setCheckedInTargets] = useState<Array<{ sessionId: string; pet: any }>>([]);

  const { data: pets, isLoading } = usePets(search);
  const { data: activeSessions } = useActiveSessions();
  const { data: reservations, isLoading: reservationsLoading } = useReservedSessions();
  const { data: pendingCheckIns } = usePendingCheckIns();
  const [retrying, setRetrying] = useState(false);
  const pendingPetIds = new Set((pendingCheckIns ?? []).flatMap((job) => job.petIds));
  const pendingReservationIds = new Set((pendingCheckIns ?? []).map((job) => job.reservationId).filter(Boolean));
  const activePetIds = new Set([
    ...(activeSessions ?? []).map((session: any) => session.pet_id),
    ...pendingPetIds,
  ]);
  const expectedArrivals = [...(reservations ?? [])].filter((reservation: any) => !pendingReservationIds.has(reservation.id)).sort(
    (left: any, right: any) =>
      new Date(left.scheduled_check_in_at).getTime() - new Date(right.scheduled_check_in_at).getTime()
  );

  const reset = () => {
    setMode("search");
    setSearch("");
    setSelectedPet(null);
    setSelectedReservation(null);
    setRegistrationOwner(null);
    setCheckedInTargets([]);
  };

  const handleReservedArrival = (reservation: any) => {
    setSelectedReservation(reservation);
    setSelectedPet({
      id: reservation.pet_id,
      name: reservation.pet_name,
      species: reservation.species,
    });
    setMode("checkIn");
  };

  if (mode === "registerPet") {
    return (
      <RegisterPetForm
        existingOwner={registrationOwner}
        onCreated={(pet) => {
          setSelectedPet(pet);
          setMode("checkIn");
        }}
        onCancel={() => setMode("search")}
      />
    );
  }

  if (mode === "checkIn" && selectedPet) {
    return (
      <CheckInForm
        pet={selectedPet}
        reservation={selectedReservation}
        householdPets={selectedReservation ? [selectedPet] : (pets ?? []).filter((candidate: any) => candidate.owner_id && candidate.owner_id === selectedPet.owner_id && !activePetIds.has(candidate.id))}
        onDone={(targets) => {
          setCheckedInTargets(targets);
          setMode("identity");
        }}
        onQueued={() => {
          Alert.alert(
            "Check-in saved",
            "UCBarkley could not reach the server, so this check-in is safely saved on this phone. We’ll finish it automatically when the connection returns."
          );
          reset();
        }}
        onCancel={reset}
      />
    );
  }

  if (mode === "identity" && checkedInTargets.length > 0) {
    const current = checkedInTargets[0];
    return <IdentityEnrollmentScreen pet={current.pet} sessionId={current.sessionId} doneLabel={checkedInTargets.length > 1 ? `Next pet · ${checkedInTargets.length - 1} remaining` : undefined} onDone={() => {
      if (checkedInTargets.length > 1) {
        setCheckedInTargets((targets) => targets.slice(1));
        return;
      }
      const sessionId = current.sessionId;
      reset();
      router.push(`/session/${sessionId}`);
    }} />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <FlatList
        data={pets ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.checkInHeader}>
            <View>
              <Text style={styles.kicker}>FRONT DESK</Text>
              <Text style={styles.header}>Check in a pet</Text>
              <Text style={styles.headerHint}>Start an expected arrival or find an existing customer.</Text>
            </View>
            {(pendingCheckIns ?? []).length > 0 && (
              <View style={styles.pendingSyncCard}>
                <View style={styles.pendingSyncCopy}>
                  <Text style={styles.pendingSyncTitle}>
                    {(pendingCheckIns ?? []).some((job) => job.state === "needs_attention")
                      ? "Check-in needs attention"
                      : `${pendingCheckIns!.length} check-in${pendingCheckIns!.length === 1 ? "" : "s"} waiting to sync`}
                  </Text>
                  <Text style={styles.pendingSyncBody}>
                    {(pendingCheckIns ?? []).map((job) => job.petNames.join(", ")).join(" · ")}
                  </Text>
                  <Text style={styles.pendingSyncBody}>
                    {(pendingCheckIns ?? []).some((job) => job.state === "needs_attention")
                      ? (pendingCheckIns ?? []).find((job) => job.lastError)?.lastError
                      : "Saved on this phone. We’ll retry automatically when the internet returns."}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.retrySyncButton}
                  disabled={retrying}
                  onPress={async () => {
                    setRetrying(true);
                    try {
                      await retryCurrentPendingCheckIns();
                      await Promise.all([
                        queryClient.invalidateQueries({ queryKey: ["pending-check-ins"] }),
                        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
                        queryClient.invalidateQueries({ queryKey: ["collar-palette"] }),
                      ]);
                    } finally {
                      setRetrying(false);
                    }
                  }}
                >
                  {retrying ? <ActivityIndicator color="#177462" /> : <Text style={styles.retrySyncText}>Retry now</Text>}
                </TouchableOpacity>
              </View>
            )}
            {expectedArrivals.length > 0 && (
              <View style={styles.arrivalsSection}>
                <View style={styles.sectionTitleRow}>
                  <Text style={styles.sectionTitle}>Expected arrivals</Text>
                  <View style={styles.countBadge}><Text style={styles.countBadgeText}>{expectedArrivals.length}</Text></View>
                </View>
                {expectedArrivals.map((reservation: any) => {
                  const scheduled = formatScheduledArrival(reservation.scheduled_check_in_at);
                  return <TouchableOpacity
                    key={reservation.id}
                    style={styles.arrivalCard}
                    accessibilityRole="button"
                    accessibilityLabel={`Start ${reservation.pet_name}'s check-in, scheduled ${scheduled.day} at ${scheduled.time}`}
                    onPress={() => handleReservedArrival(reservation)}
                  >
                    {reservation.photo_thumbnail_url
                      ? <Image source={{ uri: reservation.photo_thumbnail_url }} style={styles.arrivalPhoto} />
                      : <View style={styles.arrivalAvatar}><Text style={styles.arrivalAvatarText}>{reservation.pet_name?.slice(0, 1).toUpperCase()}</Text></View>}
                    <View style={styles.arrivalCopy}>
                      <Text style={styles.petName}>{reservation.pet_name}</Text>
                      <Text style={styles.arrivalOwner}>{reservation.owner_name || reservation.breed || reservation.species}</Text>
                      <Text style={styles.arrivalType}>{reservation.session_type === "daycare" ? "Daycare" : "Boarding"}</Text>
                    </View>
                    <View style={styles.arrivalSchedule}>
                      <Text style={styles.arrivalDay}>{scheduled.day}</Text>
                      <Text style={styles.arrivalTime}>{scheduled.time}</Text>
                      <Text style={styles.arrivalStart}>Start check-in ›</Text>
                    </View>
                  </TouchableOpacity>;
                })}
              </View>
            )}
            {reservationsLoading && <View style={styles.reservationsLoading}><ActivityIndicator color="#177462" /><Text style={styles.meta}>Loading expected arrivals…</Text></View>}
            <Text style={styles.sectionTitle}>Find an existing pet</Text>
            <TextInput
              style={styles.input}
              placeholder="Pet name, owner, phone, or email"
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {isLoading && <ActivityIndicator style={{ marginTop: 12 }} />}
          </View>
        }
        renderItem={({ item }) => {
          const active = activePetIds.has(item.id);
          const pending = pendingPetIds.has(item.id);
          return <View style={[styles.searchResult, active && styles.disabledButton]}>
          <TouchableOpacity
            style={styles.petResultButton}
            disabled={active}
            onPress={() => {
              setSelectedPet(item);
              setMode("checkIn");
            }}
          >
            <Text style={styles.petName}>{item.name}</Text>
            <Text style={styles.meta}>{item.species} {item.owner_name ? `· ${item.owner_name}` : ""}{pending ? " · Check-in pending" : active ? " · Already checked in" : ""}</Text>
          </TouchableOpacity>
          {item.owner_id && <TouchableOpacity style={styles.ownerAddButton} onPress={() => {
            setRegistrationOwner({ id: item.owner_id, name: item.owner_name, phone: item.owner_phone, email: item.owner_email });
            setMode("registerPet");
          }}><Text style={styles.ownerAddButtonText}>+ Pet for {item.owner_name}</Text></TouchableOpacity>}
        </View>}}
        ListEmptyComponent={
          search.length > 0 && !isLoading ? (
            <Text style={styles.empty}>No matches found.</Text>
          ) : null
        }
      />
      <TouchableOpacity style={styles.registerButton} onPress={() => { setRegistrationOwner(null); setMode("registerPet"); }}>
        <Text style={styles.registerButtonText}>+ Register new pet</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

export function IdentityEnrollmentScreen({ pet, sessionId, onDone, doneLabel }: { pet: any; sessionId: string; onDone: () => void; doneLabel?: string }) {
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [video, setVideo] = useState<PickedVideo | null>(null);
  const [working, setWorking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const [hasUploadedReferences, setHasUploadedReferences] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const completionIsPrimary = Boolean(doneLabel || hasUploadedReferences || uploaded);
  const completionLabel = working
    ? "Uploading…"
    : analysisPending
      ? "Getting photos ready…"
      : doneLabel ?? (hasUploadedReferences || uploaded ? "Complete check-in" : "Skip for now");

  useEffect(() => {
    if (!analysisPending) return;
    let cancelled = false;
    const checkStatus = async () => {
      try {
        const status = await apiFetch<{
          photos: Array<{ processing_status: string }>;
          videos: Array<{ processing_status: string }>;
        }>(`/sessions/${sessionId}/identity-media`);
        const stillProcessing = [...status.photos, ...status.videos]
          .some((item) => ["queued", "uploaded", "processing"].includes(item.processing_status));
        if (!cancelled && !stillProcessing) setAnalysisPending(false);
      } catch {
        // Keep the completion action locked while status is unknown. The next
        // poll retries automatically rather than silently closing the flow.
      }
    };
    void checkStatus();
    const timer = setInterval(() => void checkStatus(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [analysisPending, sessionId]);

  const preparePhotos = async (assets: ImagePicker.ImagePickerAsset[]) => {
    setPreparing(true);
    try {
      const prepared: PickedPhoto[] = [];
      let convertedCount = 0;
      for (const [index, asset] of assets.entries()) {
        const image = await preparePickedImage(asset, `checkin-${Date.now()}-${index + 1}`);
        if (image.convertedFromHeic) convertedCount += 1;
        prepared.push({ clientId: `${Date.now()}-${index}-${Math.random()}`, uri: image.uri, fileName: image.fileName, mimeType: image.mimeType });
      }
      setPhotos((current) => [...current, ...prepared].slice(0, 20));
      if (convertedCount > 0) Alert.alert("HEIC converted", `${convertedCount} identity photo${convertedCount === 1 ? " is" : "s are"} ready as JPG.`);
    } catch {
      Alert.alert("Couldn’t prepare photo", "One of the selected HEIC photos could not be converted. Try selecting it again.");
    } finally {
      setPreparing(false);
    }
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return Alert.alert("Camera permission needed", "Allow camera access to add current identity photos.");
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (!result.canceled) await preparePhotos(result.assets);
  };

  const choosePhotos = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Photos permission needed", "Allow photo access to add current identity photos.");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 20,
      quality: 0.9,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) await preparePhotos(result.assets);
  };

  const recordVideo = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return Alert.alert("Camera permission needed", "Allow camera access to record an identity video.");
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["videos"],
      videoMaxDuration: MAX_SOURCE_VIDEO_DURATION_SECONDS,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    });
    if (!result.canceled) {
      selectVideoAsset(result.assets[0]);
    }
  };

  const chooseVideo = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Video permission needed", "Allow photo-library access to choose a saved pet video.");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsEditing: false,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) selectVideoAsset(result.assets[0]);
  };

  const selectVideoAsset = (asset: ImagePicker.ImagePickerAsset) => {
    const durationSeconds = asset.duration ? asset.duration / 1000 : undefined;
    if (asset.fileSize && asset.fileSize > MAX_VIDEO_UPLOAD_BYTES) {
      Alert.alert("Video is too large", "Choose a video smaller than 100 MB.");
      return;
    }
    if (durationSeconds && durationSeconds > MAX_SOURCE_VIDEO_DURATION_SECONDS) {
      Alert.alert("Video is too long", `Choose a video that is ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter.`);
      return;
    }
    setVideo({
      clientId: `${Date.now()}-video`,
      uri: asset.uri,
      fileName: asset.fileName ?? `checkin-${Date.now()}.mov`,
      mimeType: asset.mimeType ?? "video/quicktime",
      durationSeconds,
      width: asset.width,
      height: asset.height,
    });
  };

  const upload = async () => {
    if (!photos.length && !video) return Alert.alert("Add identity media", "Take a few photos or record a short video first.");
    setWorking(true);
    try {
      let count = 0;
      if (photos.length) {
        const result = await uploadIdentityPhotoBatch(photos, pet.id, sessionId);
        count += result.uploadedCount;
      }
      if (video) await uploadVideo(video, { petId: pet.id, sessionId });
      setUploaded(count);
      setHasUploadedReferences(true);
      setAnalysisPending(true);
      setPhotos([]);
      setVideo(null);
      const uploadedMedia = video
        ? "video"
        : count === 1
          ? "photo"
          : `${count} photos`;
      Alert.alert(
        `${pet.name}’s ${uploadedMedia} received!`,
        `We’re getting ${pet.name}’s AI profile ready so UCBarkley can recognize ${pet.name} in future photos. Please keep this screen open for a moment.`,
        [{ text: "Continue" }]
      );
    } catch {
      Alert.alert("Upload failed", "Keep this screen open, check the connection, and try again.");
    } finally { setWorking(false); }
  };

  return <SafeAreaView style={styles.container} edges={["top"]}>
    <ScrollView contentContainerStyle={styles.identityContent}>
      <Text style={styles.kicker}>PET PHOTO SETUP</Text>
      <Text style={styles.identityHeader}>Help us recognize {pet.name}</Text>
      <Text style={styles.identityBody}>Add 3–6 clear photos, or record up to {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds while {pet.name} moves naturally. These are for identification only and will not appear in owner reports.</Text>
      <View style={styles.captureGrid}>
        <TouchableOpacity style={styles.captureButton} onPress={takePhoto} disabled={preparing || working}><Text style={styles.captureIcon}>▣</Text><Text style={styles.captureText}>Take photo</Text></TouchableOpacity>
        <TouchableOpacity style={styles.captureButton} onPress={choosePhotos} disabled={preparing || working}>{preparing ? <ActivityIndicator color="#177462" /> : <Text style={styles.captureIcon}>▧</Text>}<Text style={styles.captureText}>{preparing ? "Converting…" : "Choose photos"}</Text></TouchableOpacity>
      </View>
      <View style={styles.videoActionRow}>
        <TouchableOpacity style={styles.videoButton} onPress={recordVideo} disabled={preparing || working}><Text style={styles.captureIcon}>●</Text><Text style={styles.captureText}>Record video</Text><Text style={styles.videoHint}>Up to {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds</Text></TouchableOpacity>
        <TouchableOpacity style={styles.videoButton} onPress={chooseVideo} disabled={preparing || working}><Text style={styles.captureIcon}>▶</Text><Text style={styles.captureText}>Choose video</Text><Text style={styles.videoHint}>From this device</Text></TouchableOpacity>
      </View>
      {photos.length > 0 && <View><Text style={styles.selectionTitle}>{photos.length} photo{photos.length === 1 ? "" : "s"} selected</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.previewRow}>{photos.map((photo) => <Image key={photo.clientId} source={{ uri: photo.uri }} style={styles.previewImage} />)}</ScrollView></View>}
      {video && <View style={styles.videoSelected}><Text style={styles.captureText}>✓ Video ready</Text><Text style={styles.videoHint}>{video.fileName}</Text></View>}
      {uploaded > 0 && <Text style={styles.successText}>{uploaded} identification photo{uploaded === 1 ? "" : "s"} saved for {pet.name}.</Text>}
      <TouchableOpacity style={[styles.registerButton, (!photos.length && !video) && styles.disabledButton]} onPress={upload} disabled={working || preparing || (!photos.length && !video)}>{working ? <ActivityIndicator color="#fff" /> : <Text style={styles.registerButtonText}>Save identification photos</Text>}</TouchableOpacity>
      {analysisPending && <View style={styles.analysisNotice}><ActivityIndicator color="#177462" /><View style={styles.analysisCopy}><Text style={styles.captureText}>Getting {pet.name}’s AI profile ready…</Text><Text style={styles.videoHint}>This usually takes a moment. Please keep this screen open.</Text></View></View>}
      <TouchableOpacity
        style={[
          completionIsPrimary ? styles.completionButton : styles.cancelButton,
          (working || preparing || analysisPending) && styles.disabledButton,
        ]}
        onPress={onDone}
        disabled={working || preparing || analysisPending}
      >
        <Text style={completionIsPrimary ? styles.completionButtonText : styles.cancelButtonText}>
          {completionIsPrimary && !working && !analysisPending ? "✓ " : ""}{completionLabel}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  </SafeAreaView>;
}

function RegisterPetForm({ existingOwner, onCreated, onCancel }: { existingOwner?: { id: string; name: string; phone?: string; email?: string } | null; onCreated: (pet: any) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [species, setSpecies] = useState<"dog" | "cat" | "other">("dog");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const createOwner = useCreateOwner();
  const createPet = useCreatePet();

  const handleSubmit = async () => {
    try {
      let ownerId: string | undefined = existingOwner?.id;
      if (!existingOwner && ownerName.trim()) {
        const owner = await createOwner.mutateAsync({ fullName: ownerName.trim(), phone: ownerPhone.trim() || undefined });
        ownerId = owner.id;
      }
      const pet = await createPet.mutateAsync({ name: name.trim(), species, ownerId });
      onCreated(pet);
    } catch (err) {
      Alert.alert("Couldn't register pet", "Please check the details and try again.");
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={styles.formContent}
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.header}>{existingOwner ? `Add Pet for ${existingOwner.name}` : "Register New Pet"}</Text>
          {existingOwner && <View style={styles.existingOwnerCard}><Text style={styles.petName}>{existingOwner.name}</Text><Text style={styles.meta}>{[existingOwner.phone, existingOwner.email].filter(Boolean).join(" · ") || "Existing customer"}</Text></View>}
          <TextInput style={styles.input} placeholder="Pet name" value={name} onChangeText={setName} returnKeyType="next" />
          <View style={styles.speciesRow}>
            {(["dog", "cat", "other"] as const).map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.speciesChip, species === option && styles.speciesChipActive]}
                onPress={() => setSpecies(option)}
              >
                <Text style={species === option ? styles.speciesChipTextActive : styles.speciesChipText}>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {!existingOwner && <>
            <TextInput style={styles.input} placeholder="Owner name" value={ownerName} onChangeText={setOwnerName} returnKeyType="next" />
            <TextInput
              style={styles.input}
              placeholder="Owner phone"
              value={ownerPhone}
              onChangeText={setOwnerPhone}
              keyboardType="phone-pad"
              returnKeyType="done"
            />
          </>}
          <TouchableOpacity style={[styles.registerButton, (!name.trim() || createPet.isPending || createOwner.isPending) && styles.disabledButton]} onPress={handleSubmit} disabled={!name.trim() || createPet.isPending || createOwner.isPending}>
            {createPet.isPending || createOwner.isPending ? <ActivityIndicator color="#fff" /> : <Text style={styles.registerButtonText}>Continue to Check-In</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CheckInForm({ pet, reservation, householdPets, onDone, onQueued, onCancel }: { pet: any; reservation?: any; householdPets: any[]; onDone: (targets: Array<{ sessionId: string; pet: any }>) => void; onQueued: () => void; onCancel: () => void }) {
  const [sessionType, setSessionType] = useState<"boarding" | "daycare">(reservation?.session_type ?? "boarding");
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>([pet.id]);
  const [collarEnabled, setCollarEnabled] = useState(false);
  const [collarPaletteId, setCollarPaletteId] = useState<string | undefined>(undefined);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { data: palette } = useCollarPalette();
  const checkIn = useCheckIn();
  const batchCheckIn = useBatchCheckIn();
  const startReservation = useStartReservation();
  const selectedCollar = (palette ?? []).find((color: any) => color.id === collarPaletteId);
  const collarReady = !collarEnabled || Boolean(collarPaletteId);

  const openCollarScanner = async () => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) {
      Alert.alert("Camera permission needed", "Allow camera access to scan a facility collar QR code.");
      return;
    }
    setScanLocked(false);
    setScannerOpen(true);
  };

  const handleCollarScan = ({ data }: BarcodeScanningResult) => {
    if (scanLocked) return;
    setScanLocked(true);
    const collarId = collarIdFromQr(data);
    const scannedCollar = (palette ?? []).find((color: any) => color.id.toLowerCase() === collarId);
    if (!scannedCollar) {
      Alert.alert("Collar not recognized", "This QR code is not an active collar for this facility.", [
        { text: "Try again", onPress: () => setScanLocked(false) },
        { text: "Cancel", style: "cancel", onPress: () => setScannerOpen(false) },
      ]);
      return;
    }
    if (scannedCollar.in_use) {
      Alert.alert("Collar already in use", `${scannedCollar.color_name} is assigned to another checked-in pet.`, [
        { text: "Scan another", onPress: () => setScanLocked(false) },
        { text: "Cancel", style: "cancel", onPress: () => setScannerOpen(false) },
      ]);
      return;
    }
    setCollarEnabled(true);
    setCollarPaletteId(scannedCollar.id);
    setScannerOpen(false);
  };

  const handleSubmit = async () => {
    try {
      const selectedPets = householdPets.filter((candidate) => selectedPetIds.includes(candidate.id));
      if (reservation) {
        const result = await startReservation.mutateAsync({
          sessionId: reservation.id,
          petId: pet.id,
          petName: pet.name,
          collarEnabled,
          collarPaletteId: collarEnabled ? collarPaletteId : undefined,
        });
        if (result.status === "queued") return onQueued();
        onDone([{ sessionId: result.sessions[0].id, pet }]);
      } else if (selectedPets.length > 1) {
        const result = await batchCheckIn.mutateAsync({
          petIds: selectedPetIds,
          petNames: selectedPets.map((candidate) => candidate.name),
          sessionType,
        });
        if (result.status === "queued") return onQueued();
        const selectedPetsById = new Map(selectedPets.map((candidate) => [candidate.id, candidate]));
        onDone(result.sessions.map((session) => {
          const checkedInPet = selectedPetsById.get(session.pet_id);
          if (!checkedInPet) throw new Error("A checked-in pet could not be matched to its stay.");
          return { sessionId: session.id, pet: checkedInPet };
        }));
      } else {
        const selectedPet = selectedPets[0] ?? pet;
        const result = await checkIn.mutateAsync({
          petId: selectedPet.id,
          petName: selectedPet.name,
          sessionType,
          collarEnabled,
          collarPaletteId: collarEnabled ? collarPaletteId : undefined,
        });
        if (result.status === "queued") return onQueued();
        onDone([{ sessionId: result.sessions[0].id, pet: selectedPet }]);
      }
    } catch (error) {
      Alert.alert(
        "Check-in failed",
        error instanceof Error ? error.message : "Please refresh and try again."
      );
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.formContent}>
      <Text style={styles.header}>Check In {selectedPetIds.length > 1 ? `${selectedPetIds.length} Pets` : pet.name}</Text>
      {!reservation && householdPets.length > 1 && <View style={styles.householdCard}>
        <Text style={styles.petName}>Pets arriving together</Text>
        <Text style={styles.meta}>Select every pet from this family who is checking in now.</Text>
        <View style={styles.householdPetGrid}>{householdPets.map((candidate) => {
          const selected = selectedPetIds.includes(candidate.id);
          return <TouchableOpacity key={candidate.id} style={[styles.householdPetButton, selected && styles.householdPetButtonSelected]} onPress={() => setSelectedPetIds((current) => selected ? (current.length === 1 ? current : current.filter((id) => id !== candidate.id)) : [...current, candidate.id])}>
            <Text style={selected ? styles.householdPetTextSelected : styles.householdPetText}>{selected ? "✓ " : "+ "}{candidate.name}</Text>
          </TouchableOpacity>;
        })}</View>
      </View>}
      <View style={styles.speciesRow}>
        {(["boarding", "daycare"] as const).map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.speciesChip, sessionType === option && styles.speciesChipActive]}
            onPress={() => setSessionType(option)}
            disabled={Boolean(reservation)}
          >
            <Text style={sessionType === option ? styles.speciesChipTextActive : styles.speciesChipText}>
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {selectedPetIds.length === 1 && (
        <View style={styles.collarSection}>
          <View>
            <Text style={styles.petName}>Collar for this stay</Text>
            <Text style={styles.meta}>Scan the collar label to assign the exact color to {pet.name}.</Text>
          </View>
          <TouchableOpacity style={styles.scanCollarButton} onPress={() => void openCollarScanner()}>
            <Text style={styles.scanCollarIcon}>▣</Text>
            <View style={styles.scanCollarCopy}>
              <Text style={styles.scanCollarTitle}>Scan collar QR code</Text>
              <Text style={styles.scanCollarHint}>Identifies the exact facility collar and color</Text>
            </View>
          </TouchableOpacity>
          {selectedCollar && (
            <View style={styles.selectedCollarCard}>
              <View style={[styles.collarSwatch, { backgroundColor: selectedCollar.color_hex ?? "#D1D8D5" }]} />
              <View>
                <Text style={styles.selectedCollarName}>{selectedCollar.color_name} collar</Text>
                <Text style={styles.scanCollarHint}>Ready to assign to {pet.name}</Text>
              </View>
            </View>
          )}
          <Text style={styles.manualCollarLabel}>Available collars</Text>
          <View style={styles.speciesRow}>
            <TouchableOpacity
              style={[styles.speciesChip, !collarEnabled && styles.speciesChipActive]}
              onPress={() => {
                setCollarEnabled(false);
                setCollarPaletteId(undefined);
              }}
            >
              <Text style={!collarEnabled ? styles.speciesChipTextActive : styles.speciesChipText}>No collar</Text>
            </TouchableOpacity>
            {(palette ?? []).map((color: any) => (
              <TouchableOpacity
                key={color.id}
                disabled={color.in_use}
                style={[
                  styles.speciesChip,
                  collarPaletteId === color.id && styles.speciesChipActive,
                  color.in_use && styles.speciesChipDisabled,
                ]}
                onPress={() => {
                  setCollarEnabled(true);
                  setCollarPaletteId(color.id);
                }}
              >
                <View style={[styles.optionSwatch, { backgroundColor: color.color_hex ?? "#D1D8D5" }]} />
                <Text style={collarPaletteId === color.id ? styles.speciesChipTextActive : styles.speciesChipText}>
                  {color.color_name}
                  {color.in_use ? " (in use)" : ""}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {(palette ?? []).length === 0 && <Text style={styles.collarRequiredHint}>No facility collars are available yet. Add them from Collar Management in the administrator portal.</Text>}
        </View>
      )}

      {selectedPetIds.length > 1 && <Text style={styles.batchHint}>Collars can be assigned separately after this group check-in.</Text>}
      <TouchableOpacity style={[styles.registerButton, !collarReady && styles.disabledButton]} onPress={handleSubmit} disabled={checkIn.isPending || batchCheckIn.isPending || startReservation.isPending || !collarReady}>
        {checkIn.isPending || batchCheckIn.isPending || startReservation.isPending ? <ActivityIndicator color="#fff" /> : <Text style={styles.registerButtonText}>{selectedPetIds.length > 1 ? `Check In ${selectedPetIds.length} Pets Together` : "Check In"}</Text>}
      </TouchableOpacity>
      {!collarReady && <Text style={styles.collarRequiredHint}>Scan a collar or choose its color before checking in.</Text>}
      <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
      </ScrollView>
      <Modal visible={scannerOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scannerScreen}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanLocked ? undefined : handleCollarScan}
          />
          <SafeAreaView style={styles.scannerOverlay} edges={["top", "bottom"]}>
            <View style={styles.scannerHeader}>
              <View>
                <Text style={styles.scannerTitle}>Scan collar</Text>
                <Text style={styles.scannerHint}>Place the QR code inside the frame</Text>
              </View>
              <TouchableOpacity style={styles.scannerClose} onPress={() => setScannerOpen(false)}>
                <Text style={styles.scannerCloseText}>Close</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.scannerFrame} />
            <View style={styles.scannerFooter}>
              <Text style={styles.scannerFooterText}>Only collars registered to this facility can be assigned.</Text>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  formContent: { flexGrow: 1, padding: 16, gap: 10 },
  container: { flex: 1, padding: 16, gap: 10 },
  checkInHeader: { gap: 12, marginBottom: 10 },
  header: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  headerHint: { color: "#687b76", fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  list: { gap: 8, paddingVertical: 8 },
  empty: { textAlign: "center", color: "#888", marginTop: 20 },
  arrivalsSection: { gap: 8, paddingVertical: 6 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#173f38", fontSize: 15, fontWeight: "800" },
  countBadge: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 7, alignItems: "center", justifyContent: "center", backgroundColor: "#F4E7C5" },
  countBadgeText: { color: "#775E1B", fontSize: 12, fontWeight: "800" },
  arrivalCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#E5C983", borderRadius: 14, padding: 11, backgroundColor: "#FFFAF0" },
  arrivalPhoto: { width: 46, height: 46, borderRadius: 15, backgroundColor: "#F4E7C5" },
  arrivalAvatar: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#F4E7C5" },
  arrivalAvatarText: { color: "#775E1B", fontSize: 16, fontWeight: "800" },
  arrivalCopy: { flex: 1 },
  arrivalOwner: { color: "#687B76", fontSize: 12, marginTop: 2 },
  arrivalType: { color: "#775E1B", fontSize: 11, fontWeight: "700", marginTop: 3 },
  arrivalSchedule: { minWidth: 92, alignItems: "flex-end" },
  arrivalDay: { color: "#173F38", fontSize: 12, fontWeight: "800" },
  arrivalTime: { color: "#173F38", fontSize: 15, fontWeight: "800", marginTop: 1 },
  arrivalStart: { color: "#177462", fontSize: 11, fontWeight: "800", marginTop: 5 },
  reservationsLoading: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  pendingSyncCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderWidth: 1, borderColor: "#E5C983", borderRadius: 14, backgroundColor: "#FFFAF0" },
  pendingSyncCopy: { flex: 1, gap: 3 },
  pendingSyncTitle: { color: "#624F18", fontSize: 15, fontWeight: "800" },
  pendingSyncBody: { color: "#756A49", fontSize: 12, lineHeight: 17 },
  retrySyncButton: { minHeight: 42, minWidth: 84, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#177462", borderRadius: 12, paddingHorizontal: 12, backgroundColor: "#fff" },
  retrySyncText: { color: "#177462", fontWeight: "800" },
  searchResult: { backgroundColor: "#f5f5f5", borderRadius: 10, overflow: "hidden" },
  petResultButton: { padding: 14, gap: 2 },
  ownerAddButton: { borderTopWidth: 1, borderTopColor: "#dbe4e0", paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#edf7f3" },
  ownerAddButtonText: { color: "#177462", fontWeight: "700", fontSize: 13 },
  existingOwnerCard: { borderWidth: 1, borderColor: "#9fc7bb", borderRadius: 12, padding: 13, backgroundColor: "#edf7f3" },
  householdCard: { borderWidth: 1, borderColor: "#9fc7bb", borderRadius: 14, padding: 14, gap: 9, backgroundColor: "#f7faf7" },
  householdPetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  householdPetButton: { borderWidth: 1, borderColor: "#9fc7bb", borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: "#fff" },
  householdPetButtonSelected: { borderColor: "#177462", backgroundColor: "#177462" },
  householdPetText: { color: "#173f38", fontWeight: "700" },
  householdPetTextSelected: { color: "#fff", fontWeight: "700" },
  batchHint: { color: "#687b76", fontSize: 13, lineHeight: 18 },
  petName: { fontSize: 17, fontWeight: "600" },
  meta: { color: "#666" },
  registerButton: { backgroundColor: "#2f6690", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 8 },
  registerButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  cancelButton: { padding: 14, alignItems: "center" },
  cancelButtonText: { color: "#888" },
  completionButton: { minHeight: 56, borderRadius: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#177462" },
  completionButtonText: { color: "#fff", fontSize: 17, fontWeight: "800" },
  speciesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  speciesChip: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: "#ccc", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  speciesChipActive: { backgroundColor: "#2f6690", borderColor: "#2f6690" },
  speciesChipDisabled: { opacity: 0.4 },
  speciesChipText: { color: "#333" },
  speciesChipTextActive: { color: "#fff", fontWeight: "600" },
  collarSection: { gap: 10, marginTop: 8, padding: 14, borderWidth: 1, borderColor: "#D8E6E1", borderRadius: 16, backgroundColor: "#F8FBF9" },
  scanCollarButton: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderWidth: 1, borderColor: "#177462", borderRadius: 14, backgroundColor: "#EDF7F3" },
  scanCollarIcon: { color: "#177462", fontSize: 28, fontWeight: "800" },
  scanCollarCopy: { flex: 1 },
  scanCollarTitle: { color: "#173F38", fontSize: 16, fontWeight: "800" },
  scanCollarHint: { color: "#687B76", fontSize: 12, marginTop: 2 },
  selectedCollarCard: { flexDirection: "row", alignItems: "center", gap: 11, padding: 12, borderRadius: 13, backgroundColor: "#F7FAF7" },
  collarSwatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: "rgba(0,0,0,0.18)" },
  selectedCollarName: { color: "#173F38", fontSize: 15, fontWeight: "800" },
  manualCollarLabel: { color: "#687B76", fontSize: 12, fontWeight: "700" },
  optionSwatch: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: "rgba(0,0,0,0.18)" },
  collarRequiredHint: { color: "#A45A4C", fontSize: 12, textAlign: "center" },
  scannerScreen: { flex: 1, backgroundColor: "#000" },
  scannerOverlay: { flex: 1, justifyContent: "space-between", padding: 20, backgroundColor: "rgba(0,0,0,0.22)" },
  scannerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  scannerTitle: { color: "#FFF", fontSize: 24, fontWeight: "800" },
  scannerHint: { color: "#E7F1ED", fontSize: 14, marginTop: 3 },
  scannerClose: { paddingHorizontal: 15, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.58)" },
  scannerCloseText: { color: "#FFF", fontWeight: "800" },
  scannerFrame: { alignSelf: "center", width: 250, height: 250, borderWidth: 4, borderColor: "#FFF", borderRadius: 24, backgroundColor: "transparent" },
  scannerFooter: { padding: 14, borderRadius: 14, backgroundColor: "rgba(0,0,0,0.62)" },
  scannerFooterText: { color: "#FFF", fontSize: 13, textAlign: "center", lineHeight: 19 },
  identityContent: { paddingBottom: 30, gap: 14 },
  kicker: { color: "#177462", fontWeight: "800", fontSize: 12, letterSpacing: 2 },
  identityHeader: { color: "#173f38", fontSize: 29, fontWeight: "800" },
  identityBody: { color: "#687b76", fontSize: 16, lineHeight: 23 },
  captureGrid: { flexDirection: "row", gap: 10 },
  captureButton: { flex: 1, minHeight: 105, borderWidth: 1, borderColor: "#9fc7bb", borderRadius: 16, alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: "#f7faf7" },
  videoActionRow: { flexDirection: "row", gap: 10 },
  videoButton: { flex: 1, minHeight: 105, borderWidth: 1, borderColor: "#9fc7bb", borderRadius: 16, padding: 12, alignItems: "center", justifyContent: "center", gap: 5, backgroundColor: "#edf7f3" },
  captureIcon: { color: "#177462", fontSize: 25, fontWeight: "700" },
  captureText: { color: "#173f38", fontSize: 16, fontWeight: "700" },
  videoHint: { color: "#687b76", fontSize: 12, marginTop: 2, textAlign: "center" },
  selectionTitle: { color: "#173f38", fontSize: 15, fontWeight: "700", marginBottom: 8 },
  previewRow: { gap: 8 },
  previewImage: { width: 90, height: 90, borderRadius: 13, backgroundColor: "#e3e8e5" },
  videoSelected: { borderRadius: 13, padding: 14, backgroundColor: "#dff0e9" },
  successText: { color: "#177462", fontWeight: "700" },
  analysisNotice: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, backgroundColor: "#e5f3ee" },
  analysisCopy: { flex: 1 },
  disabledButton: { opacity: 0.45 },
});
