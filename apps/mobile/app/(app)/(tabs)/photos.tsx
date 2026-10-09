import { Ionicons } from "@expo/vector-icons";
import { MAX_SOURCE_VIDEO_DURATION_SECONDS } from "@ucbarkley/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  confirmPhotoAssignments,
  uploadPhotoBatch,
  waitForBatchAiSuggestions,
  type UploadProgressUpdate,
} from "../../../src/api/photoUpload";
import { useActiveSessions, useAssignVideo } from "../../../src/api/hooks";
import { uploadVideo } from "../../../src/api/videoUpload";
import { usePhotoDrafts } from "../../../src/photos/photoDraftContext";
import { preparePickedImage } from "../../../src/photos/preparePickedImage";
import {
  MAX_MEDIA_BATCH_ITEMS,
  MAX_PHOTO_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
} from "../../../src/photos/mediaPolicy";

export default function PhotosScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    drafts,
    addDrafts,
    toggleAssignment,
    markDraftAnalyzing,
    applyAiSuggestions,
    markDraftAnalysisFailed,
    toggleSelected,
    removeDraft,
    removeDrafts,
    clearDrafts,
  } = usePhotoDrafts();
  const { data: sessions } = useActiveSessions();
  const assignVideo = useAssignVideo();
  const [focusedDraftId, setFocusedDraftId] = useState<string | null>(drafts[0]?.id ?? null);
  const [uploads, setUploads] = useState<UploadProgressUpdate[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  const focusedDraft = drafts.find((draft) => draft.id === focusedDraftId) ?? drafts[0];
  const selectedDrafts = useMemo(() => drafts.filter((draft) => draft.selected), [drafts]);
  const readyDrafts = selectedDrafts.filter((draft) => draft.assignedSessionIds.length > 0);
  const imagesNeedingAnalysis = selectedDrafts.filter(
    (draft) => draft.mediaType === "image" && !draft.uploadedPhotoId
  );
  const imagesAwaitingSuggestions = selectedDrafts.filter(
    (draft) =>
      draft.mediaType === "image" &&
      !!draft.uploadedPhotoId &&
      (draft.analysisStatus === "processing" || draft.analysisStatus === "failed")
  );

  useEffect(() => {
    if (!focusedDraft && drafts.length > 0) setFocusedDraftId(drafts[0].id);
    if (drafts.length === 0) setFocusedDraftId(null);
  }, [drafts, focusedDraft]);

  const addAssets = async (assets: ImagePicker.ImagePickerAsset[]) => {
    setIsPreparing(true);
    try {
      const remainingSlots = Math.max(0, MAX_MEDIA_BATCH_ITEMS - drafts.length);
      if (remainingSlots === 0) {
        Alert.alert("Batch is full", `Send or clear this batch before adding more than ${MAX_MEDIA_BATCH_ITEMS} items.`);
        return;
      }
      const acceptedAssets = assets.slice(0, remainingSlots);
      const prepared = [];
      let convertedCount = 0;
      let oversizedCount = 0;
      let overDurationCount = 0;
      for (const [index, asset] of acceptedAssets.entries()) {
        if (asset.type === "video") {
          const fileSizeBytes = new File(asset.uri).size;
          if (fileSizeBytes > MAX_VIDEO_UPLOAD_BYTES) {
            oversizedCount += 1;
            continue;
          }
          const durationSeconds = asset.duration ? asset.duration / 1000 : undefined;
          if (durationSeconds && durationSeconds > MAX_SOURCE_VIDEO_DURATION_SECONDS) {
            overDurationCount += 1;
            continue;
          }
          prepared.push({
            uri: asset.uri,
            fileName: asset.fileName,
            mimeType: asset.mimeType ?? (asset.fileName?.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4"),
            mediaType: "video" as const,
            durationSeconds,
            width: asset.width,
            height: asset.height,
            fileSizeBytes,
          });
          continue;
        }
        const image = await preparePickedImage(asset, `ucbarkley-${Date.now()}-${index + 1}`);
        const fileSizeBytes = new File(image.uri).size;
        if (fileSizeBytes > MAX_PHOTO_UPLOAD_BYTES) {
          oversizedCount += 1;
          continue;
        }
        if (image.convertedFromHeic) convertedCount += 1;
        prepared.push({ ...image, fileSizeBytes, mediaType: "image" as const });
      }
      const ids = addDrafts(prepared);
      setFocusedDraftId(ids[0] ?? null);
      if (assets.length > acceptedAssets.length) {
        Alert.alert("Batch limit reached", `Added the first ${remainingSlots} items. Send this batch before adding more.`);
      } else if (oversizedCount > 0 || overDurationCount > 0) {
        Alert.alert(
          "Some items were skipped",
          [
            oversizedCount > 0 ? `${oversizedCount} oversized item${oversizedCount === 1 ? "" : "s"}` : null,
            overDurationCount > 0 ? `${overDurationCount} video${overDurationCount === 1 ? "" : "s"} longer than ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds` : null,
          ].filter(Boolean).join(" · "),
        );
      }
      if (convertedCount > 0) Alert.alert("HEIC converted", `${convertedCount} photo${convertedCount === 1 ? " is" : "s are"} ready as JPG.`);
    } catch {
      Alert.alert("Couldn’t prepare media", "One of the selected items could not be optimized. Try selecting it again.");
    } finally {
      setIsPreparing(false);
    }
  };

  const recordClip = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera permission needed", "Allow camera access to record short pet clips.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["videos"],
      videoMaxDuration: MAX_SOURCE_VIDEO_DURATION_SECONDS,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    });
    if (!result.canceled) await addAssets(result.assets);
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera permission needed", "Allow camera access to photograph pets during their stay.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (!result.canceled) await addAssets(result.assets);
  };

  const chooseFromLibrary = async () => {
    if (drafts.length >= MAX_MEDIA_BATCH_ITEMS) {
      Alert.alert("Batch is full", `Send or clear this batch before adding more than ${MAX_MEDIA_BATCH_ITEMS} items.`);
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Library access needed", "Allow library access to add pet photos and short clips.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: MAX_MEDIA_BATCH_ITEMS - drafts.length,
      quality: 0.9,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) {
      const tooLong = result.assets.filter((asset) => asset.type === "video" && (asset.duration ?? 0) > MAX_SOURCE_VIDEO_DURATION_SECONDS * 1000);
      if (tooLong.length > 0) {
        Alert.alert("Clip too long", `Choose clips that are ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter.`);
      }
      await addAssets(result.assets.filter((asset) => !tooLong.includes(asset)));
    }
  };

  const analyzeSelected = async () => {
    if (selectedDrafts.length === 0) {
      Alert.alert("Choose photos", "Mark at least one photo to use before uploading.");
      return;
    }
    if (
      imagesNeedingAnalysis.length === 0 &&
      readyDrafts.length === 0 &&
      imagesAwaitingSuggestions.length > 0
    ) {
      setIsUploading(true);
      try {
        const batchIds = Array.from(
          new Set(
            imagesAwaitingSuggestions
              .map((draft) => draft.analysisBatchId)
              .filter((batchId): batchId is string => !!batchId)
          )
        );
        let suggestedPhotoCount = 0;
        let lowConfidenceCount = 0;
        for (const batchId of batchIds) {
          const analysis = await waitForBatchAiSuggestions(batchId);
          for (const draft of imagesAwaitingSuggestions.filter((item) => item.analysisBatchId === batchId)) {
            const photo = analysis.photos.find((item) => item.id === draft.uploadedPhotoId);
            if (!photo || photo.processingStatus === "failed") {
              markDraftAnalysisFailed(draft.id);
              continue;
            }
            const suggestions = photo.suggestions
              .filter(
                (suggestion) =>
                  suggestion.matchStatus === "matched" || suggestion.matchStatus === "low_confidence"
              )
              .map((suggestion) => ({
                detectionId: suggestion.detectionId,
                petId: suggestion.petId,
                sessionId: suggestion.sessionId,
                petName: suggestion.petName,
                confidence: suggestion.confidence,
                matchStatus: suggestion.matchStatus as "matched" | "low_confidence",
              }));
            if (suggestions.length > 0) suggestedPhotoCount += 1;
            lowConfidenceCount += suggestions.filter(
              (suggestion) => suggestion.matchStatus === "low_confidence"
            ).length;
            applyAiSuggestions(draft.id, suggestions);
          }
        }
        Alert.alert(
          "AI suggestions updated",
          suggestedPhotoCount === 0
            ? "AI finished but does not have enough confirmed reference photos yet. Select the correct pet manually for a clear single-pet photo first."
            : `${suggestedPhotoCount} photo${suggestedPhotoCount === 1 ? " has" : "s have"} suggested pet tags${lowConfidenceCount > 0 ? `; ${lowConfidenceCount} need extra attention` : ""}. Please double-check them.`
        );
      } catch {
        Alert.alert(
          "AI is still unavailable",
          "Start both the worker and inference service, then tap Check AI again."
        );
      } finally {
        setIsUploading(false);
      }
      return;
    }
    if (imagesNeedingAnalysis.length === 0) {
      await confirmSelected();
      return;
    }

    setIsUploading(true);
    setUploads(imagesNeedingAnalysis.map((draft) => ({ fileName: draft.fileName, status: "pending" })));

    try {
      const result = await uploadPhotoBatch(
        imagesNeedingAnalysis.map((draft) => ({
          clientId: draft.id,
          uri: draft.uri,
          fileName: draft.fileName,
          mimeType: draft.mimeType,
          width: draft.width,
          height: draft.height,
        })),
        (update) =>
          setUploads((current) =>
            current.map((item) => (item.fileName === update.fileName ? update : item))
          )
      );

      const successfulUploads = result.uploads.filter((upload) => upload.status === "done");
      for (const upload of result.uploads) {
        if (upload.status === "done") {
          markDraftAnalyzing(upload.clientId, result.batchId, upload.photoId);
        } else {
          markDraftAnalysisFailed(upload.clientId);
        }
      }
      if (successfulUploads.length === 0) {
        throw new Error("No photos uploaded for analysis");
      }

      const analysis = await waitForBatchAiSuggestions(result.batchId);
      let suggestedPhotoCount = 0;
      let lowConfidenceCount = 0;
      for (const upload of successfulUploads) {
        const photo = analysis.photos.find((item) => item.id === upload.photoId);
        if (!photo || photo.processingStatus === "failed") {
          markDraftAnalysisFailed(upload.clientId);
          continue;
        }
        const suggestions = photo.suggestions
          .filter((suggestion) => suggestion.matchStatus === "matched" || suggestion.matchStatus === "low_confidence")
          .map((suggestion) => ({
            detectionId: suggestion.detectionId,
            petId: suggestion.petId,
            sessionId: suggestion.sessionId,
            petName: suggestion.petName,
            confidence: suggestion.confidence,
            matchStatus: suggestion.matchStatus as "matched" | "low_confidence",
          }));
        if (suggestions.length > 0) suggestedPhotoCount += 1;
        lowConfidenceCount += suggestions.filter((suggestion) => suggestion.matchStatus === "low_confidence").length;
        applyAiSuggestions(upload.clientId, suggestions);
      }
      setUploads([]);
      Alert.alert(
        "AI suggestions ready",
        suggestedPhotoCount === 0
          ? "AI could not identify these pets yet. Please select them manually."
          : `${suggestedPhotoCount} photo${suggestedPhotoCount === 1 ? " has" : "s have"} suggested pet tags${lowConfidenceCount > 0 ? `; ${lowConfidenceCount} need extra attention` : ""}. Please double-check them.`
      );
    } catch {
      Alert.alert(
        "AI analysis did not finish",
        "The photos remain on this screen. You can select pets manually, or check that the worker and inference service are running and try again."
      );
    } finally {
      setIsUploading(false);
    }
  };

  const confirmSelected = async () => {
    if (selectedDrafts.length === 0) {
      Alert.alert("Choose media", "Mark at least one item to use.");
      return;
    }
    if (readyDrafts.length === 0) {
      Alert.alert(
        "Check pet suggestions",
        "Select at least one pet for a photo before confirming it. You can confirm tagged photos now and leave the others for later."
      );
      return;
    }

    setIsUploading(true);
    setUploads(readyDrafts.map((draft) => ({ fileName: draft.fileName, status: "pending" })));
    const completedDraftIds: string[] = [];
    const confirmedSessionIds = new Set<string>();
    try {
      for (const draft of readyDrafts.filter((item) => item.mediaType === "image")) {
        if (!draft.uploadedPhotoId) continue;
        setUploads((current) => current.map((item) => item.fileName === draft.fileName
          ? { ...item, status: "uploading" }
          : item));
        const assignments = draft.assignedSessionIds.map((sessionId) => {
          const session = sessions?.find((item) => item.id === sessionId);
          if (!session) throw new Error("Assigned pet is no longer checked in.");
          const suggestion = draft.aiSuggestions.find((item) => item.sessionId === sessionId);
          return {
            petId: session.pet_id,
            sessionId,
            sourceDetectionId: suggestion?.detectionId,
          };
        });
        await confirmPhotoAssignments(draft.uploadedPhotoId, assignments);
        draft.assignedSessionIds.forEach((sessionId) => confirmedSessionIds.add(sessionId));
        completedDraftIds.push(draft.id);
        setUploads((current) => current.map((item) => item.fileName === draft.fileName
          ? { ...item, status: "done" }
          : item));
      }

      for (const draft of readyDrafts.filter((item) => item.mediaType === "video")) {
        setUploads((current) => current.map((item) => item.fileName === draft.fileName
          ? { ...item, status: "uploading" }
          : item));
        const upload = await uploadVideo({
          clientId: draft.id,
          uri: draft.uri,
          fileName: draft.fileName,
          mimeType: draft.mimeType,
          durationSeconds: draft.durationSeconds,
          width: draft.width,
          height: draft.height,
        });
        for (const sessionId of draft.assignedSessionIds) {
          const session = sessions?.find((item) => item.id === sessionId);
          if (!session) throw new Error("Assigned pet is no longer checked in.");
          await assignVideo.mutateAsync({ videoId: upload.videoId, petId: session.pet_id, sessionId });
        }
        completedDraftIds.push(draft.id);
        setUploads((current) => current.map((item) => item.fileName === draft.fileName
          ? { ...item, status: "done" }
          : item));
      }

      removeDrafts(completedDraftIds);
      setUploads([]);
      Alert.alert(
        "Tags confirmed",
        `${completedDraftIds.length} media item${completedDraftIds.length === 1 ? "" : "s"} sent for administrator review.`
      );
    } catch {
      removeDrafts(completedDraftIds);
      Alert.alert("Confirmation failed", "Items that still need attention remain in this batch.");
    } finally {
      if (confirmedSessionIds.size > 0) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["sessions", "active"] }),
          ...Array.from(confirmedSessionIds, (sessionId) =>
            queryClient.invalidateQueries({ queryKey: ["session-photos", sessionId] })
          ),
        ]);
      }
      setIsUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.eyebrow}>STAFF MEDIA RUN</Text>
            <Text style={styles.header}>Capture & tag</Text>
          </View>
          {drafts.length > 0 && (
            <TouchableOpacity
              onPress={() =>
                Alert.alert("Clear this batch?", "These local photo drafts have not been uploaded.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Clear", style: "destructive", onPress: clearDrafts },
                ])
              }
            >
              <Text style={styles.clearText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.primaryAction} onPress={takePhoto} disabled={isPreparing || isUploading}>
            <Ionicons name="camera" size={22} color="#FFFFFF" />
            <Text style={styles.primaryActionText}>Take photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryAction} onPress={recordClip} disabled={isPreparing || isUploading}>
            <Ionicons name="videocam-outline" size={21} color="#176B5B" />
            <Text style={styles.secondaryActionText}>Record clip</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryAction} onPress={chooseFromLibrary} disabled={isPreparing || isUploading}>
            {isPreparing ? <ActivityIndicator color="#176B5B" /> : <Ionicons name="images-outline" size={21} color="#176B5B" />}
            <Text style={styles.secondaryActionText}>{isPreparing ? "Preparing" : "Library"}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.coverageLink} onPress={() => router.push("/coverage")}>
          <Ionicons name="stats-chart-outline" size={17} color="#176B5B" />
          <Text style={styles.coverageLinkText}>View photo coverage</Text>
          <Ionicons name="chevron-forward" size={16} color="#71807B" />
        </TouchableOpacity>

        {drafts.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="camera-outline" size={32} color="#176B5B" />
            </View>
            <Text style={styles.emptyTitle}>Start a media batch</Text>
            <Text style={styles.emptyCopy}>
              Take photos and AI will suggest the pets shown. Staff confirm or correct the tags before sending.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.batchSummary}>
              <Text style={styles.sectionTitle}>Batch</Text>
              <Text style={styles.summaryText}>
                {selectedDrafts.length} selected · {readyDrafts.length} tagged
              </Text>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.draftStrip}>
              {drafts.map((draft, index) => {
                const isFocused = draft.id === focusedDraft?.id;
                return (
                  <TouchableOpacity
                    key={draft.id}
                    style={[styles.draftThumbWrap, isFocused && styles.draftThumbFocused]}
                    onPress={() => setFocusedDraftId(draft.id)}
                  >
                    {draft.mediaType === "image" ? (
                      <Image source={{ uri: draft.uri }} style={styles.draftThumb} />
                    ) : (
                      <View style={[styles.draftThumb, styles.videoPlaceholder]}>
                        <Ionicons name="play-circle" size={32} color="#FFFFFF" />
                      </View>
                    )}
                    <View style={[styles.draftIndex, draft.selected && styles.draftIndexSelected]}>
                      <Text style={[styles.draftIndexText, draft.selected && styles.draftIndexTextSelected]}>
                        {index + 1}
                      </Text>
                    </View>
                    {draft.assignedSessionIds.length > 0 && (
                      <View style={styles.assignmentCount}>
                        <Ionicons name="paw" size={11} color="#FFFFFF" />
                        <Text style={styles.assignmentCountText}>{draft.assignedSessionIds.length}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {focusedDraft && (
              <View style={styles.editorCard}>
                {focusedDraft.mediaType === "image" ? (
                  <Image source={{ uri: focusedDraft.uri }} style={styles.heroImage} />
                ) : (
                  <View style={[styles.heroImage, styles.videoPlaceholder]}>
                    <Ionicons name="videocam" size={52} color="#FFFFFF" />
                    <Text style={styles.videoLabel}>Short video clip</Text>
                  </View>
                )}
                <View style={styles.useRow}>
                  <View style={styles.useCopy}>
                    <Text style={styles.editorTitle}>Use this {focusedDraft.mediaType === "video" ? "clip" : "photo"}</Text>
                    <Text style={styles.editorHint}>Only selected media will upload.</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.toggle, focusedDraft.selected && styles.toggleActive]}
                    onPress={() => toggleSelected(focusedDraft.id)}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: focusedDraft.selected }}
                  >
                    <View style={[styles.toggleKnob, focusedDraft.selected && styles.toggleKnobActive]} />
                  </TouchableOpacity>
                </View>

                <View style={styles.divider} />
                <Text style={styles.editorTitle}>
                  {focusedDraft.mediaType === "image" && focusedDraft.analysisStatus === "ready"
                    ? "AI pet suggestions"
                    : `Which pets are in this ${focusedDraft.mediaType === "video" ? "clip" : "photo"}?`}
                </Text>
                {focusedDraft.mediaType === "image" ? (
                  <View
                    style={[
                      styles.aiStatus,
                      focusedDraft.analysisStatus === "ready" && focusedDraft.aiSuggestions.length > 0
                        ? styles.aiStatusReady
                        : undefined,
                    ]}
                  >
                    <Ionicons
                      name={focusedDraft.analysisStatus === "ready" ? "sparkles" : "sparkles-outline"}
                      size={16}
                      color="#176B5B"
                    />
                    <Text style={styles.aiStatusText}>
                      {focusedDraft.analysisStatus === "not_started"
                        ? "Run AI analysis and the suggested pets will be selected by default."
                        : focusedDraft.analysisStatus === "processing"
                          ? "AI is detecting and comparing the pets..."
                          : focusedDraft.analysisStatus === "failed" || focusedDraft.aiSuggestions.length === 0
                            ? "AI could not identify a pet. Please select manually."
                            : "Suggested pets are already selected. Double-check and correct anything wrong."}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.editorHint}>Video tagging is manual. Select every pet shown in the clip.</Text>
                )}
                <View style={styles.petGrid}>
                  {(sessions ?? []).map((session) => {
                    const isAssigned = focusedDraft.assignedSessionIds.includes(session.id);
                    const aiSuggestion = focusedDraft.aiSuggestions.find(
                      (suggestion) => suggestion.sessionId === session.id
                    );
                    return (
                      <TouchableOpacity
                        key={session.id}
                        style={[styles.petChip, isAssigned && styles.petChipActive]}
                        onPress={() => toggleAssignment(focusedDraft.id, session.id)}
                      >
                        <View style={[styles.petAvatar, isAssigned && styles.petAvatarActive]}>
                          <Text style={[styles.petAvatarText, isAssigned && styles.petAvatarTextActive]}>
                            {session.pet_name?.slice(0, 1).toUpperCase()}
                          </Text>
                        </View>
                        <Text style={[styles.petChipText, isAssigned && styles.petChipTextActive]} numberOfLines={1}>
                          {session.pet_name}
                        </Text>
                        {aiSuggestion && (
                          <View
                            style={[
                              styles.aiBadge,
                              aiSuggestion.matchStatus === "low_confidence" && styles.aiBadgeReview,
                            ]}
                          >
                            <Text
                              style={[
                                styles.aiBadgeText,
                                aiSuggestion.matchStatus === "low_confidence" && styles.aiBadgeReviewText,
                              ]}
                            >
                              {aiSuggestion.matchStatus === "low_confidence"
                                ? "AI · review"
                                : `AI${aiSuggestion.confidence === null ? "" : ` · ${Math.round(aiSuggestion.confidence * 100)}%`}`}
                            </Text>
                          </View>
                        )}
                        {isAssigned && <Ionicons name="checkmark-circle" size={18} color="#176B5B" />}
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {(sessions ?? []).length === 0 && (
                  <Text style={styles.noPets}>There are no currently checked-in pets at this facility.</Text>
                )}

                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => removeDraft(focusedDraft.id)}
                  disabled={isUploading}
                >
                  <Ionicons name="trash-outline" size={17} color="#B24B3F" />
                  <Text style={styles.removeButtonText}>Remove from batch</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {uploads.length > 0 && (
          <View style={styles.uploadList}>
            {uploads.map((upload, index) => (
              <View key={`${upload.fileName}-${index}`} style={styles.uploadRow}>
                <Text style={styles.uploadFile} numberOfLines={1}>{upload.fileName}</Text>
                <Text style={styles.uploadStatus}>
                  {upload.status === "done" ? "Done" : upload.status === "failed" ? "Failed" : "Uploading"}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {drafts.length > 0 && (
        <View style={styles.footer}>
          <View>
            <Text style={styles.footerCount}>{selectedDrafts.length} selected</Text>
            <Text style={styles.footerHint}>
              {imagesNeedingAnalysis.length > 0
                ? "AI will suggest pet tags"
                : readyDrafts.length > 0
                  ? `${readyDrafts.length} tagged item${readyDrafts.length === 1 ? " is" : "s are"} ready to confirm`
                  : imagesAwaitingSuggestions.length > 0
                    ? "Waiting for AI processing"
                    : "Review AI or select manually"}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.uploadButton, (isUploading || isPreparing || selectedDrafts.length === 0) && styles.buttonDisabled]}
            onPress={analyzeSelected}
            disabled={isUploading || isPreparing || selectedDrafts.length === 0}
          >
            {isUploading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Text style={styles.uploadButtonText}>
                  {imagesNeedingAnalysis.length > 0
                    ? "Find pets with AI"
                    : readyDrafts.length > 0
                      ? "Confirm pet tags"
                      : imagesAwaitingSuggestions.length > 0
                        ? "Check AI again"
                        : "Confirm pet tags"}
                </Text>
                <Ionicons
                  name={
                    imagesNeedingAnalysis.length > 0
                      ? "sparkles"
                      : readyDrafts.length > 0
                        ? "checkmark"
                        : imagesAwaitingSuggestions.length > 0
                          ? "refresh"
                          : "checkmark"
                  }
                  size={18}
                  color="#FFFFFF"
                />
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F7F3" },
  content: { padding: 18, paddingBottom: 120 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  eyebrow: { color: "#176B5B", fontSize: 11, fontWeight: "800", letterSpacing: 1.3 },
  header: { color: "#173B35", fontSize: 29, fontWeight: "800", marginTop: 4 },
  clearText: { color: "#B24B3F", fontSize: 14, fontWeight: "700", paddingVertical: 8 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 20 },
  primaryAction: {
    flexGrow: 1,
    flexBasis: 145,
    minHeight: 52,
    borderRadius: 15,
    backgroundColor: "#176B5B",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  primaryActionText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  secondaryAction: {
    flexGrow: 1,
    flexBasis: 145,
    minHeight: 52,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "#BFD5CC",
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
  },
  secondaryActionText: { color: "#176B5B", fontSize: 14, fontWeight: "700" },
  coverageLink: {
    minHeight: 44,
    marginTop: 10,
    paddingHorizontal: 12,
    borderRadius: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#EAF3EF",
  },
  coverageLinkText: { flex: 1, color: "#176B5B", fontSize: 13, fontWeight: "700" },
  emptyCard: {
    marginTop: 28,
    padding: 30,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E5E9E3",
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#DDF0E8",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { color: "#173B35", fontSize: 19, fontWeight: "800", marginTop: 16 },
  emptyCopy: { color: "#667570", fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 7 },
  batchSummary: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 24 },
  sectionTitle: { color: "#173B35", fontSize: 17, fontWeight: "800" },
  summaryText: { color: "#667570", fontSize: 13, fontWeight: "600" },
  draftStrip: { gap: 10, paddingVertical: 12, paddingHorizontal: 2 },
  draftThumbWrap: { width: 74, height: 74, borderRadius: 16, borderWidth: 2, borderColor: "transparent" },
  draftThumbFocused: { borderColor: "#176B5B" },
  draftThumb: { width: "100%", height: "100%", borderRadius: 13, backgroundColor: "#E4E8E2" },
  videoPlaceholder: { backgroundColor: "#315B54", alignItems: "center", justifyContent: "center" },
  videoLabel: { color: "#FFFFFF", fontSize: 14, fontWeight: "700", marginTop: 8 },
  draftIndex: {
    position: "absolute",
    left: 5,
    top: 5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  draftIndexSelected: { backgroundColor: "#176B5B" },
  draftIndexText: { color: "#52645F", fontSize: 11, fontWeight: "800" },
  draftIndexTextSelected: { color: "#FFFFFF" },
  assignmentCount: {
    position: "absolute",
    right: 5,
    bottom: 5,
    height: 20,
    minWidth: 27,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: "rgba(23,59,53,0.88)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  assignmentCountText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  editorCard: { backgroundColor: "#FFFFFF", borderRadius: 22, padding: 14, marginTop: 4 },
  heroImage: { width: "100%", aspectRatio: 4 / 3, borderRadius: 16, backgroundColor: "#E4E8E2" },
  useRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 16 },
  useCopy: { flex: 1 },
  editorTitle: { color: "#173B35", fontSize: 16, fontWeight: "800" },
  editorHint: { color: "#75817E", fontSize: 13, marginTop: 3 },
  toggle: {
    width: 50,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#D5DAD7",
    padding: 3,
    justifyContent: "center",
  },
  toggleActive: { backgroundColor: "#176B5B" },
  toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF" },
  toggleKnobActive: { alignSelf: "flex-end" },
  divider: { height: 1, backgroundColor: "#E9ECE7", marginVertical: 16 },
  aiStatus: {
    marginTop: 10,
    padding: 11,
    borderRadius: 12,
    backgroundColor: "#F2F5F2",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  aiStatusReady: { backgroundColor: "#EAF5F0" },
  aiStatusText: { flex: 1, color: "#52645F", fontSize: 12, lineHeight: 17 },
  petGrid: { gap: 8, marginTop: 12 },
  petChip: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E1E6E0",
    backgroundColor: "#FAFBF8",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  petChipActive: { borderColor: "#9EC7B7", backgroundColor: "#EAF5F0" },
  petAvatar: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: "#E6EAE6",
    alignItems: "center",
    justifyContent: "center",
  },
  petAvatarActive: { backgroundColor: "#CBE7DC" },
  petAvatarText: { color: "#62706C", fontSize: 13, fontWeight: "800" },
  petAvatarTextActive: { color: "#176B5B" },
  petChipText: { flex: 1, color: "#344B46", fontSize: 15, fontWeight: "600" },
  petChipTextActive: { color: "#176B5B" },
  aiBadge: { backgroundColor: "#D6EEE5", borderRadius: 9, paddingHorizontal: 7, paddingVertical: 4 },
  aiBadgeReview: { backgroundColor: "#FFF0C9" },
  aiBadgeText: { color: "#176B5B", fontSize: 10, fontWeight: "800" },
  aiBadgeReviewText: { color: "#8A5A00" },
  noPets: { color: "#B24B3F", fontSize: 13, marginTop: 12 },
  removeButton: { flexDirection: "row", gap: 6, alignSelf: "center", alignItems: "center", padding: 14, marginTop: 6 },
  removeButtonText: { color: "#B24B3F", fontSize: 13, fontWeight: "700" },
  uploadList: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 12, marginTop: 14, gap: 8 },
  uploadRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  uploadFile: { flex: 1, color: "#52645F", fontSize: 12 },
  uploadStatus: { color: "#176B5B", fontSize: 12, fontWeight: "700" },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 82,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E5E8E2",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerCount: { color: "#173B35", fontSize: 15, fontWeight: "800" },
  footerHint: { color: "#75817E", fontSize: 12, marginTop: 3 },
  uploadButton: {
    minWidth: 166,
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 15,
    backgroundColor: "#176B5B",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  buttonDisabled: { opacity: 0.55 },
  uploadButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
});
