import React, { useEffect, useMemo, useState } from "react";

/* =================
   Types & constants
   ================= */
const TYPES = ["activity", "food", "transport", "accomodation", "other"] as const;
type ActivityType = typeof TYPES[number];

type Activity = {
  id: string;
  date: string;          // YYYY-MM-DD
  time?: string;         // HH:MM
  durationMinutes?: number;
  title: string;
  city?: string;
  location?: string;     // Maps URL or address
  comments?: string;
  link?: string;
  type: ActivityType;
};

const LS_KEY = "trip_planner_activities_v1";
const LS_GMAPS = "trip_planner_google_maps_api_key";
const LS_SAVED = "trip_planner_saved_places";
const LS_FB_CFG = "trip_planner_firebase_config";
const LS_FB_SHARE = "trip_planner_firebase_share";
const LS_FB_SYNC  = "trip_planner_firebase_sync_enabled";


/* =========
   Utilities
   ========= */
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

function loadActivities(): Activity[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function saveActivities(items: Activity[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}
function saveApiKey(k: string) {
  localStorage.setItem(LS_GMAPS, k || "");
}
function groupBy<T, K extends string | number>(arr: T[], fn: (t: T) => K) {
  const m = new Map<K, T[]>();
  for (const it of arr) {
    const k = fn(it);
    const list = m.get(k) || [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}
function compareDateTime(a: Activity, b: Activity) {
  const A = `${a.date} ${a.time || "00:00"}`;
  const B = `${b.date} ${b.time || "00:00"}`;
  return A.localeCompare(B);
}
function parseTimeToMinutes(t?: string) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}
function renderTimeRange(a: Activity) {
  if (!a.time) return "";
  if (!a.durationMinutes || a.durationMinutes <= 0) return a.time;
  const start = parseTimeToMinutes(a.time)!;
  const end = start + a.durationMinutes;
  const eh = Math.floor((end % (24 * 60)) / 60);
  const em = end % 60;
  return `${a.time}–${pad(eh)}:${pad(em)}`;
}
function computeOverlaps(items: Activity[]) {
  const set = new Set<string>();
  const byDate = groupBy(items, i => i.date);
  for (const [, arr] of byDate) {
    const rows = arr.map(i => {
      const s = parseTimeToMinutes(i.time);
      const e = s != null && i.durationMinutes ? s + i.durationMinutes : s ?? -1;
      return { id: i.id, s: s ?? -1, e };
    }).sort((x, y) => x.s - y.s);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const A = rows[i], B = rows[j];
        if (A.s < 0 || B.s < 0) continue;
        const aEnd = Math.max(A.e, A.s);
        const bEnd = Math.max(B.e, B.s);
        const overlap = !(aEnd <= B.s || bEnd <= A.s);
        if (overlap) { set.add(A.id); set.add(B.id); }
      }
    }
    // same-minute, zero-duration
    const same = groupBy(rows.filter(r => r.s >= 0 && r.s === r.e), r => r.s);
    for (const [, list] of same) if (list.length > 1) list.forEach(r => set.add(r.id));
  }
  return set;
}
function normalizeMapsUrl(text: string) {
  try {
    if (/^https?:\/\//i.test(text)) return text.trim();
    return `https://www.google.com/maps/search/${encodeURIComponent(text)}`;
  } catch { return text; }
}
// Prefer the last !3d!4d pair, then q=/query=/ll=, then @lat,lng
function parseCoordsFromUrl(url: string) {
  try {
    if (!url) return null;
    const re = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g;
    let m: RegExpExecArray | null;
    let last: { lat: number; lng: number } | null = null;
    while ((m = re.exec(url)) !== null) {
      const lat = parseFloat(m[1]); const lng = parseFloat(m[2]);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) last = { lat, lng };
    }
    if (last) return last;

    // q= / query= / ll=
    try {
      const u = new URL(url, "https://example.invalid");
      const q = u.searchParams.get("q") || u.searchParams.get("query") || u.searchParams.get("ll");
      if (q) {
        const [latS, lngS] = q.split(",");
        const lat = parseFloat(latS); const lng = parseFloat(lngS);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
      }
    } catch {}

    // @lat,lng
    const at = url.indexOf("@");
    if (at !== -1) {
      const seg = url.slice(at + 1).split(/[\/?#]/)[0];
      const [latS, lngS] = seg.split(",");
      const lat = parseFloat(latS); const lng = parseFloat(lngS);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
    }
    return null;
  } catch { return null; }
}

function loadGoogleMaps(key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).google?.maps) return resolve((window as any).google.maps);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = () => resolve((window as any).google.maps);
    s.onerror = () => reject(new Error("Failed to load Google Maps JS"));
    document.head.appendChild(s);
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string));
}

/* =====
   UI
   ===== */
function Button(
  { children, onClick, variant, className }: { children: React.ReactNode; onClick?: () => void; variant?: "black" | "grey" | "ghost"; className?: string }
) {
  const base = "px-4 py-2 rounded-2xl transition";
  const theme =
    variant === "grey" ? "bg-neutral-200 hover:bg-neutral-300 text-black" :
    variant === "ghost" ? "bg-transparent hover:bg-neutral-100 text-black" :
    "bg-black text-white hover:bg-neutral-800";
  return <button onClick={onClick} className={`${base} ${theme} ${className || ""}`}>{children}</button>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl border border-neutral-200 p-4 md:p-6 mb-6">{children}</div>;
}
function Input(props: any) {
  return (
    <div className="mb-3">
      {props.label && <div className="text-sm font-medium mb-1">{props.label}</div>}
      <input {...props} className={`w-full rounded-2xl border border-neutral-300 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-400 ${props.className || ""}`} />
    </div>
  );
}
function TextArea(props: any) {
  return (
    <div className="mb-3">
      {props.label && <div className="text-sm font-medium mb-1">{props.label}</div>}
      <textarea {...props} className={`w-full rounded-2xl border border-neutral-300 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-400 ${props.className || ""}`} />
    </div>
  );
}
function Header({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="fixed inset-x-0 top-0 h-16 z-50 border-b border-neutral-200 bg-neutral-50/90 backdrop-blur">
      <div className="max-w-6xl mx-auto h-full px-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-black text-white grid place-items-center font-semibold select-none">TI</div>
        <div className="font-semibold">Travel Itinerary Planner</div>
        <div className="ml-auto"><Button onClick={onOpenSettings}>Settings</Button></div>
      </div>
    </div>
  );
}

/* =========
   Calendar
   ========= */
function CalendarView({ items }: { items: Activity[] }) {
  const [base, setBase] = useState(new Date());
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1);
  const start = first.getDay();
  const days = new Date(y, m + 1, 0).getDate();

 const cells: (number | null)[] = [
  ...Array.from({ length: start }, () => null as number | null),
  ...Array.from({ length: days }, (_, i) => (i + 1) as number | null),
 ];
  );

  const byDate = groupBy(items, x => x.date);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold">{base.toLocaleString(undefined, { month: "long", year: "numeric" })}</div>
        <div className="flex gap-2">
          <Button variant="grey" onClick={() => setBase(new Date(y, m - 1, 1))}>Prev</Button>
          <Button variant="grey" onClick={() => setBase(new Date())}>Today</Button>
          <Button variant="grey" onClick={() => setBase(new Date(y, m + 1, 1))}>Next</Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-2 text-sm">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d} className="text-neutral-500">{d}</div>)}
        {cells.map((d, i) => (
          <div key={i} className="min-h-[90px] border border-neutral-200 rounded-xl p-2 bg-white">
            {d && <div className="font-medium mb-1">{d}</div>}
            {d && byDate.get(`${y}-${pad(m + 1)}-${pad(d)}`)?.slice(0, 4).map(a => (
              <div key={a.id} className="truncate text-xs">• {a.time || ""} {a.title}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* =============
   Itinerary UI
   ============= */
function Itinerary(
  { items, overlaps, onUpdate, onRemove }:
  { items: Activity[]; overlaps: Set<string>; onUpdate: (id: string, p: Partial<Activity>) => void; onRemove: (id: string) => void }
) {
  if (!items.length) return <div className="text-neutral-600">No activities yet. Add something on the first tab.</div>;
  const byDate = groupBy(items, x => x.date);
  const keys = Array.from(byDate.keys()).sort();

  return (
    <div className="space-y-6">
      {keys.map(d => (
        <div key={d}>
          <div className="font-semibold mb-2">{d}</div>
          <div className="space-y-2">
            {byDate.get(d)!.map(a => (
              <div key={a.id} className="flex items-start gap-3 p-3 rounded-xl border border-neutral-200">
                <div className="w-2 h-2 rounded-full mt-2" style={{ background: overlaps.has(a.id) ? "#ef4444" : "#a3a3a3" }} />
                <div className="flex-1">
                  <div className="font-medium">
                    {a.title} {a.city ? <span className="text-neutral-500">• {a.city}</span> : null}
                  </div>
                  <div className="text-sm text-neutral-600">{renderTimeRange(a)} {a.type ? `• ${a.type}` : ""}</div>
                  {a.location && (
                    <div className="text-sm">
                      <a className="underline" href={normalizeMapsUrl(a.location)} target="_blank" rel="noopener noreferrer">Location</a>
                    </div>
                  )}
                  {a.link && (
                    <div className="text-sm">
                      <a className="underline" href={a.link} target="_blank" rel="noopener noreferrer">Link</a>
                    </div>
                  )}
                  {a.comments && <div className="text-sm text-neutral-700 mt-1 whitespace-pre-wrap">{a.comments}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="grey" onClick={() => onUpdate(a.id, { title: prompt("Title", a.title) || a.title })}>Edit</Button>
                  <Button variant="grey" onClick={() => onRemove(a.id)}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MapView({ apiKey, items }: { apiKey: string; items: Activity[] }) {
  const [savedPlaces, setSavedPlaces] = React.useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_SAVED) || "[]"); } catch { return []; }
  });
  const [showActs, setShowActs] = React.useState(true);
  const [showSaved, setShowSaved] = React.useState(true);

  React.useEffect(() => {
    localStorage.setItem(LS_SAVED, JSON.stringify(savedPlaces));
  }, [savedPlaces]);

  function onImportGeoJSON(files: FileList | null) {
    const f = files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result || "{}"));
        const feats = Array.isArray(json?.features) ? json.features : [];
        const normalized = feats
          .filter((ft: any) => ft?.geometry?.type === "Point" && Array.isArray(ft.geometry.coordinates) && ft.geometry.coordinates.length >= 2)
          .map((ft: any) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [Number(ft.geometry.coordinates[0]), Number(ft.geometry.coordinates[1])] },
            properties: ft.properties || {},
          }));
        setSavedPlaces(normalized);
      } catch { alert("Invalid GeoJSON"); }
    };
    reader.readAsText(f);
  }

  // Build pins
  const activityPins = React.useMemo(() =>
    items
      .map(a => ({ a, coord: a.location ? parseCoordsFromUrl(a.location) : null }))
      .filter(x => !!x.coord) as { a: Activity, coord: { lat: number; lng: number } }[],
    [items]
  );

  const savedPins = React.useMemo(() =>
    savedPlaces.map((ft: any) => ({
      coord: { lat: Number(ft.geometry.coordinates[1]), lng: Number(ft.geometry.coordinates[0]) },
      title: ft.properties?.location?.name || ft.properties?.name || ft.properties?.title || "Saved place",
      url: ft.properties?.google_maps_url || "",
      address: ft.properties?.location?.address || ft.properties?.address || "",
    })),
    [savedPlaces]
  );

  // Dedupe by 5 decimals; activities override saved
  const keyFrom = (c: { lat: number; lng: number }) => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
  const mergedPins = React.useMemo(() => {
    const map = new Map<string, any>();
    if (showSaved) for (const s of savedPins) map.set(keyFrom(s.coord), { kind: "saved", ...s });
    if (showActs) for (const p of activityPins) map.set(keyFrom(p.coord), {
      kind: "activity",
      title: p.a.title,
      url: p.a.location || "",
      coord: p.coord,
      address: p.a.city || "",
      activity: p.a
    });
    return Array.from(map.values());
  }, [activityPins, savedPins, showActs, showSaved]);

  // Render Google Map
  React.useEffect(() => {
    if (!apiKey) return;
    let gm: any;
    let map: any;
    let info: any;
    let markers: any[] = [];

    loadGoogleMaps(apiKey).then((g) => {
      gm = g;
      const el = document.getElementById("map");
      if (!el) return;
      map = new gm.Map(el, {
        center: { lat: 20, lng: 0 },
        zoom: 2,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true
      });
      info = new gm.InfoWindow();

      const bounds = new gm.LatLngBounds();
      mergedPins.forEach(p => bounds.extend(p.coord));
      if (!bounds.isEmpty()) map.fitBounds(bounds);

      markers = mergedPins.map(p => {
        const marker = new gm.Marker({
          position: p.coord,
          map,
          icon: {
            path: gm.SymbolPath.CIRCLE,
            scale: 6,
            strokeWeight: 2,
            strokeColor: p.kind === "activity" ? "#ef4444" : "#000",
            fillOpacity: 0
          }
        });
        marker.addListener("click", () => {
          const safeUrl = p.url ? normalizeMapsUrl(p.url) : `https://www.google.com/maps/@${p.coord.lat},${p.coord.lng},18z`;
          const html =
            `<div style="max-width:220px; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
               <div style="font-weight:600;">${escapeHtml(p.title || (p.kind === "activity" ? p.activity?.title : "Saved place"))}</div>
               ${p.address ? `<div style="color:#6b7280; font-size:12px;">${escapeHtml(p.address)}</div>` : ""}
               <div style="margin-top:8px"><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">Open in Maps</a></div>
             </div>`;
          info.setContent(html);
          info.open({ map, anchor: marker });
        });
        return marker;
      });
    }).catch(err => console.error(err));

    return () => {
      markers.forEach(m => m.setMap(null));
    };
  }, [apiKey, mergedPins]);

  return (
    <div>
      <div className="flex items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showActs} onChange={(e) => setShowActs(e.target.checked)} />
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#ef4444" }} /> Activities
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showSaved} onChange={(e) => setShowSaved(e.target.checked)} />
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: "#000" }} /> Saved
          </span>
        </label>
        <span className="text-sm text-neutral-500">• Google Maps</span>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold">Saved places</div>
        <div className="text-sm text-neutral-600">{savedPlaces.length} places</div>
      </div>
      <div className="flex items-center gap-3 mb-4">
        <input type="file" accept="application/json,.geojson,.json" onChange={(e) => onImportGeoJSON(e.target.files)} />
        <button className="px-4 py-2 rounded-2xl bg-neutral-200" onClick={() => setSavedPlaces([])}>Clear</button>
      </div>

      <div className="w-full overflow-hidden rounded-2xl border border-neutral-200">
        <div id="map" className="w-full h-[520px]" />
      </div>
      <div className="text-sm text-neutral-500 mt-3">
        Tip: upload a GeoJSON file to show your saved places. Activities are plotted from their Location field.
      </div>
    </div>
  );
}

/* =====
   App
   ===== */
export default function App() {
  const [tab, setTab] = useState<"add" | "list" | "cal" | "map">("add");
  const [items, setItems] = useState<Activity[]>(loadActivities());
  const [apiKey, setApiKey] = useState(localStorage.getItem(LS_GMAPS) || "");
  const [showSettings, setShowSettings] = useState(false);
  // Firebase sync settings (persisted locally)
  const [fbConfigText, setFbConfigText] = React.useState(() => localStorage.getItem(LS_FB_CFG) || "");
  const [fbShareCode, setFbShareCode]   = React.useState(() => localStorage.getItem(LS_FB_SHARE) || "lil-trip");
  const [syncEnabled, setSyncEnabled]   = React.useState(() => (localStorage.getItem(LS_FB_SYNC) || "false") === "true");

  // Keep a live reference to activities for the saver
  const itemsRef = React.useRef(items);
  React.useEffect(() => { itemsRef.current = items; window.dispatchEvent(new Event("localActivitiesChanged")); }, [items]);

  // Save settings to localStorage when they change
  React.useEffect(() => {
    localStorage.setItem(LS_FB_CFG, fbConfigText || "");
    localStorage.setItem(LS_FB_SHARE, fbShareCode || "");
   localStorage.setItem(LS_FB_SYNC, String(syncEnabled));
  }, [fbConfigText, fbShareCode, syncEnabled]);

  // Bridge saved places to sync (MapView will emit an event when they change)
  const savedRef = React.useRef<any[]>([]);
  React.useEffect(() => {
    const onSaved = (e: any) => { savedRef.current = Array.isArray(e.detail) ? e.detail : []; };
    window.addEventListener("savedPlacesChanged", onSaved as any);
    return () => window.removeEventListener("savedPlacesChanged", onSaved as any);
  }, []);
  function applySavedPlacesFromRemote(arr: any[]) {
   window.dispatchEvent(new CustomEvent("savedPlacesSyncSet", { detail: Array.isArray(arr) ? arr : [] })); 
  }


  useEffect(() => saveActivities(items), [items]);
  useEffect(() => saveApiKey(apiKey), [apiKey]);

  const sorted = useMemo(() => [...items].sort(compareDateTime), [items]);
  const overlaps = useMemo(() => computeOverlaps(sorted), [sorted]);

  const [form, setForm] = useState<Partial<Activity>>({ date: todayStr(), type: "activity" });

  function addActivity() {
    if (!form.date || !form.title) return alert("Date and Title are required");
    const a: Activity = {
      id: uid(),
      date: form.date!,
      time: form.time?.trim() ? form.time : undefined,
      durationMinutes: form.durationMinutes && form.durationMinutes > 0 ? Number(form.durationMinutes) : undefined,
      title: form.title!.trim(),
      city: form.city?.trim() || undefined,
      location: form.location?.trim() || undefined,
      comments: form.comments?.trim() || undefined,
      link: form.link?.trim() || undefined,
      type: (form.type as ActivityType) || "activity",
    };
    setItems(prev => [...prev, a]);
  }
  function updateActivity(id: string, patch: Partial<Activity>) {
    setItems(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }
  function removeActivity(id: string) {
    setItems(prev => prev.filter(x => x.id !== id));
  }

  function TabBtn({ id, label }: { id: "add" | "list" | "cal" | "map"; label: string }) {
    const active = tab === id; const cls = active ? "bg-black text-white" : "bg-white text-black";
    return <button onClick={() => setTab(id)} className={`rounded-2xl px-4 py-2 border border-neutral-300 ${cls}`}>{label}</button>;
  }

  useFirebaseSync({
    enabled: syncEnabled,
    configText: fbConfigText,
    shareCode: fbShareCode,
    getActivities: () => itemsRef.current,
    getSavedPlaces: () => savedRef.current,
    setFromRemote: (data: any) => {
      if (data?.activities) setItems(data.activities);
      if (data?.saved_places) applySavedPlacesFromRemote(data.saved_places);
    }
  });
  
  return (
    <div className="min-h-screen bg-neutral-100 text-black overflow-x-hidden">
      <Header onOpenSettings={() => setShowSettings(true)} />

      <main className="max-w-6xl mx-auto px-4 pt-20 pb-24">
        <div className="flex gap-3 mb-6">
          <TabBtn id="add" label="Add activity" />
          <TabBtn id="list" label="My Itinerary" />
          <TabBtn id="cal" label="Calendar view" />
          <TabBtn id="map" label="Map view" />
        </div>

        {tab === "add" && (
          <Card>
            <div className="text-2xl font-semibold mb-4">Add new activity</div>
            <div className="grid md:grid-cols-2 gap-4">
              <Input label="Date" type="date" value={form.date || ""} onChange={(e: any) => setForm(f => ({ ...f, date: e.target.value }))} />
              <Input label="Time" type="time" value={form.time || ""} onChange={(e: any) => setForm(f => ({ ...f, time: e.target.value }))} />
              <Input label="Title" value={form.title || ""} onChange={(e: any) => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g., Prado Museum" />
              <Input label="City" value={form.city || ""} onChange={(e: any) => setForm(f => ({ ...f, city: e.target.value }))} placeholder="e.g., Madrid" />
              <Input label="Location (Google Maps link or address)" value={form.location || ""} onChange={(e: any) => setForm(f => ({ ...f, location: e.target.value }))} placeholder="Paste a Maps URL or type an address" />
              <Input label="Duration (minutes, optional)" type="number" min={0} value={form.durationMinutes ?? ""} onChange={(e: any) => setForm(f => ({ ...f, durationMinutes: e.target.value ? Number(e.target.value) : undefined }))} placeholder="e.g., 90" />
              <div>
                <div className="text-sm font-medium mb-1">Type</div>
                <select className="w-full rounded-2xl border border-neutral-300 px-3 py-2" value={form.type || "activity"} onChange={(e) => setForm(f => ({ ...f, type: e.target.value as ActivityType }))}>
                  {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <TextArea label="Comments (optional)" rows={4} value={form.comments || ""} onChange={(e: any) => setForm(f => ({ ...f, comments: e.target.value }))} placeholder="Notes, booking codes, who's late, etc." />
              <Input label="Link (optional)" value={form.link || ""} onChange={(e: any) => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https://…" />
            </div>
            <div className="flex gap-2 mt-4">
              <Button onClick={addActivity}>Add activity</Button>
              <Button variant="grey" onClick={() => setForm({ date: todayStr(), type: "activity" })}>Clear</Button>
            </div>
          </Card>
        )}

        {tab === "list" && (
          <Card>
            <div className="text-2xl font-semibold mb-4">My Itinerary</div>
            <Itinerary items={sorted} overlaps={overlaps} onUpdate={updateActivity} onRemove={removeActivity} />
          </Card>
        )}

        {tab === "cal" && (
          <Card>
            <div className="text-2xl font-semibold mb-4">Calendar view</div>
            <CalendarView items={sorted} />
          </Card>
        )}

        {tab === "map" && (
          <Card>
          <div className="text-2xl font-semibold mb-2">Map view</div>
          <div className="text-neutral-600 mb-4">
          Activities are red. Saved places are black. Duplicates are merged by coordinates; the activity pin wins.
          </div>
        <MapView apiKey={apiKey} items={sorted} />
        </Card> 
        )}

      </main>

      {showSettings && (
      <div className="fixed inset-0 z-50 bg-black/30 grid place-items-center p-4">
        <div className="bg-white rounded-2xl border border-neutral-200 w-full max-w-2xl p-5">
          <div className="text-xl font-semibold mb-4">Settings</div>

          {/* Google Maps key (what you already had) */}
          <Input
            label="Google Maps API key"
            value={apiKey}
            onChange={(e: any) => setApiKey(e.target.value)}
            placeholder="paste your key"
         />

           {/* Firebase sync fields */}
          <div className="font-semibold mt-6 mb-2">Sync with Firebase</div>
          <TextArea
           label="Firebase config (paste the JSON object only)"
           rows={6}
           value={fbConfigText}
           onChange={(e: any) => setFbConfigText(e.target.value)}
           placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'
          />
          <Input
           label="Share code"
           value={fbShareCode}
           onChange={(e: any) => setFbShareCode(e.target.value)}
           placeholder="e.g., lil-trip"
          />
          <label className="flex items-center gap-2 mb-3 text-sm">
           <input
             type="checkbox"
             checked={syncEnabled}
             onChange={(e: any) => setSyncEnabled(e.target.checked)}
            />
          Enable auto-sync
           </label>
          <div className="text-xs text-neutral-500 mb-4">
            Use the same config and share code on each device. Anonymous sign-in only. Last write wins.
         </div>

          <div className="flex justify-end">
           <Button onClick={() => setShowSettings(false)}>Close</Button>
          </div>
        </div>
      </div>
      )}

      </div>
  );
}

function useFirebaseSync({
  enabled, configText, shareCode,
  getActivities, getSavedPlaces, setFromRemote
}: {
  enabled: boolean; configText: string; shareCode: string;
  getActivities: () => any[]; getSavedPlaces: () => any[]; setFromRemote: (d: any) => void;
}) {
  const startedRef = React.useRef(false);
  const debRef = React.useRef<any>(null);

  React.useEffect(() => {
    if (!enabled) return;
    if (startedRef.current) return;
    if (!configText || !shareCode) return;
    startedRef.current = true;

    let unsub: any = null;
    let firebase: any = null;

    (async () => {
      try {
        const cfg = JSON.parse(configText);
        firebase = await loadFirebaseCompat();
        if (firebase.apps?.length) firebase.app(); else firebase.initializeApp(cfg);
        const db = firebase.firestore();
        const auth = firebase.auth();
        await auth.signInAnonymously().catch(() => {});
        const ref = db.collection("itineraries").doc(String(shareCode));

        const snap = await ref.get();
        if (snap.exists) {
          const d = snap.data();
          setFromRemote({ activities: d.activities || [], saved_places: d.saved_places || [] });
        }

        unsub = ref.onSnapshot((s: any) => {
          if (!s.exists) return;
          const d = s.data();
          setFromRemote({ activities: d.activities || [], saved_places: d.saved_places || [] });
        });
      } catch (e) {
        console.error("[Sync] init failed", e);
      }
    })();

    const onLocalChange = () => {
      if (!enabled || !shareCode || !firebase) return;
      clearTimeout(debRef.current);
      debRef.current = setTimeout(async () => {
        try {
          const ref = firebase.firestore().collection("itineraries").doc(String(shareCode));
          const payload = {
            activities: getActivities() || [],
            saved_places: getSavedPlaces() || [],
            updated_at: firebase.firestore.FieldValue.serverTimestamp(),
            version: 1
          };
          await ref.set(payload, { merge: true });
        } catch (e) {
          console.error("[Sync] save failed", e);
        }
      }, 800);
    };

    const poke = () => onLocalChange();
    window.addEventListener("localActivitiesChanged", poke);
    window.addEventListener("savedPlacesChanged", poke);

    return () => {
      window.removeEventListener("localActivitiesChanged", poke);
      window.removeEventListener("savedPlacesChanged", poke);
      if (unsub) unsub();
    };
  }, [enabled, configText, shareCode, getActivities, getSavedPlaces, setFromRemote]);
}

function loadFirebaseCompat(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).firebase?.apps) return resolve((window as any).firebase);
    const add = (src: string) => new Promise<void>((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => res();
      s.onerror = () => rej(new Error("Failed " + src));
      document.head.appendChild(s);
    });
    (async () => {
      try {
        await add("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
        await add("https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js");
        await add("https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js");
        resolve((window as any).firebase);
      } catch (e) { reject(e); }
    })();
  });
}
