// app.js - main controller for "המתכונים שלי" (My Recipes)
// Single-page vanilla JS app. Renders screens into #app-root based on `state`.

const DEFAULT_CATEGORIES = ["עיקריות", "מרקים", "סלטים", "קינוחים", "מאפים ולחמים", "משקאות", "תוספות"];

const state = {
  screen: "loading", // setup | home | settings | recipeDetail | addChoice | urlImport | recipeForm
  categories: [],
  recipes: [],
  filter: { categoryId: null, favoritesOnly: false, query: "" },
  currentRecipeId: null,
  editingRecipe: null,
  formMode: "new", // new | edit
  setupCategoryDrafts: [],
  urlImportState: { url: "", loading: false, error: "" },
  keepScreenOnEnabled: true,
  wakeLockStatus: "unknown",
  photoViewerIndex: null,
  feedback: [],
  feedbackDraft: { type: "bug", text: "" },
  viewMode: "grid" // grid | list
};

// ---------------- Utilities ----------------
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2list(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("he-IL");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscales/compresses a photo before it goes into IndexedDB. Used for the
// step-by-step process photos, since a recipe can now hold several of them
// and full-resolution camera photos would otherwise bloat local storage fast.
// Falls back to the original file if anything about the canvas conversion fails.
function resizeImageFile(file, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const original = reader.result;
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) {
          resolve(original);
        }
      };
      img.onerror = () => resolve(original);
      img.src = original;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer = null;
function showToast(message, isError) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast";
  }, 3000);
}

function categoryName(id) {
  const c = state.categories.find((c) => c.id === id);
  return c ? c.name : "ללא קטגוריה";
}

// ---------------- Ingredient parsing (sections + optional marking) ----------------
// Convention used in the ingredients textarea:
//   - a line starting with "##" starts a new section, e.g. "## לבצק"
//   - a line ending with "(רשות)" (or containing "אופציונלי"/"optional") is marked optional
// On top of that, lines are auto-detected as section headings even without "##" when they
// look like the short "לרוטב:" / "לעוף/סלמון:" / "מה צריכים:" style labels many recipe sites
// already use - this also means existing/previously-imported recipes benefit automatically,
// without needing the "##" marker or a re-import.
function looksLikeIngredientHeading(line) {
  if (!/[:：]\s*$/.test(line)) return false; // ends with a colon
  if (line.length > 40) return false; // section labels are short
  if (/\d/.test(line)) return false; // quantities almost always include a digit
  const measureWords = /(כוס|כפית|כפות|כף|גרם|ק"ג|קילו|מ"ל|ליטר|יחיד|חבילה|קורט|קמצוץ|חתיכ)/;
  if (measureWords.test(line)) return false;
  return true;
}

function parseIngredientLines(lines) {
  const groups = [];
  let current = { heading: null, items: [] };
  (lines || []).forEach((raw) => {
    const line = String(raw).trim();
    if (!line) return;
    const headingMatch = line.match(/^##\s*(.+)$/);
    if (headingMatch || looksLikeIngredientHeading(line)) {
      const headingText = headingMatch ? headingMatch[1].trim() : line.replace(/[:：]\s*$/, "").trim();
      if (current.items.length || current.heading) groups.push(current);
      current = { heading: headingText, items: [] };
      return;
    }
    const isOptional =
      /\(\s*רשות\s*\)\s*$/.test(line) ||
      /\(\s*optional\s*\)\s*$/i.test(line) ||
      /אופציונלי/.test(line);
    const text = line
      .replace(/\(\s*רשות\s*\)\s*$/, "")
      .replace(/\(\s*optional\s*\)\s*$/i, "")
      .replace(/\s*[-–]?\s*אופציונלי\s*$/, "")
      .trim();
    current.items.push({ text, optional: isOptional });
  });
  if (current.items.length || current.heading) groups.push(current);
  return groups;
}

function buildIngredientsHtml(ingredients) {
  const groups = parseIngredientLines(ingredients);
  if (!groups.length) return '<p class="hint-text">לא הוזנו מרכיבים</p>';
  return groups
    .map((g) => {
      const heading = g.heading
        ? `<div class="ingredient-group-title">${escapeHtml(g.heading)}</div>`
        : "";
      const items = g.items
        .map(
          (it) =>
            `<li class="${it.optional ? "optional" : ""}">${escapeHtml(it.text)}${
              it.optional ? '<span class="optional-badge">רשות</span>' : ""
            }</li>`
        )
        .join("");
      return `${heading}<ul class="ingredients-list">${items}</ul>`;
    })
    .join("");
}

// ---------------- Instruction parsing (component groups) ----------------
// Some recipe sites write instructions per component, with the label inline at the
// start of the paragraph, e.g. "להכנת העוף/סלמון: בסיר עם מים רותחים, כף מלח..." -
// this detects that leading "label:" prefix (or an explicit "## label" line) and
// groups the steps under it, same idea as the ingredient sections above.
function looksLikeInstructionHeadingPrefix(prefix) {
  const p = prefix.trim();
  if (!p || p.length > 30) return false;
  if (/\d/.test(p)) return false;
  return true;
}

function parseInstructionLines(lines) {
  const groups = [];
  let current = { heading: null, items: [] };
  (lines || []).forEach((raw) => {
    const line = String(raw).trim();
    if (!line) return;
    const explicitHeading = line.match(/^##\s*(.+)$/);
    if (explicitHeading) {
      if (current.items.length || current.heading) groups.push(current);
      current = { heading: explicitHeading[1].trim(), items: [] };
      return;
    }
    // Only match a "label:" prefix at the very START of the line - a colon appearing
    // later mid-sentence (e.g. "...נתבל ב: סויה, דבש...") is left untouched.
    const inlineMatch = line.match(/^([^:：]{1,30}?)[:：]\s*(.+)$/);
    if (inlineMatch && looksLikeInstructionHeadingPrefix(inlineMatch[1])) {
      if (current.items.length || current.heading) groups.push(current);
      current = { heading: inlineMatch[1].trim(), items: [inlineMatch[2].trim()] };
      return;
    }
    current.items.push(line);
  });
  if (current.items.length || current.heading) groups.push(current);
  return groups;
}

function buildInstructionsHtml(instructions) {
  const groups = parseInstructionLines(instructions);
  if (!groups.length) return '<p class="hint-text">לא הוזנו הוראות</p>';
  return groups
    .map((g) => {
      const heading = g.heading
        ? `<div class="ingredient-group-title">${escapeHtml(g.heading)}</div>`
        : "";
      const items = g.items.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      return `${heading}<ol class="instructions-list">${items}</ol>`;
    })
    .join("");
}

// ---------------- Init ----------------
document.addEventListener("DOMContentLoaded", init);

async function init() {
  const savedKeepScreenOn = await DB.getMeta("keepScreenOnEnabled");
  state.keepScreenOnEnabled = savedKeepScreenOn === undefined ? true : !!savedKeepScreenOn;
  const savedViewMode = await DB.getMeta("recipeViewMode");
  state.viewMode = savedViewMode === "list" ? "list" : "grid";

  WakeLockManager.onStatusChange((status) => {
    state.wakeLockStatus = status;
    if (state.screen === "settings") render();
  });
  WakeLockManager.init(state.keepScreenOnEnabled);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearStainTimer();
    } else if (state.screen === "recipeDetail" && state.currentRecipeId) {
      scheduleStainTimer(state.currentRecipeId);
    }
  });

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./service-worker.js");
    } catch (e) {
      console.warn("Service worker registration failed:", e);
    }
  }

  await refreshData();
  const setupDone = await DB.getMeta("setupDone");
  if (!setupDone || state.categories.length === 0) {
    state.screen = "setup";
    state.setupCategoryDrafts = DEFAULT_CATEGORIES.slice();
  } else {
    state.screen = "home";
  }
  render();
}

async function refreshData() {
  state.categories = await DB.getAllCategories();
  state.recipes = await DB.getAllRecipes();
  state.feedback = await DB.getAllFeedback();
}

// ---------------- Render dispatcher ----------------
function root() {
  return document.getElementById("app-root");
}

function render() {
  const r = root();
  switch (state.screen) {
    case "setup":
      r.innerHTML = renderSetupScreen();
      break;
    case "home":
      r.innerHTML = renderHomeScreen();
      updateRecipeList();
      break;
    case "settings":
      r.innerHTML = renderSettingsScreen();
      break;
    case "recipeDetail":
      r.innerHTML = renderRecipeDetailScreen();
      break;
    case "addChoice":
      r.innerHTML = renderAddChoiceScreen();
      break;
    case "urlImport":
      r.innerHTML = renderUrlImportScreen();
      break;
    case "recipeForm":
      r.innerHTML = renderRecipeFormScreen();
      break;
    default:
      r.innerHTML = '<div class="loading">טוען...</div>';
  }
}

function goHome() {
  clearStainTimer();
  state.screen = "home";
  render();
}

// ---------------- Setup screen ----------------
function renderSetupScreen() {
  const items = state.setupCategoryDrafts
    .map(
      (name, i) => `
      <div class="setup-cat-row">
        <input type="text" class="input" value="${escapeHtml(name)}"
          oninput="setupCategoryEdit(${i}, this.value)" placeholder="שם נושא" />
        <button class="icon-btn danger" onclick="setupCategoryRemove(${i})" aria-label="הסר">✕</button>
      </div>`
    )
    .join("");

  return `
    <div class="screen setup-screen">
      <div class="setup-hero">
        <h1>ברוכים הבאים 👋</h1>
        <p>לפני שנתחיל, בואו נגדיר נושאים (קטגוריות) לאחסון המתכונים שלכם.<br/>
        אפשר תמיד להוסיף, לשנות או למחוק נושאים בהמשך דרך ההגדרות.</p>
      </div>
      <div class="setup-cats">${items}</div>
      <button class="btn secondary full" onclick="setupCategoryAdd()">+ הוספת נושא</button>
      <button class="btn primary full" onclick="finishSetup()">המשך לאפליקציה</button>
    </div>`;
}

function setupCategoryEdit(i, value) {
  state.setupCategoryDrafts[i] = value;
}
function setupCategoryAdd() {
  state.setupCategoryDrafts.push("");
  render();
}
function setupCategoryRemove(i) {
  state.setupCategoryDrafts.splice(i, 1);
  render();
}
async function finishSetup() {
  const names = state.setupCategoryDrafts.map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    await DB.addCategory(name);
  }
  await DB.setMeta("setupDone", true);
  await refreshData();
  state.screen = "home";
  render();
}

// ---------------- Home screen ----------------
function renderHomeScreen() {
  const chips = [
    `<button class="chip ${!state.filter.categoryId && !state.filter.favoritesOnly ? "active" : ""}"
        onclick="setFilterAll()">הכל</button>`,
    `<button class="chip ${state.filter.favoritesOnly ? "active" : ""}"
        onclick="setFilterFavorites()">⭐ מועדפים</button>`,
    ...state.categories.map(
      (c) => `<button class="chip ${state.filter.categoryId === c.id ? "active" : ""}"
        onclick="setFilterCategory('${c.id}')">${escapeHtml(c.name)}</button>`
    )
  ].join("");

  return `
    <div class="screen home-screen">
      <div class="topbar">
        <h1 class="app-title">המתכונים שלי</h1>
      </div>
      <div class="search-wrap">
        <div class="search-row">
          <input id="search-input" class="input search-input" type="search"
            placeholder="חיפוש מתכון, מרכיב או קטגוריה..."
            value="${escapeHtml(state.filter.query)}"
            oninput="onSearchInput(this.value)" />
          <div class="view-toggle">
            <button class="view-toggle-btn ${state.viewMode === "grid" ? "active" : ""}"
              onclick="setViewMode('grid')" aria-label="תצוגת רשת">🔲</button>
            <button class="view-toggle-btn ${state.viewMode === "list" ? "active" : ""}"
              onclick="setViewMode('list')" aria-label="תצוגת רשימה">📋</button>
          </div>
        </div>
      </div>
      <div class="chips-row">${chips}</div>
      <div id="recipe-list" class="recipe-list"></div>
    </div>
    <button class="fab" onclick="openAddChoice()" aria-label="הוספת מתכון">+</button>
    ${renderBottomNav("home")}`;
}

function renderBottomNav(active) {
  return `
    <div class="bottom-nav">
      <button class="nav-btn ${active === "home" ? "active" : ""}" onclick="goHome()">
        <span class="nav-icon">🏠</span><span>בית</span>
      </button>
      <button class="nav-btn ${active === "settings" ? "active" : ""}" onclick="openSettings()">
        <span class="nav-icon">⚙️</span><span>הגדרות</span>
      </button>
    </div>`;
}

function onSearchInput(value) {
  state.filter.query = value;
  updateRecipeList();
}
function setFilterAll() {
  state.filter.categoryId = null;
  state.filter.favoritesOnly = false;
  render();
}
function setFilterFavorites() {
  state.filter.favoritesOnly = true;
  state.filter.categoryId = null;
  render();
}
function setFilterCategory(id) {
  state.filter.categoryId = id;
  state.filter.favoritesOnly = false;
  render();
}

async function setViewMode(mode) {
  if (state.viewMode === mode) return;
  state.viewMode = mode === "list" ? "list" : "grid";
  await DB.setMeta("recipeViewMode", state.viewMode);
  render();
}

function matchesFilter(recipe) {
  if (state.filter.favoritesOnly && !recipe.favorite) return false;
  if (state.filter.categoryId && recipe.categoryId !== state.filter.categoryId) return false;
  const q = state.filter.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    recipe.title,
    (recipe.ingredients || []).join(" "),
    (recipe.instructions || []).join(" "),
    recipe.notes,
    categoryName(recipe.categoryId)
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function updateRecipeList() {
  const container = document.getElementById("recipe-list");
  if (!container) return;
  const filtered = state.recipes.filter(matchesFilter);
  container.className = state.viewMode === "list" ? "recipe-list recipe-list-rows" : "recipe-list";
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <p>לא נמצאו מתכונים.</p>
      <p>אפשר להוסיף מתכון חדש בלחיצה על +</p>
    </div>`;
    return;
  }
  const buildFn = state.viewMode === "list" ? buildRecipeRowHTML : buildRecipeCardHTML;
  container.innerHTML = filtered.map(buildFn).join("");
}

function buildRecipeCardHTML(recipe) {
  const thumb = recipe.imageDataUrl
    ? `<img class="card-thumb" src="${recipe.imageDataUrl}" alt="" />`
    : `<div class="card-thumb placeholder">🍲</div>`;
  const stainsMini = buildStainsMiniHtml(recipe.stains);
  return `
    <div class="recipe-card" onclick="openRecipeDetail('${recipe.id}')">
      <div class="card-thumb-wrap">
        ${thumb}
        ${stainsMini}
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(recipe.title || "(ללא כותרת)")}</div>
        <div class="card-meta">
          <span class="badge">${escapeHtml(categoryName(recipe.categoryId))}</span>
          ${recipe.favorite ? '<span class="fav-star">⭐</span>' : ""}
        </div>
      </div>
    </div>`;
}

function buildRecipeRowHTML(recipe) {
  const thumb = recipe.imageDataUrl
    ? `<img class="row-thumb" src="${recipe.imageDataUrl}" alt="" />`
    : `<div class="row-thumb placeholder">🍲</div>`;
  return `
    <div class="recipe-row" onclick="openRecipeDetail('${recipe.id}')">
      ${thumb}
      <div class="row-body">
        <div class="row-title">${escapeHtml(recipe.title || "(ללא כותרת)")}</div>
        <div class="row-meta">
          <span class="badge">${escapeHtml(categoryName(recipe.categoryId))}</span>
          ${recipe.favorite ? '<span class="fav-star">⭐</span>' : ""}
        </div>
      </div>
    </div>`;
}

// ---------------- Recipe detail screen ----------------
function openRecipeDetail(id) {
  state.currentRecipeId = id;
  state.photoViewerIndex = null;
  state.screen = "recipeDetail";
  scheduleStainTimer(id);
  render();
}

function renderRecipeDetailScreen() {
  const recipe = state.recipes.find((r) => r.id === state.currentRecipeId);
  if (!recipe) {
    return `<div class="screen"><p>המתכון לא נמצא.</p>
      <button class="btn secondary" onclick="goHome()">חזרה</button></div>`;
  }
  const ingredientsHtml = buildIngredientsHtml(recipe.ingredients);
  const instructionsHtml = buildInstructionsHtml(recipe.instructions);
  const photo = recipe.imageDataUrl
    ? `<img class="detail-photo" src="${recipe.imageDataUrl}" alt="תמונת המתכון" />`
    : "";
  const source = recipe.sourceUrl
    ? `<p class="source-line">מקור: <a href="${escapeHtml(recipe.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(recipe.sourceUrl)}</a></p>`
    : "";
  const notes = recipe.notes
    ? `<div class="section"><h3>הערות</h3><p class="notes-text">${escapeHtml(recipe.notes)}</p></div>`
    : "";
  const processPhotosHtml = buildProcessPhotosDetailHtml(recipe.processPhotos);
  const viewerHtml = buildPhotoViewerHtml(recipe);
  const stainsHtml = buildStainsHtml(recipe.stains);

  return `
    <div class="screen detail-screen">
      <div class="topbar with-back">
        <button class="icon-btn" onclick="goHome()" aria-label="חזרה">→</button>
        <h1 class="app-title">${escapeHtml(recipe.title || "מתכון")}</h1>
        <button class="icon-btn ${recipe.favorite ? "fav-active" : ""}" onclick="toggleFavorite('${recipe.id}')" aria-label="מועדף">
          ${recipe.favorite ? "⭐" : "☆"}
        </button>
      </div>
      <div class="detail-content print-view">
        ${stainsHtml}
        ${photo}
        <div class="badge">${escapeHtml(categoryName(recipe.categoryId))}</div>
        <div class="section">
          <h3>מרכיבים</h3>
          ${ingredientsHtml}
        </div>
        <div class="section">
          <h3>אופן ההכנה</h3>
          ${instructionsHtml}
        </div>
        ${processPhotosHtml}
        ${notes}
        ${source}
        <p class="meta-line">עודכן לאחרונה: ${formatDate(recipe.updatedAt)}</p>
      </div>
      <div class="detail-actions">
        <button class="btn secondary" onclick="openEditRecipe('${recipe.id}')">✏️ עריכה</button>
        <button class="btn secondary" onclick="shareRecipeAsPdf('${recipe.id}')">📤 שיתוף</button>
        <button class="btn danger" onclick="confirmDeleteRecipe('${recipe.id}')">🗑️ מחיקה</button>
      </div>
    </div>
    ${viewerHtml}`;
}

// ---------------- "Stains" - a well-loved recipe shows wear ----------------
// Opening a recipe and leaving it open for a while adds one translucent, randomly
// placed stain mark along the margins of the page - like a paper recipe book
// slowly picking up cooking stains on its most-used pages. Never touches content
// area; purely decorative and never shown in the shared PDF.
const STAIN_DELAY_MS = 60 * 1000;
const STAIN_ZONES = [
  // [xMin, xMax, yMin, yMax] as % of the detail content box - biased to corners/edges.
  [2, 16, 2, 16],
  [84, 98, 2, 16],
  [2, 16, 84, 98],
  [84, 98, 84, 98],
  [1, 7, 20, 80],
  [93, 99, 20, 80],
  [20, 80, 0.5, 4],
  [20, 80, 96, 99.5]
];
let stainTimer = null;

function clearStainTimer() {
  if (stainTimer) {
    clearTimeout(stainTimer);
    stainTimer = null;
  }
}

function scheduleStainTimer(recipeId) {
  clearStainTimer();
  stainTimer = setTimeout(async () => {
    stainTimer = null;
    if (state.screen !== "recipeDetail" || state.currentRecipeId !== recipeId) return;
    try {
      await DB.addStain(recipeId, randomStain());
      await refreshData();
      if (state.screen === "recipeDetail" && state.currentRecipeId === recipeId) render();
    } catch (e) {
      console.warn("Failed to add stain:", e);
    }
  }, STAIN_DELAY_MS);
}

function randomStain() {
  const zone = STAIN_ZONES[Math.floor(Math.random() * STAIN_ZONES.length)];
  const x = zone[0] + Math.random() * (zone[1] - zone[0]);
  const y = zone[2] + Math.random() * (zone[3] - zone[2]);
  return {
    x: +x.toFixed(1),
    y: +y.toFixed(1),
    size: Math.round(32 + Math.random() * 34),
    rot: Math.floor(Math.random() * 360),
    variant: Math.floor(Math.random() * 4) + 1,
    opacity: +(0.55 + Math.random() * 0.4).toFixed(2)
  };
}

// Renders one stored stain as a small "splash cluster" - a main blob plus a
// smaller satellite droplet offset toward its stored rotation angle - since a
// single isolated blob reads as a tidy dome/sphere rather than an irregular
// dried splash. Both pieces derive entirely from the one persisted {x,y,size,
// rot,variant,opacity} record, so nothing extra needs to be stored.
function renderStainCluster(s, { satellite = true } = {}) {
  const main = `<div class="stain-mark stain-v${s.variant}" style="left:${s.x}%; top:${s.y}%; width:${s.size}px; height:${s.size}px; transform:translate(-50%,-50%) rotate(${s.rot}deg); opacity:${s.opacity};"></div>`;
  if (!satellite) return main;
  const angle = ((s.rot % 360) * Math.PI) / 180;
  const dist = s.size * 0.4;
  const dx = Math.round(Math.cos(angle) * dist);
  const dy = Math.round(Math.sin(angle) * dist);
  const satSize = Math.max(10, Math.round(s.size * 0.46));
  const satVariant = (s.variant % 4) + 1;
  const satOpacity = +(s.opacity * 0.7).toFixed(2);
  const sat = `<div class="stain-mark stain-v${satVariant}" style="left:calc(${s.x}% + ${dx}px); top:calc(${s.y}% + ${dy}px); width:${satSize}px; height:${satSize}px; transform:translate(-50%,-50%) rotate(${(s.rot + 35) % 360}deg); opacity:${satOpacity};"></div>`;
  return main + sat;
}

function buildStainsHtml(stains) {
  if (!stains || !stains.length) return "";
  const marks = stains.map((s) => renderStainCluster(s)).join("");
  return `<div class="stains-layer" aria-hidden="true">${marks}</div>`;
}

// Small reflection of the same stains on the home-screen card thumbnail, so a
// well-used recipe is recognizable at a glance - like spotting the dog-eared,
// stained pages in a paper cookbook.
function buildStainsMiniHtml(stains) {
  if (!stains || !stains.length) return "";
  const shown = stains.slice(-3);
  const offsets = [
    [0, 0],
    [12, 8],
    [-8, 11]
  ];
  const marks = shown
    .map((s, i) => {
      const [dx, dy] = offsets[i] || [0, 0];
      return `<div class="stain-mark stain-v${s.variant}" style="left:calc(50% + ${dx}px); top:calc(50% + ${dy}px); width:15px; height:15px; transform:translate(-50%,-50%) rotate(${s.rot}deg);"></div>`;
    })
    .join("");
  return `<div class="card-stains-mini" aria-hidden="true">${marks}</div>`;
}

// The "process photos" media list can hold either images or short videos (both
// stored as data URLs). We don't tag items with a type field - we just sniff
// the data URL's mime prefix - so this is the single place that decides which
// tag (<img> vs <video>) a given item needs to render as.
function isVideoDataUrl(src) {
  return typeof src === "string" && src.startsWith("data:video");
}

function buildProcessPhotosDetailHtml(photos) {
  if (!photos || !photos.length) return "";
  const thumbs = photos
    .map((src, i) =>
      isVideoDataUrl(src)
        ? `<video class="process-photo-thumb" src="${src}" muted playsinline onclick="openProcessPhotoViewer(${i})"></video>`
        : `<img class="process-photo-thumb" src="${src}" alt="שלב ${i + 1} בהכנה" onclick="openProcessPhotoViewer(${i})" />`
    )
    .join("");
  return `
    <div class="section">
      <h3>תמונות</h3>
      <div class="process-photos-strip">${thumbs}</div>
    </div>`;
}

function buildPhotoViewerHtml(recipe) {
  const photos = recipe.processPhotos || [];
  if (state.photoViewerIndex === null || !photos[state.photoViewerIndex]) return "";
  const src = photos[state.photoViewerIndex];
  const mediaEl = isVideoDataUrl(src)
    ? `<video src="${src}" controls playsinline onclick="event.stopPropagation()"></video>`
    : `<img src="${src}" alt="" onclick="event.stopPropagation()" />`;
  return `
    <div class="photo-viewer" onclick="closeProcessPhotoViewer()">
      <button class="icon-btn photo-viewer-close" onclick="event.stopPropagation(); closeProcessPhotoViewer()" aria-label="סגירה">✕</button>
      ${mediaEl}
      <div class="photo-viewer-nav" onclick="event.stopPropagation()">
        <button class="icon-btn" onclick="stepProcessPhotoViewer(-1)" aria-label="הקודם">›</button>
        <span class="photo-viewer-counter">${state.photoViewerIndex + 1} / ${photos.length}</span>
        <button class="icon-btn" onclick="stepProcessPhotoViewer(1)" aria-label="הבא">‹</button>
      </div>
    </div>`;
}

function openProcessPhotoViewer(index) {
  state.photoViewerIndex = index;
  render();
}

function closeProcessPhotoViewer() {
  state.photoViewerIndex = null;
  render();
}

function stepProcessPhotoViewer(delta) {
  const recipe = state.recipes.find((r) => r.id === state.currentRecipeId);
  const photos = (recipe && recipe.processPhotos) || [];
  if (!photos.length || state.photoViewerIndex === null) return;
  state.photoViewerIndex = (state.photoViewerIndex + delta + photos.length) % photos.length;
  render();
}

async function toggleFavorite(id) {
  await DB.toggleFavorite(id);
  await refreshData();
  render();
}

async function confirmDeleteRecipe(id) {
  if (!confirm("למחוק את המתכון? לא ניתן לשחזר לאחר המחיקה.")) return;
  await DB.deleteRecipe(id);
  await refreshData();
  showToast("המתכון נמחק");
  goHome();
}

// ---------------- Share a single recipe as a PDF ----------------
// No backend and no external libraries (stays usable offline) - the recipe is
// laid out onto one or more off-screen canvases (using the exact same grouped
// ingredients/instructions data the on-screen view uses), each canvas becomes a
// JPEG, and those JPEGs are wrapped directly into a hand-built, minimal multi-page
// PDF (one full-page image per page - no font embedding needed since the canvas
// already rendered the Hebrew text correctly via the browser's own text layout).
// Deliberately leaves out the "stains" - those are this device's personal wear,
// not something to hand to someone else.
const PDF_PAGE_W = 1240;
const PDF_PAGE_H = 1754;
const PDF_MARGIN = 80;

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

function pdfWrapText(ctx, text, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (current && ctx.measureText(test).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Builds the recipe pages and returns an array of page <canvas> elements.
async function buildRecipePdfCanvases(recipe) {
  const contentW = PDF_PAGE_W - PDF_MARGIN * 2;
  const rightEdge = PDF_PAGE_W - PDF_MARGIN;
  const FONT = '"Segoe UI","Noto Sans Hebrew",Arial,sans-serif';
  const pages = [];
  let canvas, ctx, y;

  function newPage() {
    canvas = document.createElement("canvas");
    canvas.width = PDF_PAGE_W;
    canvas.height = PDF_PAGE_H;
    ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fffdf8";
    ctx.fillRect(0, 0, PDF_PAGE_W, PDF_PAGE_H);
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    y = PDF_MARGIN;
  }
  function finishPage() {
    pages.push(canvas);
  }
  function ensureSpace(h) {
    if (y + h > PDF_PAGE_H - PDF_MARGIN) {
      finishPage();
      newPage();
    }
  }
  function drawParagraph(text, { size = 17, weight = "400", color = "#3a2c1f", lineHeight } = {}) {
    const lh = lineHeight || Math.round(size * 1.55);
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    const lines = pdfWrapText(ctx, text, contentW);
    lines.forEach((line) => {
      ensureSpace(lh);
      ctx.fillText(line, rightEdge, y + size);
      y += lh;
    });
  }
  function drawSectionHeader(text) {
    y += 10;
    ensureSpace(60);
    ctx.font = `700 24px ${FONT}`;
    ctx.fillStyle = "#7a4f2a";
    ctx.fillText(text, rightEdge, y + 24);
    y += 34;
    ctx.strokeStyle = "#f0e2c9";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PDF_MARGIN, y);
    ctx.lineTo(rightEdge, y);
    ctx.stroke();
    y += 18;
  }
  function drawMarkedLine(marker, text, { color = "#3a2c1f", indent = 30 } = {}) {
    const size = 17;
    const lh = 26;
    ctx.font = `400 ${size}px ${FONT}`;
    const lines = pdfWrapText(ctx, text, contentW - indent);
    lines.forEach((line, i) => {
      ensureSpace(lh);
      ctx.fillStyle = color;
      ctx.fillText(line, rightEdge - indent, y + size);
      if (i === 0) {
        ctx.fillText(marker, rightEdge, y + size);
      }
      y += lh;
    });
  }

  newPage();

  // Title
  ctx.font = `700 32px ${FONT}`;
  ctx.fillStyle = "#7a4f2a";
  pdfWrapText(ctx, recipe.title || "מתכון", contentW).forEach((line) => {
    ensureSpace(42);
    ctx.fillText(line, rightEdge, y + 32);
    y += 42;
  });

  const metaBits = [categoryName(recipe.categoryId), recipe.favorite ? "⭐ מועדף" : ""].filter(Boolean);
  if (metaBits.length) {
    y += 2;
    drawParagraph(metaBits.join("   •   "), { size: 15, color: "#8a7a5f", lineHeight: 22 });
  }
  y += 16;

  // Main photo
  if (recipe.imageDataUrl) {
    try {
      const img = await loadImageEl(recipe.imageDataUrl);
      const maxPhotoH = 420;
      let w = contentW;
      let h = (img.height / img.width) * w;
      if (h > maxPhotoH) {
        h = maxPhotoH;
        w = (img.width / img.height) * h;
      }
      ensureSpace(h + 18);
      const x = PDF_MARGIN + (contentW - w) / 2;
      ctx.save();
      roundRectPath(ctx, x, y, w, h, 16);
      ctx.clip();
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      y += h + 24;
    } catch (e) {
      console.warn("PDF: failed to draw main photo:", e);
    }
  }

  // Ingredients
  drawSectionHeader("מרכיבים");
  const ingGroups = parseIngredientLines(recipe.ingredients);
  if (!ingGroups.length) {
    drawParagraph("לא הוזנו מרכיבים", { size: 16, color: "#8a7a5f" });
  } else {
    ingGroups.forEach((g) => {
      if (g.heading) {
        y += 6;
        drawParagraph(g.heading, { size: 18, weight: "700", color: "#a8582f", lineHeight: 26 });
      }
      g.items.forEach((it) => {
        const label = it.optional ? `${it.text}  (רשות)` : it.text;
        drawMarkedLine("•", label, { color: it.optional ? "#8a7a5f" : "#3a2c1f" });
      });
      y += 10;
    });
  }
  y += 8;

  // Instructions
  drawSectionHeader("אופן ההכנה");
  const insGroups = parseInstructionLines(recipe.instructions);
  if (!insGroups.length) {
    drawParagraph("לא הוזנו הוראות", { size: 16, color: "#8a7a5f" });
  } else {
    insGroups.forEach((g) => {
      if (g.heading) {
        y += 6;
        drawParagraph(g.heading, { size: 18, weight: "700", color: "#a8582f", lineHeight: 26 });
      }
      g.items.forEach((s, i) => {
        drawMarkedLine(`${i + 1}.`, s, { indent: 36 });
      });
      y += 10;
    });
  }

  // Notes
  if (recipe.notes) {
    y += 8;
    drawSectionHeader("הערות");
    drawParagraph(recipe.notes, { size: 15.5, lineHeight: 23 });
  }

  // Source
  if (recipe.sourceUrl) {
    y += 14;
    drawParagraph(`מקור: ${recipe.sourceUrl}`, { size: 12.5, color: "#8a7a5f", lineHeight: 18 });
  }

  finishPage();
  return pages;
}

function canvasToJpegBytes(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("toBlob failed"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      quality
    );
  });
}

// Hand-rolled minimal multi-page PDF writer: one full-page JPEG image per page,
// no fonts/text objects needed since the text was already rasterized onto the
// canvas. Produces a byte-exact, spec-valid PDF (checked against pypdf in testing).
function buildPdfFromJpegPages(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const objOffsets = [];

  function push(data) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  }
  function beginObj(num) {
    objOffsets[num] = offset;
    push(`${num} 0 obj\n`);
  }
  function endObj() {
    push("endobj\n");
  }

  const n = pages.length;
  const pageObjNums = [];
  for (let i = 0; i < n; i++) pageObjNums.push(3 + i * 3);

  push("%PDF-1.4\n");

  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObj();

  beginObj(2);
  push(`<< /Type /Pages /Kids [${pageObjNums.map((num) => `${num} 0 R`).join(" ")}] /Count ${n} >>\n`);
  endObj();

  pages.forEach((p, i) => {
    const pageObj = 3 + i * 3;
    const imgObj = 4 + i * 3;
    const contentObj = 5 + i * 3;
    const w = p.width;
    const h = p.height;

    beginObj(pageObj);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\n`
    );
    endObj();

    beginObj(imgObj);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    );
    push(p.jpeg);
    push("\nendstream\n");
    endObj();

    const contentStr = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    const contentBytes = enc.encode(contentStr);
    beginObj(contentObj);
    push(`<< /Length ${contentBytes.length} >>\nstream\n`);
    push(contentBytes);
    push("\nendstream\n");
    endObj();
  });

  const xrefOffset = offset;
  const totalObjs = 2 + n * 3;
  push(`xref\n0 ${totalObjs + 1}\n`);
  push("0000000000 65535 f\r\n");
  for (let i = 1; i <= totalObjs; i++) {
    const off = objOffsets[i] || 0;
    push(off.toString().padStart(10, "0") + " 00000 n\r\n");
  }
  push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

async function buildRecipePdfBytes(recipe) {
  const canvases = await buildRecipePdfCanvases(recipe);
  const pages = [];
  for (const c of canvases) {
    const jpeg = await canvasToJpegBytes(c, 0.88);
    pages.push({ width: c.width, height: c.height, jpeg });
  }
  return buildPdfFromJpegPages(pages);
}

function downloadBinaryBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function shareRecipeAsPdf(id) {
  const recipe = state.recipes.find((r) => r.id === id);
  if (!recipe) return;
  showToast("מכין PDF לשיתוף...");
  try {
    const pdfBytes = await buildRecipePdfBytes(recipe);
    const safeTitle = (recipe.title || "מתכון").replace(/[\\/:*?"<>|]/g, " ").trim() || "מתכון";
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const file = new File([blob], `${safeTitle}.pdf`, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: recipe.title || "מתכון" });
    } else {
      downloadBinaryBlob(blob, `${safeTitle}.pdf`);
      showToast("קובץ ה-PDF הורד - אפשר לצרף אותו ידנית בהודעה או במייל");
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelled the share sheet
    console.warn("PDF share failed:", e);
    showToast("שגיאה ביצירת ה-PDF לשיתוף", true);
  }
}

// ---------------- Add flow: choice screen ----------------
function openAddChoice() {
  state.screen = "addChoice";
  render();
}

function renderAddChoiceScreen() {
  return `
    <div class="screen">
      <div class="topbar with-back">
        <button class="icon-btn" onclick="goHome()" aria-label="חזרה">→</button>
        <h1 class="app-title">הוספת מתכון</h1>
        <span></span>
      </div>
      <div class="choice-list">
        <button class="choice-card" onclick="startPhotoFlow()">
          <div class="choice-icon">📷</div>
          <div>
            <div class="choice-title">סריקת מתכון כתוב ביד</div>
            <div class="choice-sub">צלמו את הדף הכתוב, ואז הקלידו את המתכון לתצוגה נקייה</div>
          </div>
        </button>
        <button class="choice-card" onclick="startUrlFlow()">
          <div class="choice-icon">🌐</div>
          <div>
            <div class="choice-title">ייבוא מהאינטרנט</div>
            <div class="choice-sub">הדביקו קישור לאתר מתכונים וננסה למלא אוטומטית</div>
          </div>
        </button>
        <button class="choice-card" onclick="startManualFlow()">
          <div class="choice-icon">✏️</div>
          <div>
            <div class="choice-title">הזנה ידנית</div>
            <div class="choice-sub">כתיבת מתכון חדש מאפס</div>
          </div>
        </button>
      </div>
    </div>`;
}

function blankRecipeDraft() {
  return {
    id: null,
    title: "",
    categoryId: state.categories[0] ? state.categories[0].id : null,
    favorite: false,
    ingredients: [],
    instructions: [],
    notes: "",
    sourceUrl: "",
    imageDataUrl: null,
    processPhotos: []
  };
}

function startManualFlow() {
  state.editingRecipe = blankRecipeDraft();
  state.formMode = "new";
  state.screen = "recipeForm";
  render();
}

function startPhotoFlow() {
  state.editingRecipe = blankRecipeDraft();
  state.formMode = "new";
  state.screen = "recipeForm";
  render();
  // Prompt the camera/file picker right away for convenience.
  setTimeout(() => {
    const input = document.getElementById("photo-input");
    if (input) input.click();
  }, 150);
}

function startUrlFlow() {
  state.urlImportState = { url: "", loading: false, error: "" };
  state.screen = "urlImport";
  render();
}

// ---------------- URL import screen ----------------
function renderUrlImportScreen() {
  const s = state.urlImportState;
  return `
    <div class="screen">
      <div class="topbar with-back">
        <button class="icon-btn" onclick="openAddChoice()" aria-label="חזרה">→</button>
        <h1 class="app-title">ייבוא מהאינטרנט</h1>
        <span></span>
      </div>
      <div class="form-content">
        <label class="field-label">קישור למתכון</label>
        <input id="url-input" class="input" type="url" placeholder="https://..."
          value="${escapeHtml(s.url)}" oninput="state.urlImportState.url = this.value" />
        ${s.error ? `<p class="error-text">${escapeHtml(s.error)}</p>` : ""}
        <button class="btn primary full" ${s.loading ? "disabled" : ""} onclick="runUrlImport()">
          ${s.loading ? "מייבא..." : "ייבוא מתכון"}
        </button>
        <button class="btn secondary full" onclick="skipToManualWithUrl()">דילוג להזנה ידנית</button>
        <p class="hint-text">הייבוא האוטומטי עובד טוב באתרי מתכונים גדולים. אם הוא לא מצליח, אפשר להזין את המתכון ידנית ולשמור את הקישור למקור.</p>
      </div>
    </div>`;
}

async function runUrlImport() {
  const urlInput = document.getElementById("url-input");
  const url = (urlInput ? urlInput.value : state.urlImportState.url).trim();
  if (!url) return;
  state.urlImportState.url = url;
  state.urlImportState.loading = true;
  state.urlImportState.error = "";
  render();
  try {
    const draft = await RecipeImporter.importFromUrl(url);
    state.editingRecipe = Object.assign(blankRecipeDraft(), draft);
    state.formMode = "new";
    state.screen = "recipeForm";
    render();
    showToast("המתכון יובא בהצלחה - כדאי לבדוק ולערוך לפני שמירה");
  } catch (err) {
    console.warn("Recipe import failed:", err, err && err.details);
    state.urlImportState.loading = false;
    if (err && err.code === "NO_STRUCTURED_DATA") {
      state.urlImportState.error =
        "האתר נטען בהצלחה, אבל לא נמצא בו מבנה מתכון סטנדרטי - כנראה שהאתר הזה פשוט לא נתמך לייבוא אוטומטי. אפשר לעבור להזנה ידנית ולשמור את הקישור למקור.";
    } else if (err && err.code === "FETCH_FAILED") {
      state.urlImportState.error =
        "לא הצלחנו לגשת לעמוד (ייתכן שהאתר חוסם גישה אוטומטית, או ששירותי הייבוא עמוסים כרגע). אפשר לנסות שוב בעוד רגע, או לעבור להזנה ידנית.";
    } else {
      state.urlImportState.error =
        "לא הצלחנו לייבא את המתכון אוטומטית מהקישור הזה. אפשר לנסות קישור אחר או לעבור להזנה ידנית.";
    }
    render();
  }
}

function skipToManualWithUrl() {
  const url = state.urlImportState.url.trim();
  state.editingRecipe = Object.assign(blankRecipeDraft(), { sourceUrl: url });
  state.formMode = "new";
  state.screen = "recipeForm";
  render();
}

// ---------------- Recipe form (add / edit) ----------------

// Any handler in the recipe form that re-renders (e.g. adding/removing a photo)
// replaces the whole screen's HTML, which would otherwise wipe out whatever the
// user already typed in the plain text/textarea fields (they only get read into
// state.editingRecipe at save time). Call this first, before re-rendering, so a
// photo action never loses in-progress text.
function syncRecipeFormFieldsFromDom() {
  if (!state.editingRecipe) return;
  const titleEl = document.getElementById("f-title");
  const catEl = document.getElementById("f-category");
  const favEl = document.getElementById("f-favorite");
  const ingEl = document.getElementById("f-ingredients");
  const insEl = document.getElementById("f-instructions");
  const notesEl = document.getElementById("f-notes");
  if (titleEl) state.editingRecipe.title = titleEl.value;
  if (catEl) state.editingRecipe.categoryId = catEl.value || null;
  if (favEl) state.editingRecipe.favorite = favEl.checked;
  if (ingEl) state.editingRecipe.ingredients = nl2list(ingEl.value);
  if (insEl) state.editingRecipe.instructions = nl2list(insEl.value);
  if (notesEl) state.editingRecipe.notes = notesEl.value;
}

function openEditRecipe(id) {
  const recipe = state.recipes.find((r) => r.id === id);
  if (!recipe) return;
  clearStainTimer();
  state.editingRecipe = Object.assign({}, recipe, {
    ingredients: (recipe.ingredients || []).slice(),
    instructions: (recipe.instructions || []).slice(),
    processPhotos: (recipe.processPhotos || []).slice()
  });
  state.formMode = "edit";
  state.screen = "recipeForm";
  render();
}

function renderRecipeFormScreen() {
  const d = state.editingRecipe;
  const catOptions = state.categories
    .map(
      (c) =>
        `<option value="${c.id}" ${d.categoryId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`
    )
    .join("");
  const photoBlock = d.imageDataUrl
    ? `<img class="form-photo-preview" src="${d.imageDataUrl}" alt="" />
       <div class="photo-actions">
         <button class="btn secondary" onclick="document.getElementById('photo-input').click()">החלפת תמונה</button>
         <button class="btn secondary" onclick="removePhoto()">הסרת תמונה</button>
       </div>`
    : `<button class="btn secondary full" onclick="document.getElementById('photo-input').click()">📷 הוספת תמונה של המתכון המקורי</button>`;

  return `
    <div class="screen">
      <div class="topbar with-back">
        <button class="icon-btn" onclick="cancelForm()" aria-label="ביטול">✕</button>
        <h1 class="app-title">${state.formMode === "edit" ? "עריכת מתכון" : "מתכון חדש"}</h1>
        <span></span>
      </div>
      <div class="form-content">
        <input type="file" id="photo-input" accept="image/*" style="display:none"
          onchange="onPhotoSelected(event)" />
        ${photoBlock}

        <label class="field-label">כותרת המתכון *</label>
        <input id="f-title" class="input" type="text" value="${escapeHtml(d.title)}" placeholder="לדוגמה: עוגת שוקולד של סבתא" />

        <label class="field-label">קטגוריה</label>
        <select id="f-category" class="input">
          <option value="" ${!d.categoryId ? "selected" : ""}>ללא קטגוריה</option>
          ${catOptions}
        </select>

        <label class="checkbox-row">
          <input type="checkbox" id="f-favorite" ${d.favorite ? "checked" : ""} />
          סימון כמועדף ⭐
        </label>

        <label class="field-label">מרכיבים (מרכיב אחד בכל שורה)</label>
        <p class="hint-text">שורה קצרה שמסתיימת בנקודתיים (כמו "לרוטב:") תזוהה אוטומטית ככותרת חלק. אפשר גם לסמן זאת ידנית עם ##‎ (למשל "## לבצק"). לסימון מרכיב לא-חובה, להוסיף בסוף השורה (רשות)</p>
        <textarea id="f-ingredients" class="input textarea" rows="8" placeholder="## לבצק&#10;2 כוסות קמח&#10;1 ביצה&#10;&#10;## למילוי&#10;3 תפוחים&#10;1 כפית קינמון (רשות)">${escapeHtml((d.ingredients || []).join("\n"))}</textarea>

        <label class="field-label">אופן ההכנה (שלב אחד בכל שורה)</label>
        <textarea id="f-instructions" class="input textarea" rows="8" placeholder="לחמם תנור ל-180 מעלות&#10;לערבב את החומרים היבשים&#10;...">${escapeHtml((d.instructions || []).join("\n"))}</textarea>

        <label class="field-label">הוספת תמונות (רשות)</label>
        <p class="hint-text">אפשר להוסיף כמה תמונות או סרטונים שמראים את שלבי ההכנה, לפי סדר ההוספה.</p>
        <input type="file" id="process-photo-input" accept="image/*,video/*" multiple style="display:none" onchange="onProcessPhotosSelected(event)" />
        ${buildProcessPhotosFormHtml(d.processPhotos)}
        <button class="btn secondary full" onclick="document.getElementById('process-photo-input').click()">📷 הוספת תמונות</button>

        <label class="field-label">הערות</label>
        <textarea id="f-notes" class="input textarea" rows="3">${escapeHtml(d.notes || "")}</textarea>

        ${d.sourceUrl ? `<p class="hint-text">מקור: ${escapeHtml(d.sourceUrl)}</p>` : ""}

        <button class="btn primary full" onclick="saveRecipeForm()">💾 שמירת מתכון</button>
        <button class="btn secondary full" onclick="cancelForm()">ביטול</button>
      </div>
    </div>`;
}

async function onPhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    syncRecipeFormFieldsFromDom();
    state.editingRecipe.imageDataUrl = dataUrl;
    render();
  } catch (e) {
    showToast("שגיאה בטעינת התמונה", true);
  }
}

function removePhoto() {
  syncRecipeFormFieldsFromDom();
  state.editingRecipe.imageDataUrl = null;
  render();
}

function buildProcessPhotosFormHtml(photos) {
  if (!photos || !photos.length) return "";
  const items = photos
    .map((src, i) => {
      const mediaEl = isVideoDataUrl(src)
        ? `<video src="${src}" muted playsinline></video>`
        : `<img src="${src}" alt="" />`;
      return `
      <div class="process-photo-item">
        ${mediaEl}
        <button type="button" class="process-photo-remove" onclick="removeProcessPhoto(${i})" aria-label="הסרה">✕</button>
      </div>`;
    })
    .join("");
  return `<div class="process-photos-grid">${items}</div>`;
}

async function onProcessPhotosSelected(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = ""; // allow selecting the same file again later if needed
  if (!files.length) return;
  syncRecipeFormFieldsFromDom();
  if (!state.editingRecipe.processPhotos) state.editingRecipe.processPhotos = [];
  for (const file of files) {
    try {
      // Videos aren't run through the canvas resize step (that's image-only) -
      // they're stored as-is.
      const isVideo = file.type && file.type.startsWith("video/");
      const dataUrl = isVideo ? await readFileAsDataUrl(file) : await resizeImageFile(file);
      state.editingRecipe.processPhotos.push(dataUrl);
    } catch (e) {
      console.warn("Failed to add process photo:", e);
    }
  }
  render();
}

function removeProcessPhoto(index) {
  if (!state.editingRecipe.processPhotos) return;
  syncRecipeFormFieldsFromDom();
  state.editingRecipe.processPhotos.splice(index, 1);
  render();
}

function cancelForm() {
  const hasContent =
    state.editingRecipe &&
    (state.editingRecipe.title ||
      (state.editingRecipe.ingredients || []).length ||
      (state.editingRecipe.instructions || []).length ||
      (state.editingRecipe.processPhotos || []).length);
  if (hasContent && !confirm("לבטל ולאבד את השינויים שלא נשמרו?")) return;
  if (state.formMode === "edit" && state.editingRecipe.id) {
    openRecipeDetail(state.editingRecipe.id);
  } else {
    goHome();
  }
}

async function saveRecipeForm() {
  const title = document.getElementById("f-title").value.trim();
  if (!title) {
    showToast("יש להזין כותרת למתכון", true);
    return;
  }
  const categoryId = document.getElementById("f-category").value || null;
  const favorite = document.getElementById("f-favorite").checked;
  const ingredients = nl2list(document.getElementById("f-ingredients").value);
  const instructions = nl2list(document.getElementById("f-instructions").value);
  const notes = document.getElementById("f-notes").value.trim();

  const recipe = Object.assign({}, state.editingRecipe, {
    title,
    categoryId,
    favorite,
    ingredients,
    instructions,
    notes
  });

  const saved = await DB.saveRecipe(recipe);
  await refreshData();
  showToast("המתכון נשמר");
  openRecipeDetail(saved.id);
}

// ---------------- Settings screen ----------------
function openSettings() {
  state.screen = "settings";
  render();
}

function renderSettingsScreen() {
  const catRows = state.categories
    .map(
      (c) => `
      <div class="setting-cat-row">
        <input type="text" class="input" value="${escapeHtml(c.name)}"
          onchange="renameCategory('${c.id}', this.value)" />
        <button class="icon-btn danger" onclick="removeCategory('${c.id}')" aria-label="מחיקה">🗑️</button>
      </div>`
    )
    .join("");

  return `
    <div class="screen settings-screen">
      <div class="topbar">
        <h1 class="app-title">הגדרות</h1>
      </div>
      <div class="form-content">
        <div class="section">
          <h3>ניהול נושאים (קטגוריות)</h3>
          <div id="settings-cats">${catRows}</div>
          <div class="add-cat-row">
            <input id="new-cat-name" class="input" type="text" placeholder="נושא חדש" />
            <button class="btn secondary" onclick="addCategoryFromSettings()">הוספה</button>
          </div>
        </div>

        <div class="section">
          <h3>מסך פעיל</h3>
          <label class="checkbox-row">
            <input type="checkbox" id="keep-screen-on-toggle" ${state.keepScreenOnEnabled ? "checked" : ""}
              onchange="toggleKeepScreenOn(this.checked)" />
            למנוע מהמסך להיכבות בזמן שהאפליקציה פתוחה
          </label>
          <p class="hint-text">${wakeLockStatusText()}</p>
        </div>

        <div class="section">
          <h3>גיבוי ושחזור</h3>
          <p class="hint-text">כל המתכונים שמורים על הטאבלט בלבד. מומלץ לייצא גיבוי מדי פעם.</p>
          <button class="btn primary full" onclick="exportBackup()">⬇️ ייצוא גיבוי (JSON)</button>
          <label class="checkbox-row">
            <input type="checkbox" id="import-replace-mode" />
            החלפת כל הנתונים הקיימים בייבוא (במקום מיזוג)
          </label>
          <input type="file" id="import-file-input" accept="application/json" style="display:none" onchange="importBackup(event)" />
          <button class="btn secondary full" onclick="document.getElementById('import-file-input').click()">⬆️ ייבוא גיבוי</button>
        </div>

        <div class="section">
          <h3>באגים והצעות</h3>
          <p class="hint-text">מקום לרשום באגים שנתקלתם בהם או רעיונות לשיפור. הרשימה נשמרת מקומית בטאבלט, ואפשר לשלוח אותה במייל.</p>
          <div class="feedback-type-row">
            <label class="radio-inline">
              <input type="radio" name="feedback-type" value="bug" ${state.feedbackDraft.type === "bug" ? "checked" : ""}
                onchange="state.feedbackDraft.type = this.value" />
              🐛 באג
            </label>
            <label class="radio-inline">
              <input type="radio" name="feedback-type" value="suggestion" ${state.feedbackDraft.type === "suggestion" ? "checked" : ""}
                onchange="state.feedbackDraft.type = this.value" />
              💡 הצעה
            </label>
          </div>
          <textarea id="feedback-text" class="input textarea" rows="3" placeholder="מה קרה? מה הייתם רוצים שיהיה?"
            oninput="state.feedbackDraft.text = this.value">${escapeHtml(state.feedbackDraft.text)}</textarea>
          <button class="btn secondary full" onclick="addFeedbackEntry()">➕ הוספה לרשימה</button>
          ${buildFeedbackListHtml(state.feedback)}
          ${state.feedback.length ? `<button class="btn primary full" onclick="emailFeedbackList()">📤 שליחת הרשימה במייל</button>` : ""}
        </div>

        <div class="section about-section">
          <h3>אודות</h3>
          <p class="hint-text">המתכונים שלי - אפליקציה אישית לניהול מתכונים, פועלת כולה על המכשיר שלך.</p>
        </div>
      </div>
      ${renderBottomNav("settings")}
    </div>`;
}

function buildFeedbackListHtml(items) {
  if (!items || !items.length) {
    return `<p class="hint-text">עדיין לא נוספו דיווחים.</p>`;
  }
  const rows = items
    .map(
      (item) => `
      <div class="feedback-item">
        <div class="feedback-item-head">
          <span class="feedback-type-badge ${item.type === "suggestion" ? "suggestion" : "bug"}">${
        item.type === "suggestion" ? "💡 הצעה" : "🐛 באג"
      }</span>
          <span class="feedback-date">${formatDate(item.createdAt)}</span>
          <button class="icon-btn danger feedback-delete" onclick="deleteFeedbackEntry('${item.id}')" aria-label="מחיקה">🗑️</button>
        </div>
        <p class="feedback-text">${escapeHtml(item.text)}</p>
      </div>`
    )
    .join("");
  return `<div class="feedback-list">${rows}</div>`;
}

async function addFeedbackEntry() {
  const textEl = document.getElementById("feedback-text");
  const text = ((textEl ? textEl.value : state.feedbackDraft.text) || "").trim();
  if (!text) {
    showToast("יש להזין תיאור לפני ההוספה", true);
    return;
  }
  await DB.addFeedback({ type: state.feedbackDraft.type, text });
  state.feedbackDraft = { type: "bug", text: "" };
  state.feedback = await DB.getAllFeedback();
  render();
  showToast("נוסף לרשימה");
}

async function deleteFeedbackEntry(id) {
  await DB.deleteFeedback(id);
  state.feedback = await DB.getAllFeedback();
  render();
  showToast("הדיווח נמחק");
}

function emailFeedbackList() {
  const typeLabel = (t) => (t === "suggestion" ? "הצעה" : "באג");
  const body = state.feedback
    .map((item) => `[${typeLabel(item.type)}] ${formatDate(item.createdAt)}\n${item.text}`)
    .join("\n\n---\n\n");
  const subject = "המתכונים שלי - באגים והצעות";
  const mailto = `mailto:sommerelad@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
}

function wakeLockStatusText() {
  if (!state.keepScreenOnEnabled) return "כבוי - המסך יוכל להיכבות כרגיל.";
  switch (state.wakeLockStatus) {
    case "active":
      return "פעיל ✅ - המסך יישאר דלוק כל עוד האפליקציה פתוחה.";
    case "unsupported":
      return "הדפדפן הזה לא תומך בתכונה זו.";
    case "failed":
      return "לא הצלחנו להפעיל את נעילת המסך (ודאו שהאפליקציה נפתחת מכתובת https://).";
    case "released":
      return "המתנה... ננעל שוב אוטומטית כשהמסך יהיה פעיל.";
    default:
      return "בודק זמינות...";
  }
}

async function toggleKeepScreenOn(checked) {
  state.keepScreenOnEnabled = checked;
  await DB.setMeta("keepScreenOnEnabled", checked);
  WakeLockManager.setEnabled(checked);
  render();
}

async function renameCategory(id, name) {
  const cat = state.categories.find((c) => c.id === id);
  if (!cat) return;
  cat.name = name.trim() || cat.name;
  await DB.updateCategory(cat);
  await refreshData();
  showToast("הנושא עודכן");
}

async function removeCategory(id) {
  if (!confirm("למחוק את הנושא? מתכונים שהיו בנושא זה יהפכו ל'ללא קטגוריה'.")) return;
  await DB.deleteCategory(id);
  await refreshData();
  render();
}

async function addCategoryFromSettings() {
  const input = document.getElementById("new-cat-name");
  const name = input.value.trim();
  if (!name) return;
  await DB.addCategory(name);
  await refreshData();
  render();
}

async function exportBackup() {
  const data = await DB.exportAllData();
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadBlob(JSON.stringify(data, null, 2), `recipes-backup-${dateStr}.json`, "application/json");
  showToast("קובץ הגיבוי הורד");
}

async function importBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const replace = document.getElementById("import-replace-mode").checked;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (replace && !confirm("פעולה זו תמחק את כל המתכונים והנושאים הקיימים ותחליף אותם בגיבוי. להמשיך?")) {
      return;
    }
    const result = await DB.importAllData(json, { mode: replace ? "replace" : "merge" });
    await refreshData();
    showToast(`יובאו ${result.recipes} מתכונים ו-${result.categories} נושאים`);
    render();
  } catch (e) {
    console.warn(e);
    showToast("שגיאה בייבוא הקובץ - ודאו שזהו קובץ גיבוי תקין", true);
  }
}
