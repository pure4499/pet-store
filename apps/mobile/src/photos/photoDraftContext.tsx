import { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";

export interface PhotoDraft {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
  mediaType: "image" | "video";
  durationSeconds?: number;
  width?: number;
  height?: number;
  fileSizeBytes?: number;
  assignedSessionIds: string[];
  uploadedPhotoId?: string;
  analysisBatchId?: string;
  analysisStatus: "not_started" | "processing" | "ready" | "failed";
  aiSuggestions: PhotoAiSuggestion[];
  isManuallyAdjusted: boolean;
  selected: boolean;
}

export interface PhotoAiSuggestion {
  detectionId: string;
  petId: string;
  sessionId: string;
  petName: string;
  confidence: number | null;
  matchStatus: "matched" | "low_confidence";
}

interface NewPhotoDraft {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  mediaType?: "image" | "video";
  durationSeconds?: number;
  width?: number;
  height?: number;
  fileSizeBytes?: number;
}

interface PhotoDraftContextValue {
  drafts: PhotoDraft[];
  addDrafts: (photos: NewPhotoDraft[]) => string[];
  toggleAssignment: (draftId: string, sessionId: string) => void;
  markDraftAnalyzing: (draftId: string, batchId: string, photoId: string) => void;
  applyAiSuggestions: (draftId: string, suggestions: PhotoAiSuggestion[]) => void;
  markDraftAnalysisFailed: (draftId: string) => void;
  toggleSelected: (draftId: string) => void;
  removeDraft: (draftId: string) => void;
  removeDrafts: (draftIds: string[]) => void;
  clearDrafts: () => void;
}

const PhotoDraftContext = createContext<PhotoDraftContextValue | null>(null);

export function PhotoDraftProvider({ children }: PropsWithChildren) {
  const [drafts, setDrafts] = useState<PhotoDraft[]>([]);

  const value = useMemo<PhotoDraftContextValue>(
    () => ({
      drafts,
      addDrafts: (photos) => {
        const nonce = Date.now();
        const additions = photos.map((photo, index) => ({
          id: `${nonce}-${index}-${photo.uri}`,
          uri: photo.uri,
          fileName: photo.fileName ?? `ucbarkley-${nonce}-${index + 1}.${photo.mediaType === "video" ? "mp4" : "jpg"}`,
          mimeType: photo.mimeType ?? (photo.mediaType === "video" ? "video/mp4" : "image/jpeg"),
          mediaType: photo.mediaType ?? "image",
          durationSeconds: photo.durationSeconds,
          width: photo.width,
          height: photo.height,
          fileSizeBytes: photo.fileSizeBytes,
          assignedSessionIds: [],
          analysisStatus: "not_started" as const,
          aiSuggestions: [],
          isManuallyAdjusted: false,
          selected: true,
        }));
        setDrafts((current) => [...current, ...additions]);
        return additions.map((draft) => draft.id);
      },
      toggleAssignment: (draftId, sessionId) => {
        setDrafts((current) =>
          current.map((draft) => {
            if (draft.id !== draftId) return draft;
            const isAssigned = draft.assignedSessionIds.includes(sessionId);
            return {
              ...draft,
              isManuallyAdjusted: true,
              assignedSessionIds: isAssigned
                ? draft.assignedSessionIds.filter((id) => id !== sessionId)
                : [...draft.assignedSessionIds, sessionId],
            };
          })
        );
      },
      markDraftAnalyzing: (draftId, batchId, photoId) => {
        setDrafts((current) =>
          current.map((draft) =>
            draft.id === draftId
              ? {
                  ...draft,
                  uploadedPhotoId: photoId,
                  analysisBatchId: batchId,
                  analysisStatus: "processing",
                }
              : draft
          )
        );
      },
      applyAiSuggestions: (draftId, suggestions) => {
        setDrafts((current) =>
          current.map((draft) => {
            if (draft.id !== draftId) return draft;
            const suggestedSessionIds = Array.from(
              new Set(suggestions.map((suggestion) => suggestion.sessionId))
            );
            return {
              ...draft,
              analysisStatus: "ready",
              aiSuggestions: suggestions,
              assignedSessionIds: draft.isManuallyAdjusted
                ? draft.assignedSessionIds
                : suggestedSessionIds,
            };
          })
        );
      },
      markDraftAnalysisFailed: (draftId) => {
        setDrafts((current) =>
          current.map((draft) =>
            draft.id === draftId ? { ...draft, analysisStatus: "failed" } : draft
          )
        );
      },
      toggleSelected: (draftId) => {
        setDrafts((current) =>
          current.map((draft) => (draft.id === draftId ? { ...draft, selected: !draft.selected } : draft))
        );
      },
      removeDraft: (draftId) => setDrafts((current) => current.filter((draft) => draft.id !== draftId)),
      removeDrafts: (draftIds) => {
        const ids = new Set(draftIds);
        setDrafts((current) => current.filter((draft) => !ids.has(draft.id)));
      },
      clearDrafts: () => setDrafts([]),
    }),
    [drafts]
  );

  return <PhotoDraftContext.Provider value={value}>{children}</PhotoDraftContext.Provider>;
}

export function usePhotoDrafts(): PhotoDraftContextValue {
  const context = useContext(PhotoDraftContext);
  if (!context) throw new Error("usePhotoDrafts must be used within PhotoDraftProvider");
  return context;
}
