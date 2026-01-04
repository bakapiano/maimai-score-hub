import "./App.css";

import { useEffect, useMemo, useState } from "react";

type LoginRequest = { jobId: string; userId: string };

type SyncScore = {
  musicId: string;
  cid: number;
  chartIndex: number;
  category: string | null;
  type: string;
  title: string;
  dxScore: string | null;
  score: string | null;
  fs: string | null;
  fc: string | null;
  rating: number | null;
  musicDetailLevel: number | null;
  isNew: boolean | null;
};

type SyncDetail = {
  id: string;
  friendCode: string;
  scores?: SyncScore[];
  [key: string]: unknown;
};

type RatingSummary = {
  newTop: SyncScore[];
  oldTop: SyncScore[];
  newSum: number;
  oldSum: number;
  totalSum: number;
};

const TABS = [
  { key: "login", label: "Login" },
  { key: "profile", label: "Profile" },
  { key: "sync", label: "Sync" },
  { key: "music", label: "Music" },
  { key: "cover", label: "Cover" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (null as T);
  return { ok: res.ok, status: res.status, data };
}

function buildRatingSummary(detail: SyncDetail): RatingSummary | null {
  if (!detail || !Array.isArray(detail.scores)) return null;

  const scores = detail.scores.filter(
    (s) => typeof s === "object"
  ) as SyncScore[];
  const withRating = scores.filter((s) => typeof s.rating === "number");

  const newScores = withRating
    .filter((s) => s.isNew === true)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const oldScores = withRating
    .filter((s) => s.isNew === false)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));

  const newTop = newScores.slice(0, 15);
  const oldTop = oldScores.slice(0, 35);

  const newSum = newTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);
  const oldSum = oldTop.reduce((sum, s) => sum + (s.rating ?? 0), 0);

  return {
    newTop,
    oldTop,
    newSum,
    oldSum,
    totalSum: newSum + oldSum,
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("login");
  const [health, setHealth] = useState<string>("");
  const [friendCode, setFriendCode] = useState("634142510810999");
  const [skipUpdateScore, setSkipUpdateScore] = useState(true);
  const [loginReq, setLoginReq] = useState<LoginRequest | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [profileResp, setProfileResp] = useState<string>("");
  const [profilePatchResp, setProfilePatchResp] = useState<string>("");
  const [profileTokenInput, setProfileTokenInput] = useState<string>("");
  const [profileLxnsTokenInput, setProfileLxnsTokenInput] =
    useState<string>("");
  const [syncsResp, setSyncsResp] = useState<string>("");
  const [syncDetail, setSyncDetail] = useState<string>("");
  const [syncDetailObj, setSyncDetailObj] = useState<SyncDetail | null>(null);
  const [ratingSummary, setRatingSummary] = useState<RatingSummary | null>(
    null
  );
  const [syncs, setSyncs] = useState<any[]>([]);
  const [selectedSyncId, setSelectedSyncId] = useState<string>("");
  const [exportResp, setExportResp] = useState<string>("");
  const [exportLxnsResp, setExportLxnsResp] = useState<string>("");
  const [coverSyncResp, setCoverSyncResp] = useState<string>("");
  const [coverId, setCoverId] = useState<string>("100199");
  const [coverUrl, setCoverUrl] = useState<string>("");
  const [musicSyncResp, setMusicSyncResp] = useState<string>("");
  const [polling, setPolling] = useState(false);

  const canLogin = useMemo(() => friendCode.trim().length > 0, [friendCode]);

  useEffect(() => {
    (async () => {
      const res = await fetchJson<{ status?: string }>("/api/health");
      setHealth(res.ok ? JSON.stringify(res.data) : `HTTP ${res.status}`);
    })();
  }, []);

  useEffect(() => {
    if (!loginReq || token || polling === false) return;

    const handle = setInterval(async () => {
      const res = await fetchJson<any>(
        `/api/auth/login-status?jobId=${loginReq.jobId}`
      );
      if (!res.ok) {
        setJobStatus(`HTTP ${res.status}`);
        return;
      }

      setJobStatus(JSON.stringify(res.data, null, 2));

      if (res.data?.status === "completed" && res.data?.token) {
        setToken(res.data.token);
        setPolling(false);
      }
    }, 1500);

    return () => clearInterval(handle);
  }, [loginReq, token, polling]);

  const startLogin = async () => {
    setToken("");
    setProfileResp("");
    setProfilePatchResp("");
    setJobStatus("");
    setLoginReq(null);
    setPolling(false);

    const res = await fetchJson<LoginRequest>("/api/auth/login-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        friendCode: friendCode.trim(),
        skipUpdateScore,
      }),
    });

    if (res.ok && res.data) {
      setLoginReq(res.data);
      setPolling(true);
    } else {
      setJobStatus(`Login request failed (HTTP ${res.status})`);
    }
  };

  const fetchProfile = async () => {
    setProfileResp("");
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const res = await fetchJson<unknown>("/api/users/profile", { headers });
    if (res.ok) {
      const data = res.data as any;
      setProfileResp(JSON.stringify(data, null, 2));
      setProfileTokenInput(
        typeof data?.divingFishImportToken === "string"
          ? data.divingFishImportToken
          : ""
      );
      setProfileLxnsTokenInput(
        typeof data?.lxnsImportToken === "string" ? data.lxnsImportToken : ""
      );
    } else {
      setProfileResp(`HTTP ${res.status}`);
    }
  };

  const patchProfile = async () => {
    setProfilePatchResp("");
    const headers = token
      ? {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        }
      : { "Content-Type": "application/json" };

    const res = await fetchJson<unknown>("/api/users/profile", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        divingFishImportToken: profileTokenInput || null,
        lxnsImportToken: profileLxnsTokenInput || null,
      }),
    });

    setProfilePatchResp(
      res.ok ? JSON.stringify(res.data, null, 2) : `HTTP ${res.status}`
    );
  };

  const loadSyncs = async () => {
    setSyncsResp("");
    setSyncDetail("");
    setSyncDetailObj(null);
    setRatingSummary(null);
    setExportResp("");
    setExportLxnsResp("");
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const res = await fetchJson<any[]>("/api/sync", { headers });
    if (res.ok) {
      setSyncs(res.data ?? []);
      setSyncsResp(JSON.stringify(res.data, null, 2));
      setSelectedSyncId(res.data?.[0]?.id ?? "");
    } else {
      setSyncsResp(`HTTP ${res.status}`);
      setSyncs([]);
      setSelectedSyncId("");
    }
  };

  const loadSyncDetail = async () => {
    if (!selectedSyncId) return;
    setSyncDetail("");
    setSyncDetailObj(null);
    setRatingSummary(null);
    setExportResp("");
    setExportLxnsResp("");
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const res = await fetchJson<any>(`/api/sync/${selectedSyncId}`, {
      headers,
    });
    if (res.ok) {
      setSyncDetail(JSON.stringify(res.data, null, 2));
      const detail = res.data as SyncDetail;
      setSyncDetailObj(detail);
      setRatingSummary(buildRatingSummary(detail));
    } else {
      setSyncDetail(`HTTP ${res.status}`);
    }
  };

  const exportDivingFish = async () => {
    if (!selectedSyncId) return;
    setExportResp("Running...");
    const headers = token
      ? {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        }
      : { "Content-Type": "application/json" };

    const res = await fetchJson<any>(
      `/api/sync/${selectedSyncId}/diving-fish`,
      {
        method: "POST",
        headers,
      }
    );

    setExportResp(
      res.ok ? JSON.stringify(res.data, null, 2) : `HTTP ${res.status}`
    );
  };

  const exportLxns = async () => {
    if (!selectedSyncId) return;
    setExportLxnsResp("Running...");
    const headers = token
      ? {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        }
      : { "Content-Type": "application/json" };

    const res = await fetchJson<any>(`/api/sync/${selectedSyncId}/lxns`, {
      method: "POST",
      headers,
    });

    setExportLxnsResp(
      res.ok ? JSON.stringify(res.data, null, 2) : `HTTP ${res.status}`
    );
  };

  const triggerCoverSync = async () => {
    setCoverSyncResp("Running...");
    const res = await fetchJson<any>("/api/cover/sync", {
      method: "POST",
    });
    setCoverSyncResp(
      res.ok ? JSON.stringify(res.data, null, 2) : `HTTP ${res.status}`
    );
  };

  const triggerMusicSync = async () => {
    setMusicSyncResp("Running...");
    const res = await fetchJson<any>("/api/music/sync", { method: "POST" });
    setMusicSyncResp(
      res.ok ? JSON.stringify(res.data, null, 2) : `HTTP ${res.status}`
    );
  };

  const showCover = () => {
    if (!coverId.trim()) return;
    setCoverUrl(`/api/cover/${coverId.trim()}`);
  };

  return (
    <div style={{ maxWidth: 720, margin: "24px auto", padding: "0 16px" }}>
      <h1>Login flow tester</h1>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid #ccc",
              background: activeTab === tab.key ? "#0f6cff" : "#fff",
              color: activeTab === tab.key ? "#fff" : "#111",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "login" && (
        <>
          <div className="card" style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              Backend health
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{health}</pre>
          </div>

          <div className="card" style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>
              Step 1: Request login
            </div>
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <label>
                Friend Code
                <input
                  value={friendCode}
                  onChange={(e) => setFriendCode(e.target.value)}
                  style={{ marginLeft: 8 }}
                  placeholder="e.g. 634142510810999"
                  defaultValue={"634142510810999"}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                Skip Update Score
                <input
                  type="checkbox"
                  checked={skipUpdateScore}
                  onChange={(e) => setSkipUpdateScore(e.target.checked)}
                />
              </label>
              <button onClick={startLogin} disabled={!canLogin}>
                Create login job
              </button>
            </div>
            {loginReq && (
              <div style={{ marginTop: 8, fontSize: 14, opacity: 0.8 }}>
                jobId: <code>{loginReq.jobId}</code>
              </div>
            )}
          </div>

          <div className="card" style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>
              Step 2: Poll status
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <button
                onClick={() => setPolling((p) => !p)}
                disabled={!loginReq || !!token}
                style={{ minWidth: 120 }}
              >
                {polling ? "Pause polling" : "Start polling"}
              </button>
              <div style={{ fontSize: 13, opacity: 0.8 }}>
                Polling every 1.5s; stops when token arrives.
              </div>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {jobStatus || "Waiting..."}
            </pre>
          </div>

          <div className="card" style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>
              Step 3: Token
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>JWT</div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  margin: 0,
                }}
              >
                {token || "No token yet"}
              </pre>
            </div>
            <button
              onClick={() => setActiveTab("profile")}
              disabled={!token}
              style={{ minWidth: 180 }}
            >
              Go to Profile tab
            </button>
          </div>
        </>
      )}

      {activeTab === "profile" && (
        <div className="card" style={{ textAlign: "left" }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Profile APIs</div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>JWT</div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                margin: 0,
              }}
            >
              {token || "No token yet"}
            </pre>
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button onClick={fetchProfile} disabled={!token}>
              GET /users/profile
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              divingFishImportToken
              <input
                value={profileTokenInput}
                onChange={(e) => setProfileTokenInput(e.target.value)}
                placeholder="token or empty for null"
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              lxnsImportToken
              <input
                value={profileLxnsTokenInput}
                onChange={(e) => setProfileLxnsTokenInput(e.target.value)}
                placeholder="token or empty for null"
              />
            </label>
            <button onClick={patchProfile} disabled={!token}>
              PATCH /users/profile
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Profile response
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {profileResp || "No profile loaded"}
            </pre>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              PATCH response
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {profilePatchResp || "No patch yet"}
            </pre>
          </div>
        </div>
      )}

      {activeTab === "sync" && (
        <div className="card" style={{ textAlign: "left" }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Sync APIs</div>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={loadSyncs}
              disabled={!token}
              style={{ minWidth: 140 }}
            >
              Load my syncs
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Sync ID
              <select
                value={selectedSyncId}
                onChange={(e) => setSelectedSyncId(e.target.value)}
                disabled={!syncs.length}
              >
                {syncs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} (scores: {s.scoreCount ?? "?"})
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={loadSyncDetail}
              disabled={!token || !selectedSyncId}
            >
              Load detail
            </button>
            <button
              onClick={exportDivingFish}
              disabled={!token || !selectedSyncId}
              style={{ minWidth: 200 }}
            >
              Export to diving-fish
            </button>
            <button
              onClick={exportLxns}
              disabled={!token || !selectedSyncId}
              style={{ minWidth: 200 }}
            >
              Export to LXNS
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync list</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {syncsResp || "No data"}
            </pre>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync detail</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {syncDetail || "No data"}
            </pre>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Export response (diving-fish)
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {exportResp || "Not exported"}
            </pre>
          </div>
          {ratingSummary && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Rating summary (new: top 15, old: top 35)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>Total</div>
                  <div>sum: {ratingSummary.totalSum.toFixed(2)}</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>isNew = true</div>
                  <div>sum: {ratingSummary.newSum.toFixed(2)}</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>isNew = false</div>
                  <div>sum: {ratingSummary.oldSum.toFixed(2)}</div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: "grid", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>Top 15 (isNew=true)</div>
                  <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {ratingSummary.newTop.map((s, idx) => (
                      <li key={`${s.musicId}-${s.cid}-${idx}`}>
                        <span style={{ fontWeight: 600 }}>{s.title}</span> #
                        {s.chartIndex} — rating: {(s.rating ?? 0).toFixed(2)}
                      </li>
                    ))}
                    {!ratingSummary.newTop.length && <div>None</div>}
                  </ol>
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>Top 35 (isNew=false)</div>
                  <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {ratingSummary.oldTop.map((s, idx) => (
                      <li key={`${s.musicId}-${s.cid}-${idx}`}>
                        <span style={{ fontWeight: 600 }}>{s.title}</span> #
                        {s.chartIndex} — rating: {(s.rating ?? 0).toFixed(2)}
                      </li>
                    ))}
                    {!ratingSummary.oldTop.length && <div>None</div>}
                  </ol>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "music" && (
        <div className="card" style={{ textAlign: "left" }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Music sync</div>
          <button onClick={triggerMusicSync} style={{ minWidth: 140 }}>
            Trigger music sync
          </button>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Sync response
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {musicSyncResp || "No sync triggered"}
            </pre>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Export response (LXNS)
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {exportLxnsResp || "No export run"}
            </pre>
          </div>
        </div>
      )}

      {activeTab === "cover" && (
        <div className="card" style={{ textAlign: "left" }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Cover sync</div>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button onClick={triggerCoverSync} style={{ minWidth: 140 }}>
              Sync all covers
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              Cover ID
              <input
                value={coverId}
                onChange={(e) => setCoverId(e.target.value)}
                style={{ width: 140 }}
                placeholder="e.g. 100199 or 00100"
              />
            </label>
            <button onClick={showCover} disabled={!coverId.trim()}>
              Show cover
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Sync response
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {coverSyncResp || "No sync triggered"}
            </pre>
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Cover preview
            </div>
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={`cover-${coverId}`}
                style={{ maxWidth: 180, border: "1px solid #ccc" }}
                onError={() => setCoverSyncResp("Cover not found")}
              />
            ) : (
              <div style={{ opacity: 0.7 }}>No cover loaded</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
