import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARE_LOG_PRESETS, MAX_SOURCE_VIDEO_DURATION_SECONDS, type CareLogPresetId } from "@ucbarkley/shared-types";
import QRCode from "qrcode";
import { API_URL, api } from "./api";
import { isImageFile, MAX_ADMIN_MEDIA_BATCH_ITEMS, prepareImageFiles } from "./imageFiles";
import type {
  DashboardData,
  DailyLog,
  PetOption,
  PhotoLink,
  ReportVideo,
  ReportMusicStyle,
  ReportMediaWindow,
  ReportVisualStyle,
  ReportTheme,
  ReviewFilter,
  ReviewPhoto,
  SessionOption,
  SessionWorkspaceData,
  IdentityMediaStatus,
  OrganizationUser,
  RoleOption,
  UserProfile,
  SessionSummary,
  CustomerDetail,
  CustomerPetDetail,
  CustomerSummary,
  CatalogItem,
  ChargeSheet,
  CommerceOverview,
  CollarPaletteItem,
  FacilityOption,
} from "./types";

type View = { name: "dashboard" } | { name: "stays" } | { name: "customers" } | { name: "checkin" } | { name: "shop" } | { name: "upload" } | { name: "review" } | { name: "collars" } | { name: "users" } | { name: "profile" } | { name: "session"; sessionId: string };
type UploadPhase = "idle" | "converting" | "uploading" | "analyzing" | "complete";
type UploadActivity = { phase: UploadPhase; completed: number; total: number };
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

interface ConfirmationOptions {
  eyebrow?: string;
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  hideCancel?: boolean;
}

function PetAvatar({ name, src, size }: { name: string; src?: string | null; size?: "small" | "xlarge" }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [src]);
  return <span className={`pet-avatar${size ? ` ${size}` : ""}`} aria-label={`${name} photo`}>
    {src && !imageFailed
      ? <img src={src} alt="" onError={() => setImageFailed(true)} />
      : name.slice(0, 1).toUpperCase()}
  </span>;
}

function ConfirmationDialog({ options, onCancel, onConfirm }: { options: ConfirmationOptions; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onCancel]);

  return <div className="modal-backdrop confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className={`confirmation-dialog ${options.tone === "danger" ? "danger" : ""} ${options.hideCancel ? "notice" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
      <div className="confirmation-icon" aria-hidden="true">{options.tone === "danger" ? "×" : options.hideCancel ? "!" : "?"}</div>
      <div><span className="eyebrow">{options.eyebrow ?? "Please confirm"}</span><h2 id="confirmation-title">{options.title}</h2></div>
      <p id="confirmation-message">{options.message}</p>
      {options.detail && <div className="confirmation-detail">{options.detail}</div>}
      <footer className={options.hideCancel ? "single-action" : ""}>{!options.hideCancel && <button type="button" className="outline-button" autoFocus onClick={onCancel}>{options.cancelLabel ?? "Cancel"}</button>}<button type="button" autoFocus={options.hideCancel} className={options.tone === "danger" ? "danger-button" : "primary-button"} onClick={onConfirm}>{options.confirmLabel}</button></footer>
    </section>
  </div>;
}

function useConfirmation() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const requestConfirmation = useCallback((next: ConfirmationOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);
  const answer = useCallback((confirmed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    resolve?.(confirmed);
  }, []);
  useEffect(() => () => resolver.current?.(false), []);
  const dialog = options
    ? <ConfirmationDialog options={options} onCancel={() => answer(false)} onConfirm={() => answer(true)} />
    : null;
  return { requestConfirmation, confirmationDialog: dialog };
}

function photoDeleteConfirmation(ownerVisible: boolean): ConfirmationOptions {
  return {
    eyebrow: "Photo controls",
    title: ownerVisible ? "Remove this shared photo?" : "Delete this photo?",
    message: ownerVisible
      ? "Families can currently see this photo. Deleting it will remove it from their gallery and from UCBarkley."
      : "This photo will be removed from AI review and from every pet’s photo gallery.",
    detail: ownerVisible
      ? "Videos that were already created will stay the same. This photo cannot be restored from the portal."
      : "This cannot be undone from the portal.",
    confirmLabel: "Delete photo",
    cancelLabel: "Keep photo",
    tone: "danger",
  };
}

function friendlyErrorNotice(error: unknown, title = "We couldn’t finish that"): ConfirmationOptions {
  return {
    eyebrow: "Something went wrong",
    title,
    message: messageOf(error),
    detail: "Nothing was changed. Please try again.",
    confirmLabel: "Got it",
    hideCancel: true,
  };
}

const SIMPLE_VIEWS = new Set<View["name"]>(["dashboard", "stays", "customers", "checkin", "shop", "upload", "review", "collars", "users", "profile"]);

function viewFromUrl(): View {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("view") as View["name"] | null;
  if (name === "session") {
    const sessionId = params.get("session");
    if (sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      return { name, sessionId };
    }
  }
  return name && SIMPLE_VIEWS.has(name) ? { name } as View : { name: "dashboard" };
}

function urlForView(view: View) {
  const url = new URL(window.location.href);
  if (view.name === "dashboard") url.searchParams.delete("view");
  else url.searchParams.set("view", view.name);
  if (view.name === "session") url.searchParams.set("session", view.sessionId);
  else url.searchParams.delete("session");
  return `${url.pathname}${url.search}${url.hash}`;
}

const FILTERS: Array<{ id: ReviewFilter; label: string }> = [
  { id: "review", label: "Needs review" },
  { id: "candidate", label: "Staff selected" },
  { id: "unmatched", label: "AI uncertain" },
  { id: "failed", label: "Processing failed" },
  { id: "published", label: "Published" },
  { id: "all", label: "All photos" },
];

const REPORT_THEMES: Array<{ id: ReportTheme; name: string; description: string }> = [
  { id: "storybook", name: "Storybook", description: "Warm, playful daily story" },
  { id: "timeline_diary", name: "Timeline diary", description: "Care moments in time order" },
  { id: "care_card", name: "Care card", description: "Clean wellness-focused update" },
  { id: "photo_journal", name: "Photo journal", description: "Image-forward scrapbook feel" },
  { id: "postcard", name: "Postcard", description: "Bright note from their stay" },
];

const REPORT_MEDIA_WINDOWS: Array<{ id: ReportMediaWindow; name: string; description: string }> = [
  { id: "report_day", name: "Report day", description: "Only photos and moments from this date" },
  { id: "last_2_days", name: "Last 2 days", description: "This date and the previous day" },
  { id: "last_3_days", name: "Last 3 days", description: "This date and the previous two days" },
  { id: "full_stay", name: "Entire stay", description: "Everything since check-in" },
];

const REPORT_MUSIC_TRACKS: Array<{ id: ReportMusicStyle; name: string; description: string }> = [
  { id: "warm_story", name: "Happy Tails", description: "Bouncy ukulele · handclaps" },
  { id: "day_in_motion", name: "Playtime Bounce", description: "Playful xylophone · skipping beat" },
  { id: "gentle_care", name: "Gentle Sunshine", description: "Warm marimba · cheerful shaker" },
  { id: "dreamy_memories", name: "Happy Memories", description: "Toy glockenspiel · dancing 6/8 rhythm" },
  { id: "sunny_postcard", name: "Sunny Parade", description: "Toy piano · lively parade beat" },
  { id: "none", name: "No music", description: "Keep the highlight silent" },
];

const DEFAULT_MUSIC_BY_THEME: Record<ReportTheme, ReportMusicStyle> = {
  storybook: "warm_story",
  timeline_diary: "day_in_motion",
  care_card: "gentle_care",
  photo_journal: "dreamy_memories",
  postcard: "sunny_postcard",
};

const REPORT_VISUAL_STYLES: Array<{ id: ReportVisualStyle; name: string; description: string; icon: string }> = [
  { id: "clean", name: "Clean", description: "Classic UCBarkley layout", icon: "○" },
  { id: "sticker_dots", name: "Sticker dots", description: "Playful dotted frames and paw stickers", icon: "🐾" },
  { id: "cartoon_title", name: "Cartoon title", description: "Bold, bouncy storybook lettering", icon: "Aa" },
];

type AudibleReportMusicStyle = Exclude<ReportMusicStyle, "none">;

type MusicPreviewTrack = {
  chords: number[][];
  bpm: number;
  instrument: "ukulele" | "xylophone" | "marimba" | "glockenspiel" | "toy_piano";
  groove: "swing" | "bounce" | "shaker" | "six_eight" | "march";
  subdivisions: 2 | 3;
  arpPattern: number[];
  leadRhythm: number[];
  bassRhythm: number[];
  chordRhythm: number[];
};

const MUSIC_PREVIEW_TRACKS: Record<AudibleReportMusicStyle, MusicPreviewTrack> = {
  warm_story: { chords: [[261.63, 329.63, 392, 523.25], [349.23, 440, 523.25, 698.46], [392, 493.88, 587.33, 783.99], [261.63, 329.63, 392, 523.25], [349.23, 440, 523.25, 698.46], [293.66, 369.99, 440, 587.33], [392, 493.88, 587.33, 783.99], [261.63, 329.63, 392, 523.25]], bpm: 136, instrument: "ukulele", groove: "swing", subdivisions: 2, arpPattern: [0, 2, 1, 3, 2, 1, 3, 2], leadRhythm: [1, 0, .72, .42, 1, 0, .62, 0], bassRhythm: [1, 0, .65, 0, 1, 0, .65, 0], chordRhythm: [1, 0, 0, .7, 1, 0, 0, .7] },
  day_in_motion: { chords: [[293.66, 369.99, 440, 587.33], [392, 493.88, 587.33, 783.99], [440, 554.37, 659.25, 880], [293.66, 369.99, 440, 587.33], [392, 493.88, 587.33, 783.99], [329.63, 415.3, 493.88, 659.25], [440, 554.37, 659.25, 880], [293.66, 369.99, 440, 587.33]], bpm: 152, instrument: "xylophone", groove: "bounce", subdivisions: 2, arpPattern: [0, 1, 2, 3, 2, 3, 1, 2], leadRhythm: [1, 0, .78, 0, 1, .55, 0, .72], bassRhythm: [1, 0, 0, .8, 1, .65, 0, .8], chordRhythm: [1, 0, .65, 0, 1, 0, .65, 0] },
  gentle_care: { chords: [[349.23, 440, 523.25, 698.46], [466.16, 587.33, 698.46, 932.33], [523.25, 659.25, 783.99, 1046.5], [349.23, 440, 523.25, 698.46], [466.16, 587.33, 698.46, 932.33], [392, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.5], [349.23, 440, 523.25, 698.46]], bpm: 142, instrument: "marimba", groove: "shaker", subdivisions: 2, arpPattern: [0, 2, 1, 2, 3, 2, 1, 2], leadRhythm: [1, .6, 0, .85, 1, .6, 0, .75], bassRhythm: [1, 0, 0, 0, .8, 0, 0, 0], chordRhythm: [1, 0, 0, 0, .75, 0, 0, 0] },
  dreamy_memories: { chords: [[392, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.5], [587.33, 739.99, 880, 1174.66], [392, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.5], [440, 554.37, 659.25, 880], [587.33, 739.99, 880, 1174.66], [392, 493.88, 587.33, 783.99]], bpm: 146, instrument: "glockenspiel", groove: "six_eight", subdivisions: 3, arpPattern: [0, 1, 2, 3, 2, 1, 0, 2, 3, 1, 2, 3], leadRhythm: [1, 0, .62, 0, .48, 0, 1, 0, .72, 0, .52, 0], bassRhythm: [1, 0, 0, .65, 0, 0, 1, 0, 0, .65, 0, 0], chordRhythm: [1, 0, 0, 0, 0, 0, .8, 0, 0, 0, 0, 0] },
  sunny_postcard: { chords: [[392, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.5], [587.33, 739.99, 880, 1174.66], [392, 493.88, 587.33, 783.99], [523.25, 659.25, 783.99, 1046.5], [587.33, 739.99, 880, 1174.66], [392, 493.88, 587.33, 783.99], [392, 493.88, 587.33, 783.99]], bpm: 150, instrument: "toy_piano", groove: "march", subdivisions: 2, arpPattern: [0, 2, 3, 1, 2, 3, 2, 1], leadRhythm: [1, 0, .78, .48, 1, 0, .82, .55], bassRhythm: [1, 0, 1, 0, 1, 0, 1, 0], chordRhythm: [1, 0, .8, 0, 1, 0, .8, 0] },
};

interface MusicPreviewPlayback {
  stop: () => void;
}

export default function App() {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [authenticated, setAuthenticated] = useState(api.hasSession);
  const [currentRole, setCurrentRole] = useState(api.currentRole);
  const [view, setView] = useState<View>(viewFromUrl);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadActivity, setUploadActivity] = useState<UploadActivity>({ phase: "idle", completed: 0, total: 0 });
  const [checkingOutSessionId, setCheckingOutSessionId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadFoundation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const refreshed = await api.refreshSession();
      if (!refreshed) {
        setAuthenticated(false);
        return;
      }
      setCurrentRole(api.currentRole);
      const [dashboardData, sessionData] = await Promise.all([api.dashboard(), api.sessions()]);
      setDashboard(dashboardData);
      setSessions(sessionData.filter((session) => session.status !== "cancelled"));
    } catch (caught) {
      setError(messageOf(caught));
      if (messageOf(caught).includes("manager access") || messageOf(caught).includes("401")) {
        api.logout();
        setAuthenticated(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) void loadFoundation();
  }, [authenticated, loadFoundation]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const restoreView = () => {
      setView(viewFromUrl());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, []);

  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />;
  }

  const navigate = (next: View) => {
    window.history.pushState(null, "", urlForView(next));
    setView(next);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const checkOut = async (sessionId: string, petName: string) => {
    if (!await requestConfirmation({
      eyebrow: "Departure",
      title: `Check ${petName} out?`,
      message: `${petName} will leave the active stays and AI review lists.`,
      detail: "Photos, care updates, and report history will be kept.",
      confirmLabel: "Check out",
      cancelLabel: "Keep checked in",
      tone: "danger",
    })) return;
    setCheckingOutSessionId(sessionId);
    setError(null);
    try {
      await api.checkOut(sessionId);
      setToast(`${petName} checked out.`);
      await loadFoundation();
      if (view.name === "session" && view.sessionId === sessionId) navigate({ name: "stays" });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCheckingOutSessionId(null);
    }
  };
  const canManageUsers = currentRole === "super_admin" || currentRole === "owner_admin";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate({ name: "dashboard" })}>
          <span className="brand-mark"><img src="/ucbarkley-icon.png" alt="" /></span>
          <span><b>UCBarkley</b><small>Manager portal</small></span>
        </button>
        <nav className="desktop-nav">
          <div className="sidebar-primary-nav">
            <NavButton active={view.name === "dashboard"} icon="⌂" onClick={() => navigate({ name: "dashboard" })}>Overview</NavButton>
            <NavButton active={view.name === "stays"} icon="●" count={dashboard?.stats.active_sessions} onClick={() => navigate({ name: "stays" })}>Active stays</NavButton>
            <NavButton active={view.name === "customers"} icon="♡" onClick={() => navigate({ name: "customers" })}>Customers</NavButton>
            <NavButton active={view.name === "checkin"} icon="+" onClick={() => navigate({ name: "checkin" })}>Check-in</NavButton>
            {/* <NavButton active={view.name === "shop"} icon="$" onClick={() => navigate({ name: "shop" })}>Shop & POS</NavButton> */}
            <NavButton active={view.name === "upload"} icon="↑" onClick={() => navigate({ name: "upload" })}>Upload photos</NavButton>
            <NavButton active={view.name === "review"} icon="✦" count={dashboard?.stats.photos_to_review} onClick={() => navigate({ name: "review" })}>AI review</NavButton>
            {/* <NavButton active={view.name === "collars"} icon="▣" onClick={() => navigate({ name: "collars" })}>Collar management</NavButton> */}
            {canManageUsers && <NavButton active={view.name === "users"} icon="◎" onClick={() => navigate({ name: "users" })}>Users & roles</NavButton>}
          </div>
          <div className="sidebar-stays">
            <div className="nav-heading">Active stays</div>
            {dashboard?.sessions.map((session) => (
              <NavButton key={session.session_id} active={view.name === "session" && view.sessionId === session.session_id} icon={session.pet_name.slice(0, 1).toUpperCase()} onClick={() => navigate({ name: "session", sessionId: session.session_id })}>
                {session.pet_name}
              </NavButton>
            ))}
          </div>
        </nav>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <NavButton active={view.name === "dashboard"} icon="⌂" onClick={() => navigate({ name: "dashboard" })}>Overview</NavButton>
          <NavButton active={view.name === "stays" || view.name === "session"} icon="●" count={dashboard?.stats.active_sessions} onClick={() => navigate({ name: "stays" })}>Stays</NavButton>
          <NavButton active={view.name === "checkin"} icon="+" onClick={() => navigate({ name: "checkin" })}>Check-in</NavButton>
          <NavButton active={view.name === "upload"} icon="↑" onClick={() => navigate({ name: "upload" })}>Upload</NavButton>
          <NavButton active={mobileMenuOpen || view.name === "customers" || view.name === "shop" || view.name === "review" || view.name === "collars" || view.name === "users" || view.name === "profile"} icon="•••" onClick={() => setMobileMenuOpen(true)}>More</NavButton>
        </nav>
        <div className="sidebar-footer">
          <span className="live-dot" /> Connected to<br /><small>{API_URL}</small>
          <div><button onClick={() => navigate({ name: "profile" })}>My profile</button><button onClick={() => { api.logout(); setAuthenticated(false); }}>Sign out</button></div>
        </div>
        {mobileMenuOpen && <div className="mobile-menu-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setMobileMenuOpen(false); }}>
          <section className="mobile-menu-sheet" role="dialog" aria-modal="true" aria-label="More navigation">
            <header><div><span className="eyebrow">Navigation</span><h2>More</h2></div><button className="close-button" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}>×</button></header>
            <div className="mobile-menu-grid">
              <button className={view.name === "customers" ? "active" : ""} onClick={() => navigate({ name: "customers" })}><i>♡</i><span><b>Customers</b><small>Owners and pet records</small></span></button>
              <button className={view.name === "shop" ? "active" : ""} onClick={() => navigate({ name: "shop" })}><i>$</i><span><b>Shop & POS</b><small>Catalog and stay charges</small></span></button>
              <button className={view.name === "review" ? "active" : ""} onClick={() => navigate({ name: "review" })}><i>✦</i><span><b>AI review</b><small>{dashboard?.stats.photos_to_review ?? 0} photos need review</small></span></button>
              <button className={view.name === "collars" ? "active" : ""} onClick={() => navigate({ name: "collars" })}><i>▣</i><span><b>Collar management</b><small>Colors and QR labels</small></span></button>
              {canManageUsers && <button className={view.name === "users" ? "active" : ""} onClick={() => navigate({ name: "users" })}><i>◎</i><span><b>Users & roles</b><small>Manage team access</small></span></button>}
              <button className={view.name === "profile" ? "active" : ""} onClick={() => navigate({ name: "profile" })}><i>☺</i><span><b>My profile</b><small>Account and password</small></span></button>
            </div>
            <footer><button onClick={() => { setMobileMenuOpen(false); void loadFoundation(); }}>↻ Refresh data</button><button onClick={() => { setMobileMenuOpen(false); api.logout(); setAuthenticated(false); }}>Sign out</button></footer>
          </section>
        </div>}
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">{dashboard?.organization.name ?? "UCBarkley"}</span>
            <strong>{view.name === "dashboard" ? "Today’s care desk" : view.name === "stays" ? "Pets currently on site" : view.name === "customers" ? "Customer directory" : view.name === "checkin" ? "Arrivals & departures" : view.name === "shop" ? "Shop operations" : view.name === "upload" ? "Import & identify" : view.name === "review" ? "Photo intelligence" : view.name === "collars" ? "Facility collars" : view.name === "users" ? "Access management" : view.name === "profile" ? "My account" : "Report workspace"}</strong>
          </div>
          <div className="topbar-actions"><button className="account-button" onClick={() => navigate({ name: "profile" })}>My profile</button><button className="icon-button" aria-label="Refresh" onClick={() => void loadFoundation()}>↻</button></div>
        </header>

        {error && <div className="banner error-banner"><b>Couldn’t load manager data.</b><span>{error}</span><button onClick={() => void loadFoundation()}>Try again</button></div>}
        {view.name !== "upload" && (uploadActivity.phase === "converting" || uploadActivity.phase === "uploading" || uploadActivity.phase === "analyzing") && <button className="background-upload-banner" onClick={() => navigate({ name: "upload" })}>
          <span className="live-dot" />
          <span><b>Photo batch continues in the background</b><small>{uploadActivity.phase === "converting" ? `Preparing ${uploadActivity.completed} of ${uploadActivity.total} photos` : uploadActivity.phase === "uploading" ? `Uploading ${uploadActivity.completed} of ${uploadActivity.total} photos` : `Upload complete · AI is analyzing ${uploadActivity.total} photos`}</small></span>
          <strong>View progress →</strong>
        </button>}
        {loading && !dashboard && <Loading label="Opening the care desk" />}
        {dashboard && view.name === "dashboard" && <Dashboard data={dashboard} onReview={() => navigate({ name: "review" })} onCheckIn={() => navigate({ name: "checkin" })} onSession={(sessionId) => navigate({ name: "session", sessionId })} onCheckOut={checkOut} checkingOutSessionId={checkingOutSessionId} />}
        {dashboard && view.name === "stays" && <ActiveStaysPage sessions={dashboard.sessions} targetPhotoCount={dashboard.organization.best_photo_count} onCheckIn={() => navigate({ name: "checkin" })} onSession={(sessionId) => navigate({ name: "session", sessionId })} onCheckOut={checkOut} checkingOutSessionId={checkingOutSessionId} />}
        {view.name === "customers" && <CustomerDirectory notify={setToast} onAddPet={() => navigate({ name: "checkin" })} />}
        {view.name === "checkin" && <CheckInDesk sessions={sessions} onChanged={loadFoundation} onSession={(sessionId) => navigate({ name: "session", sessionId })} notify={setToast} />}
        {view.name === "shop" && <ShopPosPage notify={setToast} onSession={(sessionId) => navigate({ name: "session", sessionId })} />}
        <div hidden={view.name !== "upload"}><UploadDesk sessions={sessions} onChanged={() => { void loadFoundation(); }} notify={setToast} onActivity={setUploadActivity} /></div>
        {view.name === "review" && <ReviewQueue sessions={sessions.filter((session) => session.status === "active")} onChanged={() => { void loadFoundation(); }} notify={setToast} />}
        {view.name === "collars" && <CollarManagementPage notify={setToast} />}
        {view.name === "users" && canManageUsers && <UserManagement notify={setToast} />}
        {view.name === "profile" && <ProfilePage notify={setToast} onSignedOut={() => setAuthenticated(false)} />}
        {view.name === "session" && <SessionWorkspace sessionId={view.sessionId} notify={setToast} onChanged={() => void loadFoundation()} onCheckOut={checkOut} checkingOut={checkingOutSessionId === view.sessionId} />}
      </main>
      {toast && <div className="toast">✓ {toast}</div>}
      {confirmationDialog}
    </div>
  );
}

function CustomerDirectory({ notify, onAddPet }: { notify: (value: string) => void; onAddPet: () => void }) {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editingPet, setEditingPet] = useState<CustomerPetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.customers(query, page, pageSize);
      setCustomers(response.customers);
      setTotal(response.total);
      if (selectedId && !response.customers.some((customer) => customer.id === selectedId) && !query) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [page, query, selectedId]);

  const loadDetail = useCallback(async (customerId: string) => {
    setSelectedId(customerId);
    setDetailLoading(true);
    setError(null);
    try {
      setDetail(await api.customer(customerId));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => { void loadDirectory(); }, [loadDirectory]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setQuery(search.trim());
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const updated = (next: CustomerDetail, message: string) => {
    setDetail(next);
    setEditingCustomer(false);
    setEditingPet(null);
    notify(message);
    void loadDirectory();
  };

  return <div className="page-stack customer-page">
    <section className="page-intro"><div><span className="eyebrow">Customers & pets</span><h1>Customer directory</h1><p>Find owner contacts, household details, pet profiles, imported history, and records that still need review.</p></div><button className="primary-button" onClick={onAddPet}>+ Add pet</button></section>
    {error && <div className="banner error-banner"><b>Couldn’t load customer information.</b><span>{error}</span><button onClick={() => void loadDirectory()}>Try again</button></div>}
    <div className="customer-directory-layout">
      <section className="section-card customer-directory-list">
        <div className="section-heading"><div><span className="eyebrow">Directory</span><h2>{total.toLocaleString()} customer{total === 1 ? "" : "s"}</h2></div></div>
        <label className="customer-search"><span>Search owner, contact, or pet</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, phone, pet, or breed…" /></label>
        {loading ? <Loading label="Loading customers" /> : customers.length === 0 ? <Empty title="No customers found" detail={query ? "Try a different name, contact, or pet." : "Customers will appear here after registration or import."} /> : <div className="customer-card-list">{customers.map((customer) => <button key={customer.id} className={selectedId === customer.id ? "selected" : ""} onClick={() => void loadDetail(customer.id)}>
          <span className="pet-avatar small">{customer.full_name.slice(0, 1)}</span>
          <span><b>{customer.full_name}</b><small>{[customer.phone, customer.email].filter(Boolean).join(" · ") || "No contact method"}</small><em>{customer.pets.length ? customer.pets.map((pet) => pet.name).join(", ") : "No linked pets"}</em></span>
          <span className="customer-card-meta">{customer.open_issue_count > 0 && <i>{customer.open_issue_count} review</i>}<small>{customer.household_status || "unlinked"}</small><strong>›</strong></span>
        </button>)}</div>}
        <footer className="directory-pagination"><button disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>← Previous</button><span>Page {page} of {pageCount}</span><button disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>Next →</button></footer>
      </section>

      <section className="section-card customer-detail-panel">
        {!selectedId ? <Empty title="Choose a customer" detail="Select a customer to see their household and complete pet records." /> : detailLoading ? <Loading label="Opening customer profile" /> : detail ? <>
          <header className="customer-detail-header"><span className="pet-avatar xlarge">{detail.full_name.slice(0, 1)}</span><div><span className="eyebrow">Customer profile</span><h2>{detail.full_name}</h2><p>{[detail.phone, detail.email].filter(Boolean).join(" · ") || "No contact information on file"}</p></div><div className="customer-detail-actions"><span className={`status-pill ${detail.household_status === "active" ? "ready" : ""}`}>{detail.household_status || "Unlinked"}</span><button className="outline-button compact" onClick={() => setEditingCustomer(true)}>Edit customer</button></div></header>

          <div className="customer-info-grid">
            <article><span>Primary address</span><b>{formatCustomerAddress(detail.addresses.find((address) => address.is_primary) ?? detail.addresses[0]) || "No address on file"}</b></article>
            <article><span>Household labels</span><b>{detail.household_flags.length ? detail.household_flags.map((flag) => title(flag.flag_type)).join(", ") : "None"}</b></article>
            <article><span>Communication</span><b>{detail.communication_preferences.length ? detail.communication_preferences.map((preference) => `${title(preference.preference_status)} · ${title(preference.channel)}`).join(", ") : "Not recorded"}</b></article>
            <article><span>Internal customer note</span><b>{detail.notes || "No customer note"}</b></article>
          </div>

          <section className="customer-pets-section"><div className="section-heading"><div><span className="eyebrow">Linked pets</span><h2>{detail.pets.length} pet{detail.pets.length === 1 ? "" : "s"}</h2></div><button className="outline-button compact" onClick={onAddPet}>+ Add pet</button></div>
            {detail.pets.length === 0 ? <Empty title="No linked pets" detail="Use Check-in → New pet to add one under this customer." /> : <div className="customer-pet-list">{detail.pets.map((pet) => <details key={pet.id} open={detail.pets.length === 1}><summary><PetAvatar name={pet.name} src={pet.photo_thumbnail_url} size="small" /><span><b>{pet.name}</b><small>{[pet.breed, title(pet.species), title(pet.status)].filter(Boolean).join(" · ")}</small></span><span>{pet.flags.length > 0 && <i>{pet.flags.length} flag{pet.flags.length === 1 ? "" : "s"}</i>}⌄</span></summary><div className="customer-pet-detail">
              <div className="pet-profile-heading"><div><b>Profile</b><small>{pet.stay_count} recorded stay{pet.stay_count === 1 ? "" : "s"}{pet.last_stay_at ? ` · Last ${formatDate(pet.last_stay_at)}` : ""}</small></div><button className="outline-button compact" onClick={() => setEditingPet(pet)}>Edit pet</button></div>
              <dl className="pet-profile-grid"><div><dt>Birthday</dt><dd>{pet.date_of_birth ? `${pet.date_of_birth.slice(0, 10)}${pet.date_of_birth_is_approximate ? " (approx.)" : ""}` : "Unknown"}</dd></div><div><dt>Sex</dt><dd>{pet.sex ? title(pet.sex) : "Unknown"}</dd></div><div><dt>Size</dt><dd>{pet.size_class ? title(pet.size_class) : "Unknown"}</dd></div><div><dt>Weight</dt><dd>{pet.weight_kg ? `${pet.weight_kg} kg` : "Not recorded"}</dd></div><div><dt>Color</dt><dd>{pet.color_markings || "Not recorded"}</dd></div><div><dt>Temperament</dt><dd>{pet.temperament || "Not recorded"}</dd></div></dl>
              <CustomerPetRecords pet={pet} />
            </div></details>)}</div>}
          </section>

          <section className="customer-import-review"><div className="section-heading"><div><span className="eyebrow">Import review</span><h2>{detail.import_issues.length} open item{detail.import_issues.length === 1 ? "" : "s"}</h2></div></div>{detail.import_issues.length === 0 ? <p className="clean-import">✓ No unresolved import warnings for this customer.</p> : <div className="import-issue-list">{detail.import_issues.map((issue) => <article key={issue.id}><span className="status-pill attention">{title(issue.entity_type)}</span><div><b>{friendlyIssueCode(issue.issue_code)}</b><small>{issue.field_name}{issue.source_row_number ? ` · Source row ${issue.source_row_number}` : ""}</small>{issue.raw_value && <code>{issue.raw_value}</code>}</div></article>)}</div>}</section>
        </> : <Empty title="Customer unavailable" detail="Refresh the directory and try again." />}
      </section>
    </div>
    {editingCustomer && detail && <CustomerEditDialog customer={detail} onCancel={() => setEditingCustomer(false)} onSaved={(next) => updated(next, "Customer information updated.")} />}
    {editingPet && detail && <PetEditDialog customerId={detail.id} pet={editingPet} onCancel={() => setEditingPet(null)} onSaved={(next) => updated(next, `${editingPet.name}’s profile updated.`)} />}
  </div>;
}

function CustomerPetRecords({ pet }: { pet: CustomerPetDetail }) {
  return <div className="pet-record-sections">
    <article><h4>Notes</h4>{pet.notes.length ? pet.notes.map((note, index) => <p key={`${note.note_type}-${index}`}><b>{note.note_type === "customer_provided" ? "From customer" : "Internal"}</b>{note.body}</p>) : <small>None recorded</small>}</article>
    <article><h4>Safety & care flags</h4>{pet.flags.length ? <div className="record-chips">{pet.flags.map((flag) => <span key={flag.flag_type}>{title(flag.flag_type)}{flag.note ? ` · ${flag.note}` : ""}</span>)}</div> : <small>None recorded</small>}</article>
    <article><h4>Identifiers</h4>{pet.identifiers.length ? pet.identifiers.map((identifier, index) => <p key={`${identifier.identifier_type}-${index}`}><b>{title(identifier.identifier_type)}</b>{identifier.identifier_value}</p>) : <small>None recorded</small>}</article>
    <article><h4>Care providers</h4>{pet.care_providers.length ? pet.care_providers.map((provider) => <p key={provider.id}><b>{provider.name}</b>{[title(provider.provider_type), provider.phone, provider.email].filter(Boolean).join(" · ")}</p>) : <small>None recorded</small>}</article>
    <article className="service-history"><h4>Previous services</h4>{pet.service_milestones.length ? <div className="record-chips">{pet.service_milestones.map((milestone, index) => <span key={`${milestone.service_type}-${milestone.occurred_on}-${index}`}>{title(milestone.service_type)} · {milestone.occurred_on.slice(0, 10)}</span>)}</div> : <small>None recorded</small>}</article>
  </div>;
}

function CustomerEditDialog({ customer, onCancel, onSaved }: { customer: CustomerDetail; onCancel: () => void; onSaved: (customer: CustomerDetail) => void }) {
  const primary = customer.addresses.find((address) => address.is_primary) ?? customer.addresses[0];
  const [fullName, setFullName] = useState(customer.full_name);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(customer.household_status ?? "active");
  const [line1, setLine1] = useState(primary?.line1 ?? "");
  const [line2, setLine2] = useState(primary?.line2 ?? "");
  const [city, setCity] = useState(primary?.city ?? "");
  const [region, setRegion] = useState(primary?.region ?? "");
  const [postalCode, setPostalCode] = useState(primary?.postal_code ?? "");
  const [countryCode, setCountryCode] = useState(primary?.country_code ?? "US");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      onSaved(await api.updateCustomer(customer.id, {
        fullName: fullName.trim(), phone: blankToNull(phone), email: blankToNull(email), notes: blankToNull(notes), householdStatus: status,
        address: line1.trim() ? { line1: line1.trim(), line2: blankToNull(line2), city: blankToNull(city), region: blankToNull(region), postalCode: blankToNull(postalCode), countryCode: blankToNull(countryCode) } : null,
      }));
    } catch (caught) { setError(messageOf(caught)); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="password-dialog customer-edit-dialog" onSubmit={save}><header><div><span className="eyebrow">Customer record</span><h2>Edit {customer.full_name}</h2></div><button className="icon-button" type="button" onClick={onCancel}>×</button></header><div className="customer-edit-grid"><label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} required /></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as "active" | "inactive")}><option value="active">Active</option><option value="inactive">Inactive</option></select></label><label>Phone<input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="wide">Internal note<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="wide edit-section-label">Primary address</div><label className="wide">Address line 1<input value={line1} onChange={(event) => setLine1(event.target.value)} placeholder="Leave blank to remove the address" /></label><label className="wide">Address line 2<input value={line2} onChange={(event) => setLine2(event.target.value)} /></label><label>City<input value={city} onChange={(event) => setCity(event.target.value)} /></label><label>State / region<input value={region} onChange={(event) => setRegion(event.target.value)} /></label><label>Postal code<input value={postalCode} onChange={(event) => setPostalCode(event.target.value)} /></label><label>Country code<input value={countryCode} maxLength={2} onChange={(event) => setCountryCode(event.target.value)} /></label></div>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="outline-button" onClick={onCancel} disabled={saving}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save customer"}</button></footer></form></div>;
}

function PetEditDialog({ customerId, pet, onCancel, onSaved }: { customerId: string; pet: CustomerPetDetail; onCancel: () => void; onSaved: (customer: CustomerDetail) => void }) {
  const [name, setName] = useState(pet.name);
  const [species, setSpecies] = useState(pet.species);
  const [breed, setBreed] = useState(pet.breed ?? "");
  const [status, setStatus] = useState(pet.status);
  const [dateOfBirth, setDateOfBirth] = useState(pet.date_of_birth?.slice(0, 10) ?? "");
  const [sex, setSex] = useState(pet.sex ?? "");
  const [reproductiveStatus, setReproductiveStatus] = useState(pet.reproductive_status ?? "");
  const [mixedBreed, setMixedBreed] = useState(pet.is_mixed_breed === null ? "" : String(pet.is_mixed_breed));
  const [sizeClass, setSizeClass] = useState(pet.size_class ?? "");
  const [weightKg, setWeightKg] = useState(pet.weight_kg ?? "");
  const [color, setColor] = useState(pet.color_markings ?? "");
  const [temperament, setTemperament] = useState(pet.temperament ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      onSaved(await api.updateCustomerPet(customerId, pet.id, {
        name: name.trim(), species, breed: blankToNull(breed), status, dateOfBirth: blankToNull(dateOfBirth),
        sex: sex ? sex as CustomerPetDetail["sex"] : null,
        reproductiveStatus: reproductiveStatus ? reproductiveStatus as CustomerPetDetail["reproductive_status"] : null,
        isMixedBreed: mixedBreed === "" ? null : mixedBreed === "true",
        sizeClass: sizeClass ? sizeClass as CustomerPetDetail["size_class"] : null,
        weightKg: weightKg ? Number(weightKg) : null, colorMarkings: blankToNull(color), temperament: blankToNull(temperament),
      }));
    } catch (caught) { setError(messageOf(caught)); } finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="password-dialog customer-edit-dialog" onSubmit={save}><header><div><span className="eyebrow">Pet profile</span><h2>Edit {pet.name}</h2></div><button className="icon-button" type="button" onClick={onCancel}>×</button></header><div className="customer-edit-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Species<select value={species} onChange={(event) => setSpecies(event.target.value as CustomerPetDetail["species"])}><option value="dog">Dog</option><option value="cat">Cat</option><option value="other">Other</option></select></label><label>Breed<input value={breed} onChange={(event) => setBreed(event.target.value)} /></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as CustomerPetDetail["status"])}><option value="active">Active</option><option value="inactive">Inactive</option><option value="deceased">Deceased</option><option value="transferred">Transferred</option></select></label><label>Date of birth<input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} /></label><label>Sex<select value={sex} onChange={(event) => setSex(event.target.value)}><option value="">Unknown</option><option value="female">Female</option><option value="male">Male</option></select></label><label>Spay / neuter status<select value={reproductiveStatus} onChange={(event) => setReproductiveStatus(event.target.value)}><option value="">Unknown</option><option value="spayed">Spayed</option><option value="neutered">Neutered</option><option value="intact">Intact</option></select></label><label>Mixed breed<select value={mixedBreed} onChange={(event) => setMixedBreed(event.target.value)}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></label><label>Size<select value={sizeClass} onChange={(event) => setSizeClass(event.target.value)}><option value="">Unknown</option>{["toy", "small", "medium", "large", "giant"].map((value) => <option key={value} value={value}>{title(value)}</option>)}</select></label><label>Weight (kg)<input type="number" min="0" step="0.01" value={weightKg} onChange={(event) => setWeightKg(event.target.value)} /></label><label>Color / markings<input value={color} onChange={(event) => setColor(event.target.value)} /></label><label className="wide">Temperament<textarea value={temperament} onChange={(event) => setTemperament(event.target.value)} /></label></div>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="outline-button" onClick={onCancel} disabled={saving}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save pet"}</button></footer></form></div>;
}

function UserManagement({ notify }: { notify: (value: string) => void }) {
  const [users, setUsers] = useState<OrganizationUser[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [facilities, setFacilities] = useState<FacilityOption[]>([]);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [facilityIds, setFacilityIds] = useState<string[]>([]);
  const [newFacilityName, setNewFacilityName] = useState("");
  const [resetTarget, setResetTarget] = useState<OrganizationUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [editTarget, setEditTarget] = useState<OrganizationUser | null>(null);
  const [editFullName, setEditFullName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editRoleId, setEditRoleId] = useState("");
  const [editStatus, setEditStatus] = useState<"active" | "disabled">("active");
  const [editFacilityIds, setEditFacilityIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const [userData, roleData, facilityData] = await Promise.all([api.users(), api.roles(), api.facilities()]);
      setUsers(userData); setRoles(roleData); setFacilities(facilityData);
      setRoleId((current) => current || roleData.find((role) => role.slug === "staff")?.id || roleData[0]?.id || "");
      setFacilityIds((current) => current.length ? current : facilityData.filter((facility) => facility.is_default).map((facility) => facility.id));
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await api.createUser({ email: email.trim(), password, fullName: fullName.trim(), roleId, facilityIds });
      setFullName(""); setEmail(""); setPassword("");
      notify("User created and role assigned."); await load();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  const assignRole = async (user: OrganizationUser, nextRoleId: string) => {
    setSaving(true); setError(null);
    try { await api.assignUserRole(user.id, nextRoleId); notify(`Role updated for ${user.full_name}.`); await load(); }
    catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (user: OrganizationUser) => {
    const status = user.status === "active" ? "disabled" : "active";
    setSaving(true); setError(null);
    try { await api.updateUser(user.id, { status }); notify(`${user.full_name} is now ${status}.`); await load(); }
    catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  const openEditUser = (user: OrganizationUser) => {
    setEditTarget(user);
    setEditFullName(user.full_name);
    setEditEmail(user.email);
    setEditRoleId(user.role_id);
    setEditStatus(user.status === "disabled" ? "disabled" : "active");
    setEditFacilityIds(user.facilities.map((facility) => facility.id));
    setError(null);
  };

  const saveUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!editTarget) return;
    setSaving(true); setError(null);
    try {
      await api.updateUser(editTarget.id, { fullName: editFullName.trim(), email: editEmail.trim(), status: editStatus });
      if (editRoleId !== editTarget.role_id) await api.assignUserRole(editTarget.id, editRoleId);
      await api.assignUserFacilities(editTarget.id, editFacilityIds);
      notify(`Account information updated for ${editFullName.trim()}.`);
      setEditTarget(null);
      await load();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  const addFacility = async (event: FormEvent) => {
    event.preventDefault();
    if (!newFacilityName.trim()) return;
    setSaving(true); setError(null);
    try {
      const facility = await api.createFacility(newFacilityName.trim());
      setNewFacilityName("");
      notify(`${facility.name} was added.`);
      await load();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  const toggleFacility = (current: string[], facilityId: string) => current.includes(facilityId)
    ? current.filter((id) => id !== facilityId)
    : [...current, facilityId];

  const resetUserPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetTarget || resetPassword !== resetConfirm) {
      setError("The new passwords do not match.");
      return;
    }
    setSaving(true); setError(null);
    try {
      await api.resetUserPassword(resetTarget.id, resetPassword);
      notify(`Password reset for ${resetTarget.full_name}.`);
      setResetTarget(null); setResetPassword(""); setResetConfirm("");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  return <div className="page-stack">
    <section className="page-intro"><div><span className="eyebrow">Owner administrator</span><h1>User management</h1><p>Add team members by role, update account information, reset passwords, and disable access without deleting history.</p></div></section>
    {error && <div className="banner error-banner"><b>User management could not finish.</b><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    <div className="user-management-grid">
      <section className="section-card user-create-card">
        <div className="section-heading"><div><span className="eyebrow">New account</span><h2>Add a team member</h2></div></div>
        <form onSubmit={create}>
          <label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} required /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Temporary password<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <label>Role<select value={roleId} onChange={(event) => setRoleId(event.target.value)} required>{roles.map((role) => <option key={role.id} value={role.id}>{role.display_name}</option>)}</select></label>
          <fieldset className="facility-picker"><legend>Assigned locations</legend>{facilities.map((facility) => <label key={facility.id}><input type="checkbox" checked={facilityIds.includes(facility.id)} onChange={() => setFacilityIds((current) => toggleFacility(current, facility.id))} /> <span>{facility.name}</span></label>)}</fieldset>
          <button className="primary-button" disabled={saving || !roleId || facilityIds.length === 0}>{saving ? "Saving…" : "Create user"}</button>
        </form>
      </section>
      <section className="section-card user-list-card">
        <div className="section-heading"><div><span className="eyebrow">Team access</span><h2>{users.length} user{users.length === 1 ? "" : "s"}</h2></div><button className="outline-button compact" onClick={() => void load()} disabled={busy}>↻ Refresh</button></div>
        {busy ? <Loading label="Loading team access" /> : <div className="user-list">{users.map((user) => <article key={user.id} className={user.status === "disabled" ? "disabled" : ""}>
          <span className="pet-avatar small">{user.full_name.slice(0, 1).toUpperCase()}</span>
          <div><b>{user.full_name}{user.id === api.currentUserId ? " · You" : ""}</b><small>{user.email}</small><small>{user.last_login_at ? `Last login ${formatDate(user.last_login_at)}` : "Has not signed in yet"}</small><small>{user.facilities.map((facility) => facility.name).join(" · ") || "No locations assigned"}</small></div>
          <label><span>Role</span><select value={user.role_id} disabled={saving} onChange={(event) => void assignRole(user, event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.display_name}</option>)}</select></label>
          <div className="user-actions"><button className="outline-button compact" disabled={saving} onClick={() => openEditUser(user)}>Edit user</button><button className="outline-button compact" disabled={saving} onClick={() => { setResetTarget(user); setResetPassword(""); setResetConfirm(""); }}>Reset password</button><button className={user.status === "active" ? "status-control active" : "status-control"} disabled={saving} onClick={() => void toggleStatus(user)}>{user.status === "active" ? "Active" : "Disabled"}</button></div>
        </article>)}</div>}
      </section>
    </div>
    <section className="section-card location-management-card">
      <div className="section-heading"><div><span className="eyebrow">Operating locations</span><h2>Locations</h2><p className="section-helper">Create each physical location, then assign one or more to every staff account.</p></div></div>
      <form className="location-create-form" onSubmit={addFacility}><label>Location name<input value={newFacilityName} onChange={(event) => setNewFacilityName(event.target.value)} placeholder="Example: Downtown" required /></label><button className="primary-button" disabled={saving || !newFacilityName.trim()}>{saving ? "Adding…" : "Add location"}</button></form>
      <div className="location-chip-list">{facilities.map((facility) => <span key={facility.id}>{facility.name}{facility.is_default ? " · Primary" : ""}</span>)}</div>
    </section>
    <section className="role-explainer">{roles.map((role) => <article key={role.id}><b>{role.display_name}</b><span>{role.description}</span></article>)}</section>
    {editTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setEditTarget(null); }}><form className="password-dialog user-edit-dialog" onSubmit={saveUser}>
      <header><div><span className="eyebrow">Account details</span><h2>Edit user</h2><p>Update identity and access information for {editTarget.full_name}.</p></div><button type="button" className="close-button" disabled={saving} onClick={() => setEditTarget(null)}>×</button></header>
      <label>Full name<input value={editFullName} onChange={(event) => setEditFullName(event.target.value)} required autoFocus /></label>
      <label>Email<input type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} required /></label>
      <div className="edit-user-grid"><label>Role<select value={editRoleId} onChange={(event) => setEditRoleId(event.target.value)} required>{roles.map((role) => <option key={role.id} value={role.id}>{role.display_name}</option>)}</select></label><label>Account status<select value={editStatus} onChange={(event) => setEditStatus(event.target.value as "active" | "disabled")}><option value="active">Active</option><option value="disabled">Disabled</option></select></label></div>
      <fieldset className="facility-picker"><legend>Assigned locations</legend>{facilities.map((facility) => <label key={facility.id}><input type="checkbox" checked={editFacilityIds.includes(facility.id)} onChange={() => setEditFacilityIds((current) => toggleFacility(current, facility.id))} /> <span>{facility.name}</span></label>)}</fieldset>
      {error && <div className="form-error">{error}</div>}
      <footer><button type="button" className="outline-button" disabled={saving} onClick={() => setEditTarget(null)}>Cancel</button><button className="primary-button" disabled={saving || !editFullName.trim() || !editEmail.trim() || !editRoleId || editFacilityIds.length === 0}>{saving ? "Saving…" : "Save changes"}</button></footer>
    </form></div>}
    {resetTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setResetTarget(null); }}><form className="password-dialog" onSubmit={resetUserPassword}>
      <header><div><span className="eyebrow">Owner administrator</span><h2>Reset password</h2><p>Set a new temporary password for {resetTarget.full_name}. Their refresh sessions will be signed out.</p></div><button type="button" className="close-button" onClick={() => setResetTarget(null)}>×</button></header>
      <label>New password<input type="password" minLength={8} autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} required autoFocus /></label>
      <label>Confirm new password<input type="password" minLength={8} autoComplete="new-password" value={resetConfirm} onChange={(event) => setResetConfirm(event.target.value)} required /></label>
      {resetConfirm && resetPassword !== resetConfirm && <div className="form-error">The passwords do not match.</div>}
      <footer><button type="button" className="outline-button" onClick={() => setResetTarget(null)}>Cancel</button><button className="primary-button" disabled={saving || resetPassword.length < 8 || resetPassword !== resetConfirm}>{saving ? "Resetting…" : "Reset password"}</button></footer>
    </form></div>}
  </div>;
}

function CollarManagementPage({ notify }: { notify: (value: string) => void }) {
  const [collars, setCollars] = useState<CollarPaletteItem[]>([]);
  const [collarQrImages, setCollarQrImages] = useState<Record<string, string>>({});
  const [collarName, setCollarName] = useState("");
  const [collarHex, setCollarHex] = useState("#177462");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setCollars(await api.collarPalette()); }
    catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(collars.map(async (collar) => [
      collar.id,
      await QRCode.toDataURL(collar.qr_payload, { width: 480, margin: 2, errorCorrectionLevel: "H" }),
    ] as const)).then((entries) => {
      if (!cancelled) setCollarQrImages(Object.fromEntries(entries));
    }).catch((caught) => {
      if (!cancelled) setError(messageOf(caught));
    });
    return () => { cancelled = true; };
  }, [collars]);

  const createCollar = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createCollarColor({ colorName: collarName.trim(), colorHex: collarHex });
      setCollarName("");
      await load();
      notify("Collar added. Its QR label is ready to download.");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  return <div className="page-stack collar-management-page">
    <section className="page-intro"><div><span className="eyebrow">Facility equipment</span><h1>Collar management</h1><p>Each physical collar has its own permanent QR code. Attach the matching label so staff can scan it during check-in and identify similar-looking pets by collar color.</p></div><button className="outline-button" onClick={() => void load()} disabled={busy}>↻ Refresh</button></section>
    {error && <div className="banner error-banner"><b>Collars could not be updated.</b><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    <section className="section-card collar-registry">
      <div className="section-heading"><div><span className="eyebrow">Color registry</span><h2>{collars.length} collar{collars.length === 1 ? "" : "s"}</h2><p className="section-helper">Red, blue, green, yellow, and orange are included automatically. Add another physical collar here when needed.</p></div></div>
      <form className="collar-create-form" onSubmit={createCollar}>
        <label>Color name<input value={collarName} onChange={(event) => setCollarName(event.target.value)} placeholder="Example: Purple" required /></label>
        <label>Exact color<input type="color" value={collarHex} onChange={(event) => setCollarHex(event.target.value)} aria-label="Collar color" /></label>
        <button className="primary-button" disabled={saving || !collarName.trim()}>{saving ? "Adding…" : "Add collar"}</button>
      </form>
      {busy
        ? <Loading label="Loading facility collars" />
        : collars.length === 0
          ? <div className="empty"><b>No collars registered yet</b><span>Refresh after the database migration or add a collar above.</span></div>
          : <div className="collar-label-grid">{collars.map((collar) => <article key={collar.id}>
            <div className="collar-label-preview">
              {collarQrImages[collar.id] && <img src={collarQrImages[collar.id]} alt={`QR code for ${collar.color_name} collar`} />}
              <span style={{ background: collar.color_hex ?? "#D1D8D5" }} />
            </div>
            <div><b>{collar.color_name}</b><small>{collar.in_use ? "Currently assigned" : "Available"}</small><small>{collar.color_hex}</small></div>
            {collarQrImages[collar.id] && <a className="outline-button compact" href={collarQrImages[collar.id]} download={`ucbarkley-collar-${collar.color_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`}>Download QR label</a>}
          </article>)}</div>}
    </section>
  </div>;
}

function ProfilePage({ notify, onSignedOut }: { notify: (value: string) => void; onSignedOut: () => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true);
    api.profile()
      .then(setProfile)
      .catch((caught) => setError(messageOf(caught)))
      .finally(() => setBusy(false));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    setSaving(true); setError(null);
    try {
      await api.changeMyPassword(currentPassword, newPassword);
      notify("Password changed. Please sign in again.");
      api.logout();
      window.setTimeout(onSignedOut, 700);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setSaving(false); }
  };

  if (busy) return <Loading label="Loading your profile" />;
  return <div className="page-stack profile-page">
    <section className="page-intro"><div><span className="eyebrow">Account & security</span><h1>My profile</h1><p>Review your account and change the password you use to sign in.</p></div></section>
    {error && <div className="banner error-banner"><b>Profile action could not finish.</b><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    {profile && <div className="profile-grid">
      <section className="section-card profile-summary"><span className="pet-avatar">{profile.full_name.slice(0, 1).toUpperCase()}</span><div><span className="eyebrow">Signed in as</span><h2>{profile.full_name}</h2><p>{profile.email}</p><dl><div><dt>Organization</dt><dd>{profile.organization_name}</dd></div><div><dt>Role</dt><dd>{profile.role_slug === "super_admin" ? "Owner administrator" : profile.role_name}</dd></div><div><dt>Status</dt><dd>{title(profile.status)}</dd></div></dl></div></section>
      <section className="section-card password-card"><div className="section-heading"><div><span className="eyebrow">Security</span><h2>Change password</h2></div></div><form onSubmit={submit}>
        <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
        <label>New password<input type="password" minLength={8} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
        <label>Confirm new password<input type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        {confirmPassword && newPassword !== confirmPassword && <div className="form-error">The passwords do not match.</div>}
        <button className="primary-button" disabled={saving || newPassword.length < 8 || newPassword !== confirmPassword}>{saving ? "Changing…" : "Change password"}</button>
      </form></section>
    </div>}
  </div>;
}

function UploadDesk({ sessions, onChanged, notify, onActivity }: { sessions: SessionOption[]; onChanged: () => void; notify: (value: string) => void; onActivity: (activity: UploadActivity) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [conversionProgress, setConversionProgress] = useState({ completed: 0, total: 0 });
  const [convertedCount, setConvertedCount] = useState(0);
  const [completedUploads, setCompletedUploads] = useState(0);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<ReviewPhoto[]>([]);
  const [selected, setSelected] = useState<ReviewPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSessions = sessions.filter((session) => session.status === "active");
  const [videoFiles, setVideoFiles] = useState<Array<{ file: File; duration: number }>>([]);
  const [videoSessionId, setVideoSessionId] = useState("");
  const [videoUploading, setVideoUploading] = useState(false);
  const [completedVideoUploads, setCompletedVideoUploads] = useState(0);
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  const videoPreviews = useMemo(() => videoFiles.map(({ file }) => URL.createObjectURL(file)), [videoFiles]);

  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  useEffect(() => () => videoPreviews.forEach((url) => URL.revokeObjectURL(url)), [videoPreviews]);
  useEffect(() => {
    const completed = phase === "converting" ? conversionProgress.completed : phase === "uploading" ? completedUploads : phase === "analyzing" || phase === "complete" ? files.length : 0;
    onActivity({ phase, completed, total: phase === "converting" ? conversionProgress.total : files.length });
  }, [completedUploads, conversionProgress.completed, conversionProgress.total, files.length, onActivity, phase]);
  useEffect(() => {
    if (!activeSessions.some((session) => session.id === videoSessionId)) setVideoSessionId(activeSessions[0]?.id ?? "");
  }, [activeSessions, videoSessionId]);

  const isVideoFile = (file: File) => {
    const lowerName = file.name.toLowerCase();
    return file.type === "video/mp4" || file.type === "video/quicktime" || lowerName.endsWith(".mp4") || lowerName.endsWith(".mov");
  };

  const prepareVideos = async (chosen: File[]) => Promise.all(chosen.map(async (file) => {
    if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 100 MB.`);
    const duration = await readVideoDuration(file);
    if (duration > MAX_SOURCE_VIDEO_DURATION_SECONDS) throw new Error(`${file.name} is longer than ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds.`);
    return { file, duration };
  }));

  const chooseFiles = async (list: FileList | null) => {
    if (!list || phase !== "idle") return;
    const selectedFiles = Array.from(list);
    const chosen = selectedFiles.slice(0, MAX_ADMIN_MEDIA_BATCH_ITEMS);
    const imageFiles = chosen.filter(isImageFile);
    const selectedVideos = chosen.filter(isVideoFile);
    const unsupportedCount = chosen.length - imageFiles.length - selectedVideos.length;
    setFiles([]);
    setVideoFiles([]);
    setPhotos([]);
    setBatchId(null);
    setConvertedCount(0);
    setCompletedVideoUploads(0);
    setConversionProgress({ completed: 0, total: imageFiles.length });
    setError(null);
    if (!imageFiles.length && !selectedVideos.length) {
      setError("Choose photos, MP4 videos, or MOV videos.");
      return;
    }
    if (selectedFiles.length > chosen.length) {
      notify(`Only the first ${MAX_ADMIN_MEDIA_BATCH_ITEMS} photos and videos were added.`);
    }

    setPhase("converting");
    try {
      const [prepared, preparedVideos] = await Promise.all([
        imageFiles.length
          ? prepareImageFiles(imageFiles, (completed, total) => setConversionProgress({ completed, total }))
          : Promise.resolve({ files: [] as File[], convertedCount: 0 }),
        prepareVideos(selectedVideos),
      ]);
      setFiles(prepared.files);
      setVideoFiles(preparedVideos);
      setConvertedCount(prepared.convertedCount);
      if (prepared.convertedCount > 0) notify(`${prepared.convertedCount} HEIC photo${prepared.convertedCount === 1 ? " was" : "s were"} converted to JPG and ${prepared.convertedCount === 1 ? "is" : "are"} ready to upload.`);
      if (preparedVideos.length > 0) notify(`${preparedVideos.length} video${preparedVideos.length === 1 ? " is" : "s are"} ready. Assign ${preparedVideos.length === 1 ? "it" : "them"} to an active pet below.`);
      if (unsupportedCount > 0) setError(`${unsupportedCount} unsupported file${unsupportedCount === 1 ? " was" : "s were"} skipped.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPhase("idle");
    }
  };

  const loadBatchPhotos = useCallback(async (id: string) => {
    const data = await api.photos("all", id);
    setPhotos(data.photos);
    setSelected((current) => current ? data.photos.find((photo) => photo.id === current.id) ?? null : null);
  }, []);

  const analyze = async () => {
    setError(null);
    setCompletedUploads(0);
    setPhotos([]);
    setPhase("uploading");
    try {
      const id = await api.uploadPhotoBatch(files, setCompletedUploads);
      setBatchId(id);
      setPhase("analyzing");
      // Once each object is confirmed, the worker owns AI processing. Keep
      // observing that server-side job even if the manager visits another page.
      while (true) {
        const batch = await api.photoBatch(id);
        const finished = batch.statusCounts
          .filter((status) => status.processing_status === "processed" || status.processing_status === "failed")
          .reduce((sum, status) => sum + Number(status.count), 0);
        if (finished >= files.length) break;
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      await loadBatchPhotos(id);
      setPhase("complete");
      notify("AI analysis finished. Review the suggested pets and match rates.");
      onChanged();
    } catch (caught) {
      setError(messageOf(caught));
      setPhase("idle");
    }
  };

  const refresh = async () => {
    if (!batchId) return;
    try {
      await loadBatchPhotos(batchId);
      notify("AI results refreshed.");
    } catch (caught) { setError(messageOf(caught)); }
  };

  const changed = async (message: string) => {
    notify(message);
    onChanged();
    if (batchId) await loadBatchPhotos(batchId);
  };

  const reset = () => {
    setFiles([]); setPhotos([]); setBatchId(null); setCompletedUploads(0); setConvertedCount(0); setConversionProgress({ completed: 0, total: 0 }); setError(null); setPhase("idle");
  };

  const chooseVideos = async (list: FileList | null) => {
    if (!list) return;
    const chosen = Array.from(list).slice(0, MAX_ADMIN_MEDIA_BATCH_ITEMS);
    if (!chosen.length) return;
    setError(null);
    try {
      if (chosen.some((file) => !isVideoFile(file))) throw new Error("Choose MP4 or MOV videos.");
      const preparedVideos = await prepareVideos(chosen);
      setVideoFiles(preparedVideos);
      setCompletedVideoUploads(0);
    } catch (caught) {
      setVideoFiles([]);
      setError(messageOf(caught));
    }
  };

  const uploadVideos = async () => {
    if (!videoFiles.length || !videoSessionId) return;
    const session = activeSessions.find((item) => item.id === videoSessionId);
    if (!session) return;
    setVideoUploading(true);
    setCompletedVideoUploads(0);
    setError(null);
    let uploadedCount = 0;
    try {
      for (let index = 0; index < videoFiles.length; index += 1) {
        const video = videoFiles[index];
        await api.uploadReportVideo(video.file, session.pet_id, session.id, video.duration);
        uploadedCount = index + 1;
        setCompletedVideoUploads(uploadedCount);
      }
      setVideoFiles([]);
      notify(`${uploadedCount} video${uploadedCount === 1 ? " was" : "s were"} added to ${session.pet_name} as private report clips. Approve ${uploadedCount === 1 ? "it" : "them"} from the pet’s report desk before generating the report.`);
      onChanged();
    } catch (caught) {
      if (uploadedCount > 0) {
        setVideoFiles((current) => current.slice(uploadedCount));
        onChanged();
      }
      setError(`${uploadedCount > 0 ? `${uploadedCount} video${uploadedCount === 1 ? " was" : "s were"} uploaded before the problem. ` : ""}${messageOf(caught)}`);
    } finally {
      setVideoUploading(false);
    }
  };

  return <div className="page-stack">
    <section className="page-intro"><div><span className="eyebrow">Manager media import</span><h1>Upload & identify</h1><p>Add photos for AI identification or assign short videos directly to a checked-in pet for the report highlight.</p></div>{photos.length > 0 && <button className="outline-button" onClick={reset}>Start another photo batch</button>}</section>
    {error && <div className="banner error-banner"><b>Upload could not finish.</b><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    {photos.length === 0 && <section className="section-card upload-card">
      <label className={`upload-dropzone ${files.length || videoFiles.length ? "has-files" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void chooseFiles(event.dataTransfer.files); }}>
        <input type="file" accept="image/*,.heic,.heif,video/mp4,video/quicktime,.mp4,.mov" multiple onChange={(event) => void chooseFiles(event.target.files)} disabled={phase !== "idle"} />
        <span>↑</span><b>{phase === "converting" ? "Preparing selected media…" : files.length || videoFiles.length ? `${files.length} photo${files.length === 1 ? "" : "s"} · ${videoFiles.length} video${videoFiles.length === 1 ? "" : "s"} ready` : "Choose photos or videos, or drop them here"}</b><small>JPEG, PNG, HEIC, MP4, or MOV · maximum {MAX_ADMIN_MEDIA_BATCH_ITEMS} files per selection</small>
      </label>
      {videoFiles.length > 0 && <div className="banner"><b>Videos ready to assign</b><span>Choose the active pet in the Short report video section below, then upload the selected clips.</span></div>}
      {files.length > 0 && <div className="upload-preview-grid">{files.map((file, index) => <article key={`${file.name}-${file.lastModified}`}><img src={previews[index]} alt="Selected upload" /><div><b>{file.name}</b><small>{formatBytes(file.size)}</small></div>{phase === "idle" && <button aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>}</article>)}</div>}
      {files.length > 0 && <div className="upload-actions"><div><b>{phase === "uploading" ? `Uploading ${completedUploads} of ${files.length}` : phase === "analyzing" ? "AI is detecting and matching pets…" : "Ready for AI analysis"}</b><small>{convertedCount > 0 ? `${convertedCount} HEIC photo${convertedCount === 1 ? "" : "s"} converted to JPG. ` : ""}Photos remain private until a manager approves and publishes them.</small></div><button className="primary-button" disabled={phase !== "idle"} onClick={() => void analyze()}>{phase === "idle" ? `Upload & analyze ${files.length}` : "Working…"}</button></div>}
    </section>}
    <section className="section-card report-clip-upload-card">
      <div className="section-heading"><div><span className="eyebrow">Short report video</span><h2>Add clips to the report highlight</h2><p className="section-helper">Upload MP4 or MOV videos, assign them to a checked-in pet, then approve them from that pet’s report desk. Each selected video must be {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter.</p></div><span className="media-count">{MAX_SOURCE_VIDEO_DURATION_SECONDS} sec · 100 MB each</span></div>
      <div className="report-clip-upload-grid">
        <label className="report-clip-picker"><input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple disabled={videoUploading} onChange={(event) => void chooseVideos(event.target.files)} /><span>▶</span><b>{videoFiles.length ? "Choose different videos" : "Choose short videos"}</b><small>MP4 or MOV · clear, steady pet footage works best</small></label>
        {videoFiles.length ? <div className="report-video-preview-list">{videoFiles.map((video, index) => <article key={`${video.file.name}-${video.file.lastModified}-${index}`}><video src={videoPreviews[index]} controls muted playsInline preload="metadata" /><button type="button" aria-label={`Remove ${video.file.name}`} onClick={() => setVideoFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button><div><b>{video.file.name}</b><small>{formatBytes(video.file.size)} · {Math.ceil(video.duration)} sec</small></div></article>)}</div> : <div className="report-clip-placeholder"><span>▶</span><small>Your clip previews will appear here.</small></div>}
        <div className="report-clip-assignment"><label>Assign all selected videos to active pet<select value={videoSessionId} onChange={(event) => setVideoSessionId(event.target.value)} disabled={videoUploading || activeSessions.length === 0}>{activeSessions.length === 0 ? <option value="">No active stays</option> : activeSessions.map((session) => <option key={session.id} value={session.id}>{session.pet_name}</option>)}</select></label>{videoFiles.length > 0 && <p><b>{videoFiles.length} video{videoFiles.length === 1 ? "" : "s"} selected</b><small>{videoUploading ? `Uploaded ${completedVideoUploads} of ${videoFiles.length}` : "All clips will be assigned to the selected pet."}</small></p>}<button type="button" className="primary-button" disabled={!videoFiles.length || !videoSessionId || videoUploading} onClick={() => void uploadVideos()}>{videoUploading ? `Uploading ${completedVideoUploads} of ${videoFiles.length}…` : `Upload & assign ${videoFiles.length ? `${videoFiles.length} ` : ""}clip${videoFiles.length === 1 ? "" : "s"}`}</button></div>
      </div>
    </section>
    {photos.length > 0 && <>
      <section className="section-heading batch-results-heading"><div><span className="eyebrow">Batch results</span><h2>AI suggestions & match rates</h2></div><button className="outline-button compact" onClick={() => void refresh()}>↻ Refresh results</button></section>
      <div className="banner"><b>Human confirmation required</b><span>Open each photo to accept, add, or correct pets—including multiple pets in a group photo.</span></div>
      <div className="photo-grid">{photos.map((photo) => <PhotoCard key={photo.id} photo={photo} onClick={() => setSelected(photo)} />)}</div>
    </>}
    {selected && <PhotoReviewDialog photo={selected} sessions={sessions} onClose={() => setSelected(null)} onChanged={changed} />}
  </div>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("staff@example.com");
  const [password, setPassword] = useState("");
  const [passwordResetToken, setPasswordResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (passwordResetToken) {
        if (newPassword !== confirmPassword) {
          setError("The new passwords do not match.");
          return;
        }
        await api.replaceExpiredPassword(passwordResetToken, newPassword);
      } else {
        const result = await api.login(email.trim(), password);
        if (result.passwordChangeRequired) {
          setPasswordResetToken(result.passwordResetToken);
          setPassword("");
          return;
        }
      }
      onSuccess();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-story">
        <span className="brand-mark large"><img src="/ucbarkley-icon.png" alt="" /></span>
        <div><span className="eyebrow light">UCBarkley Manager</span><h1>Every pet’s day,<br />ready to share.</h1></div>
        <p>Review staff uploads, double-check AI suggestions, and turn today’s moments into owner-ready stories.</p>
        <div className="story-proof"><span>✦</span><div><b>Human-reviewed AI</b><small>Nothing reaches an owner until your team approves it.</small></div></div>
      </section>
      <section className="login-panel">
        <form onSubmit={submit}>
          <span className="eyebrow">Manager access</span>
          <h2>{passwordResetToken ? "Password reset required" : "Welcome back"}</h2>
          <p>{passwordResetToken ? "For your security, you need to reset your password every 60 days. Your current password has expired, and you cannot sign in until you create a new one." : "Use an owner administrator or manager account."}</p>
          {!passwordResetToken && <>
            <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
          </>}
          {passwordResetToken && <>
            <label>New password<input type="password" minLength={8} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoFocus /></label>
            <label>Confirm new password<input type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
            {confirmPassword && newPassword !== confirmPassword && <div className="form-error">The passwords do not match.</div>}
          </>}
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full" disabled={busy || (passwordResetToken ? newPassword.length < 8 || newPassword !== confirmPassword : !email || !password)}>{busy ? "Please wait…" : passwordResetToken ? "Reset password & sign in" : "Open manager portal"}</button>
          <small className="api-note">API: {API_URL}</small>
        </form>
      </section>
    </div>
  );
}

function Dashboard({ data, onReview, onCheckIn, onSession, onCheckOut, checkingOutSessionId }: { data: DashboardData; onReview: () => void; onCheckIn: () => void; onSession: (id: string) => void; onCheckOut: (id: string, petName: string) => Promise<void>; checkingOutSessionId: string | null }) {
  const stats = data.stats;
  const usagePercent = data.mediaUsage.storageLimitBytes > 0
    ? Math.min(100, Math.round((data.mediaUsage.totalBytes / data.mediaUsage.storageLimitBytes) * 100))
    : 0;
  const usageTone = usagePercent >= 100 ? "limit" : usagePercent >= 90 ? "danger" : usagePercent >= 75 ? "warning" : "healthy";
  return (
    <div className="page-stack">
      <section className="hero-card">
        <div><span className="eyebrow light">Live operations</span><h1>Good morning.<br /><em>{stats.photos_to_review} photos</em> need your eye.</h1><p>AI has organized the latest uploads. Confirm identities, choose the strongest moments, and keep each pet’s report moving.</p></div>
        <button onClick={onReview}>Start reviewing <span>→</span></button>
      </section>
      <section className="stat-grid">
        <Stat label="Checked in" value={stats.active_sessions} note="active stays" tone="green" />
        <Stat label="Needs review" value={stats.photos_to_review} note="photos and detections" tone="gold" />
        <Stat label="Published today" value={stats.photos_published_today} note="owner-ready moments" tone="blue" />
        <Stat label="Video drafts" value={stats.videos_ready_to_approve} note="ready to approve" tone="rose" />
      </section>
      <section className={`section-card media-usage ${usageTone}`}>
        <div className="section-heading"><div><span className="eyebrow">Media usage</span><h2>Cloud storage allowance</h2></div><strong>{formatBytes(data.mediaUsage.totalBytes)} of {formatBytes(data.mediaUsage.storageLimitBytes)}</strong></div>
        <div className="usage-track" aria-label={`${usagePercent}% of media allowance used`}><i style={{ width: `${usagePercent}%` }} /></div>
        <div className="usage-breakdown">
          <span><b>{formatBytes(data.mediaUsage.photoBytes)}</b> photos · {data.mediaUsage.photoCount} files</span>
          <span><b>{formatBytes(data.mediaUsage.videoBytes)}</b> videos · {data.mediaUsage.videoCount} files</span>
          <span><b>{usagePercent}%</b> used</span>
        </div>
        <p>{usagePercent >= 100 ? "Uploads are paused until storage is freed or the allowance is increased." : usagePercent >= 90 ? "Storage is almost full. Review old unpublished media before the next large upload." : usagePercent >= 75 ? "Storage is filling up. Plan a cleanup or allowance increase soon." : "New uploads are optimized before transfer. Published and identity media remain available under the retention policy."}</p>
      </section>
      <section className="section-card">
        <div className="section-heading"><div><span className="eyebrow">Coverage</span><h2>Active pets</h2></div><div className="heading-actions"><span className="muted">Goal: {data.organization.best_photo_count} selected photos per stay</span><button className="primary-button compact" onClick={onCheckIn}>+ Check in pet</button></div></div>
        {data.sessions.length === 0 ? <Empty title="No pets are checked in" detail="Active stays will appear here." /> : <div className="pet-table">
          {data.sessions.map((session) => {
            const count = session.published_photo_count + session.candidate_photo_count;
            const target = data.organization.best_photo_count;
            const percent = Math.min(100, Math.round((count / target) * 100));
            return <div className="pet-row-entry" key={session.session_id}><button className="pet-row" onClick={() => onSession(session.session_id)}>
              <PetAvatar name={session.pet_name} src={session.photo_thumbnail_url} />
              <span className="pet-identity"><b>{session.pet_name}</b><small>{session.breed || title(session.species)} · {title(session.session_type)}</small></span>
              <span className="coverage"><span><b>{count}</b> / {target} photos</span><i><u style={{ width: `${percent}%` }} /></i></span>
              <span className={`status-pill ${percent >= 100 ? "ready" : "attention"}`}>{percent >= 100 ? "Ready" : `${target - count} needed`}</span>
              <span className="row-arrow">›</span>
            </button><button className="checkout-button prominent" disabled={checkingOutSessionId !== null} onClick={() => void onCheckOut(session.session_id, session.pet_name)}>{checkingOutSessionId === session.session_id ? "Checking out…" : "Check out"}</button></div>;
          })}
        </div>}
      </section>
    </div>
  );
}

function ActiveStaysPage({ sessions, targetPhotoCount, onCheckIn, onSession, onCheckOut, checkingOutSessionId }: { sessions: SessionSummary[]; targetPhotoCount: number; onCheckIn: () => void; onSession: (id: string) => void; onCheckOut: (id: string, petName: string) => Promise<void>; checkingOutSessionId: string | null }) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLowerCase();
  const visibleSessions = sessions.filter((session) => !normalizedSearch || [session.pet_name, session.breed, session.species, session.session_type].some((value) => value?.toLowerCase().includes(normalizedSearch)));
  return <div className="page-stack">
    <section className="page-intro"><div><span className="eyebrow">Live occupancy</span><h1>Active stays</h1><p>See every pet currently checked in, their stay schedule, care activity, and report readiness.</p></div><button className="primary-button" onClick={onCheckIn}>+ Check in pet</button></section>
    <section className="section-card active-stay-directory"><div className="section-heading"><div><span className="eyebrow">On site now</span><h2>{sessions.length} pet{sessions.length === 1 ? "" : "s"} currently staying</h2></div><label className="stay-search"><span>Search stays</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pet, breed, or stay type" /></label></div>
      {sessions.length === 0 ? <Empty title="No active stays" detail="Checked-in pets will appear here." /> : visibleSessions.length === 0 ? <Empty title="No matching stays" detail="Try a different pet name, breed, or stay type." /> : <div className="stay-directory-grid">{visibleSessions.map((session) => {
        const photoCount = session.published_photo_count + session.candidate_photo_count;
        const ready = photoCount >= targetPhotoCount;
        return <article key={session.session_id} className="stay-directory-card"><header><PetAvatar name={session.pet_name} src={session.photo_thumbnail_url} /><div><h3>{session.pet_name}</h3><p>{session.breed || title(session.species)} · {title(session.session_type)}</p></div><span className="status-pill ready">Checked in</span></header><dl><div><dt>Checked in</dt><dd>{formatDate(session.check_in_at)}</dd></div><div><dt>Expected checkout</dt><dd>{session.expected_check_out_at ? formatDate(session.expected_check_out_at) : "Not scheduled"}</dd></div></dl><div className="stay-progress"><span><b>{photoCount}</b> / {targetPhotoCount} report photos</span><i><u style={{ width: `${Math.min(100, Math.round((photoCount / targetPhotoCount) * 100))}%` }} /></i></div><footer><span>{session.logs_today} care update{session.logs_today === 1 ? "" : "s"} today</span><b className={ready ? "ready" : "attention"}>{ready ? "Report media ready" : `${Math.max(0, targetPhotoCount - photoCount)} photos needed`}</b><div className="stay-directory-actions"><button className="outline-button compact" onClick={() => onSession(session.session_id)}>View stay →</button><button className="checkout-button prominent" disabled={checkingOutSessionId !== null} onClick={() => void onCheckOut(session.session_id, session.pet_name)}>{checkingOutSessionId === session.session_id ? "Checking out…" : "Check out"}</button></div></footer></article>;
      })}</div>}
    </section>
  </div>;
}

function CheckInDesk({ sessions, onChanged, onSession, notify }: { sessions: SessionOption[]; onChanged: () => Promise<void>; onSession: (id: string) => void; notify: (value: string) => void }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const activeSessions = useMemo(() => sessions.filter((session) => session.status === "active"), [sessions]);
  const reservations = useMemo(() => sessions
    .filter((session) => session.status === "reserved")
    .sort((left, right) => new Date(left.scheduled_check_in_at).getTime() - new Date(right.scheduled_check_in_at).getTime()), [sessions]);
  const activePetIds = useMemo(() => new Set(activeSessions.map((session) => session.pet_id)), [activeSessions]);
  const reservedPetIds = useMemo(() => new Set(reservations.map((session) => session.pet_id)), [reservations]);
  const [pets, setPets] = useState<PetOption[]>([]);
  const [search, setSearch] = useState("");
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSpecies, setNewSpecies] = useState<"dog" | "cat" | "other">("dog");
  const [newBreed, setNewBreed] = useState("");
  const [newOwnerName, setNewOwnerName] = useState("");
  const [newOwnerPhone, setNewOwnerPhone] = useState("");
  const [newOwnerEmail, setNewOwnerEmail] = useState("");
  const [existingOwner, setExistingOwner] = useState<{ id: string; name: string; phone: string | null; email: string | null } | null>(null);
  const [sessionType, setSessionType] = useState<"boarding" | "daycare">("boarding");
  const [arrivalMode, setArrivalMode] = useState<"checkin" | "reservation">("checkin");
  const [checkInAt, setCheckInAt] = useState(localDateTimeValue());
  const [expectedCheckOutAt, setExpectedCheckOutAt] = useState("");
  const [notes, setNotes] = useState("");
  const [loadingPets, setLoadingPets] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identityTargets, setIdentityTargets] = useState<Array<{ id: string; pet_id: string; pet_name: string }>>([]);
  const [ownerTarget, setOwnerTarget] = useState<PetOption | null>(null);
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");

  useEffect(() => {
    let current = true;
    const timeout = window.setTimeout(async () => {
      setLoadingPets(true);
      try {
        const result = await api.pets(search);
        if (current) setPets(result);
      } catch (caught) {
        if (current) setError(messageOf(caught));
      } finally {
        if (current) setLoadingPets(false);
      }
    }, 250);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [search]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      let petId = selectedPetIds[0] ?? "";
      let petName = pets.find((pet) => pet.id === petId)?.name ?? newName.trim();
      if (registering) {
        const pet = await api.createPet({
          name: newName.trim(),
          species: newSpecies,
          ...(newBreed.trim() ? { breed: newBreed.trim() } : {}),
          ...(existingOwner
            ? { ownerId: existingOwner.id }
            : { owner: {
                fullName: newOwnerName.trim(),
                ...(newOwnerPhone.trim() ? { phone: newOwnerPhone.trim() } : {}),
                ...(newOwnerEmail.trim() ? { email: newOwnerEmail.trim() } : {}),
              } }),
        });
        petId = pet.id;
        petName = pet.name;
      }
      const selectedPets = registering
        ? [{ id: petId, name: petName }]
        : selectedPetIds.map((id) => ({ id, name: pets.find((pet) => pet.id === id)?.name ?? "Pet" }));
      if (arrivalMode === "reservation") {
        await api.createReservations({
          petIds: selectedPets.map((pet) => pet.id),
          sessionType,
          scheduledCheckInAt: new Date(checkInAt).toISOString(),
          expectedCheckOutAt: new Date(expectedCheckOutAt).toISOString(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        notify(selectedPets.length > 1 ? `Reservation saved for ${selectedPets.length} pets.` : `Reservation saved for ${petName}.`);
      } else {
        const stayInput = {
          sessionType,
          checkInAt: new Date(checkInAt).toISOString(),
          ...(expectedCheckOutAt ? { expectedCheckOutAt: new Date(expectedCheckOutAt).toISOString() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        };
        const checkedInSessions = selectedPets.length > 1
          ? await api.checkInBatch({ ...stayInput, petIds: selectedPets.map((pet) => pet.id) })
          : [await api.checkIn({ ...stayInput, petId })];
        notify(selectedPets.length > 1 ? `${selectedPets.length} pets checked in together.` : `${petName} checked in for ${sessionType}.`);
        setIdentityTargets(checkedInSessions.map((session, index) => ({ id: session.id, pet_id: selectedPets[index].id, pet_name: selectedPets[index].name })));
      }
      setSelectedPetIds([]); setNewName(""); setNewBreed(""); setNewOwnerName(""); setNewOwnerPhone(""); setNewOwnerEmail(""); setExistingOwner(null); setCheckInAt(localDateTimeValue()); setExpectedCheckOutAt(""); setNotes(""); setRegistering(false);
      await onChanged();
      setPets(await api.pets(search));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setWorking(false);
    }
  };

  const checkOut = async (session: SessionOption) => {
    if (!await requestConfirmation({
      eyebrow: "Departure",
      title: `Check ${session.pet_name} out?`,
      message: `${session.pet_name} will leave the active stays and AI review lists.`,
      detail: "Photos, care updates, and report history will be kept.",
      confirmLabel: "Check out",
      cancelLabel: "Keep checked in",
      tone: "danger",
    })) return;
    setWorking(true); setError(null);
    try {
      await api.checkOut(session.id);
      notify(`${session.pet_name} checked out.`);
      await onChanged();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };

  const startReservation = async (session: SessionOption) => {
    setWorking(true); setError(null);
    try {
      const active = await api.startReservation(session.id);
      notify(`${session.pet_name} checked in from the reservation.`);
      setIdentityTargets([{ id: active.id, pet_id: active.pet_id, pet_name: session.pet_name }]);
      await onChanged();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };

  const cancelReservation = async (session: SessionOption) => {
    if (!await requestConfirmation({
      eyebrow: "Reservation",
      title: `Cancel ${session.pet_name}’s reservation?`,
      message: "This expected arrival will be removed from the check-in desk.",
      detail: "The pet and customer records will stay in UCBarkley.",
      confirmLabel: "Cancel reservation",
      cancelLabel: "Keep reservation",
      tone: "danger",
    })) return;
    setWorking(true); setError(null);
    try {
      await api.cancelReservation(session.id);
      notify(`${session.pet_name}’s reservation was cancelled.`);
      await onChanged();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };

  const openOwnerForm = (pet: PetOption) => {
    setOwnerTarget(pet); setOwnerName(""); setOwnerPhone(""); setOwnerEmail(""); setError(null);
  };

  const addPetForOwner = (pet: PetOption) => {
    if (!pet.owner_id || !pet.owner_name) return;
    setExistingOwner({ id: pet.owner_id, name: pet.owner_name, phone: pet.owner_phone, email: pet.owner_email });
    setRegistering(true);
    setSelectedPetIds([]);
    setNewName("");
    setNewSpecies("dog");
    setNewBreed("");
    setError(null);
  };

  const saveOwner = async (event: FormEvent) => {
    event.preventDefault();
    if (!ownerTarget) return;
    setWorking(true); setError(null);
    try {
      await api.assignPetOwner(ownerTarget.id, {
        fullName: ownerName.trim(),
        ...(ownerPhone.trim() ? { phone: ownerPhone.trim() } : {}),
        ...(ownerEmail.trim() ? { email: ownerEmail.trim() } : {}),
      });
      notify(`Owner information added for ${ownerTarget.name}.`);
      setOwnerTarget(null);
      setPets(await api.pets(search));
    } catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };

  const hasPet = registering
    ? Boolean(newName.trim() && (existingOwner || (newOwnerName.trim() && (newOwnerPhone.trim() || newOwnerEmail.trim()))))
    : selectedPetIds.length > 0;
  const canSubmit = hasPet && Boolean(checkInAt) && (arrivalMode === "checkin" || Boolean(expectedCheckOutAt));
  const identityTarget = identityTargets[0] ?? null;
  if (identityTarget) {
    return <div className="page-stack">
      <section className="page-intro"><div><span className="eyebrow">Identity enrollment</span><h1>Update {identityTarget.pet_name}’s AI photos</h1><p>Add several current photos, or record a short video while {identityTarget.pet_name} moves naturally. These references improve matching and never go into an owner report.</p></div></section>
      <IdentityEnrollment
        session={identityTarget}
        doneLabel={identityTargets.length > 1 ? `Next pet (${identityTargets.length - 1} remaining)` : "Finish check-in"}
        onDone={() => {
          notify(`${identityTarget.pet_name} is ready for the stay.`);
          setIdentityTargets((current) => current.slice(1));
        }}
      />
    </div>;
  }
  return <div className="page-stack">
    <section className="page-intro"><div><span className="eyebrow">Front desk</span><h1>Reservations, arrivals & departures</h1><p>Add phone reservations ahead of time, then start the same stay when the pet arrives.</p></div><div className="heading-actions"><span className="status-pill attention">{reservations.length} reserved</span><span className="status-pill ready">{activeSessions.length} checked in</span></div></section>
    {error && <div className="banner error-banner"><b>Couldn’t update the stay.</b><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    <div className="checkin-grid">
      <section className="section-card checkin-card">
        <div className="section-heading"><div><span className="eyebrow">Front desk entry</span><h2>{arrivalMode === "reservation" ? "Add a reservation" : "Check in pets"}</h2></div><button className="outline-button compact" type="button" onClick={() => { setRegistering((value) => !value); setExistingOwner(null); setSelectedPetIds([]); }}>{registering ? "Find existing pet" : "+ New pet"}</button></div>
        <form className="checkin-form" onSubmit={submit}>
          <div className="arrival-mode-picker" role="group" aria-label="Choose reservation or check-in">
            <button type="button" className={arrivalMode === "checkin" ? "selected" : ""} onClick={() => { setArrivalMode("checkin"); setCheckInAt(localDateTimeValue()); }}><b>Check in now</b><small>Pet is arriving now</small></button>
            <button type="button" className={arrivalMode === "reservation" ? "selected" : ""} onClick={() => setArrivalMode("reservation")}><b>Add reservation</b><small>Owner called ahead</small></button>
          </div>
          {registering ? <div className="form-grid">
            {existingOwner ? <div className="wide selected-owner-summary"><span className="pet-avatar small">{existingOwner.name.slice(0, 1)}</span><div><span className="eyebrow">Adding pet under</span><b>{existingOwner.name}</b><small>{[existingOwner.phone, existingOwner.email].filter(Boolean).join(" · ") || "No contact information on file"}</small></div><button type="button" onClick={() => { setExistingOwner(null); setRegistering(false); }}>Change owner</button></div> : <><div className="wide form-section-label"><span className="eyebrow">Customer</span><b>Owner contact for reports</b></div><label>Owner name<input value={newOwnerName} onChange={(event) => setNewOwnerName(event.target.value)} placeholder="Customer’s full name" autoFocus required /></label><label>Phone<input type="tel" value={newOwnerPhone} onChange={(event) => setNewOwnerPhone(event.target.value)} placeholder="At least phone or email" /></label><label className="wide">Email<input type="email" value={newOwnerEmail} onChange={(event) => setNewOwnerEmail(event.target.value)} placeholder="Reports can be delivered here" /></label></>}
            <div className="wide form-section-label"><span className="eyebrow">Pet</span><b>Arriving pet</b></div>
            <label>Pet name<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Pet’s name" required autoFocus={Boolean(existingOwner)} /></label>
            <label>Species<select value={newSpecies} onChange={(event) => setNewSpecies(event.target.value as typeof newSpecies)}><option value="dog">Dog</option><option value="cat">Cat</option><option value="other">Other</option></select></label>
            <label className="wide">Breed (optional)<input value={newBreed} onChange={(event) => setNewBreed(event.target.value)} placeholder="e.g. Golden retriever" /></label>
          </div> : <>
            <label>Find customer or pet<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Owner name, phone, email, or pet name…" /></label>
            <div className="arrival-pet-list customer-results">{loadingPets ? <small>Searching customers and pets…</small> : pets.length === 0 ? <small>No customer or pet found. Choose “New pet” to register both.</small> : groupPetsByOwner(pets).map((group) => <section key={group.key} className="customer-group"><header><span><b>{group.ownerName}</b><small>{[group.ownerPhone, group.ownerEmail].filter(Boolean).join(" · ") || "No contact information on file"}</small></span>{group.ownerName === "Owner not linked" ? <button type="button" className="link-owner-button" onClick={() => openOwnerForm(group.pets[0])}>+ Add owner info</button> : <button type="button" className="add-pet-button" onClick={() => addPetForOwner(group.pets[0])}>+ Add pet</button>}</header>{group.pets.map((pet) => {
              const active = activePetIds.has(pet.id);
              const reserved = reservedPetIds.has(pet.id);
              const selected = selectedPetIds.includes(pet.id);
              const selectedOwnerId = pets.find((candidate) => selectedPetIds.includes(candidate.id))?.owner_id;
              const differentOwner = selectedPetIds.length > 0 && (!selectedOwnerId || !pet.owner_id || pet.owner_id !== selectedOwnerId);
              return <button type="button" key={pet.id} disabled={active || (arrivalMode === "checkin" && reserved) || differentOwner} className={selected ? "selected" : ""} onClick={() => setSelectedPetIds((current) => selected ? current.filter((id) => id !== pet.id) : [...current, pet.id])}><PetAvatar name={pet.name} src={pet.photo_thumbnail_url} size="small" /><span><b>{pet.name}</b><small>{pet.breed || title(pet.species)}</small></span><i>{active ? "Already checked in" : reserved && arrivalMode === "checkin" ? "Reserved—start below" : differentOwner ? "Another owner" : selected ? "✓ Selected" : reserved ? "+ Another date" : "+ Add"}</i></button>;
            })}</section>)}</div>
          </>}
          <div className="form-grid stay-details">
            <label>Stay type<select value={sessionType} onChange={(event) => setSessionType(event.target.value as typeof sessionType)}><option value="boarding">Boarding</option><option value="daycare">Daycare</option></select></label>
            <label>{arrivalMode === "reservation" ? "Scheduled arrival" : "Check-in date & time"}<input type="datetime-local" value={checkInAt} onChange={(event) => setCheckInAt(event.target.value)} required /></label>
            <label>Expected check-out<input type="datetime-local" value={expectedCheckOutAt} onChange={(event) => setExpectedCheckOutAt(event.target.value)} required={arrivalMode === "reservation"} /></label>
            <label className="wide">Arrival notes (optional)<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Care notes the team should see…" /></label>
          </div>
          <button className="primary-button full" disabled={working || !canSubmit}>{working ? "Saving stay…" : arrivalMode === "reservation" ? (selectedPetIds.length > 1 ? `Reserve ${selectedPetIds.length} pets together` : "Save reservation") : existingOwner ? `Add pet under ${existingOwner.name} & check in` : registering ? "Register & check in" : selectedPetIds.length > 1 ? `Check in ${selectedPetIds.length} pets together` : "Check in selected pet"}</button>
        </form>
      </section>
      <section className="section-card active-stays-card">
        <div className="section-heading"><div><span className="eyebrow">Expected arrivals</span><h2>Reservations</h2></div><span className="count-bubble attention">{reservations.length}</span></div>
        {reservations.length === 0 ? <Empty title="No upcoming reservations" detail="Phone reservations will appear here until the pet checks in." /> : <div className="reservation-list">{reservations.map((session) => <article key={session.id}><div className="reservation-main"><PetAvatar name={session.pet_name} src={session.photo_thumbnail_url} size="small" /><span><b>{session.pet_name}</b><small>{title(session.session_type)} · Arrives {formatDate(session.scheduled_check_in_at)}</small>{session.expected_check_out_at && <small>Leaves {formatDate(session.expected_check_out_at)}</small>}</span></div>{session.notes && <p>{session.notes}</p>}<div className="reservation-actions"><button className="primary-button compact" disabled={working} onClick={() => void startReservation(session)}>Start check-in</button><button className="text-danger-button" disabled={working} onClick={() => void cancelReservation(session)}>Cancel</button></div></article>)}</div>}
        <div className="reservation-active-divider" />
        <div className="section-heading"><div><span className="eyebrow">On site now</span><h2>Active stays</h2></div><span className="count-bubble">{activeSessions.length}</span></div>
        {activeSessions.length === 0 ? <Empty title="No active stays" detail="Checked-in pets will appear here and in the Staff app." /> : <div className="active-stay-list">{activeSessions.map((session) => <article key={session.id}><button className="stay-main" onClick={() => onSession(session.id)}><PetAvatar name={session.pet_name} src={session.photo_thumbnail_url} size="small" /><span><b>{session.pet_name}</b><small>{title(session.session_type)} · In {formatDate(session.check_in_at ?? session.scheduled_check_in_at)}</small></span><i>›</i></button><button className="reference-button" disabled={working} onClick={() => setIdentityTargets([{ id: session.id, pet_id: session.pet_id, pet_name: session.pet_name }])}>AI photos</button><button className="checkout-button" disabled={working} onClick={() => void checkOut(session)}>Check out</button></article>)}</div>}
      </section>
    </div>
    {ownerTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setOwnerTarget(null); }}><form className="password-dialog owner-dialog" onSubmit={saveOwner}><header><div><span className="eyebrow">Customer contact</span><h2>Add owner for {ownerTarget.name}</h2></div><button className="icon-button" type="button" disabled={working} onClick={() => setOwnerTarget(null)}>×</button></header><p>Reports and owner notifications will use this contact. If the email or phone already belongs to a customer, {ownerTarget.name} will be linked to that existing customer.</p><label>Owner name<input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} autoFocus required /></label><label>Phone<input type="tel" value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} placeholder="Phone or email is required" /></label><label>Email<input type="email" value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" /></label>{error && <div className="form-error">{error}</div>}<footer><button type="button" className="outline-button" disabled={working} onClick={() => setOwnerTarget(null)}>Cancel</button><button className="primary-button" disabled={working || !ownerName.trim() || (!ownerPhone.trim() && !ownerEmail.trim())}>{working ? "Saving…" : "Save owner"}</button></footer></form></div>}
    {confirmationDialog}
  </div>;
}

function IdentityEnrollment({ session, onDone, doneLabel = "Finish check-in" }: { session: { id: string; pet_id: string; pet_name: string }; onDone: () => void; doneLabel?: string }) {
  const [status, setStatus] = useState<IdentityMediaStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.identityMedia(session.id)); }
    catch (caught) { setError(messageOf(caught)); }
  }, [session.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Keep an open enrollment panel current even after a server-side retry or
    // worker recovery changes a row that the browser previously saw as final.
    // Otherwise a newly enrolled embedding can remain labeled "skipped" until
    // the user reloads the entire page.
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const addPhotos = async (files: FileList | null) => {
    const selected = Array.from(files ?? []).filter(isImageFile).slice(0, 20);
    if (!selected.length) return;
    setWorking(true); setError(null); setNotice(null);
    try {
      const prepared = await prepareImageFiles(selected);
      await api.uploadIdentityPhotos(prepared.files, session.pet_id, session.id);
      await load();
      setNotice(`${prepared.files.length} check-in photo${prepared.files.length === 1 ? " was" : "s were"} uploaded and queued for AI analysis.`);
    }
    catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };

  const addVideo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setWorking(true); setError(null); setNotice(null);
    try {
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("Choose a video smaller than 100 MB.");
      const durationSeconds = await readVideoDuration(file);
      if (durationSeconds > MAX_SOURCE_VIDEO_DURATION_SECONDS) throw new Error(`Choose a check-in video that is ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter.`);
      await api.uploadIdentityVideo(file, session.pet_id, session.id, durationSeconds);
      await load();
      setNotice("Check-in video uploaded. AI is extracting clear reference frames in the background.");
    }
    catch (caught) { setError(friendlyVideoError(caught)); }
    finally { setWorking(false); }
  };

  const enrolled = status?.photos.reduce((sum, photo) => sum + photo.enrolled_embedding_count, 0) ?? 0;
  const skippedPhotos = status?.photos.filter((photo) => photo.processing_status === "processed" && photo.enrolled_embedding_count === 0) ?? [];
  const recheckSkipped = async () => {
    if (!skippedPhotos.length) return;
    setWorking(true); setError(null); setNotice(null);
    try {
      for (const photo of skippedPhotos) await api.reprocessPhoto(photo.id);
      await load();
      setNotice(`${skippedPhotos.length} skipped reference${skippedPhotos.length === 1 ? " was" : "s were"} queued for a fresh AI check.`);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setWorking(false); }
  };
  const processingPhotos = status?.photos.filter((photo) => photo.processing_status !== "processed" && photo.processing_status !== "failed").length ?? 0;
  const processingVideos = status?.videos.filter((video) => video.processing_status !== "processed" && video.processing_status !== "failed").length ?? 0;
  const processing = processingPhotos + processingVideos;
  return <section className="section-card identity-enrollment-card">
    <div className="identity-guidance"><b>Best results</b><span>Use 3–6 clear views: face, left side, right side, and full body. If similar-looking pets wear different bright leashes, include the leash in at least one check-in photo; UCBarkley uses its color only as a secondary clue. Identity videos may be up to {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds.</span></div>
    {error && <div className="banner error-banner" role="alert" aria-live="assertive"><span><b>We couldn’t upload that file.</b><br />{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    {notice && <div className="banner success-banner"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
    <div className="identity-actions">
      <label className="identity-action"><span>▧</span><b>Add multiple photos</b><small>{working ? "Preparing and uploading photos…" : "Choose or capture up to 20 images"}</small><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple disabled={working} onChange={(event) => void addPhotos(event.target.files)} /></label>
      <label className="identity-action"><span>●</span><b>Record video</b><small>Use this device’s camera · up to {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds</small><input type="file" accept="video/mp4,video/quicktime" capture="environment" disabled={working} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void addVideo(event.target.files)} /></label>
      <label className="identity-action"><span>▶</span><b>Choose video</b><small>Upload an MP4 or MOV saved on this device</small><input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={working} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void addVideo(event.target.files)} /></label>
    </div>
    <div className="identity-summary"><div><b>{working ? "Working…" : `${enrolled} usable AI reference${enrolled === 1 ? "" : "s"}`}</b><span>{processing > 0 ? `${processing} upload${processing === 1 ? " is" : "s are"} still being analyzed.` : "Only single-pet frames are enrolled automatically."}</span></div>{skippedPhotos.length > 0 && <button type="button" className="outline-button compact" disabled={working || processing > 0} onClick={() => void recheckSkipped()}>↻ Re-check {skippedPhotos.length} skipped</button>}</div>
    {status && status.photos.length > 0 && <div className="identity-photo-grid">{status.photos.map((photo) => <IdentityReferencePhoto key={photo.id} photo={photo} />)}</div>}
    {status && status.videos.length > 0 && <div className="identity-video-list">{status.videos.map((video) => <span key={video.id}><b>Video</b> · {title(video.processing_status)}{video.extracted_frame_count ? ` · ${video.extracted_frame_count} frames extracted` : ""}</span>)}</div>}
    <div className="upload-actions"><span><b>{working ? "Uploading references…" : processing > 0 ? "AI is analyzing the references…" : "References are ready"}</b><small>{working || processing > 0 ? "Keep this uploader open until analysis finishes." : "More references can be added at any time while this stay is active."}</small></span><button className="primary-button" disabled={working || processing > 0} onClick={onDone}>{working ? "Uploading…" : processing > 0 ? `Analyzing ${processing} upload${processing === 1 ? "" : "s"}…` : doneLabel}</button></div>
  </section>;
}

function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      callback();
    };
    const timeout = window.setTimeout(() => finish(() => reject(new Error("The browser could not read this video’s details. Try exporting it as an MP4, then choose it again."))), 12_000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      Number.isFinite(duration) && duration > 0
        ? finish(() => resolve(duration))
        : finish(() => reject(new Error("The video duration could not be read. Try exporting it as an MP4, then choose it again.")));
    };
    video.onerror = () => finish(() => reject(new Error("This video could not be opened by the browser. Try exporting it as an MP4, then choose it again.")));
    video.src = url;
    video.load();
  });
}

function friendlyVideoError(error: unknown) {
  const message = messageOf(error);
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return "We couldn’t reach video storage. Check your connection and choose the video again.";
  if (/storage allowance|exceed.*storage|413/i.test(message)) return "This facility’s media storage is full. Remove unused media or increase the storage allowance, then try again.";
  if (/401|unauthorized|sign.?in/i.test(message)) return "Your session expired. Sign in again, return to this pet, and retry the upload.";
  if (/invalid request/i.test(message)) return `This video could not be accepted. Use an MP4 or MOV no longer than ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds and smaller than 100 MB.`;
  if (/upload failed \(403\)|upload failed \(400\)/i.test(message)) return "Video storage did not accept this file. Please choose the video again; exporting it as an MP4 may help.";
  return message;
}

function ReviewQueue({ sessions, onChanged, notify }: { sessions: SessionOption[]; onChanged: () => void; notify: (value: string) => void }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [filter, setFilter] = useState<ReviewFilter>("review");
  const [photos, setPhotos] = useState<ReviewPhoto[]>([]);
  const [selected, setSelected] = useState<ReviewPhoto | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvingPhotoId, setApprovingPhotoId] = useState<string | null>(null);
  const [reprocessingPhotoId, setReprocessingPhotoId] = useState<string | null>(null);
  const [bulkReprocessing, setBulkReprocessing] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const data = await api.photos(filter);
      setPhotos(data.photos);
      setSelected((current) => current ? data.photos.find((photo) => photo.id === current.id) ?? null : null);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(false); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const hasProcessingPhotos = photos.some((photo) => ["uploaded", "queued", "processing"].includes(photo.processing_status));
  useEffect(() => {
    if (!hasProcessingPhotos) return;
    const timer = window.setInterval(() => {
      void api.photos(filter).then((data) => {
        setPhotos(data.photos);
        setSelected((current) => current ? data.photos.find((photo) => photo.id === current.id) ?? null : null);
      }).catch((caught) => setError(messageOf(caught)));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [filter, hasProcessingPhotos]);

  const changed = async (message: string) => {
    notify(message); onChanged(); await load();
  };

  const quickApprove = async (photo: ReviewPhoto) => {
    const links = photo.links.filter((link) => link.review_state === "candidate" || link.review_state === "pending");
    if (!links.length) { setSelected(photo); return; }
    const petNames = Array.from(new Set(links.map((link) => link.pet_name).filter(Boolean))).join(", ");
    if (!await requestConfirmation({
      eyebrow: "Share with family",
      title: "Approve and publish this photo?",
      message: `This photo will become visible to ${petNames || "the assigned pet’s family"}.`,
      detail: "Published assignments stay locked so the family always sees the approved version.",
      confirmLabel: "Approve & publish",
      cancelLabel: "Review first",
    })) return;
    setApprovingPhotoId(photo.id); setError(null);
    try {
      for (const sessionId of new Set(links.map((link) => link.session_id))) {
        await api.publishPhotos(sessionId, links.filter((link) => link.session_id === sessionId).map((link) => link.id));
      }
      await changed(`Photo approved and published${petNames ? ` for ${petNames}` : ""}.`);
    } catch (caught) { setError(messageOf(caught)); }
    finally { setApprovingPhotoId(null); }
  };

  const reprocessFromList = async (photo: ReviewPhoto) => {
    if (!await requestConfirmation({
      eyebrow: "Fresh AI review",
      title: "Run AI again?",
      message: "UCBarkley will compare this photo with the latest active pet reference photos.",
      detail: "Manager corrections and published assignments will stay unchanged.",
      confirmLabel: "Run AI again",
      cancelLabel: "Not now",
    })) return;
    setReprocessingPhotoId(photo.id); setError(null);
    try { await api.reprocessPhoto(photo.id); await changed("Photo queued for a fresh AI analysis."); }
    catch (caught) { setError(messageOf(caught)); }
    finally { setReprocessingPhotoId(null); }
  };

  const reprocessVisible = async () => {
    const bulkFilter = filter as "review" | "unmatched" | "failed" | "all";
    const scopeLabel = filter === "all" ? "every completed report photo" : `every photo in the ${FILTERS.find((item) => item.id === filter)?.label ?? filter} queue`;
    if (!await requestConfirmation({
      eyebrow: "Fresh AI review",
      title: `Re-run AI on ${scopeLabel}?`,
      message: "This also includes matching photos that are not currently loaded on screen.",
      detail: "The latest AI-ready pet references will be used. Published photos and manager corrections will stay unchanged.",
      confirmLabel: "Re-run AI",
      cancelLabel: "Not now",
    })) return;
    setBulkReprocessing(true); setError(null);
    try {
      const result = await api.reprocessAllPhotos(bulkFilter);
      notify(`${result.queuedCount} photo${result.queuedCount === 1 ? "" : "s"} queued for fresh AI analysis.`);
      onChanged();
      await load();
    } catch (caught) {
      setError(messageOf(caught));
    } finally { setBulkReprocessing(false); }
  };

  const deleteFromList = async (photo: ReviewPhoto) => {
    const ownerVisible = photo.links.some((link) => link.review_state === "published");
    if (!await requestConfirmation(photoDeleteConfirmation(ownerVisible))) return;
    setDeletingPhotoId(photo.id); setError(null);
    try {
      await api.deletePhoto(photo.id);
      setSelected((current) => current?.id === photo.id ? null : current);
      await changed(ownerVisible ? "Uploaded photo deleted and removed from owner view." : "Uploaded photo deleted.");
    } catch (caught) { setError(messageOf(caught)); }
    finally { setDeletingPhotoId(null); }
  };

  return <div className="page-stack">
    <section className="page-intro"><div><span className="eyebrow">AI + human review</span><h1>Photo intelligence</h1><p>Confirm the pets AI recognized, fix uncertain matches, and approve only the moments worth sharing.</p></div><div className="review-page-actions"><div className="review-legend"><span><i className="legend-dot confident" />Confident</span><span><i className="legend-dot review" />Review</span><span><i className="legend-dot unknown" />Unknown</span></div>{(["review", "unmatched", "failed", "all"] as ReviewFilter[]).includes(filter) && photos.length > 0 && <button type="button" className="outline-button bulk-reprocess-button" disabled={busy || bulkReprocessing} onClick={() => void reprocessVisible()}>{bulkReprocessing ? "Queuing photos…" : filter === "all" ? "↻ Re-run AI on all photos" : "↻ Re-run entire queue"}</button>}</div></section>
    <div className="filter-bar">{FILTERS.map((item) => <button key={item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
    {error && <div className="banner error-banner">{error}<button onClick={() => void load()}>Try again</button></div>}
    {busy ? <Loading label="Gathering photo suggestions" /> : photos.length === 0 ? <Empty title="This queue is clear" detail="New staff uploads and uncertain AI matches will appear here." /> : <div className="photo-grid">{photos.map((photo) => <PhotoCard key={photo.id} photo={photo} onClick={() => setSelected(photo)} onQuickApprove={() => void quickApprove(photo)} onReprocess={() => void reprocessFromList(photo)} onDelete={() => void deleteFromList(photo)} approving={approvingPhotoId === photo.id} reprocessing={bulkReprocessing || reprocessingPhotoId === photo.id} deleting={deletingPhotoId === photo.id} />)}</div>}
    {selected && <PhotoReviewDialog photo={selected} sessions={sessions} onClose={() => setSelected(null)} onChanged={changed} />}
    {confirmationDialog}
  </div>;
}

function PhotoCard({ photo, onClick, onQuickApprove, onReprocess, onDelete, approving = false, reprocessing = false, deleting = false }: { photo: ReviewPhoto; onClick: () => void; onQuickApprove?: () => void; onReprocess?: () => void; onDelete?: () => void; approving?: boolean; reprocessing?: boolean; deleting?: boolean }) {
  const primary = photo.detections.find((detection) => detection.match_status !== "manually_rejected");
  const confidence = primary?.match_confidence ? Math.round(Number(primary.match_confidence) * 100) : null;
  const isProcessing = ["uploaded", "queued", "processing"].includes(photo.processing_status);
  const state = photo.processing_status === "failed" ? "failed" : primary?.match_status === "matched" || primary?.match_status === "manually_assigned" ? "confident" : primary?.matched_pet_id ? "review" : "unknown";
  const assignedLabels = Array.from(new Set(photo.links.filter((link) => link.review_state !== "rejected").map((link) => link.pet_name).filter(Boolean)));
  const suggestedLabels = Array.from(new Set(photo.detections.filter((detection) => detection.match_status !== "manually_rejected").map((detection) => detection.matched_pet_name).filter(Boolean)));
  const labels = assignedLabels.length ? assignedLabels : suggestedLabels;
  const rates = photo.detections
    .filter((detection) => detection.match_status !== "manually_rejected")
    .map((detection, index) => ({
      label: detection.matched_pet_name || `Pet ${index + 1}: unknown`,
      confidence: detection.match_confidence === null ? null : Math.round(Number(detection.match_confidence) * 100),
    }));
  const publishableCount = photo.links.filter((link) => link.review_state === "candidate" || link.review_state === "pending").length;
  return <article className="photo-card">
    <button className="photo-card-open" onClick={onClick}>
      <div className="photo-frame"><img src={photo.viewUrl} alt="Staff upload" /><span className={`match-badge ${state}`}>{state === "failed" ? "Processing failed" : isProcessing ? `AI ${title(photo.processing_status)}` : state === "confident" ? `${confidence ?? "—"}% visual similarity` : state === "review" ? `AI uncertain · ${confidence ?? "—"}%` : photo.detections.length ? "Pet found · choose identity" : "No pet detected"}</span>{photo.detections.length > 1 && <span className="group-badge">{photo.detections.length} pets</span>}</div>
      {rates.length > 0 && <div className="match-rates">{rates.map((rate, index) => <span key={`${rate.label}-${index}`}>{rate.label}<b>{rate.confidence === null ? "No identity" : `${rate.confidence}% similarity`}</b></span>)}</div>}
      <div className="photo-meta"><div><b>{labels.length ? `${labels.join(" + ")}${assignedLabels.length ? "" : " · suggestions only"}` : "Needs identification"}</b><small>{formatDate(photo.capture_at ?? photo.uploaded_at)} · {photo.uploaded_by_name}</small></div><span>Review →</span></div>
    </button>
    {(onReprocess || onDelete || (onQuickApprove && publishableCount > 0)) && <div className="quick-approval"><span><b>{publishableCount ? `${publishableCount} assignment${publishableCount === 1 ? "" : "s"}` : suggestedLabels.length ? "AI suggestions—not assigned" : "Photo controls"}</b><small>{publishableCount ? "Review, publish, or delete" : suggestedLabels.length ? "Open Review to confirm pet assignments" : "Re-run AI or remove upload"}</small></span><div className="quick-actions">{onReprocess && <button className="secondary" onClick={onReprocess} disabled={reprocessing || approving || deleting}>{reprocessing ? "Queuing…" : "↻ Re-run AI"}</button>}{onDelete && <button className="danger" onClick={onDelete} disabled={deleting || reprocessing || approving}>{deleting ? "Deleting…" : "Delete photo"}</button>}{onQuickApprove && publishableCount > 0 && <button onClick={onQuickApprove} disabled={approving || reprocessing || deleting}>{approving ? "Publishing…" : "Quick approve ✓"}</button>}</div></div>}
  </article>;
}

function PhotoReviewDialog({ photo, sessions, onClose, onChanged }: { photo: ReviewPhoto; sessions: SessionOption[]; onClose: () => void; onChanged: (message: string) => Promise<void> }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const suggested = useMemo(() => new Set([
    ...photo.links.filter((link) => link.review_state !== "rejected").map((link) => link.session_id),
    ...photo.detections.filter((detection) => detection.match_status !== "manually_rejected" && detection.matched_session_id).map((detection) => detection.matched_session_id!),
  ]), [photo]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(suggested);
  const [working, setWorking] = useState(false);

  useEffect(() => setSelectedSessions(suggested), [suggested]);

  const toggle = (id: string) => setSelectedSessions((current) => {
    const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const save = async () => {
    if (selectedSessions.size === 0) return;
    setWorking(true);
    try {
      const assignments = [...selectedSessions].map((sessionId) => {
        const session = sessions.find((candidate) => candidate.id === sessionId)!;
        const direct = photo.detections.find((detection) => detection.matched_session_id === sessionId);
        const sole = selectedSessions.size === 1 && photo.detections.filter((detection) => detection.match_status !== "manually_rejected").length === 1
          ? photo.detections.find((detection) => detection.match_status !== "manually_rejected")
          : undefined;
        // Never pair a group assignment to a crop merely by list position. A wrong
        // crop would become bad reference data for later identity suggestions.
        const source = direct ?? sole;
        return { petId: session.pet_id, sessionId, ...(source ? { sourceDetectionId: source.id } : {}) };
      });
      await api.confirmAssignments(photo.id, assignments);
      const petNames = assignments.map((assignment) => sessions.find((session) => session.id === assignment.sessionId)?.pet_name).filter(Boolean);
      await onChanged(`Photo added to ${petNames.join(" and ") || `${assignments.length} selected pet${assignments.length === 1 ? "" : "s"}`} for report review.`);
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t save these pet assignments")); }
    finally { setWorking(false); }
  };

  const publish = async () => {
    const publishable = photo.links.filter((link) => link.review_state === "candidate" || link.review_state === "pending");
    if (!publishable.length) return;
    setWorking(true);
    try {
      for (const sessionId of new Set(publishable.map((link) => link.session_id))) {
        await api.publishPhotos(sessionId, publishable.filter((link) => link.session_id === sessionId).map((link) => link.id));
      }
      await onChanged("Photo approved and published."); onClose();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t publish this photo")); }
    finally { setWorking(false); }
  };

  const reprocess = async () => {
    setWorking(true);
    try { await api.reprocessPhoto(photo.id); await onChanged("Photo queued for a fresh AI analysis."); onClose(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t run AI again")); }
    finally { setWorking(false); }
  };

  const reject = async () => {
    if (!await requestConfirmation({
      eyebrow: "Review decision",
      title: "Remove this photo from review?",
      message: "The photo and all unpublished pet assignments will leave the review queue.",
      detail: "Nothing already shared with a family will be changed.",
      confirmLabel: "Remove from review",
      cancelLabel: "Keep reviewing",
      tone: "danger",
    })) return;
    setWorking(true);
    try { await api.rejectPhoto(photo.id); await onChanged("Photo removed from the review queue."); onClose(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t remove this photo")); }
    finally { setWorking(false); }
  };

  const removeUpload = async () => {
    const ownerVisible = photo.links.some((link) => link.review_state === "published");
    if (!await requestConfirmation(photoDeleteConfirmation(ownerVisible))) return;
    setWorking(true);
    try { await api.deletePhoto(photo.id); await onChanged("Uploaded photo deleted."); onClose(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t delete this photo")); }
    finally { setWorking(false); }
  };

  const publishableCount = photo.links.filter((link) => link.review_state === "candidate" || link.review_state === "pending").length;
  return <><div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="review-dialog">
      <header><div><span className="eyebrow">Manager review</span><h2>Confirm who’s in this photo</h2></div><button className="close-button" onClick={onClose}>×</button></header>
      <div className="review-layout">
        <div className="review-photo"><img src={photo.viewUrl} alt="Full staff upload" />{photo.detections.map((detection, index) => <span key={detection.id} className={`detection-box ${detection.match_status}`} style={{ left: `${Number(detection.bbox_x) * 100}%`, top: `${Number(detection.bbox_y) * 100}%`, width: `${Number(detection.bbox_width) * 100}%`, height: `${Number(detection.bbox_height) * 100}%` }}><b>{index + 1}</b></span>)}</div>
        <div className="review-panel">
          {photo.processing_status === "failed" && <div className="inline-warning"><b>AI processing failed</b><span>{photo.processing_error || "The worker could not process this image."}</span></div>}
          <div className="suggestion-list">{photo.detections.filter((detection) => detection.match_status !== "manually_rejected").map((detection, index) => <div className="suggestion" key={detection.id}>{detection.cropUrl ? <img src={detection.cropUrl} alt={`Detected pet ${index + 1}`} /> : <span className="crop-placeholder">{index + 1}</span>}<div><small>Detection {index + 1} · {title(detection.species_guess || "pet")}</small><b>{detection.matched_pet_name || "No identity found"}</b><span>{detection.match_confidence ? `${Math.round(Number(detection.match_confidence) * 100)}% visual similarity` : "No reference match"}{detection.match_signals?.leashColorAvailable ? detection.match_signals.leashColorAdjustment && detection.match_signals.leashColorAdjustment > 0 ? " · leash color supports this suggestion" : " · leash color checked—please verify" : ""}</span></div><span className={`status-pill ${detection.match_status === "matched" ? "ready" : "attention"}`}>{title(detection.match_status.replace("_", " "))}</span></div>)}</div>
          <div className="assignment-heading"><div><h3>Pet assignments</h3><p>AI suggestions are not assignments yet. Keep every pet shown selected, then confirm below.</p></div><span>{selectedSessions.size} selected</span></div>
          <div className="pet-picker">{sessions.map((session) => { const checked = selectedSessions.has(session.id); const ai = photo.detections.some((detection) => detection.matched_session_id === session.id); return <button key={session.id} className={checked ? "selected" : ""} onClick={() => toggle(session.id)}><PetAvatar name={session.pet_name} src={session.photo_thumbnail_url} size="small" /><span><b>{session.pet_name}</b><small>{title(session.species)} · Checked in</small></span>{ai && <em>AI suggestion</em>}<i>{checked ? "✓" : "+"}</i></button>; })}</div>
        </div>
      </div>
      <footer><div className="secondary-actions"><button onClick={reprocess} disabled={working}>↻ Run AI again</button><button className="danger-link" onClick={reject} disabled={working}>Reject photo</button><button className="danger-link" onClick={removeUpload} disabled={working}>Delete upload</button></div><div className="primary-actions">{publishableCount > 0 && <button className="outline-button" onClick={publish} disabled={working}>Approve & publish ({publishableCount})</button>}<button className="primary-button" onClick={save} disabled={working || selectedSessions.size === 0}>{working ? "Saving…" : `Confirm & add to ${selectedSessions.size} pet${selectedSessions.size === 1 ? "" : "s"}`}</button></div></footer>
    </section>
  </div>{confirmationDialog}</>;
}

function PetReportMediaUploader({ session, notify, onUploaded }: { session: { id: string; pet_id: string; pet_name: string }; notify: (value: string) => void; onUploaded: () => Promise<void> }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoProgress, setPhotoProgress] = useState(0);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [working, setWorking] = useState<"photos" | "video" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const photoPreviews = useMemo(() => photoFiles.map((file) => URL.createObjectURL(file)), [photoFiles]);
  const videoPreview = useMemo(() => videoFile ? URL.createObjectURL(videoFile) : null, [videoFile]);

  useEffect(() => () => photoPreviews.forEach((url) => URL.revokeObjectURL(url)), [photoPreviews]);
  useEffect(() => () => { if (videoPreview) URL.revokeObjectURL(videoPreview); }, [videoPreview]);

  const choosePhotos = async (list: FileList | null) => {
    const selected = Array.from(list ?? []).filter(isImageFile).slice(0, MAX_ADMIN_MEDIA_BATCH_ITEMS);
    setError(null); setNotice(null);
    setPhotoProgress(0);
    if (!selected.length) return setError("Choose one or more image files.");
    setWorking("photos");
    try {
      const prepared = await prepareImageFiles(selected);
      setPhotoFiles(prepared.files);
      if (prepared.convertedCount) notify(`${prepared.convertedCount} HEIC photo${prepared.convertedCount === 1 ? " was" : "s were"} converted to JPG.`);
    } catch (caught) {
      setPhotoFiles([]);
      setError(messageOf(caught));
    } finally {
      setWorking(null);
    }
  };

  const uploadPhotos = async () => {
    if (!photoFiles.length) return;
    setWorking("photos"); setError(null); setPhotoProgress(0);
    try {
      const result = await api.uploadReportPhotosForPet(photoFiles, session.pet_id, session.id, setPhotoProgress);
      setPhotoFiles([]);
      notify(`${result.photoCount} photo${result.photoCount === 1 ? "" : "s"} added to ${session.pet_name} for private report review.`);
      await onUploaded();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setWorking(null);
    }
  };

  const uploadVideo = async (file = videoFile, duration = videoDuration) => {
    if (!file || !duration) return;
    setWorking("video"); setError(null);
    try {
      await api.uploadReportVideo(file, session.pet_id, session.id, duration);
      setVideoFile(null); setVideoDuration(null);
      notify(`Video added to ${session.pet_name} for private report review.`);
      await onUploaded();
      setNotice(`Video uploaded and assigned to ${session.pet_name}. Review it in Source clips below.`);
    } catch (caught) {
      const message = friendlyVideoError(caught);
      setError(message);
      await requestConfirmation({
        eyebrow: "Video not uploaded",
        title: "We couldn’t upload that video",
        message,
        detail: "The file was not added to the pet’s report. Close this message, then choose the same video again.",
        confirmLabel: "Choose again",
        hideCancel: true,
      });
    } finally {
      setWorking(null);
    }
  };

  const chooseVideo = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setError(null); setNotice(null);
    try {
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) throw new Error("Choose a video smaller than 100 MB.");
      const lowerName = file.name.toLowerCase();
      if (!(file.type === "video/mp4" || file.type === "video/quicktime" || lowerName.endsWith(".mp4") || lowerName.endsWith(".mov"))) throw new Error("Choose an MP4 or MOV video.");
      const duration = await readVideoDuration(file);
      if (duration > MAX_SOURCE_VIDEO_DURATION_SECONDS) throw new Error(`Choose a video that is ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter.`);
      setVideoFile(file);
      setVideoDuration(duration);
      await uploadVideo(file, duration);
    } catch (caught) {
      const message = friendlyVideoError(caught);
      setVideoFile(null); setVideoDuration(null); setError(message);
      await requestConfirmation({
        eyebrow: "Video not uploaded",
        title: "We couldn’t use that video",
        message,
        detail: "The file was not added. Close this message, then choose the same video again or try an MP4 copy.",
        confirmLabel: "Choose again",
        hideCancel: true,
      });
    }
  };

  return <><section className="section-card pet-media-uploader">
    <div className="section-heading"><div><span className="eyebrow">Private report media</span><h2>Upload photos or video</h2><p className="section-helper">Files are assigned directly to {session.pet_name}’s stay. They remain private until you approve and publish them below.</p></div></div>
    {error && <div className="banner error-banner" role="alert" aria-live="assertive"><span><b>Upload not completed.</b><br />{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
    {notice && <div className="banner success-banner"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div>}
    <div className="pet-media-upload-grid">
      <article>
        <label className="report-clip-picker"><input type="file" accept="image/*,.heic,.heif" multiple disabled={working !== null} onChange={(event) => void choosePhotos(event.target.files)} /><span>▧</span><b>{working === "photos" && !photoFiles.length ? "Preparing photos…" : photoFiles.length ? "Choose different photos" : "Choose photos"}</b><small>JPEG, PNG, or HEIC · up to {MAX_ADMIN_MEDIA_BATCH_ITEMS}</small></label>
        {photoFiles.length > 0 && <><div className="pet-media-photo-preview">{photoPreviews.slice(0, 6).map((url, index) => <img key={url} src={url} alt={`Selected upload ${index + 1}`} />)}{photoFiles.length > 6 && <span>+{photoFiles.length - 6}</span>}</div><button type="button" className="primary-button full" disabled={working !== null} onClick={() => void uploadPhotos()}>{working === "photos" ? `Uploading ${photoProgress} of ${photoFiles.length}…` : `Upload ${photoFiles.length} photo${photoFiles.length === 1 ? "" : "s"}`}</button></>}
      </article>
      <article>
        <label className="report-clip-picker"><input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={working !== null} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void chooseVideo(event.target.files)} /><span>▶</span><b>{working === "video" ? "Uploading video…" : videoFile ? "Choose a different video" : "Choose & upload video"}</b><small>MP4 or MOV · up to {MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds and 100 MB · upload starts automatically</small></label>
        {videoPreview && <><video src={videoPreview} controls muted playsInline preload="metadata" /><small className="pet-media-file-detail">{videoFile?.name} · {formatBytes(videoFile?.size ?? 0)} · {Math.ceil(videoDuration ?? 0)} sec</small>{working !== "video" && <button type="button" className="primary-button full" disabled={working !== null} onClick={() => void uploadVideo()}>Retry upload</button>}</>}
      </article>
    </div>
  </section>{confirmationDialog}</>;
}

function ShopPosPage({ notify, onSession }: { notify: (value: string) => void; onSession: (sessionId: string) => void }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [overview, setOverview] = useState<CommerceOverview | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [itemType, setItemType] = useState<"service" | "product">("service");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(false);
  const [trackInventory, setTrackInventory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextCatalog] = await Promise.all([api.commerceOverview(), api.catalogItems(true)]);
      setOverview(nextOverview);
      setCatalog(nextCatalog);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setItemType("service");
    setName("");
    setDescription("");
    setSku("");
    setPrice("");
    setTaxable(false);
    setTrackInventory(false);
  };

  const editItem = (item: CatalogItem) => {
    setEditingId(item.id);
    setItemType(item.item_type);
    setName(item.name);
    setDescription(item.description ?? "");
    setSku(item.sku ?? "");
    setPrice((item.unit_price_cents / 100).toFixed(2));
    setTaxable(item.taxable);
    setTrackInventory(item.track_inventory);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveItem = async (event: FormEvent) => {
    event.preventDefault();
    const unitPriceCents = price.trim() === "" ? Number.NaN : Math.round(Number(price) * 100);
    if (!name.trim() || !Number.isFinite(unitPriceCents) || unitPriceCents < 0) {
      await requestConfirmation({ eyebrow: "Catalog item", title: "Add a name and valid price", message: "The item needs a name and a price of zero or more.", confirmLabel: "Got it", hideCancel: true });
      return;
    }
    setWorking(true);
    try {
      const data = { itemType, name: name.trim(), description: description.trim() || undefined, sku: sku.trim() || undefined, unitPriceCents, taxable, trackInventory };
      if (editingId) {
        const existing = catalog.find((item) => item.id === editingId);
        if (!existing) throw new Error("Catalog item is no longer available");
        await api.updateCatalogItem(editingId, { ...data, isActive: existing.is_active });
        notify(`${name.trim()} updated.`);
      } else {
        await api.createCatalogItem(data);
        notify(`${name.trim()} added to the catalog.`);
      }
      resetForm();
      await load();
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Catalog item couldn’t be saved"));
    } finally {
      setWorking(false);
    }
  };

  const toggleItem = async (item: CatalogItem) => {
    if (item.is_active && !await requestConfirmation({ eyebrow: "Shop catalog", title: `Deactivate ${item.name}?`, message: "It will disappear from new charge entry, while existing stay charges keep their saved name and price.", confirmLabel: "Deactivate", tone: "danger" })) return;
    setWorking(true);
    try {
      await api.updateCatalogItem(item.id, {
        itemType: item.item_type,
        name: item.name,
        description: item.description ?? undefined,
        sku: item.sku ?? undefined,
        unitPriceCents: item.unit_price_cents,
        taxable: item.taxable,
        trackInventory: item.track_inventory,
        isActive: !item.is_active,
      });
      notify(`${item.name} ${item.is_active ? "deactivated" : "reactivated"}.`);
      if (editingId === item.id) resetForm();
      await load();
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Catalog item couldn’t be updated"));
    } finally {
      setWorking(false);
    }
  };

  const money = (cents: number, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);

  if (loading && !overview) return <Loading label="Opening shop operations" />;

  return <div className="shop-pos-page">
    <section className="page-intro shop-pos-intro"><div><span className="eyebrow">Shop operations</span><h1>Services, products & stay charges</h1><p>Keep the shop catalog and every current stay’s running charge sheet in one place.</p></div><span className="status-pill attention">Payments not connected</span></section>
    {error && <div className="banner error-banner"><b>Shop data couldn’t load.</b><span>{error}</span><button onClick={() => void load()}>Try again</button></div>}
    <section className="pos-stat-grid">
      <article><span>Current stays</span><strong>{overview?.stats.current_stays ?? 0}</strong><small>Checked in and expected arrivals</small></article>
      <article><span>With charges</span><strong>{overview?.stats.charged_stays ?? 0}</strong><small>Stays with at least one line item</small></article>
      <article><span>Open charge total</span><strong>{money(overview?.stats.open_total_cents ?? 0)}</strong><small>Operational total, not collected payment</small></article>
    </section>
    <div className="shop-pos-layout">
      <section className="section-card pos-stay-board">
        <div className="section-heading"><div><span className="eyebrow">Front desk</span><h2>Current stay charges</h2><p className="section-helper">Open a pet’s workspace to add or adjust services and products.</p></div><button className="icon-button" aria-label="Refresh shop data" onClick={() => void load()}>↻</button></div>
        {!overview?.stays.length ? <Empty title="No current stays" detail="Checked-in pets and expected arrivals will appear here." /> : <div className="pos-stay-list">{overview.stays.map((stay) => <button key={stay.session_id} onClick={() => onSession(stay.session_id)}><PetAvatar name={stay.pet_name} src={stay.photo_thumbnail_url} size="small" /><span><b>{stay.pet_name}</b><small>{stay.status === "reserved" ? "Expected arrival" : title(stay.session_type)} · {stay.item_count} {stay.item_count === 1 ? "item" : "items"}</small></span><strong>{money(stay.total_cents, stay.currency)}</strong><i>→</i></button>)}</div>}
      </section>
      <section className="section-card catalog-editor-card">
        <div className="section-heading"><div><span className="eyebrow">Reusable catalog</span><h2>{editingId ? "Edit catalog item" : "Add service or product"}</h2><p className="section-helper">Catalog price changes never rewrite charges already saved to a stay.</p></div>{editingId && <button className="outline-button" onClick={resetForm}>Cancel edit</button>}</div>
        <form className="catalog-editor" onSubmit={saveItem}>
          <div className="catalog-form-grid"><label><span>Type</span><select value={itemType} onChange={(event) => setItemType(event.target.value as "service" | "product")}><option value="service">Service</option><option value="product">Product</option></select></label><label><span>Name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Bath, daycare, treats…" /></label><label><span>Price</span><input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} placeholder="0.00" /></label><label><span>SKU (optional)</span><input value={sku} maxLength={80} onChange={(event) => setSku(event.target.value)} placeholder="GROOM-BATH" /></label><label className="wide"><span>Description (optional)</span><input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="What staff should know about this item" /></label></div>
          <div className="catalog-flags"><label><input type="checkbox" checked={taxable} onChange={(event) => setTaxable(event.target.checked)} /><span><b>Taxable</b><small>Prepared for future tax calculation</small></span></label><label><input type="checkbox" checked={trackInventory} onChange={(event) => setTrackInventory(event.target.checked)} /><span><b>Track inventory</b><small>Marks physical products for a future inventory workflow</small></span></label></div>
          <button className="primary-button" disabled={working}>{working ? "Saving…" : editingId ? "Save changes" : "Add to catalog"}</button>
        </form>
      </section>
    </div>
    <section className="section-card catalog-list-card">
      <div className="section-heading"><div><span className="eyebrow">Catalog</span><h2>Services & products</h2><p className="section-helper">Inactive items remain visible for history but cannot be added to new charges.</p></div><span className="count-bubble">{catalog.filter((item) => item.is_active).length} active</span></div>
      {!catalog.length ? <Empty title="Catalog is empty" detail="Add the first service or product above." /> : <div className="catalog-list">{catalog.map((item) => <article key={item.id} className={item.is_active ? "" : "inactive"}><span className={`catalog-kind ${item.item_type}`}>{item.item_type}</span><div><b>{item.name}</b><small>{item.description || item.sku || "No description"}{item.sku && item.description ? ` · ${item.sku}` : ""}</small></div><strong>{money(item.unit_price_cents, item.currency)}</strong><span className={`status-pill ${item.is_active ? "good" : "muted"}`}>{item.is_active ? "Active" : "Inactive"}</span><div><button className="outline-button" disabled={working} onClick={() => editItem(item)}>Edit</button><button className={item.is_active ? "danger-link" : "outline-button"} disabled={working} onClick={() => void toggleItem(item)}>{item.is_active ? "Deactivate" : "Reactivate"}</button></div></article>)}</div>}
    </section>
    {confirmationDialog}
  </div>;
}

function ChargeSheetCard({ sessionId, petName, notify }: { sessionId: string; petName: string; notify: (value: string) => void }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [sheet, setSheet] = useState<ChargeSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [catalogItemId, setCatalogItemId] = useState("");
  const [itemType, setItemType] = useState<"service" | "product">("service");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [saveToCatalog, setSaveToCatalog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catalogItems, chargeSheet] = await Promise.all([api.catalogItems(), api.chargeSheet(sessionId)]);
      setCatalog(catalogItems);
      setSheet(chargeSheet);
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Charge sheet couldn’t load"));
    } finally {
      setLoading(false);
    }
  }, [requestConfirmation, sessionId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setExpanded(false); }, [sessionId]);

  const addItem = async (event: FormEvent) => {
    event.preventDefault();
    const unitPriceCents = Math.round(Number(price) * 100);
    if (!catalogItemId && (!name.trim() || !Number.isFinite(unitPriceCents) || unitPriceCents < 0)) {
      await requestConfirmation({ eyebrow: "Check the item", title: "Add a name and valid price", message: "Custom charges need an item name and a price of zero or more.", confirmLabel: "Got it", hideCancel: true });
      return;
    }
    setWorking(true);
    try {
      let selectedCatalogId = catalogItemId || undefined;
      if (!selectedCatalogId && saveToCatalog) {
        const created = await api.createCatalogItem({ itemType, name: name.trim(), unitPriceCents });
        selectedCatalogId = created.id;
        setCatalog((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      const updated = await api.addChargeItem(sessionId, selectedCatalogId
        ? { catalogItemId: selectedCatalogId, quantity }
        : { itemType, name: name.trim(), unitPriceCents, quantity });
      setSheet(updated);
      setCatalogItemId("");
      setName("");
      setPrice("");
      setQuantity(1);
      setSaveToCatalog(false);
      notify(`Added a charge to ${petName}’s stay.`);
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Charge couldn’t be added"));
    } finally {
      setWorking(false);
    }
  };

  const changeQuantity = async (item: ChargeSheet["items"][number], nextQuantity: number) => {
    if (nextQuantity < 1 || nextQuantity > 999 || working) return;
    setWorking(true);
    try {
      setSheet(await api.updateChargeItem(sessionId, item.id, { quantity: nextQuantity, notes: item.notes }));
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Quantity couldn’t be updated"));
    } finally {
      setWorking(false);
    }
  };

  const removeItem = async (item: ChargeSheet["items"][number]) => {
    const confirmed = await requestConfirmation({ eyebrow: "Charge sheet", title: `Remove ${item.name}?`, message: "This removes the line from this stay only. It does not remove the service or product from your catalog.", confirmLabel: "Remove item", tone: "danger" });
    if (!confirmed) return;
    setWorking(true);
    try {
      setSheet(await api.deleteChargeItem(sessionId, item.id));
      notify(`${item.name} was removed from ${petName}’s charge sheet.`);
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Charge couldn’t be removed"));
    } finally {
      setWorking(false);
    }
  };

  const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: sheet?.currency || "USD" }).format(cents / 100);

  const itemCount = sheet?.items.length ?? 0;

  return <section className={`section-card charge-sheet-card ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <button
      type="button"
      className="charge-sheet-toggle"
      aria-expanded={expanded}
      aria-controls={`charge-sheet-${sessionId}`}
      onClick={() => setExpanded((current) => !current)}
    >
      <div className="charge-sheet-toggle-copy"><span className="eyebrow">Front desk · phase 1</span><h2>Stay charge sheet</h2><p className="section-helper">Track services and products used during this stay. No card will be charged yet.</p></div>
      <div className="charge-sheet-toggle-summary">
        <span className="status-pill attention">Payments not connected</span>
        <span className="charge-sheet-compact-total"><small>{loading ? "Loading…" : `${itemCount} ${itemCount === 1 ? "item" : "items"}`}</small><strong>{money(sheet?.total_cents ?? 0)}</strong></span>
        <span className="charge-sheet-chevron" aria-hidden="true">⌄</span>
      </div>
    </button>
    {expanded && <div id={`charge-sheet-${sessionId}`} className="charge-sheet-content">
    {loading ? <Empty title="Loading charge sheet…" detail="Getting this stay’s services and products." /> : <div className="charge-sheet-layout">
      <form className="charge-entry-form" onSubmit={addItem}>
        <label><span>Service or product</span><select value={catalogItemId} onChange={(event) => setCatalogItemId(event.target.value)}><option value="">Custom item</option>{catalog.map((item) => <option key={item.id} value={item.id}>{item.name} · {money(item.unit_price_cents)}</option>)}</select></label>
        {!catalogItemId && <div className="charge-custom-fields"><label><span>Type</span><select value={itemType} onChange={(event) => setItemType(event.target.value as "service" | "product")}><option value="service">Service</option><option value="product">Product</option></select></label><label><span>Item name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Daycare, bath, treats…" /></label><label><span>Price</span><input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} placeholder="0.00" /></label></div>}
        <label className="charge-quantity"><span>Quantity</span><input type="number" min="1" max="999" value={quantity} onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))} /></label>
        {!catalogItemId && <label className="charge-save-catalog"><input type="checkbox" checked={saveToCatalog} onChange={(event) => setSaveToCatalog(event.target.checked)} /><span><b>Save for future stays</b><small>Add this item to the shop catalog.</small></span></label>}
        <button className="primary-button" disabled={working}>{working ? "Saving…" : "Add charge"}</button>
      </form>
      <div className="charge-lines">
        {!sheet?.items.length ? <Empty title="No charges yet" detail="Add a service or product when it is provided." /> : sheet.items.map((item) => <article key={item.id}><div><span>{item.item_type}</span><b>{item.name}</b><small>{money(item.unit_price_cents)} each</small></div><div className="charge-line-actions"><div><button type="button" disabled={working || item.quantity <= 1} onClick={() => void changeQuantity(item, item.quantity - 1)} aria-label={`Decrease ${item.name} quantity`}>−</button><b>{item.quantity}</b><button type="button" disabled={working} onClick={() => void changeQuantity(item, item.quantity + 1)} aria-label={`Increase ${item.name} quantity`}>+</button></div><strong>{money(item.line_total_cents)}</strong><button type="button" className="charge-remove" disabled={working} onClick={() => void removeItem(item)}>Remove</button></div></article>)}
        <footer><span>Stay total</span><strong>{money(sheet?.total_cents ?? 0)}</strong><small>Charge sheet only · checkout payment will be connected in a later phase.</small></footer>
      </div>
    </div>}
    </div>}
    {confirmationDialog}
  </section>;
}

function SessionWorkspace({ sessionId, notify, onChanged, onCheckOut, checkingOut }: { sessionId: string; notify: (value: string) => void; onChanged: () => void; onCheckOut: (id: string, petName: string) => Promise<void>; checkingOut: boolean }) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [data, setData] = useState<SessionWorkspaceData | null>(null);
  const [identity, setIdentity] = useState<IdentityMediaStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [working, setWorking] = useState(false);
  // Date-only report windows follow the manager's local calendar. Using the
  // UTC date here moved the report to tomorrow during evening hours in North
  // American time zones, which made today's published photos look ineligible.
  const [reportDate, setReportDate] = useState(currentDateValue());
  const [mediaWindow, setMediaWindow] = useState<ReportMediaWindow>("report_day");
  const [caption, setCaption] = useState("");
  const [reportTheme, setReportTheme] = useState<ReportTheme>("storybook");
  const [musicStyle, setMusicStyle] = useState<ReportMusicStyle>(DEFAULT_MUSIC_BY_THEME.storybook);
  const [visualStyle, setVisualStyle] = useState<ReportVisualStyle>("clean");
  const [includeQualityIdentityPhotos, setIncludeQualityIdentityPhotos] = useState(true);
  const [previewingMusicStyle, setPreviewingMusicStyle] = useState<AudibleReportMusicStyle | null>(null);
  const musicPreviewRef = useRef<MusicPreviewPlayback | null>(null);
  const [mainPhotoLinkId, setMainPhotoLinkId] = useState<string | null>(null);
  const [selectedVideoLinkId, setSelectedVideoLinkId] = useState<string | null>(null);
  const [mainImagePickerOpen, setMainImagePickerOpen] = useState(false);
  const [previewReport, setPreviewReport] = useState<ReportVideo | null>(null);
  const [previewStarted, setPreviewStarted] = useState(false);
  const [selectedPhotoLinks, setSelectedPhotoLinks] = useState<Set<string>>(new Set());
  const [carePresetId, setCarePresetId] = useState<CareLogPresetId | null>(null);
  const [careDetails, setCareDetails] = useState("");
  const [careDate, setCareDate] = useState(currentDateValue());
  const [careTime, setCareTime] = useState(currentTimeValue());
  const [savingCareLog, setSavingCareLog] = useState(false);
  const [identityEditorOpen, setIdentityEditorOpen] = useState(false);

  const stopMusicPreview = useCallback(() => {
    musicPreviewRef.current?.stop();
    musicPreviewRef.current = null;
    setPreviewingMusicStyle(null);
  }, []);

  const toggleMusicPreview = async (style: AudibleReportMusicStyle) => {
    if (previewingMusicStyle === style) {
      stopMusicPreview();
      return;
    }
    stopMusicPreview();
    try {
      let playback: MusicPreviewPlayback | null = null;
      playback = await startMusicPreview(style, () => {
        if (musicPreviewRef.current === playback) {
          musicPreviewRef.current = null;
          setPreviewingMusicStyle(null);
        }
      });
      musicPreviewRef.current = playback;
      setPreviewingMusicStyle(style);
    } catch (caught) {
      await requestConfirmation(friendlyErrorNotice(caught, "Music preview couldn’t start"));
    }
  };

  useEffect(() => () => musicPreviewRef.current?.stop(), []);

  useEffect(() => {
    if (!previewReport) return;
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [previewReport]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [workspace, identityMedia] = await Promise.all([api.workspace(sessionId), api.identityMedia(sessionId)]);
      setData(workspace);
      setIdentity(identityMedia);
      setSelectedPhotoLinks(new Set(workspace.photos.filter((photo) => photo.review_state === "candidate").map((photo) => photo.id)));
    }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t load this stay")); }
    finally { setBusy(false); }
  }, [sessionId, requestConfirmation]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!identity?.photos.some((photo) => ["uploaded", "queued", "processing"].includes(photo.processing_status))) return;
    const timer = window.setInterval(() => {
      void api.identityMedia(sessionId).then(setIdentity).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [identity, sessionId]);
  useEffect(() => {
    const eligiblePhotos = data?.photos.filter((photo) => photo.review_state === "published" && reportMediaInWindow(photo.capture_at ?? photo.uploaded_at, reportDate, mediaWindow, data.session.check_in_at ?? data.session.scheduled_check_in_at)) ?? [];
    const recommendedPhoto = bestQualityPhoto(eligiblePhotos);
    setMainPhotoLinkId((current) => eligiblePhotos.some((photo) => photo.id === current) ? current : recommendedPhoto?.id ?? null);
  }, [data, mediaWindow, reportDate]);
  useEffect(() => {
    const eligibleVideos = data?.videos.filter((video) => video.review_state === "published" && reportMediaInWindow(video.capture_at ?? video.uploaded_at, reportDate, mediaWindow, data.session.check_in_at ?? data.session.scheduled_check_in_at)) ?? [];
    setSelectedVideoLinkId((current) => eligibleVideos.some((video) => video.id === current) ? current : eligibleVideos[0]?.id ?? null);
  }, [data, mediaWindow, reportDate]);

  const publishPhotos = async () => {
    if (!data) return;
    const ids = data.photos.filter((photo) => (photo.review_state === "candidate" || photo.review_state === "pending") && selectedPhotoLinks.has(photo.id)).map((photo) => photo.id);
    const excludedCount = data.photos.filter((photo) => (photo.review_state === "candidate" || photo.review_state === "pending") && !selectedPhotoLinks.has(photo.id)).length;
    if (!await requestConfirmation({
      eyebrow: "Final photo selection",
      title: "Publish the selected photos?",
      message: `${ids.length} selected photo${ids.length === 1 ? "" : "s"} will become owner-visible. ${excludedCount} unselected photo${excludedCount === 1 ? "" : "s"} will be excluded.`,
      detail: "Published photos stay locked from ordinary review.",
      confirmLabel: "Save & publish",
      cancelLabel: "Review selection",
    })) return;
    setWorking(true);
    try {
      const result = await api.finalizePhotoSelection(sessionId, ids);
      notify(`${result.publishedCount} published · ${result.excludedCount} excluded.`);
      onChanged();
      await load();
    }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t publish this photo selection")); }
    finally { setWorking(false); }
  };

  const publishVideos = async () => {
    if (!data) return;
    const ids = data.videos.filter((video) => video.review_state === "candidate").map((video) => video.id);
    if (!ids.length) return;
    setWorking(true);
    try { await api.publishVideos(sessionId, ids); notify(`${ids.length} clips approved.`); await load(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t approve these video clips")); }
    finally { setWorking(false); }
  };

  const createVideo = async (event: FormEvent) => {
    event.preventDefault(); stopMusicPreview(); setWorking(true);
    try { await api.createReportVideo(sessionId, { reportDate, mediaWindow, closingCaption: caption || undefined, targetSeconds: 15, template: reportTheme, musicStyle, visualStyle, mainPhotoLinkId: mainPhotoLinkId ?? undefined, photoLinkIds: previewPhotos.slice(0, 6).map((photo) => photo.id), videoLinkIds: selectedVideoLinkId ? [selectedVideoLinkId] : [], includeQualityIdentityPhotos }); notify(`${REPORT_THEMES.find((theme) => theme.id === reportTheme)?.name} report queued from ${REPORT_MEDIA_WINDOWS.find((window) => window.id === mediaWindow)?.name.toLowerCase()} media with ${REPORT_MUSIC_TRACKS.find((track) => track.id === musicStyle)?.name.toLowerCase()} and ${REPORT_VISUAL_STYLES.find((style) => style.id === visualStyle)?.name.toLowerCase()} styling${includeQualityIdentityPhotos ? ", including the best eligible check-in photos" : ""}${selectedVideoLinkId ? " plus the selected video clip" : ""}.`); setCaption(""); await load(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t create this report")); }
    finally { setWorking(false); }
  };

  const transition = async (report: ReportVideo) => {
    if (report.status === "approved" && !await requestConfirmation({
      eyebrow: "Owner report",
      title: "Publish this report?",
      message: "The report will become available through its private family link.",
      detail: "Email delivery is a separate step, so publishing will not send a message yet.",
      confirmLabel: "Publish report",
      cancelLabel: "Keep private",
    })) return;
    setWorking(true);
    try {
      if (report.status === "ready") { await api.approveReportVideo(report.id); notify("Video draft approved."); }
      else if (report.status === "approved") { await api.publishReportVideo(report.id); notify("Video published to the report."); }
      setPreviewReport(null);
      setPreviewStarted(false);
      await load();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, report.status === "ready" ? "We couldn’t approve this report" : "We couldn’t publish this report")); }
    finally { setWorking(false); }
  };

  const deleteReport = async (report: ReportVideo) => {
    if (report.status !== "ready" && report.status !== "failed" && report.status !== "approved") return;
    const approvalWarning = report.status === "approved"
      ? "This draft has already passed manager approval, but it is still private and has not been published."
      : "This draft has not been published.";
    if (!await requestConfirmation({
      eyebrow: "Private report",
      title: `Delete “${report.title}”?`,
      message: approvalWarning,
      detail: "The generated video and draft will be permanently removed. Published reports cannot be deleted here.",
      confirmLabel: "Delete draft",
      cancelLabel: "Keep report",
      tone: "danger",
    })) return;
    setWorking(true);
    try {
      await api.deleteReportVideo(report.id);
      if (previewReport?.id === report.id) {
        setPreviewReport(null);
        setPreviewStarted(false);
      }
      notify("Private report draft deleted.");
      await load();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t delete this report")); }
    finally { setWorking(false); }
  };

  const emailReport = async (report: ReportVideo) => {
    if (!data) return;
    const recipient = report.emailRecipientOverride || data.session.owner_email || "the owner's saved household email";
    const deliveryLabel = report.emailRecipientOverride ? "test inbox" : "owner";
    if (!await requestConfirmation({
      eyebrow: "Email report",
      title: "Send this private report link?",
      message: `${report.title} will be emailed to ${recipient} (${deliveryLabel}).`,
      detail: "Anyone with the private link can view and share the published report.",
      confirmLabel: "Send email",
      cancelLabel: "Not now",
    })) return;
    setWorking(true);
    try {
      const result = await api.emailReportShare(report.id);
      notify(`Report link emailed to ${result.recipients.join(", ")}.`);
      await load();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t send this email")); }
    finally { setWorking(false); }
  };

  const copyReportLink = async (report: ReportVideo) => {
    if (!report.shareUrl) return;
    try {
      await navigator.clipboard.writeText(report.shareUrl);
      notify("Private report link copied. You can share it with the family.");
    } catch {
      await requestConfirmation({
        eyebrow: "Private report link",
        title: "Copying isn’t available in this browser",
        message: report.shareUrl,
        detail: "Select and copy the link above to share it with the family.",
        confirmLabel: "Got it",
        hideCancel: true,
      });
    }
  };

  const recordCareUpdate = async (event: FormEvent) => {
    event.preventDefault();
    const preset = CARE_LOG_PRESETS.find((item) => item.id === carePresetId);
    if (!preset && !careDetails.trim()) return;
    setSavingCareLog(true);
    try {
      await api.createCareLog(sessionId, {
        entryType: preset?.entryType ?? "note",
        entryAt: isoForLocalDateTime(careDate, careTime),
        title: preset?.label ?? "Manager note",
        body: careDetails.trim() || preset?.defaultBody,
        structuredData: preset ? { presetId: preset.id, status: "completed", source: "admin_portal" } : { source: "admin_portal" },
      });
      setCarePresetId(null);
      setCareDetails("");
      setCareDate(currentDateValue());
      setCareTime(currentTimeValue());
      notify(`${preset?.label ?? "Note"} added to the pet diary.`);
      onChanged();
      await load();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t save this care update")); }
    finally { setSavingCareLog(false); }
  };

  if (busy && !data) return <Loading label="Preparing the report workspace" />;
  if (!data) return null;
  const candidatePhotos = data.photos.filter((photo) => photo.review_state === "candidate");
  const reviewablePhotos = data.photos.filter((photo) => photo.review_state === "candidate" || photo.review_state === "pending");
  const publishedPhotos = data.photos.filter((photo) => photo.review_state === "published");
  const sessionStart = data.session.check_in_at ?? data.session.scheduled_check_in_at;
  const reportWindowPhotos = publishedPhotos.filter((photo) => reportMediaInWindow(photo.capture_at ?? photo.uploaded_at, reportDate, mediaWindow, sessionStart));
  const latestPublishedPhotoDate = publishedPhotos.reduce<string>((latest, photo) => {
    const photoDate = localDateKey(photo.capture_at ?? photo.uploaded_at);
    return photoDate > latest ? photoDate : latest;
  }, "");
  const eligibleIdentityPhotos = identity?.photos.filter((photo) => {
    const existingReportCopy = data.photos.find((reportPhoto) => reportPhoto.source_identity_photo_id === photo.id);
    return photo.processing_status === "processed"
      && photo.detected_pet_count === 1
      && Number(photo.best_quality_score ?? 0) >= 0.78
      && existingReportCopy?.review_state !== "rejected"
      && existingReportCopy?.review_state !== "published"
      && reportMediaInWindow(photo.capture_at ?? photo.uploaded_at, reportDate, mediaWindow, sessionStart);
  }) ?? [];
  const possibleReportPhotoCount = reportWindowPhotos.length + (includeQualityIdentityPhotos ? Math.min(2, eligibleIdentityPhotos.length) : 0);
  const aiRankedPhotos = reportWindowPhotos.slice().sort((left, right) => {
    const scoreDifference = heroSuitabilityScore(right) - heroSuitabilityScore(left);
    return scoreDifference || Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0);
  });
  const previewPhotos = [
    ...aiRankedPhotos.filter((photo) => photo.id === mainPhotoLinkId),
    ...aiRankedPhotos.filter((photo) => photo.id !== mainPhotoLinkId),
  ];
  const aiRecommendedPhoto = aiRankedPhotos[0];
  const selectedMainPhoto = reportWindowPhotos.find((photo) => photo.id === mainPhotoLinkId) ?? reportWindowPhotos[0];
  const mainImageChoices = [
    ...aiRankedPhotos.filter((photo) => photo.id === aiRecommendedPhoto?.id),
    ...aiRankedPhotos.filter((photo) => photo.id !== aiRecommendedPhoto?.id),
  ];
  const useAiMainImage = () => {
    const recommended = bestQualityPhoto(reportWindowPhotos);
    if (!recommended) return;
    setMainPhotoLinkId(recommended.id);
    setMainImagePickerOpen(false);
    notify(`AI re-ranked ${reportWindowPhotos.length} approved photo${reportWindowPhotos.length === 1 ? "" : "s"} in this report window and selected the best report set.`);
  };
  const candidateVideos = data.videos.filter((video) => video.review_state === "candidate");
  const publishedVideos = data.videos.filter((video) => video.review_state === "published");
  const skippedIdentityPhotos = identity?.photos.filter((photo) => photo.processing_status === "processed" && photo.enrolled_embedding_count === 0) ?? [];
  const selectedCandidateCount = reviewablePhotos.filter((photo) => selectedPhotoLinks.has(photo.id)).length;
  const togglePhoto = (photo: PhotoLink) => {
    if (photo.review_state !== "candidate" && photo.review_state !== "pending") return;
    setSelectedPhotoLinks((current) => {
      const next = new Set(current);
      next.has(photo.id) ? next.delete(photo.id) : next.add(photo.id);
      return next;
    });
  };
  const removeIdentityPhoto = async (photoId: string) => {
    if (!await requestConfirmation({
      eyebrow: "AI identity reference",
      title: "Remove this reference photo?",
      message: "This image will no longer help AI recognize the pet in new uploads.",
      detail: "Existing published report photos and videos will not be affected.",
      confirmLabel: "Remove reference",
      cancelLabel: "Keep reference",
      tone: "danger",
    })) return;
    setWorking(true);
    try { const result = await api.removeIdentityPhoto(photoId); notify(`Reference removed. ${result.deactivatedEmbeddingCount} AI embedding${result.deactivatedEmbeddingCount === 1 ? "" : "s"} deactivated.`); await load(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t remove this reference photo")); }
    finally { setWorking(false); }
  };
  const useIdentityPhotoInReport = async (photoId: string) => {
    setWorking(true);
    try {
      await api.promoteIdentityPhoto(photoId);
      notify("Photo added to report candidates. Save the final photo selection, then choose it as the main image.");
      await load();
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t add this photo to the report")); }
    finally { setWorking(false); }
  };
  const recheckSkippedIdentityPhotos = async () => {
    if (!skippedIdentityPhotos.length) return;
    setWorking(true);
    try {
      for (const photo of skippedIdentityPhotos) await api.reprocessPhoto(photo.id);
      setIdentity(await api.identityMedia(sessionId));
      notify(`${skippedIdentityPhotos.length} skipped reference${skippedIdentityPhotos.length === 1 ? " was" : "s were"} queued for a fresh AI check.`);
    } catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t re-check these references")); }
    finally { setWorking(false); }
  };
  const deleteUploadedPhoto = async (photo: PhotoLink) => {
    if (!photo.photo_id) return;
    const ownerVisible = photo.review_state === "published";
    if (!await requestConfirmation(photoDeleteConfirmation(ownerVisible))) return;
    setWorking(true);
    try { await api.deletePhoto(photo.photo_id); notify("Uploaded photo deleted."); onChanged(); await load(); }
    catch (caught) { await requestConfirmation(friendlyErrorNotice(caught, "We couldn’t delete this photo")); }
    finally { setWorking(false); }
  };
  const selectedTheme = REPORT_THEMES.find((theme) => theme.id === reportTheme) ?? REPORT_THEMES[0];
  const layoutPreviewReport: ReportVideo = {
    id: "layout-preview",
    report_date: reportDate,
    media_window: mediaWindow,
    template: reportTheme,
    music_style: musicStyle,
    visual_style: visualStyle,
    title: `${data.session.pet_name}’s happy day`,
    story_text: null,
    closing_caption: caption.trim() || null,
    target_seconds: 15,
    actual_seconds: null,
    status: "queued",
    render_error: null,
    main_photo_id: previewPhotos[0]?.photo_id ?? null,
    previewUrl: null,
    created_at: reportDate,
    approved_at: null,
    published_at: null,
    shareUrl: null,
    share_created_at: null,
    last_emailed_at: null,
    emailRecipientOverride: null,
    emailDeliveryConfigured: false,
  };

  return <div className="page-stack">
    <section className="session-hero"><PetAvatar name={data.session.pet_name} src={data.session.photo_thumbnail_url} size="xlarge" /><div><span className="eyebrow">{title(data.session.session_type)} stay</span><h1>{data.session.pet_name}’s report desk</h1><p>{data.session.breed || title(data.session.species)}{data.session.owner_name ? ` · ${data.session.owner_name}` : ""} · Checked in {formatDate(sessionStart)}</p></div><div className="session-hero-actions"><span className="status-pill ready">Checked in</span><button className="checkout-button prominent" disabled={checkingOut} onClick={() => void onCheckOut(data.session.id, data.session.pet_name)}>{checkingOut ? "Checking out…" : "Check out pet"}</button></div></section>
    <section className="section-card stay-detail-card"><div className="section-heading"><div><span className="eyebrow">Stay record</span><h2>Stay details</h2><p className="section-helper">Operational information recorded at check-in.</p></div><span className="status-pill ready">Currently on site</span></div><div className="stay-detail-grid"><article><span>Stay type</span><b>{title(data.session.session_type)}</b><small>{data.session.breed || title(data.session.species)}</small></article><article><span>Checked in</span><b>{formatDate(sessionStart)}</b><small>{data.session.checked_in_by_name ? `By ${data.session.checked_in_by_name}` : "Check-in staff not recorded"}</small></article><article><span>Expected checkout</span><b>{data.session.expected_check_out_at ? formatDate(data.session.expected_check_out_at) : "Not scheduled"}</b><small>{data.session.expected_check_out_at ? "Planned departure" : "Add a departure time at check-in"}</small></article><article><span>Owner</span><b>{data.session.owner_name || "Not linked"}</b><small>{[data.session.owner_phone, data.session.owner_email].filter(Boolean).join(" · ") || "No contact information"}</small></article><article><span>Stay collar</span><b className="collar-detail">{data.session.collar_enabled && data.session.collar_color_hex && <i style={{ background: data.session.collar_color_hex }} />}{data.session.collar_enabled ? data.session.collar_label || data.session.collar_color_name || "Enabled" : "Not assigned"}</b><small>{data.session.collar_enabled && data.session.collar_color_name ? data.session.collar_color_name : "No active collar assignment"}</small></article><article className="stay-notes"><span>Arrival notes</span><b>{data.session.notes || "No arrival notes were added."}</b></article></div></section>
    <ChargeSheetCard sessionId={data.session.id} petName={data.session.pet_name} notify={notify} />
    <section className="section-card identity-reference-summary">
      <div className="section-heading"><div><span className="eyebrow">AI identity references · not report media</span><h2>Current appearance</h2></div><div className="identity-heading-actions"><span className="count-bubble">{identity?.photos.reduce((sum, photo) => sum + photo.enrolled_embedding_count, 0) ?? 0} AI ready</span>{skippedIdentityPhotos.length > 0 && <button type="button" className="outline-button compact" disabled={working} onClick={() => void recheckSkippedIdentityPhotos()}>↻ Re-check {skippedIdentityPhotos.length} skipped</button>}<button type="button" className="outline-button compact" aria-expanded={identityEditorOpen} onClick={() => setIdentityEditorOpen((open) => !open)}>{identityEditorOpen ? "Close uploader" : "+ Add check-in photos"}</button></div></div>
      {!identity || identity.photos.length === 0
        ? <Empty title="No identity references yet" detail="Use Add check-in photos to upload current views or a short video and improve pet suggestions." />
        : <><div className="identity-photo-grid workspace-references">{identity.photos.map((photo) => <IdentityReferencePhoto key={photo.id} photo={photo} onUseInReport={() => void useIdentityPhotoInReport(photo.id)} onRemove={() => void removeIdentityPhoto(photo.id)} disabled={working} />)}</div>{identity.videos.length > 0 && <div className="identity-video-list">{identity.videos.map((video) => <span key={video.id}><b>Reference video</b> · {title(video.processing_status)}{video.extracted_frame_count ? ` · ${video.extracted_frame_count} frames extracted` : ""}</span>)}</div>}</>}
      {identityEditorOpen && <div className="late-identity-enrollment"><IdentityEnrollment session={{ id: data.session.id, pet_id: data.session.pet_id, pet_name: data.session.pet_name }} doneLabel="Done adding references" onDone={() => { setIdentityEditorOpen(false); notify(`${data.session.pet_name}’s check-in references were updated.`); void load(); }} /></div>}
    </section>
    <PetReportMediaUploader session={{ id: data.session.id, pet_id: data.session.pet_id, pet_name: data.session.pet_name }} notify={notify} onUploaded={async () => { onChanged(); await load(); }} />
    <section className="approval-flow" aria-label="Photo approval process"><article className="done"><b>1</b><span><strong>Confirm identity</strong><small>AI suggestions are checked by staff or a manager.</small></span></article><i>→</i><article className={candidatePhotos.length ? "active" : "done"}><b>2</b><span><strong>Select report media</strong><small>Choose the candidate photos that tell this pet’s story.</small></span></article><i>→</i><article className={publishedPhotos.length ? "done" : ""}><b>3</b><span><strong>Approve & publish</strong><small>Only this step makes photos owner-visible.</small></span></article></section>
    <div className="workspace-grid">
      <section className="section-card media-workspace"><div className="section-heading"><div><span className="eyebrow">Step 2 · report media selection</span><h2>Photos</h2><p className="section-helper">Select the photos to publish. When you save, every unselected Pending or Candidate photo is excluded.</p></div>{reviewablePhotos.length > 0 && <button className="primary-button compact" disabled={working} onClick={publishPhotos}>Save final selection · {selectedCandidateCount}</button>}</div>
        {data.photos.length === 0 ? <Empty title="No assigned photos" detail="Review staff uploads and assign this pet first." /> : <div className="workspace-photo-grid">{data.photos.map((photo) => { const selectable = photo.review_state === "candidate" || photo.review_state === "pending"; const selected = selectedPhotoLinks.has(photo.id); return <div className="workspace-photo-item" key={photo.id}><button type="button" onClick={() => togglePhoto(photo)} disabled={!selectable} aria-pressed={selectable ? selected : undefined} className={`workspace-photo ${photo.review_state} ${selectable ? "selectable" : ""} ${selected ? "selected" : ""}`}><img src={photo.viewUrl} alt={data.session.pet_name} /><span>{selectable ? (selected ? "Selected ✓" : `Excluded · ${title(photo.review_state)}`) : title(photo.review_state)}</span>{photo.review_state === "published" && <i>Owner visible</i>}</button><button type="button" className="delete-photo-button" disabled={working} onClick={() => void deleteUploadedPhoto(photo)} aria-label={`Delete uploaded photo for ${data.session.pet_name}`} title="Delete uploaded photo">×</button></div>; })}</div>}
      </section>
      <section className="section-card diary-card"><div className="section-heading"><div><span className="eyebrow">Pet diary</span><h2>Care timeline</h2></div><span className="count-bubble">{data.logs.length}</span></div>
        <form className="care-log-composer" onSubmit={recordCareUpdate}><div><b>Quick care update</b><small>Choose a standard activity; details are optional.</small></div><div className="care-preset-grid">{CARE_LOG_PRESETS.map((preset) => <button type="button" key={preset.id} className={carePresetId === preset.id ? "selected" : ""} onClick={() => setCarePresetId((current) => current === preset.id ? null : preset.id)}><span>{preset.icon}</span>{preset.label}</button>)}</div><textarea value={careDetails} maxLength={300} onChange={(event) => setCareDetails(event.target.value)} placeholder="Optional details, amount eaten, mood, or anything the family should know…" /><div className="care-datetime-fields"><label><span><b>Date</b><small>Choose the day this happened.</small></span><input type="date" required min={localDateKey(sessionStart)} max={currentDateValue()} value={careDate} onChange={(event) => setCareDate(event.target.value)} /></label><label><span><b>Time</b><small>Choose when it happened.</small></span><input type="time" required value={careTime} onChange={(event) => setCareTime(event.target.value)} /></label></div><button className="primary-button full" disabled={savingCareLog || !isValidDate(careDate) || !isValidTime(careTime) || (!carePresetId && !careDetails.trim())}>{savingCareLog ? "Saving…" : "Add to timeline"}</button></form>
        {data.logs.length === 0 ? <Empty title="No care updates yet" detail="Standard activities and staff notes will appear here." /> : <div className="timeline">{data.logs.map((log) => <article key={log.id}><time><span>{new Date(log.entry_at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>{new Date(log.entry_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><i /><div><small>{title(log.entry_type)}</small><b>{log.title || "Care update"}</b>{log.body && <p>{log.body}</p>}{log.created_by_name && <em>Recorded by {log.created_by_name}</em>}</div></article>)}</div>}
      </section>
      <section className="section-card clip-card"><div className="section-heading"><div><span className="eyebrow">Source clips</span><h2>Video</h2><p className="section-helper">Approve a clip, then choose the one to mix into the 15-second report.</p></div>{candidateVideos.length > 0 && <button className="outline-button compact" disabled={working} onClick={publishVideos}>Approve {candidateVideos.length}</button>}</div>
        {data.videos.length === 0 ? <Empty title="No clips uploaded" detail="Use Upload photos → Short report video to add one, or create a photo-only highlight." /> : <><div className="video-strip">{data.videos.map((video) => { const canChoose = video.review_state === "published"; const chosen = selectedVideoLinkId === video.id; return <article key={video.id} className={chosen ? "selected" : ""}><video src={video.viewUrl} controls preload="metadata" /><span>{title(video.review_state)} · {video.duration_seconds ? `${Math.round(Number(video.duration_seconds))}s` : "clip"}</span>{canChoose && <button type="button" aria-pressed={chosen} onClick={() => setSelectedVideoLinkId(chosen ? null : video.id)}>{chosen ? "✓ Included in report" : "Use in report"}</button>}</article>; })}</div>{publishedVideos.length > 0 && <button type="button" className="clip-photos-only" disabled={!selectedVideoLinkId} onClick={() => setSelectedVideoLinkId(null)}>Use photos only</button>}</>}
      </section>
    </div>
    <div className="report-planning-grid">
      <section className="section-card report-builder"><div className="section-heading"><div><span className="eyebrow">Automated highlight</span><h2>Create a 15-second story</h2><p className="section-helper">Choose how much of the stay to include. AI ranks approved photos and eligible check-in photos inside that window.</p></div><span className="media-count">{reportWindowPhotos.length} approved · {eligibleIdentityPhotos.length} check-in eligible</span></div>
        <form onSubmit={createVideo}>
          <label>Report date<input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} /></label>
          <fieldset className="report-window-picker"><legend>Photos and timeline to include</legend><small>The report date stays the same; this controls how far back AI looks for approved media and care moments.</small><div>{REPORT_MEDIA_WINDOWS.map((window) => <button type="button" key={window.id} aria-pressed={mediaWindow === window.id} className={mediaWindow === window.id ? "selected" : ""} onClick={() => setMediaWindow(window.id)}><b>{window.name}</b><small>{window.description}</small></button>)}</div></fieldset>
          <label className="checkin-report-option"><input type="checkbox" checked={includeQualityIdentityPhotos} onChange={(event) => setIncludeQualityIdentityPhotos(event.target.checked)} /><span><b>Include the best check-in photos</b><small>AI can add up to 2 clear, single-pet check-in frames to this private draft. You will still preview and approve the report before the family can see it.</small></span></label>
          <fieldset className="theme-picker"><legend>Report theme</legend>{REPORT_THEMES.map((theme) => <button type="button" key={theme.id} aria-pressed={reportTheme === theme.id} className={reportTheme === theme.id ? `selected ${theme.id}` : theme.id} onClick={() => { stopMusicPreview(); setReportTheme(theme.id); setMusicStyle(DEFAULT_MUSIC_BY_THEME[theme.id]); }}><b>{theme.name}</b><small>{theme.description}</small></button>)}</fieldset>
          <fieldset className="visual-style-picker"><legend>Pet styling <span>Experimental</span></legend><small>Try a playful treatment or keep the photos clean. This changes the report and video title cards.</small><div>{REPORT_VISUAL_STYLES.map((style) => <button type="button" key={style.id} aria-pressed={visualStyle === style.id} className={visualStyle === style.id ? "selected" : ""} onClick={() => setVisualStyle(style.id)}><i>{style.icon}</i><b>{style.name}</b><small>{style.description}</small></button>)}</div></fieldset>
          <fieldset className="music-picker"><legend>Background music</legend><small>Listen before choosing. These previews use the same original UCBarkley notes as the rendered video.</small><div>{REPORT_MUSIC_TRACKS.map((track) => {
            const isSelected = musicStyle === track.id;
            const isPlaying = track.id !== "none" && previewingMusicStyle === track.id;
            return <div key={track.id} className={`music-option ${isSelected ? "selected" : ""} ${isPlaying ? "playing" : ""}`}>
              <button type="button" className="music-select-button" aria-pressed={isSelected} onClick={() => { stopMusicPreview(); setMusicStyle(track.id); }}><span>{track.id === "none" ? "∅" : "♪"}</span><b>{track.name}</b><small>{track.description}{DEFAULT_MUSIC_BY_THEME[reportTheme] === track.id ? " · Recommended" : ""}</small></button>
              {track.id === "none" ? <span className="music-silent-label">Silent</span> : <button type="button" className="music-preview-button" aria-pressed={isPlaying} aria-label={`${isPlaying ? "Stop" : "Listen to"} ${track.name}`} onClick={() => void toggleMusicPreview(track.id as AudibleReportMusicStyle)}>{isPlaying ? "■ Stop" : "▶ Listen"}</button>}
            </div>;
          })}</div></fieldset>
          <fieldset className="main-image-picker"><legend>Main image</legend><small>AI starts with the highest-quality approved photo and centers the detected pet. You can override it or run the selection again.</small>{selectedMainPhoto ? <div className="main-image-summary"><img src={selectedMainPhoto.viewUrl} style={{ objectPosition: photoFocalPoint(selectedMainPhoto) }} alt={`${data.session.pet_name}’s selected main report image`} /><span><b>{selectedMainPhoto.id === aiRecommendedPhoto?.id ? "✦ AI recommended" : "★ Manager selection"}</b><small>{selectedMainPhoto.id === aiRecommendedPhoto?.id ? "Highest-quality approved photo" : "Your choice overrides the AI recommendation"}</small></span><div className="main-image-actions"><button type="button" onClick={useAiMainImage}>↻ Re-run AI selection</button><button type="button" onClick={() => setMainImagePickerOpen(true)}>Choose image</button></div></div> : publishedPhotos.length > 0 ? <div className="main-image-window-empty"><p>{publishedPhotos.length} approved photo{publishedPhotos.length === 1 ? " is" : "s are"} available, but {publishedPhotos.length === 1 ? "it is" : "they are"} outside the selected {REPORT_MEDIA_WINDOWS.find((window) => window.id === mediaWindow)?.name.toLowerCase()} window for {reportDate}.</p>{latestPublishedPhotoDate && <button type="button" onClick={() => setReportDate(latestPublishedPhotoDate)}>Use latest photo date · {latestPublishedPhotoDate}</button>}</div> : <p>No approved photos are available yet.</p>}</fieldset>
          <div className="theme-selection-preview" aria-live="polite"><header><div><span>Selected layout</span><b>{selectedTheme.name}</b></div><small>{REPORT_MEDIA_WINDOWS.find((window) => window.id === mediaWindow)?.name} · {REPORT_VISUAL_STYLES.find((style) => style.id === visualStyle)?.name} · {REPORT_MUSIC_TRACKS.find((track) => track.id === musicStyle)?.name} · Preview only</small></header><div className="theme-preview-viewport"><ThemedReportPreview key={`${reportTheme}-${visualStyle}-${reportDate}-${mediaWindow}-${mainPhotoLinkId ?? "no-photo"}`} report={layoutPreviewReport} petName={data.session.pet_name} facilityName="UCBarkley" photos={previewPhotos} logs={data.logs} onVideoPlay={() => undefined} showVideoPlaceholder /></div></div>
          <label>Closing message<textarea value={caption} maxLength={180} onChange={(event) => setCaption(event.target.value)} placeholder={`A little note for ${data.session.pet_name}’s family…`} /></label>
          <button className="primary-button full" disabled={working || possibleReportPhotoCount < 3}>{working ? "Working…" : "Generate themed report ✦"}</button>{possibleReportPhotoCount < 3 && <small>Choose at least 3 photos in this report window. {Math.max(0, 3 - possibleReportPhotoCount)} more approved or eligible check-in photo{Math.max(0, 3 - possibleReportPhotoCount) === 1 ? " is" : "s are"} needed.</small>}
        </form>
      </section>
      <section className="section-card report-history-card"><div className="section-heading"><div><span className="eyebrow">This stay</span><h2>Report history</h2><p className="section-helper">Review earlier reports before creating or publishing the next one.</p></div><div className="report-history-heading-actions"><span className="count-bubble">{data.reports.filter((report) => report.status === "published").length} owner visible</span><button className="icon-button" aria-label="Refresh report history" title="Refresh report history" onClick={() => void load()}>↻</button></div></div>
        <div className="history-key"><span><i className="published" />Owner visible</span><span><i className="private" />Private</span></div>
        {data.reports.length === 0 ? <Empty title="No previous reports" detail="The first report created for this stay will appear here." /> : <div className="report-history-list">{data.reports.map((report) => {
          const hero = reportHeroPhoto(report, reportPhotosForPreview(report, data.photos));
          const isPublished = report.status === "published";
          const milestone = isPublished
            ? `Published ${formatDate(report.published_at ?? report.created_at)}`
            : report.status === "approved"
              ? `Approved ${formatDate(report.approved_at ?? report.created_at)} · still private`
              : `${title(report.status)} · Created ${formatDate(report.created_at)}`;
          return <article className={isPublished ? "published" : "private"} key={report.id}>
            {report.previewUrl ? <button type="button" className="history-preview-thumb" aria-label={`Preview ${report.title}`} onClick={() => { setPreviewReport(report); setPreviewStarted(false); }}>{hero ? <img src={hero.viewUrl} alt="" /> : <span>▶</span>}<i>▶</i></button> : <div className="history-render-placeholder"><span>{report.status === "failed" ? "!" : "✦"}</span></div>}
            <div className="report-history-copy"><div className="history-status-row"><span className={`status-pill report-${report.status}`}>{isPublished ? "Owner visible" : title(report.status)}</span><time>{reportDateKey(report.report_date)}</time></div><h3>{report.title}</h3><p>{REPORT_THEMES.find((theme) => theme.id === report.template)?.name ?? title(report.template)} · {REPORT_MEDIA_WINDOWS.find((window) => window.id === (report.media_window || "report_day"))?.name} · {REPORT_VISUAL_STYLES.find((style) => style.id === report.visual_style)?.name ?? "Clean"} · {REPORT_MUSIC_TRACKS.find((track) => track.id === report.music_style)?.name ?? "Warm Story"} · {milestone}</p>{report.status === "approved" && <small className="history-next-step">Publish this private report to enable its email link.</small>}{report.emailRecipientOverride && <small className="history-test-delivery">Test delivery only · {report.emailRecipientOverride}</small>}{isPublished && !report.emailDeliveryConfigured && <small className="history-next-step">Email provider setup required before sending.</small>}{report.last_emailed_at && <small className="history-delivery">Emailed {formatDate(report.last_emailed_at)}</small>}{report.render_error && <div className="form-error">{report.render_error}</div>}<div className="history-actions">{report.previewUrl && <button type="button" className="history-view-button" disabled={working} onClick={() => { setPreviewReport(report); setPreviewStarted(false); }}>{report.status === "ready" ? "Preview before approval" : report.status === "approved" ? "Preview & publish" : "View report"} →</button>}{(report.status === "ready" || report.status === "failed" || report.status === "approved") && <button type="button" className="history-view-button delete-report-button" disabled={working} onClick={() => void deleteReport(report)}>Delete draft</button>}{isPublished && <button type="button" className="history-view-button" disabled={working || !report.emailDeliveryConfigured} title={report.emailDeliveryConfigured ? undefined : "Configure RESEND_API_KEY to enable email delivery"} onClick={() => void emailReport(report)}>✉ {report.emailRecipientOverride ? "Email test link" : "Email owner link"}</button>}{isPublished && report.shareUrl && <button type="button" className="history-view-button" disabled={working} onClick={() => void copyReportLink(report)}>Copy link</button>}</div></div>
          </article>;
        })}</div>}
        <p className="history-footnote">“Owner visible” means the report was published to the owner portal. Email delivery is tracked separately.</p>
      </section>
    </div>
    {mainImagePickerOpen && <div className="modal-backdrop main-image-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMainImagePickerOpen(false)}><section className="main-image-dialog" role="dialog" aria-modal="true" aria-labelledby="main-image-dialog-title"><header><div><span className="eyebrow">Report hero</span><h2 id="main-image-dialog-title">Choose the main image</h2><p>AI recommends the strongest approved photo from the selected report window and centers the detected pet. Your selection always wins.</p></div><button type="button" className="close-button" onClick={() => setMainImagePickerOpen(false)}>×</button></header><div className="main-image-grid">{mainImageChoices.map((photo) => <button type="button" key={photo.id} aria-pressed={mainPhotoLinkId === photo.id} className={`${mainPhotoLinkId === photo.id ? "selected" : ""} ${aiRecommendedPhoto?.id === photo.id ? "ai-recommended" : ""}`} onClick={() => { setMainPhotoLinkId(photo.id); setMainImagePickerOpen(false); }}><img src={photo.viewUrl} style={{ objectPosition: photoFocalPoint(photo) }} alt={`Choose as ${data.session.pet_name}’s main report image`} />{aiRecommendedPhoto?.id === photo.id && <i>✦ AI recommended</i>}<span>{mainPhotoLinkId === photo.id ? "★ Current main image" : "Choose this image"}</span></button>)}</div><footer><span>{reportWindowPhotos.length} approved photo{reportWindowPhotos.length === 1 ? "" : "s"} in this window · Ranked by image quality and framing</span><button type="button" onClick={useAiMainImage}>↻ Use AI recommendation again</button></footer></section></div>}
    {previewReport && <div className="modal-backdrop report-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPreviewReport(null)}><section className="report-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="report-preview-title"><header><div><span className="eyebrow">Owner report preview</span><h2 id="report-preview-title">{previewReport.title}</h2></div><button className="close-button" onClick={() => setPreviewReport(null)}>×</button></header><div className="report-preview-body" tabIndex={0}><div className={`preview-privacy ${previewReport.status === "published" ? "published" : "private"}`}><b>{previewReport.status === "published" ? "Owner visible" : "Private preview"}</b><span>{previewReport.status === "published" ? "This report has already been published." : "The owner cannot see this draft yet."}</span></div><ThemedReportPreview report={previewReport} petName={data.session.pet_name} facilityName="UCBarkley" photos={reportPhotosForPreview(previewReport, data.photos)} logs={data.logs} onVideoPlay={() => setPreviewStarted(true)} />{previewReport.story_text && <div className="report-story-review"><div><span className="eyebrow">Grounded story</span><b>Built from confirmed report details</b></div><p>{previewReport.story_facts?.companionPets?.length ? `Named friends: ${previewReport.story_facts.companionPets.map((pet) => pet.name).join(", ")}. ` : ""}{previewReport.story_facts?.recordedMoments?.length ? `Care moments: ${previewReport.story_facts.recordedMoments.map(title).join(", ")}.` : "No activity was guessed from the images."}</p></div>}<div className="report-preview-meta"><span className={`status-pill report-${previewReport.status}`}>{title(previewReport.status)}</span><div><b>{REPORT_THEMES.find((theme) => theme.id === previewReport.template)?.name ?? title(previewReport.template)}</b><small>{reportDateKey(previewReport.report_date)} · {previewReport.target_seconds}-second highlight included</small></div></div></div><footer><div><b>Review checklist</b><small>Check the pets, photos, generated story, care details, closing message, and embedded video.</small>{(previewReport.status === "ready" || previewReport.status === "approved") && <button type="button" className="delete-report-button" disabled={working} onClick={() => void deleteReport(previewReport)}>Delete private draft</button>}</div>{(previewReport.status === "ready" || previewReport.status === "approved") && <div className="preview-action"><small>{previewStarted ? "Video preview started ✓" : "Play the video inside the report to enable the next step."}</small><button className="primary-button" disabled={working || !previewStarted} onClick={() => void transition(previewReport)}>{previewReport.status === "ready" ? "Approve private draft" : "Publish report"}</button></div>}</footer></section></div>}
    {confirmationDialog}
  </div>;
}

function ThemedReportPreview({ report, petName, facilityName, photos, logs, onVideoPlay, showVideoPlaceholder = false }: { report: ReportVideo; petName: string; facilityName: string; photos: PhotoLink[]; logs: DailyLog[]; onVideoPlay: () => void; showVideoPlaceholder?: boolean }) {
  const normalizedReportDate = reportDateKey(report.report_date);
  const mediaWindow = report.media_window || "report_day";
  const availablePhotos = photos.filter((photo) => reportMediaInWindow(photo.capture_at ?? photo.uploaded_at, normalizedReportDate, mediaWindow));
  const reportPhotos = [
    ...availablePhotos.filter((photo) => photo.photo_id === report.main_photo_id),
    ...availablePhotos.filter((photo) => photo.photo_id !== report.main_photo_id),
  ].slice(0, 4);
  const reportLogs = logs
    .filter((log) => reportMediaInWindow(log.entry_at, normalizedReportDate, mediaWindow))
    .slice()
    .reverse();
  const dateLabel = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${normalizedReportDate}T12:00:00`));
  const firstLog = reportLogs[0];
  const summary = report.story_text || firstLog?.body || report.closing_caption || `${petName} enjoyed a day full of care, play, and happy moments.`;
  const closing = report.closing_caption || `${petName} had a wonderful day and cannot wait to see you!`;
  const media = reportPhotos.map((photo, index) => <img key={photo.id} src={photo.viewUrl} style={{ objectPosition: photoFocalPoint(photo) }} alt={`${petName}'s report moment ${index + 1}`} />);
  const video = report.previewUrl
    ? <figure className="themed-video"><video src={report.previewUrl} poster={reportPhotos[0]?.viewUrl} controls playsInline preload="metadata" onPlay={onVideoPlay} /><figcaption>{mediaWindow === "report_day" ? "Today’s" : "Stay"} highlight · {report.target_seconds} sec</figcaption></figure>
    : showVideoPlaceholder
      ? <figure className="themed-video themed-video-placeholder"><span>▶</span><b>{report.target_seconds}-second highlight</b><small>Generated after you create the report</small></figure>
      : null;
  const fallbackMoments: DailyLog[] = [
    { id: "morning", entry_at: `${normalizedReportDate}T08:10:00`, title: "Good morning, sunshine", body: "Breakfast, water, and a cheerful start to the day.", entry_type: "feeding", structured_data: null, created_by_name: null },
    { id: "playtime", entry_at: `${normalizedReportDate}T11:35:00`, title: "Friends make playtime better", body: "A playful moment with friends and plenty of tail wags.", entry_type: "activity", structured_data: null, created_by_name: null },
    { id: "afternoon", entry_at: `${normalizedReportDate}T15:20:00`, title: "A calm afternoon", body: "A comfortable rest after enrichment and play.", entry_type: "note", structured_data: null, created_by_name: null },
  ];
  const moments = reportLogs.length > 0 ? reportLogs : fallbackMoments;
  const visualClass = `visual-${report.visual_style || "clean"}`;

  if (report.template === "care_card") return <article className={`themed-report care-card-report ${visualClass}`}>
    <header><div><span>Daily care report</span><h1>{petName}</h1><p>{dateLabel} · {facilityName}</p></div>{media[0]}</header>
    <section className="care-glance"><div><small>Meals</small><b>All eaten</b></div><div><small>Energy</small><b>Playful</b></div><div><small>Water</small><b>Normal</b></div><div><small>Rest</small><b>Comfortable</b></div></section>
    <section className="care-story"><div><small>Staff summary</small><h2>{summary}</h2></div><div>{moments.slice(0, 3).map((log) => <p key={log.id}><b>{formatTime(log.entry_at)} · {log.created_by_name || "UCBarkley team"}</b>{log.title}{log.body ? ` — ${log.body}` : ""}</p>)}</div></section>
    <section className="themed-media-row">{media.slice(1, 3)}{video}</section>
  </article>;

  if (report.template === "timeline_diary") return <article className={`themed-report timeline-report ${visualClass}`}>
    <header><div><span>A day in the life of</span><h1>{petName}</h1><p>{facilityName} · {dateLabel}</p></div>{media[0]}</header>
    <section><div className="timeline-report-heading"><h2>{mediaWindow === "report_day" ? "Today’s diary" : "Stay highlights"}</h2><span>{moments.length} moments saved</span></div><div className="report-timeline">{moments.map((log, index) => <article key={log.id}><time>{mediaWindow === "report_day" ? formatTime(log.entry_at) : formatTimelineMoment(log.entry_at)}</time><i /><div><h3>{log.title || title(log.entry_type)}</h3><p>{log.body || "A happy moment from the stay."}</p></div>{index === 1 && video ? video : media[index + 1]}</article>)}</div></section>
    <blockquote><b>Staff note:</b> {closing}</blockquote>
  </article>;

  if (report.template === "photo_journal") return <article className={`themed-report journal-report ${visualClass}`}>
    <header><div><span>{petName}’s stay journal</span><h1>Little moments,<br />big tail wags.</h1></div><em>A very good day</em></header>
    <section className="journal-collage"><div className="journal-main">{media[0]}</div><div>{media[1]}{video}</div><div>{media[2]}<blockquote>{closing}</blockquote></div></section>
    <section className="journal-notes"><div><b>Morning favorite</b><p>{moments[0]?.body || summary}</p></div><div><b>Afternoon highlight</b><p>{moments[1]?.body || closing}</p></div><div><b>Care notes</b><p>Meals checked · Water normal · Plenty of play</p></div><div><b>Tomorrow</b><p>More gentle enrichment and happy adventures.</p></div></section>
  </article>;

  if (report.template === "postcard") return <article className={`themed-report postcard-report ${visualClass}`}>
    <header>{media[0]}<div><span>A note from today</span><h1>Wish you<br />were here!</h1><p>{petName} is having a wonderful stay.</p></div></header>
    <section className="postcard-copy"><div><h2>Hi, {petName}’s family!</h2><p>{summary}</p></div><aside><small>Today’s mood</small><b>Happy explorer</b><span>Playful · Social · Relaxed</span></aside></section>
    <section className="postcard-media">{media.slice(1, 3)}{video}</section>
    <blockquote>“{closing}” <b>With love ♥</b></blockquote>
  </article>;

  return <article className={`themed-report storybook-report ${visualClass}`}>
    <header>{media[0]}<div><span>{facilityName} · Daily story</span><h1>{report.title}</h1><p>{dateLabel}</p></div></header>
    <section className="storybook-intro"><div><h2>A bright start and a happy tail</h2><p>{summary}</p></div><aside><b>Today at a glance</b><span>Breakfast <strong>All eaten</strong></span><span>Energy <strong>Playful</strong></span><span>Potty <strong>Normal</strong></span><span>Rest <strong>Comfortable</strong></span></aside></section>
    <section className="storybook-media"><div>{media[1]}</div><div>{media[2]}{video}</div></section>
    <blockquote>“{closing}”</blockquote><small className="report-signoff">With love from the {facilityName} team ♡</small>
  </article>;
}

async function startMusicPreview(style: AudibleReportMusicStyle, onEnded: () => void): Promise<MusicPreviewPlayback> {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) throw new Error("Music previews are not supported by this browser.");

  const context = new AudioContextClass();
  const track = MUSIC_PREVIEW_TRACKS[style];
  const seconds = 15;
  const beatSeconds = 60 / track.bpm;
  const stepSeconds = beatSeconds / track.subdivisions;
  const startAt = context.currentTime + 0.04;
  const endAt = startAt + seconds;
  const filter = context.createBiquadFilter();
  const compressor = context.createDynamicsCompressor();
  const master = context.createGain();
  const delay = context.createDelay();
  const feedback = context.createGain();
  const wet = context.createGain();
  const sources: AudioScheduledSourceNode[] = [];
  let stopped = false;

  filter.type = "lowpass";
  filter.frequency.value = track.instrument === "ukulele" ? 7_200 : track.instrument === "marimba" ? 8_200 : 9_200;
  compressor.threshold.value = -16;
  compressor.knee.value = 12;
  compressor.ratio.value = 5;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.12;
  delay.delayTime.value = track.instrument === "glockenspiel" ? stepSeconds * 1.5 : stepSeconds;
  feedback.gain.value = track.instrument === "glockenspiel" ? 0.075 : 0.025;
  wet.gain.value = track.instrument === "glockenspiel" ? 0.085 : 0.035;
  master.gain.setValueAtTime(0, startAt);
  master.gain.linearRampToValueAtTime(0.78, startAt + 0.08);
  master.gain.setValueAtTime(0.78, endAt - 0.35);
  master.gain.linearRampToValueAtTime(0, endAt);

  filter.connect(compressor);
  filter.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(compressor);
  compressor.connect(master);
  master.connect(context.destination);

  const scheduleTone = (frequency: number, at: number, duration: number, gainValue: number, type: OscillatorType) => {
    const oscillator = context.createOscillator();
    const voice = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    voice.gain.setValueAtTime(0.0001, at);
    voice.gain.linearRampToValueAtTime(gainValue, at + Math.min(0.012, duration / 5));
    voice.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(voice);
    voice.connect(filter);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.01);
    sources.push(oscillator);
  };

  const scheduleInstrument = (frequency: number, at: number, accent: number) => {
    const durationScale = track.instrument === "xylophone" ? 0.38 : track.instrument === "marimba" ? 0.48 : track.instrument === "ukulele" ? 0.60 : track.instrument === "glockenspiel" ? 1.05 : 0.56;
    const wave: OscillatorType = track.instrument === "ukulele" || track.instrument === "toy_piano" ? "triangle" : "sine";
    const baseGain = (track.instrument === "ukulele" ? 0.072 : track.instrument === "toy_piano" ? 0.070 : 0.082) * accent;
    scheduleTone(frequency, at, stepSeconds * durationScale, baseGain, wave);
    if (track.instrument === "xylophone") scheduleTone(frequency * 3, at, stepSeconds * 0.24, baseGain * 0.24, "sine");
    if (track.instrument === "marimba") scheduleTone(frequency * 3, at, stepSeconds * 0.32, baseGain * 0.28, "sine");
    if (track.instrument === "glockenspiel") scheduleTone(frequency * 2.01, at, stepSeconds * 1.35, baseGain * 0.26, "sine");
    if (track.instrument === "toy_piano") scheduleTone(frequency * 2, at, stepSeconds * 0.42, baseGain * 0.14, "sine");
  };

  const noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.12), context.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let index = 0; index < noiseData.length; index += 1) noiseData[index] = Math.random() * 2 - 1;
  const scheduleNoise = (at: number, duration: number, gainValue: number, highPassHz: number) => {
    const noise = context.createBufferSource();
    const highPass = context.createBiquadFilter();
    const voice = context.createGain();
    noise.buffer = noiseBuffer;
    highPass.type = "highpass";
    highPass.frequency.value = highPassHz;
    voice.gain.setValueAtTime(gainValue, at);
    voice.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    noise.connect(highPass);
    highPass.connect(voice);
    voice.connect(filter);
    noise.start(at);
    noise.stop(at + duration + 0.01);
    sources.push(noise);
  };

  const totalSteps = Math.ceil(seconds / stepSeconds);
  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const swingOffset = track.groove === "swing" && stepIndex % 2 === 1 ? stepSeconds * 0.16 : 0;
    const at = startAt + stepIndex * stepSeconds + swingOffset;
    if (at >= endAt) break;
    const beatIndex = Math.floor(stepIndex / track.subdivisions);
    const chord = track.chords[Math.floor(beatIndex / 2) % track.chords.length];
    const leadAccent = track.leadRhythm[stepIndex % track.leadRhythm.length];
    const bassAccent = track.bassRhythm[stepIndex % track.bassRhythm.length];
    const chordAccent = track.chordRhythm[stepIndex % track.chordRhythm.length];
    if (leadAccent) scheduleInstrument(chord[track.arpPattern[stepIndex % track.arpPattern.length]], at, leadAccent);
    if (bassAccent) scheduleTone(chord[0] / 2, at, stepSeconds * 0.76, 0.082 * bassAccent, "sine");
    if (chordAccent) {
      const chordWave: OscillatorType = track.instrument === "ukulele" || track.instrument === "toy_piano" ? "triangle" : "sine";
      chord.slice(0, 3).forEach((frequency) => scheduleTone(frequency, at, stepSeconds * 0.55, 0.012 * chordAccent, chordWave));
    }

    const percussion = previewPercussionHits(track.groove, stepIndex, track.subdivisions);
    if (percussion.kick) {
      const kick = context.createOscillator();
      const kickGain = context.createGain();
      kick.type = "sine";
      kick.frequency.setValueAtTime(145, at);
      kick.frequency.exponentialRampToValueAtTime(52, at + 0.13);
      kickGain.gain.setValueAtTime(0.24, at);
      kickGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      kick.connect(kickGain);
      kickGain.connect(filter);
      kick.start(at);
      kick.stop(at + 0.16);
      sources.push(kick);
    }
    if (percussion.snare) scheduleNoise(at, 0.11, percussion.snareLevel, 1_250);
    if (percussion.hatLevel) scheduleNoise(at, 0.04, percussion.hatLevel, track.groove === "shaker" ? 3_800 : 5_500);
  }

  const finishTimer = window.setTimeout(() => {
    if (stopped) return;
    stopped = true;
    void context.close();
    onEnded();
  }, (seconds + 0.15) * 1000);

  try {
    await context.resume();
  } catch (error) {
    window.clearTimeout(finishTimer);
    void context.close();
    throw error;
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(finishTimer);
      sources.forEach((source) => {
        try { source.stop(); } catch { /* The source already ended. */ }
      });
      void context.close();
    },
  };
}

function previewPercussionHits(groove: MusicPreviewTrack["groove"], stepIndex: number, subdivisions: number) {
  const step = stepIndex % (subdivisions * 4);
  if (groove === "bounce") return { kick: [0, 3, 4, 6].includes(step), snare: [2, 6].includes(step), snareLevel: 0.10, hatLevel: step % 2 ? 0.023 : 0.038 };
  if (groove === "shaker") return { kick: [0, 4].includes(step), snare: [2, 6].includes(step), snareLevel: 0.055, hatLevel: step % 2 ? 0.048 : 0.029 };
  if (groove === "six_eight") {
    const sixStep = stepIndex % 6;
    return { kick: sixStep === 0, snare: sixStep === 3, snareLevel: 0.068, hatLevel: [0, 3].includes(sixStep) ? 0.046 : 0.025 };
  }
  if (groove === "march") return { kick: [0, 4].includes(step), snare: [2, 6].includes(step) || step % 2 === 1, snareLevel: step % 2 === 1 ? 0.032 : 0.11, hatLevel: 0.014 };
  return { kick: [0, 4].includes(step), snare: [2, 6].includes(step), snareLevel: 0.095, hatLevel: step % 2 ? 0.023 : 0.036 };
}

function photoFocalPoint(photo: PhotoLink): string {
  const x = Number(photo.hero_bbox_x);
  const y = Number(photo.hero_bbox_y);
  const width = Number(photo.hero_bbox_width);
  const height = Number(photo.hero_bbox_height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return "50% 50%";
  const centerX = Math.min(0.9, Math.max(0.1, x + width / 2));
  const centerY = Math.min(0.9, Math.max(0.1, y + height / 2));
  return `${(centerX * 100).toFixed(1)}% ${(centerY * 100).toFixed(1)}%`;
}

function IdentityReferencePhoto({ photo, onUseInReport, onRemove, disabled = false }: { photo: IdentityMediaStatus["photos"][number]; onUseInReport?: () => void; onRemove?: () => void; disabled?: boolean }) {
  const label = photo.enrolled_embedding_count
    ? "AI ready"
    : photo.detected_pet_count === 0 && photo.processing_status === "processed"
      ? "No pet detected—skipped"
      : photo.detected_pet_count > 1
        ? "Multiple pets—skipped"
        : photo.processing_status === "processed" && Number(photo.best_quality_score) < 0.45
          ? "Image quality too low—skipped"
          : photo.processing_status === "processed" && Number(photo.best_detector_confidence) < 0.55
            ? "Pet detection uncertain—skipped"
            : title(photo.processing_status);
  return <article><img src={photo.viewUrl} alt="Check-in AI identity reference" />{onUseInReport && <button className="use-reference-report" disabled={disabled || photo.processing_status !== "processed"} onClick={onUseInReport} aria-label="Add this check-in photo to report candidates">★ Report</button>}<span className={`status-pill ${photo.enrolled_embedding_count ? "ready" : photo.processing_status === "failed" ? "report-failed" : "attention"}`}>{label}</span>{onRemove && <button className="remove-reference" disabled={disabled} onClick={onRemove} aria-label="Remove this AI reference photo">×</button>}</article>;
}

function NavButton({ active, icon, count, onClick, children }: { active: boolean; icon: string; count?: number; onClick: () => void; children: React.ReactNode }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}><i>{icon}</i><span>{children}</span>{count ? <em>{count}</em> : null}</button>;
}
function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone: string }) { return <article className={`stat-card ${tone}`}><span>{label}</span><b>{value}</b><small>{note}</small></article>; }
function Loading({ label }: { label: string }) { return <div className="loading"><i /><b>{label}</b></div>; }
function Empty({ title: heading, detail }: { title: string; detail: string }) { return <div className="empty"><span>✦</span><b>{heading}</b><small>{detail}</small></div>; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }
function title(value: string) { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function formatTimelineMoment(value: string) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function bestQualityPhoto(photos: PhotoLink[]) {
  return photos.reduce<PhotoLink | undefined>((best, photo) => {
    if (!best) return photo;
    const score = heroSuitabilityScore(photo);
    const bestScore = heroSuitabilityScore(best);
    return score > bestScore ? photo : best;
  }, undefined);
}
function heroSuitabilityScore(photo: PhotoLink) {
  const quality = Math.max(0, Math.min(1, Number(photo.quality_score ?? 0)));
  const detectorConfidence = Math.max(0, Math.min(1, Number(photo.hero_detector_confidence ?? 0)));
  const x = Number(photo.hero_bbox_x);
  const y = Number(photo.hero_bbox_y);
  const width = Number(photo.hero_bbox_width);
  const height = Number(photo.hero_bbox_height);
  const hasFraming = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
  if (!hasFraming) return quality * 0.55 - 0.25;

  const area = width * height;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const centerDistance = Math.min(1, Math.hypot(centerX - 0.5, centerY - 0.48) / 0.7);
  const edgeMargin = Math.min(x, y, 1 - x - width, 1 - y - height);

  // Hero images should show the pet clearly with some surroundings. Extremely
  // large boxes are usually cropped faces; very small boxes make the pet hard
  // to see. Touching the frame edge suggests part of the pet is cut off.
  const occupancyScore = area < 0.06
    ? Math.max(0, area / 0.06)
    : area <= 0.48
      ? 1
      : Math.max(0, 1 - (area - 0.48) / 0.42);
  const edgeScore = edgeMargin >= 0.04 ? 1 : Math.max(0, edgeMargin / 0.04);
  const compositionScore = occupancyScore * 0.58 + edgeScore * 0.27 + (1 - centerDistance) * 0.15;
  const closeUpPenalty = area > 0.7 ? 0.75 + (area - 0.7) : area > 0.55 ? (area - 0.55) * 2 : 0;
  const croppedPenalty = edgeMargin <= 0.005 && area > 0.4 ? 0.35 : 0;
  const crowdPenalty = Math.max(0, Number(photo.detected_pet_count ?? 1) - 2) * 0.04;
  const landscapeBonus = photo.width && photo.height && photo.width >= photo.height ? 0.04 : 0;

  return quality * 0.42 + detectorConfidence * 0.12 + compositionScore * 0.46
    + landscapeBonus - closeUpPenalty - croppedPenalty - crowdPenalty;
}
function reportHeroPhoto(report: ReportVideo, photos: PhotoLink[]) {
  return photos.find((photo) => photo.photo_id === report.main_photo_id)
    ?? photos.find((photo) => localDateKey(photo.capture_at ?? photo.uploaded_at) === reportDateKey(report.report_date))
    ?? photos[0];
}
function reportPhotosForPreview(report: ReportVideo, photos: PhotoLink[]) {
  if (!report.photo_ids?.length) return photos.filter((photo) => photo.review_state === "published");
  const order = new Map(report.photo_ids.map((id, index) => [id, index]));
  return photos
    .filter((photo) => photo.photo_id && order.has(photo.photo_id))
    .sort((left, right) => (order.get(left.photo_id!) ?? 0) - (order.get(right.photo_id!) ?? 0));
}
function reportDateKey(value: string) {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match?.[0] ?? value;
}
function localDateKey(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function reportMediaInWindow(value: string | null | undefined, reportDate: string, mediaWindow: ReportMediaWindow, checkInAt?: string) {
  const mediaDate = localDateKey(value);
  if (!mediaDate || mediaDate > reportDate) return false;
  if (mediaWindow === "full_stay") return !checkInAt || mediaDate >= localDateKey(checkInAt);
  const daysBack = mediaWindow === "last_3_days" ? 2 : mediaWindow === "last_2_days" ? 1 : 0;
  const start = new Date(`${reportDate}T12:00:00`);
  start.setDate(start.getDate() - daysBack);
  const calculatedStart = localDateKey(start.toISOString());
  const stayStart = checkInAt ? localDateKey(checkInAt) : "";
  const effectiveStart = stayStart && stayStart > calculatedStart ? stayStart : calculatedStart;
  return mediaDate >= effectiveStart;
}
function formatBytes(value: number) {
  if (value <= 0) return "0 KB";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function blankToNull(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}
function formatCustomerAddress(address?: CustomerDetail["addresses"][number]) {
  if (!address) return "";
  return [address.line1, address.line2, address.city, address.region, address.postal_code, address.country_code]
    .filter(Boolean).join(", ");
}
function friendlyIssueCode(value: string) {
  const labels: Record<string, string> = {
    address_parse_required: "Address needs review",
    duplicate_microchip_review: "Duplicate microchip needs review",
    future_service_date: "Future service date needs review",
    missing_contact_method: "Contact method missing",
    non_size_value_ignored: "Invalid size value was not imported",
    weight_unit_required: "Weight needs a confirmed unit",
  };
  return labels[value] ?? title(value);
}
function groupPetsByOwner(pets: PetOption[]) {
  const groups = new Map<string, { key: string; ownerName: string; ownerPhone: string | null; ownerEmail: string | null; pets: PetOption[] }>();
  for (const pet of pets) {
    const key = pet.owner_id || `unlinked-${pet.id}`;
    const current = groups.get(key) || { key, ownerName: pet.owner_name || "Owner not linked", ownerPhone: pet.owner_phone, ownerEmail: pet.owner_email, pets: [] };
    current.pets.push(pet);
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => a.ownerName.localeCompare(b.ownerName));
}
function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
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
