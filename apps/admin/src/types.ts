export type ReviewFilter = "review" | "candidate" | "unmatched" | "failed" | "published" | "all";

export interface DashboardStats {
  active_sessions: number;
  photos_to_review: number;
  photos_published_today: number;
  videos_to_review: number;
  videos_ready_to_approve: number;
}

export interface SessionSummary {
  session_id: string;
  pet_id: string;
  pet_name: string;
  species: string;
  breed: string | null;
  session_type: string;
  check_in_at: string;
  expected_check_out_at: string | null;
  candidate_photo_count: number;
  published_photo_count: number;
  candidate_video_count: number;
  logs_today: number;
  latest_photo_at: string | null;
  photo_thumbnail_url: string | null;
}

export interface DashboardData {
  organization: { id: string; name: string; slug: string; best_photo_count: number };
  stats: DashboardStats;
  sessions: SessionSummary[];
  mediaUsage: {
    photoBytes: number;
    videoBytes: number;
    totalBytes: number;
    photoCount: number;
    videoCount: number;
    storageLimitBytes: number;
  };
}

export interface CollarPaletteItem {
  id: string;
  organization_id: string;
  color_name: string;
  color_hex: string | null;
  qr_payload: string;
  is_active: boolean;
  in_use: boolean;
}

export interface SessionOption {
  id: string;
  pet_id: string;
  pet_name: string;
  species: string;
  session_type: string;
  status: "reserved" | "active" | "checked_out" | "cancelled";
  scheduled_check_in_at: string;
  check_in_at: string | null;
  expected_check_out_at: string | null;
  reservation_group_id: string | null;
  notes: string | null;
  check_out_at: string | null;
  photo_thumbnail_url: string | null;
}

export interface PetOption {
  id: string;
  owner_id: string | null;
  name: string;
  species: "dog" | "cat" | "other";
  breed: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  photo_thumbnail_url: string | null;
}

export interface CustomerAddress {
  id: string;
  address_type: "home" | "mailing" | "other";
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  is_primary?: boolean;
}

export interface CustomerPetSummary {
  id: string;
  name: string;
  species: "dog" | "cat" | "other";
  breed: string | null;
  status: "active" | "inactive" | "deceased" | "transferred";
  photo_thumbnail_url: string | null;
}

export interface CustomerSummary {
  id: string;
  household_id: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  household_status: "active" | "inactive" | null;
  primary_address: CustomerAddress | null;
  pets: CustomerPetSummary[];
  open_issue_count: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerPetDetail extends CustomerPetSummary {
  owner_id: string;
  date_of_birth: string | null;
  date_of_birth_is_approximate: boolean;
  sex: "male" | "female" | "unknown" | null;
  reproductive_status: "intact" | "spayed" | "neutered" | "unknown" | null;
  is_mixed_breed: boolean | null;
  size_class: "toy" | "small" | "medium" | "large" | "giant" | "unknown" | null;
  weight_kg: string | null;
  color_markings: string | null;
  medical_notes: string | null;
  care_notes: string | null;
  temperament: string | null;
  flags: Array<{ flag_type: string; note: string | null }>;
  notes: Array<{ note_type: "internal" | "customer_provided"; body: string }>;
  identifiers: Array<{ identifier_type: string; identifier_value: string; issuer: string | null }>;
  care_providers: Array<{
    id: string;
    provider_type: string;
    name: string;
    phone: string | null;
    email: string | null;
    relationship: string;
  }>;
  service_milestones: Array<{ service_type: string; occurred_on: string }>;
  stay_count: number;
  last_stay_at: string | null;
}

export interface CustomerImportIssue {
  id: string;
  entity_type: "household" | "owner" | "pet" | "service";
  external_id: string | null;
  field_name: string;
  issue_code: string;
  raw_value: string | null;
  resolution_status: "open" | "resolved" | "ignored";
  resolution_note: string | null;
  source_row_number: number | null;
  created_at: string;
}

export interface CustomerDetail extends Omit<CustomerSummary, "primary_address" | "open_issue_count" | "pets"> {
  addresses: CustomerAddress[];
  household_flags: Array<{ flag_type: "vip" | "alert"; note: string | null }>;
  communication_preferences: Array<{ purpose: string; channel: string; preference_status: string }>;
  pets: CustomerPetDetail[];
  import_issues: CustomerImportIssue[];
}

export interface CustomerDirectoryResponse {
  customers: CustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Detection {
  id: string;
  bbox_x: string;
  bbox_y: string;
  bbox_width: string;
  bbox_height: string;
  detector_confidence: string | null;
  species_guess: string | null;
  quality_score: string | null;
  matched_pet_id: string | null;
  matched_pet_name: string | null;
  matched_session_id: string | null;
  match_confidence: string | null;
  match_status: string;
  match_signals?: {
    appearanceSimilarity?: number;
    leashColorAvailable?: boolean;
    leashColorAgreement?: number;
    leashColorAdjustment?: number;
    combinedRankingScore?: number;
  };
  cropUrl: string | null;
}

export interface PhotoLink {
  id: string;
  photo_id?: string;
  pet_id: string;
  pet_name?: string;
  session_id: string;
  source_detection_id: string | null;
  association_type: "auto_matched" | "manual";
  review_state: "pending" | "candidate" | "rejected" | "published";
  quality_score: string | null;
  is_manually_adjusted: boolean;
  published_at: string | null;
  viewUrl?: string;
  capture_at?: string | null;
  uploaded_at?: string;
  source_identity_photo_id?: string | null;
  width?: number | null;
  height?: number | null;
  hero_bbox_x?: string | null;
  hero_bbox_y?: string | null;
  hero_bbox_width?: string | null;
  hero_bbox_height?: string | null;
  hero_detector_confidence?: string | null;
  detected_pet_count?: number;
}

export interface ReviewPhoto {
  id: string;
  processing_status: string;
  processing_error: string | null;
  capture_at: string | null;
  uploaded_at: string;
  uploaded_by_name: string;
  width: number | null;
  height: number | null;
  viewUrl: string;
  detections: Detection[];
  links: PhotoLink[];
}

export interface VideoLink {
  id: string;
  video_id: string;
  pet_id: string;
  session_id: string;
  review_state: "candidate" | "rejected" | "published";
  duration_seconds: string | null;
  content_type: string;
  capture_at: string | null;
  uploaded_at: string;
  viewUrl: string;
}

export interface DailyLog {
  id: string;
  entry_type: string;
  entry_at: string;
  title: string | null;
  body: string | null;
  structured_data: Record<string, unknown> | null;
  created_by_name: string | null;
}

export interface ReportVideo {
  id: string;
  report_date: string;
  media_window: ReportMediaWindow;
  template: ReportTheme;
  music_style: ReportMusicStyle;
  visual_style: ReportVisualStyle;
  title: string;
  story_text: string | null;
  story_facts?: {
    source?: string;
    companionPets?: Array<{ id: string; name: string; appearedInPhoto: boolean; appearedInVideo: boolean }>;
    recordedMoments?: string[];
    selectedPhotoCount?: number;
    selectedVideoIncluded?: boolean;
    coversMultipleDays?: boolean;
  };
  closing_caption: string | null;
  target_seconds: number;
  actual_seconds: string | null;
  status: "queued" | "rendering" | "ready" | "failed" | "approved" | "published";
  render_error: string | null;
  main_photo_id: string | null;
  photo_ids?: string[];
  previewUrl: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
  shareUrl: string | null;
  share_created_at: string | null;
  last_emailed_at: string | null;
  emailRecipientOverride: string | null;
  emailDeliveryConfigured: boolean;
}

export type ReportTheme = "storybook" | "timeline_diary" | "care_card" | "photo_journal" | "postcard";
export type ReportMusicStyle = "none" | "warm_story" | "day_in_motion" | "gentle_care" | "dreamy_memories" | "sunny_postcard";
export type ReportVisualStyle = "clean" | "sticker_dots" | "cartoon_title";
export type ReportMediaWindow = "report_day" | "last_2_days" | "last_3_days" | "full_stay";

export interface SessionWorkspaceData {
  session: SessionOption & {
    owner_name: string | null;
    owner_email: string | null;
    owner_phone: string | null;
    breed: string | null;
    expected_check_out_at: string | null;
    notes: string | null;
    collar_enabled: boolean;
    collar_label: string | null;
    collar_color_name: string | null;
    collar_color_hex: string | null;
    checked_in_by_name: string | null;
  };
  photos: PhotoLink[];
  videos: VideoLink[];
  logs: DailyLog[];
  reports: ReportVideo[];
}

export interface IdentityMediaStatus {
  session: { id: string; pet_id: string; pet_name: string };
  photos: Array<{
    id: string;
    processing_status: "uploaded" | "queued" | "processing" | "processed" | "failed";
    processing_error: string | null;
    source_video_id: string | null;
    capture_at: string | null;
    uploaded_at: string;
    detected_pet_count: number;
    enrolled_embedding_count: number;
    best_quality_score: string | null;
    best_detector_confidence: string | null;
    viewUrl: string;
  }>;
  videos: Array<{
    id: string;
    processing_status: "queued" | "uploaded" | "processing" | "processed" | "failed";
    processing_error: string | null;
    extracted_frame_count: number;
    duration_seconds: string | null;
    uploaded_at: string;
  }>;
}

export interface CatalogItem {
  id: string;
  item_type: "service" | "product";
  name: string;
  description: string | null;
  sku: string | null;
  unit_price_cents: number;
  currency: string;
  taxable: boolean;
  track_inventory: boolean;
  is_active: boolean;
}

export interface CommerceStay {
  session_id: string;
  pet_id: string;
  pet_name: string;
  session_type: "boarding" | "daycare";
  status: "reserved" | "active";
  check_in_at: string | null;
  scheduled_check_in_at: string | null;
  expected_check_out_at: string | null;
  charge_sheet_id: string | null;
  charge_status: "open" | "locked" | "settled" | "void";
  currency: string;
  item_count: number;
  total_cents: number;
  photo_thumbnail_url: string | null;
}

export interface CommerceOverview {
  stats: {
    current_stays: number;
    charged_stays: number;
    open_total_cents: number;
  };
  stays: CommerceStay[];
  payment_status: "not_connected";
}

export interface ChargeSheetItem {
  id: string;
  catalog_item_id: string | null;
  item_type: "service" | "product";
  name: string;
  unit_price_cents: number;
  quantity: number;
  discount_cents: number;
  tax_cents: number;
  notes: string | null;
  line_total_cents: number;
}

export interface ChargeSheet {
  id: string | null;
  session_id: string;
  pet_id: string;
  status: "open" | "locked" | "settled" | "void";
  currency: string;
  notes: string | null;
  items: ChargeSheetItem[];
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_status: "not_connected";
}

export type UserRoleSlug = "owner_admin" | "manager" | "staff";

export interface FacilityOption {
  id: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

export interface RoleOption {
  id: string;
  slug: UserRoleSlug;
  display_name: string;
  description: string;
  priority: number;
}

export interface OrganizationUser {
  id: string;
  email: string;
  full_name: string;
  status: "active" | "disabled" | "invited";
  created_at: string;
  last_login_at: string | null;
  role_id: string;
  role_slug: UserRoleSlug;
  role_name: string;
  role_description: string;
  facilities: Array<{ id: string; name: string }>;
}

export interface UserProfile extends OrganizationUser {
  organization_name: string;
}
