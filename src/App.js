import { useState, useRef, useEffect, useCallback } from "react";

const SHEETS_URL = process.env.REACT_APP_SHEETS_URL;
const ANTHROPIC_API_KEY = process.env.REACT_APP_ANTHROPIC_API_KEY;
const DEFAULT_GOALS = { calories: 2000, protein: 150, carbs: 250, fat: 65 };
const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snacks"];

const FOOD_SYSTEM = `You are a nutrition database. When given a food name or description, return ONLY valid JSON (no markdown, no backticks) in this exact format:
{"name":"Food Name","calories":000,"protein":0,"carbs":0,"fat":0,"serving":"100g or 1 cup etc"}
Estimate nutrition for a standard single serving size.`;

const PHOTO_SYSTEM = `You are a food recognition and nutrition expert. Analyze the food image and return ONLY valid JSON (no markdown, no backticks):
{"name":"Identified Food","calories":000,"protein":0,"carbs":0,"fat":0,"serving":"estimated serving size"}
Be specific. Estimate for the visible portion.`;

async function callClaude(prompt, system) {
  // Keeping the name so you don't have to rename it everywhere
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    mode: "cors", // Add this line
    redirect: "follow", // Add this line
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "proxyAI", prompt, system }),
  });

  const rawText = await res.text();
  // Sometimes Gemini adds ```json backticks, we strip those just in case
  const cleanJson = rawText.replace(/```json|```/g, "").trim();
  return cleanJson;
}

async function sheetsGet() {
  const res = await fetch(SHEETS_URL);
  return res.json();
}

async function sheetsPost(payload) {
  await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload),
  });
}

const Ring = ({ value, goal, size = 96 }) => {
  const r = size / 2 - 8;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(value / goal, 1);
  const over = value > goal;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#f0ece4"
        strokeWidth="7"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={over ? "#e05c5c" : "#2a2118"}
        strokeWidth="7"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)" }}
      />
    </svg>
  );
};

const MacroChip = ({ label, value, goal, color }) => {
  const pct = Math.min((value / goal) * 100, 100);
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "#a09880",
          marginBottom: 3,
          fontFamily: "monospace",
        }}
      >
        <span style={{ textTransform: "uppercase", letterSpacing: 0.8 }}>
          {label}
        </span>
        <span style={{ color: "#3d3322" }}>
          {Math.round(value)}
          <span style={{ color: "#c0b49a" }}>/{goal}</span>
        </span>
      </div>
      <div style={{ height: 3, background: "#ede8de", borderRadius: 2 }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            borderRadius: 2,
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
};

export default function App() {
  const today = new Date().toISOString().split("T")[0];
  const [goals, setGoals] = useState(DEFAULT_GOALS);
  const [log, setLog] = useState({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [view, setView] = useState("today");
  const [meal, setMeal] = useState("Breakfast");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [qty, setQty] = useState(1);
  const [searching, setSearching] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState({
    name: "",
    calories: "",
    protein: "",
    carbs: "",
    fat: "",
  });
  const [editGoals, setEditGoals] = useState(DEFAULT_GOALS);
  const [toast, setToast] = useState(null);
  const fileRef = useRef();
  const camRef = useRef();

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  const fetchData = useCallback(async () => {
    try {
      setSyncing(true);
      const data = await sheetsGet();
      setLog(data.log || {});
      setGoals(data.goals || DEFAULT_GOALS);
      setEditGoals(data.goals || DEFAULT_GOALS);
      setLastSync(new Date());
    } catch {
      showToast("Couldn't sync — check connection", "err");
    }
    setSyncing(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const todayItems = log[today] || [];
  const totals = todayItems.reduce(
    (a, i) => ({
      calories: a.calories + i.calories * i.qty,
      protein: a.protein + i.protein * i.qty,
      carbs: a.carbs + i.carbs * i.qty,
      fat: a.fat + i.fat * i.qty,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const addToLog = async (food) => {
    const id = Date.now();
    const entry = { ...food, qty, meal, id };
    setLog((prev) => ({ ...prev, [today]: [...(prev[today] || []), entry] }));
    setResult(null);
    setQuery("");
    setQty(1);
    setShowCustom(false);
    setCustom({ name: "", calories: "", protein: "", carbs: "", fat: "" });
    showToast(`${food.name} added to ${meal} ✓`);
    await sheetsPost({ action: "add", date: today, ...food, qty, meal, id });
  };

  const removeEntry = async (id) => {
    setLog((prev) => ({
      ...prev,
      [today]: prev[today].filter((e) => e.id !== id),
    }));
    await sheetsPost({ action: "delete", date: today, id });
  };

  const saveGoals = async () => {
    setGoals(editGoals);
    showToast("Goals saved & synced ✓");
    await sheetsPost({ action: "saveGoals", ...editGoals });
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResult(null);
    try {
      const t = await callClaude(`Food: ${query}`, FOOD_SYSTEM);
      setResult(JSON.parse(t.replace(/```json|```/g, "").trim()));
    } catch {
      showToast("Couldn't find that food. Try a different name.", "err");
    }
    setSearching(false);
  };

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoLoading(true);
    setResult(null);
    try {
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const t = await callClaude(
        "Identify and estimate nutrition for this food.",
        PHOTO_SYSTEM,
        { type: file.type, data }
      );
      setResult(JSON.parse(t.replace(/```json|```/g, "").trim()));
    } catch {
      showToast("Couldn't analyse the image. Try a clearer photo.", "err");
    }
    setPhotoLoading(false);
    e.target.value = "";
  };

  const calLeft = goals.calories - Math.round(totals.calories);
  const allDays = Object.keys(log).sort().reverse();

  const s = {
    wrap: {
      minHeight: "100vh",
      background: "#f7f3ec",
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      color: "#2a2118",
    },
    header: {
      background: "#2a2118",
      padding: "0 20px",
      position: "sticky",
      top: 0,
      zIndex: 50,
    },
    headerInner: {
      maxWidth: 540,
      margin: "0 auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 54,
    },
    logo: {
      fontFamily: "Georgia, serif",
      fontSize: 20,
      color: "#f7f3ec",
      letterSpacing: "-0.5px",
      fontStyle: "italic",
    },
    navBtn: (active) => ({
      padding: "5px 14px",
      borderRadius: 20,
      border: "none",
      fontSize: 12,
      fontWeight: 600,
      background: active ? "#f7f3ec" : "transparent",
      color: active ? "#2a2118" : "#a09070",
      cursor: "pointer",
      transition: "all 0.15s",
      fontFamily: "'DM Sans', sans-serif",
    }),
    body: { maxWidth: 540, margin: "0 auto", padding: "20px 16px" },
    card: {
      background: "#fff",
      borderRadius: 16,
      padding: "18px",
      marginBottom: 14,
      border: "1px solid #ede8de",
      boxShadow: "0 1px 3px rgba(42,33,24,0.04)",
    },
    input: {
      width: "100%",
      padding: "11px 14px",
      border: "1px solid #e8e2d6",
      borderRadius: 10,
      fontSize: 14,
      background: "#faf8f4",
      fontFamily: "'DM Sans', sans-serif",
      color: "#2a2118",
      outline: "none",
    },
    btn: (variant = "dark") => ({
      padding: "11px 18px",
      borderRadius: 10,
      border: variant === "outline" ? "1px dashed #c8bfaf" : "none",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      fontFamily: "'DM Sans', sans-serif",
      background: variant === "dark" ? "#2a2118" : "transparent",
      color: variant === "dark" ? "#f7f3ec" : "#2a2118",
    }),
    mealTab: (active) => ({
      flex: 1,
      padding: "8px 4px",
      borderRadius: 8,
      border: "none",
      fontSize: 11,
      fontWeight: 600,
      background: active ? "#2a2118" : "#f7f3ec",
      color: active ? "#f7f3ec" : "#a09880",
      cursor: "pointer",
      fontFamily: "'DM Sans', sans-serif",
      whiteSpace: "nowrap",
    }),
    label: {
      fontSize: 10,
      fontFamily: "monospace",
      textTransform: "uppercase",
      letterSpacing: 1,
      color: "#a09880",
      display: "block",
      marginBottom: 5,
    },
  };

  if (loading)
    return (
      <div
        style={{
          ...s.wrap,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div
          style={{
            fontFamily: "Georgia, serif",
            fontSize: 28,
            fontStyle: "italic",
            color: "#2a2118",
          }}
        >
          nourish.
        </div>
        <div
          style={{
            width: 24,
            height: 24,
            border: "2px solid #e8e2d6",
            borderTopColor: "#2a2118",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
          }}
        />
        <div style={{ fontSize: 13, color: "#a09880" }}>
          Loading your shared log…
        </div>
      </div>
    );

  return (
    <div style={s.wrap}>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      <style>{`
        * { box-sizing: border-box; }
        button:active { transform: scale(0.97); }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes toastIn { from { opacity:0; transform:translateX(-50%) translateY(-10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            zIndex: 999,
            padding: "10px 18px",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            animation: "toastIn 0.25s ease",
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            background: toast.type === "err" ? "#e05c5c" : "#2a2118",
            color: "#fff",
          }}
        >
          {toast.msg}
        </div>
      )}

      <div style={s.header}>
        <div style={s.headerInner}>
          <span style={s.logo}>nourish.</span>
          <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
            {syncing && (
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  border: "1.5px solid #c8b99a",
                  borderTopColor: "transparent",
                  animation: "spin 0.8s linear infinite",
                  marginRight: 4,
                }}
              />
            )}
            {[
              ["today", "Today"],
              ["log", "History"],
              ["goals", "Goals"],
            ].map(([v, l]) => (
              <button
                key={v}
                style={s.navBtn(view === v)}
                onClick={() => setView(v)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {lastSync && (
        <div
          style={{
            textAlign: "center",
            fontSize: 10,
            color: "#b0a090",
            fontFamily: "monospace",
            padding: "5px 0",
            background: "#f0ece4",
          }}
        >
          🔄 synced with Google Sheets ·{" "}
          {lastSync.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      )}

      <div style={s.body}>
        {view === "today" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <div style={{ ...s.card, background: "#2a2118" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <div
                  style={{
                    position: "relative",
                    width: 96,
                    height: 96,
                    flexShrink: 0,
                  }}
                >
                  <Ring
                    value={totals.calories}
                    goal={goals.calories}
                    size={96}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        color: "#f7f3ec",
                        fontFamily: "monospace",
                        lineHeight: 1,
                      }}
                    >
                      {Math.round(totals.calories)}
                    </span>
                    <span
                      style={{
                        fontSize: 9,
                        color: "#8a7a68",
                        fontFamily: "monospace",
                        marginTop: 1,
                      }}
                    >
                      / {goals.calories}
                    </span>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: calLeft > 0 ? "#c8b99a" : "#e05c5c",
                      marginBottom: 14,
                      fontWeight: 500,
                    }}
                  >
                    {calLeft > 0
                      ? `${calLeft} kcal remaining`
                      : `${Math.abs(calLeft)} kcal over goal`}
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <MacroChip
                      label="Protein"
                      value={totals.protein}
                      goal={goals.protein}
                      color="#f7f3ec"
                    />
                    <MacroChip
                      label="Carbs"
                      value={totals.carbs}
                      goal={goals.carbs}
                      color="#a09070"
                    />
                    <MacroChip
                      label="Fat"
                      value={totals.fat}
                      goal={goals.fat}
                      color="#6a5c48"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div style={s.card}>
              <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
                {MEAL_TYPES.map((m) => (
                  <button
                    key={m}
                    style={s.mealTab(meal === m)}
                    onClick={() => setMeal(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  style={s.input}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder={`Search food for ${meal}…`}
                />
                <button
                  style={{ ...s.btn("dark"), opacity: searching ? 0.6 : 1 }}
                  onClick={handleSearch}
                  disabled={searching}
                >
                  {searching ? "…" : "Search"}
                </button>
              </div>
              <input
                type="file"
                accept="image/*"
                ref={fileRef}
                style={{ display: "none" }}
                onChange={handlePhoto}
              />
              <input
                type="file"
                accept="image/*"
                capture="environment"
                ref={camRef}
                style={{ display: "none" }}
                onChange={handlePhoto}
              />
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button
                  style={{
                    ...s.btn("outline"),
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    opacity: photoLoading ? 0.6 : 1,
                  }}
                  onClick={() => fileRef.current.click()}
                  disabled={photoLoading}
                >
                  🖼️ {photoLoading ? "Analysing…" : "Upload Photo"}
                </button>
                <button
                  style={{
                    ...s.btn("outline"),
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    opacity: photoLoading ? 0.6 : 1,
                  }}
                  onClick={() => camRef.current.click()}
                  disabled={photoLoading}
                >
                  📸 Camera
                </button>
              </div>
              <button
                style={{ ...s.btn("outline"), width: "100%", fontSize: 12 }}
                onClick={() => setShowCustom(!showCustom)}
              >
                {showCustom ? "− Hide manual entry" : "+ Enter manually"}
              </button>

              {showCustom && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 14,
                    background: "#faf8f4",
                    borderRadius: 12,
                  }}
                >
                  <input
                    style={{ ...s.input, marginBottom: 10 }}
                    placeholder="Food name *"
                    value={custom.name}
                    onChange={(e) =>
                      setCustom((p) => ({ ...p, name: e.target.value }))
                    }
                  />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4,1fr)",
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    {[
                      ["calories", "kcal"],
                      ["protein", "prot"],
                      ["carbs", "carb"],
                      ["fat", "fat"],
                    ].map(([k, l]) => (
                      <div key={k}>
                        <span style={s.label}>{l}</span>
                        <input
                          type="number"
                          style={{
                            width: "100%",
                            padding: "9px 8px",
                            border: "1px solid #e8e2d6",
                            borderRadius: 8,
                            fontSize: 14,
                            fontFamily: "monospace",
                            background: "#faf8f4",
                            textAlign: "center",
                            color: "#2a2118",
                            outline: "none",
                          }}
                          placeholder="0"
                          value={custom[k]}
                          onChange={(e) =>
                            setCustom((p) => ({ ...p, [k]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    style={{ ...s.btn("dark"), width: "100%" }}
                    onClick={() => {
                      if (!custom.name || !custom.calories)
                        return showToast("Name and calories required", "err");
                      addToLog({
                        name: custom.name,
                        calories: +custom.calories,
                        protein: +custom.protein || 0,
                        carbs: +custom.carbs || 0,
                        fat: +custom.fat || 0,
                        serving: "1 serving",
                      });
                    }}
                  >
                    Add to {meal}
                  </button>
                </div>
              )}

              {result && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 16,
                    background: "#faf8f4",
                    borderRadius: 14,
                    border: "1px solid #e8e2d6",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>
                        {result.name}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#a09880",
                          fontFamily: "monospace",
                          marginTop: 2,
                        }}
                      >
                        {result.serving}
                      </div>
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontWeight: 700,
                        fontSize: 20,
                      }}
                    >
                      {Math.round(result.calories * qty)}
                      <span
                        style={{
                          fontSize: 11,
                          color: "#a09880",
                          fontWeight: 400,
                        }}
                      >
                        {" "}
                        kcal
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    {[
                      ["Protein", result.protein, "#2a2118"],
                      ["Carbs", result.carbs, "#8a7a60"],
                      ["Fat", result.fat, "#b8a890"],
                    ].map(([l, v, c]) => (
                      <div
                        key={l}
                        style={{
                          flex: 1,
                          background: "#fff",
                          borderRadius: 10,
                          padding: "10px 6px",
                          textAlign: "center",
                          border: "1px solid #ede8de",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: "#a09880",
                            fontFamily: "monospace",
                            textTransform: "uppercase",
                          }}
                        >
                          {l}
                        </div>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 16,
                            color: c,
                            fontFamily: "monospace",
                            marginTop: 2,
                          }}
                        >
                          {Math.round(v * qty)}
                          <span style={{ fontSize: 10, fontWeight: 400 }}>
                            g
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        background: "#fff",
                        border: "1px solid #e8e2d6",
                        borderRadius: 10,
                        padding: "8px 14px",
                        gap: 10,
                      }}
                    >
                      <button
                        onClick={() =>
                          setQty((q) => Math.max(0.5, +(q - 0.5).toFixed(1)))
                        }
                        style={{
                          background: "none",
                          border: "none",
                          fontSize: 18,
                          color: "#8a7a68",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        −
                      </button>
                      <span
                        style={{
                          fontFamily: "monospace",
                          fontSize: 14,
                          minWidth: 28,
                          textAlign: "center",
                          fontWeight: 600,
                        }}
                      >
                        {qty}×
                      </span>
                      <button
                        onClick={() => setQty((q) => +(q + 0.5).toFixed(1))}
                        style={{
                          background: "none",
                          border: "none",
                          fontSize: 18,
                          color: "#8a7a68",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        +
                      </button>
                    </div>
                    <button
                      style={{ ...s.btn("dark"), flex: 1 }}
                      onClick={() => addToLog(result)}
                    >
                      Add to {meal}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {MEAL_TYPES.map((m) => {
              const items = todayItems.filter((i) => i.meal === m);
              if (!items.length) return null;
              const mCals = items.reduce((s, i) => s + i.calories * i.qty, 0);
              return (
                <div key={m} style={{ marginBottom: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "0 4px",
                      marginBottom: 6,
                      marginTop: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        color: "#a09880",
                        fontWeight: 600,
                      }}
                    >
                      {m}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "#c8b99a",
                      }}
                    >
                      {Math.round(mCals)} kcal
                    </span>
                  </div>
                  {items.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        background: "#fff",
                        borderRadius: 10,
                        padding: "12px 14px",
                        marginBottom: 4,
                        border: "1px solid #ede8de",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>
                          {item.name}
                          {item.qty !== 1 && (
                            <span style={{ color: "#a09880", fontWeight: 400 }}>
                              {" "}
                              ×{item.qty}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            fontFamily: "monospace",
                            color: "#b0a090",
                            marginTop: 2,
                          }}
                        >
                          P:{Math.round(item.protein * item.qty)}g · C:
                          {Math.round(item.carbs * item.qty)}g · F:
                          {Math.round(item.fat * item.qty)}g
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "monospace",
                            fontWeight: 600,
                            fontSize: 14,
                          }}
                        >
                          {Math.round(item.calories * item.qty)}
                        </span>
                        <button
                          onClick={() => removeEntry(item.id)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#ddd",
                            fontSize: 18,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}

            {todayItems.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: "48px 20px",
                  color: "#c8bfaf",
                }}
              >
                <div style={{ fontSize: 36, marginBottom: 10 }}>🥗</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>
                  Nothing logged yet today
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  Search a food, snap a photo, or add manually above
                </div>
              </div>
            )}
          </div>
        )}

        {view === "log" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <div
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "#a09880",
                marginBottom: 14,
              }}
            >
              Shared History · Google Sheets
            </div>
            {allDays.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: "#c8bfaf",
                  fontSize: 14,
                }}
              >
                No history yet — start logging today!
              </div>
            )}
            {allDays.map((day) => {
              const items = log[day] || [];
              const dc = items.reduce((s, i) => s + i.calories * i.qty, 0);
              const dp = items.reduce((s, i) => s + i.protein * i.qty, 0);
              const dc2 = items.reduce((s, i) => s + i.carbs * i.qty, 0);
              const df = items.reduce((s, i) => s + i.fat * i.qty, 0);
              const over = dc > goals.calories;
              const label =
                day === today
                  ? "Today"
                  : new Date(day + "T12:00:00").toLocaleDateString("en-GB", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    });
              return (
                <div key={day} style={s.card}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 10,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      {label}
                    </span>
                    <span
                      style={{
                        fontFamily: "monospace",
                        fontSize: 15,
                        fontWeight: 700,
                        color: over ? "#e05c5c" : "#2a2118",
                      }}
                    >
                      {Math.round(dc)}{" "}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 400,
                          color: "#a09880",
                        }}
                      >
                        / {goals.calories} kcal
                      </span>
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: "#f0ece4",
                      borderRadius: 2,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min((dc / goals.calories) * 100, 100)}%`,
                        background: over ? "#e05c5c" : "#2a2118",
                        borderRadius: 2,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 16,
                      fontSize: 12,
                      fontFamily: "monospace",
                      color: "#a09880",
                    }}
                  >
                    <span>
                      P: <b style={{ color: "#2a2118" }}>{Math.round(dp)}g</b>
                    </span>
                    <span>
                      C: <b style={{ color: "#2a2118" }}>{Math.round(dc2)}g</b>
                    </span>
                    <span>
                      F: <b style={{ color: "#2a2118" }}>{Math.round(df)}g</b>
                    </span>
                    <span style={{ marginLeft: "auto" }}>
                      {items.length} items
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {view === "goals" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <div
              style={{
                fontSize: 11,
                fontFamily: "monospace",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: "#a09880",
                marginBottom: 14,
              }}
            >
              Daily Targets
            </div>
            <div style={s.card}>
              {[
                ["calories", "Daily Calories", "kcal"],
                ["protein", "Protein", "g"],
                ["carbs", "Carbohydrates", "g"],
                ["fat", "Fat", "g"],
              ].map(([k, l, u]) => (
                <div key={k} style={{ marginBottom: 20 }}>
                  <label style={s.label}>{l}</label>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <input
                      type="number"
                      style={{
                        ...s.input,
                        fontFamily: "monospace",
                        fontSize: 16,
                      }}
                      value={editGoals[k]}
                      onChange={(e) =>
                        setEditGoals((p) => ({ ...p, [k]: +e.target.value }))
                      }
                    />
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: "monospace",
                        color: "#a09880",
                        minWidth: 26,
                      }}
                    >
                      {u}
                    </span>
                  </div>
                </div>
              ))}
              <button
                style={{
                  ...s.btn("dark"),
                  width: "100%",
                  padding: 14,
                  fontSize: 14,
                }}
                onClick={saveGoals}
              >
                Save Goals (syncs to both devices)
              </button>
            </div>
            <div
              style={{
                marginTop: 12,
                padding: "14px 16px",
                background: "#fff8ef",
                borderRadius: 12,
                border: "1px solid #ede0c8",
                fontSize: 12,
                color: "#8a7060",
                lineHeight: 1.6,
              }}
            >
              <b>Tip:</b> Your full food log lives in Google Sheets — open it
              anytime to view, export, or analyse your data.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
