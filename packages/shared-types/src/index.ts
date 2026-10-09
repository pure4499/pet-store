// Shared domain types mirroring the Postgres schema (apps/api/db/migrations/0001_init_core_schema.sql).
// Consumed by apps/api, apps/worker, and apps/mobile so the API contract stays in sync
// across services without duplicating field lists by hand in each one.

export type UUID = string;
export type ISODateTime = string;

/** Maximum accepted length for check-in identity and report source clips. */
export const MAX_SOURCE_VIDEO_DURATION_SECONDS = 30;

export type UserRole = "owner_admin" | "manager" | "staff";
export type UserStatus = "invited" | "active" | "disabled";

export interface OrganizationRole {
  id: UUID;
  organizationId: UUID;
  slug: UserRole;
  displayName: string;
  description: string;
  priority: number;
}

export interface UserRoleAssignment {
  organizationId: UUID;
  userId: UUID;
  roleId: UUID;
  assignedBy: UUID | null;
  assignedAt: ISODateTime;
}

export interface Organization {
  id: UUID;
  name: string;
  slug: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface OrganizationSettings {
  organizationId: UUID;
  bestPhotoCount: number;
  matchConfidenceThreshold: number;
  lowConfidenceThreshold: number;
  collarFeatureEnabled: boolean;
  photoRetentionDaysUnpublished: number | null;
}

export interface StaffUser {
  id: UUID;
  organizationId: UUID;
  email: string;
  fullName: string;
  roleId: UUID;
  role: UserRole;
  status: UserStatus;
  createdAt: ISODateTime;
  lastLoginAt: ISODateTime | null;
}

export interface Owner {
  id: UUID;
  organizationId: UUID;
  fullName: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export type HouseholdStatus = "active" | "inactive";
export type HouseholdFlagType = "vip" | "alert";

export interface HouseholdFlag {
  id: UUID;
  organizationId: UUID;
  householdId: UUID;
  flagType: HouseholdFlagType;
  note: string | null;
  active: boolean;
  endedAt: ISODateTime | null;
}

export interface HouseholdAddress {
  id: UUID;
  organizationId: UUID;
  householdId: UUID;
  addressType: "home" | "mailing" | "other";
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  isPrimary: boolean;
}

export type Species = "dog" | "cat" | "other";
export type Sex = "male" | "female" | "unknown";
export type PetStatus = "active" | "inactive" | "deceased" | "transferred";
export type PetSizeClass = "toy" | "small" | "medium" | "large" | "giant" | "unknown";
export type ReproductiveStatus = "intact" | "spayed" | "neutered" | "unknown";

export interface Pet {
  id: UUID;
  organizationId: UUID;
  ownerId: UUID | null;
  name: string;
  species: Species;
  breed: string | null;
  dateOfBirth: string | null;
  dateOfBirthIsApproximate: boolean;
  sex: Sex | null;
  reproductiveStatus: ReproductiveStatus | null;
  status: PetStatus;
  isMixedBreed: boolean | null;
  sizeClass: PetSizeClass | null;
  weightKg: number | null;
  colorMarkings: string | null;
  medicalNotes: string | null;
  careNotes: string | null;
  temperament: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type CommunicationPurpose =
  | "service_reminders"
  | "marketing"
  | "service_reminders_and_marketing";
export type CommunicationChannel = "all" | "email" | "sms" | "phone" | "postal";
export type CommunicationPreferenceStatus = "opted_in" | "opted_out" | "unknown";

export interface OwnerCommunicationPreference {
  id: UUID;
  organizationId: UUID;
  ownerId: UUID;
  purpose: CommunicationPurpose;
  channel: CommunicationChannel;
  preferenceStatus: CommunicationPreferenceStatus;
  externalSourceId: UUID | null;
  importBatchId: UUID | null;
  sourceRecordedAt: ISODateTime | null;
}

export type PetIdentifierType = "microchip" | "registration";

export interface PetIdentifier {
  id: UUID;
  organizationId: UUID;
  petId: UUID;
  identifierType: PetIdentifierType;
  identifierValue: string;
  issuer: string | null;
  externalSourceId: UUID | null;
  importBatchId: UUID | null;
}

export type PetFlagType =
  | "bite_risk"
  | "dog_reactivity"
  | "escape_risk"
  | "muzzle_required"
  | "leash_required_in_kennel"
  | "visual_impairment"
  | "vocal";

export interface PetFlag {
  id: UUID;
  organizationId: UUID;
  petId: UUID;
  flagType: PetFlagType;
  note: string | null;
  active: boolean;
  endedAt: ISODateTime | null;
}

export type PetNoteType = "internal" | "customer_provided";

export interface PetNote {
  id: UUID;
  organizationId: UUID;
  petId: UUID;
  noteType: PetNoteType;
  body: string;
  externalSourceId: UUID | null;
  importBatchId: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type CareProviderType = "veterinarian" | "groomer" | "other";

export interface CareProvider {
  id: UUID;
  organizationId: UUID;
  providerType: CareProviderType;
  name: string;
  phone: string | null;
  email: string | null;
}

export type DataImportStatus =
  | "planned"
  | "validated"
  | "importing"
  | "completed"
  | "failed"
  | "rolled_back";

export interface DataImportBatch {
  id: UUID;
  organizationId: UUID;
  externalSourceId: UUID;
  sourceFileId: string | null;
  sourceFileName: string;
  sourceSheetName: string | null;
  sourceRowCount: number;
  status: DataImportStatus;
  validationSummary: Record<string, unknown>;
  importedBy: UUID | null;
  startedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type DataImportIssueStatus = "open" | "resolved" | "ignored";

export interface DataImportIssue {
  id: UUID;
  organizationId: UUID;
  importBatchId: UUID;
  sourceRowNumber: number | null;
  entityType: "household" | "owner" | "pet" | "service";
  externalId: string | null;
  fieldName: string;
  issueCode: string;
  rawValue: string | null;
  resolutionStatus: DataImportIssueStatus;
  resolutionNote: string | null;
  createdAt: ISODateTime;
  resolvedAt: ISODateTime | null;
}

export type PetServiceType = "grooming" | "boarding" | "daycare";

export interface PetServiceMilestone {
  id: UUID;
  organizationId: UUID;
  petId: UUID;
  importBatchId: UUID;
  externalSourceId: UUID;
  serviceType: PetServiceType;
  occurredOn: string;
  createdAt: ISODateTime;
}

export interface ExternalSource {
  id: UUID;
  organizationId: UUID;
  sourceKey: string;
  displayName: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CollarPaletteColor {
  id: UUID;
  organizationId: UUID;
  colorName: string;
  colorHex: string | null;
  qrPayload: string;
  isActive: boolean;
}

export type SessionType = "boarding" | "daycare";
export type SessionStatus = "reserved" | "active" | "checked_out" | "cancelled";

export interface Session {
  id: UUID;
  organizationId: UUID;
  petId: UUID;
  sessionType: SessionType;
  scheduledCheckInAt: ISODateTime;
  checkInAt: ISODateTime | null;
  expectedCheckOutAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  status: SessionStatus;
  notes: string | null;
  collarEnabled: boolean;
  collarPaletteId: UUID | null;
  collarLabel: string | null;
  collarAssignedAt: ISODateTime | null;
}

export type LogEntryType =
  | "note"
  | "feeding"
  | "medication"
  | "activity"
  | "incident"
  | "other";

export const CARE_LOG_PRESETS = [
  { id: "feeding", label: "Feeding", icon: "🍽️", entryType: "feeding", defaultBody: "Yum! Mealtime went great." },
  { id: "water", label: "Fresh water", icon: "💧", entryType: "feeding", defaultBody: "Fresh water and happy sips!" },
  { id: "potty", label: "Potty", icon: "✓", entryType: "other", defaultBody: "Potty time went great!" },
  { id: "walk", label: "Walk", icon: "🐾", entryType: "activity", defaultBody: "We had a lovely little walk!" },
  { id: "play", label: "Playtime", icon: "🎾", entryType: "activity", defaultBody: "So much fun at playtime!" },
  { id: "rest", label: "Rest", icon: "☁️", entryType: "activity", defaultBody: "Cozy, comfy rest time." },
  { id: "medication", label: "Medication", icon: "✚", entryType: "medication", defaultBody: "Medication was given with care." },
  { id: "grooming", label: "Grooming", icon: "✦", entryType: "other", defaultBody: "Freshened up and looking extra cute!" },
  { id: "happy_social", label: "Happy & social", icon: "♡", entryType: "note", defaultBody: "Lots of happy moments with friends today!" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: string;
  entryType: LogEntryType;
  defaultBody: string;
}>;

export type CareLogPresetId = (typeof CARE_LOG_PRESETS)[number]["id"];

export interface DailyLogEntry {
  id: UUID;
  organizationId: UUID;
  sessionId: UUID;
  entryType: LogEntryType;
  entryAt: ISODateTime;
  createdBy: UUID;
  title: string | null;
  body: string | null;
  structuredData: Record<string, unknown> | null;
}

export type PhotoProcessingStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "processed"
  | "failed";

export interface Photo {
  id: UUID;
  organizationId: UUID;
  batchId: UUID | null;
  storageKey: string;
  thumbnailKey: string | null;
  captureAt: ISODateTime | null;
  uploadedAt: ISODateTime;
  width: number | null;
  height: number | null;
  processingStatus: PhotoProcessingStatus;
  processingError: string | null;
}

export type MatchStatus =
  | "pending"
  | "matched"
  | "low_confidence"
  | "no_match"
  | "manually_assigned"
  | "manually_rejected";

export interface PhotoDetection {
  id: UUID;
  photoId: UUID;
  organizationId: UUID;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  cropStorageKey: string | null;
  detectorConfidence: number | null;
  speciesGuess: "dog" | "cat" | "unknown" | null;
  qualityScore: number | null;
  matchedPetId: UUID | null;
  matchConfidence: number | null;
  matchStatus: MatchStatus;
}

export type PhotoReviewState = "pending" | "candidate" | "rejected" | "published";

export interface PhotoPetLink {
  id: UUID;
  organizationId: UUID;
  photoId: UUID;
  petId: UUID;
  sessionId: UUID;
  associationType: "auto_matched" | "manual";
  reviewState: PhotoReviewState;
  qualityScore: number | null;
  isManuallyAdjusted: boolean;
  publishedAt: ISODateTime | null;
}

export type VideoReviewState = "candidate" | "rejected" | "published";

export interface Video {
  id: UUID;
  organizationId: UUID;
  storageKey: string;
  captureAt: ISODateTime | null;
  uploadedAt: ISODateTime;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  contentType: "video/mp4" | "video/quicktime";
}

export interface VideoPetLink {
  id: UUID;
  organizationId: UUID;
  videoId: UUID;
  petId: UUID;
  sessionId: UUID;
  associationType: "auto_matched" | "manual";
  reviewState: VideoReviewState;
  isManuallyAdjusted: boolean;
  publishedAt: ISODateTime | null;
}

export type ReportVideoStatus = "queued" | "rendering" | "ready" | "failed" | "approved" | "published";
export type ReportMusicStyle = "none" | "warm_story" | "day_in_motion" | "gentle_care" | "dreamy_memories" | "sunny_postcard";
export type ReportVisualStyle = "clean" | "sticker_dots" | "cartoon_title";
export type ReportMediaWindow = "report_day" | "last_2_days" | "last_3_days" | "full_stay";

export interface ReportVideoDraft {
  id: UUID;
  organizationId: UUID;
  sessionId: UUID;
  petId: UUID;
  reportDate: string;
  mediaWindow: ReportMediaWindow;
  template: "storybook" | "timeline_diary" | "care_card" | "photo_journal" | "postcard";
  musicStyle: ReportMusicStyle;
  visualStyle: ReportVisualStyle;
  title: string;
  storyText: string | null;
  storyFacts: Record<string, unknown>;
  closingCaption: string | null;
  mainPhotoId: UUID | null;
  targetSeconds: number;
  actualSeconds: number | null;
  status: ReportVideoStatus;
  outputStorageKey: string | null;
  renderError: string | null;
  createdAt: ISODateTime;
}
