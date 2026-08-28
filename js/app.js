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
  wakeLockStatus: "unknown"
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

  WakeLockManager.onStatusChange((status) => {
    state.wakeLockStatus = status;
    if (state.screen === "settings") render();
  });
  WakeLockManager.init(state.keepScreenOnEnabled);

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
        <input id="search-input" class="input search-input" type="search"
          placeholder="חיפוש מתכון, מרכיב או קטגוריה..."
          value="${escapeHtml(state.filter.query)}"
          oninput="onSearchInput(this.value)" />
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
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <p>לא נמצאו מתכונים.</p>
      <p>אפשר להוסיף מתכון חדש בלחיצה על +</p>
    </div>`;
    return;
  }
  container.innerHTML = filtered.map(buildRecipeCardHTML).join("");
}

function buildRecipeCardHTML(recipe) {
  const thumb = recipe.imageDataUrl
    ? `<img class="card-thumb" src="${recipe.imageDataUrl}" alt="" />`
    : `<div class="card-thumb placeholder">🍲</div>`;
  return `
    <div class="recipe-card" onclick="openRecipeDetail('${recipe.id}')">
      ${thumb}
      <div class="card-body">
        <div class="card-title">${escapeHtml(recipe.title || "(ללא כותרת)")}</div>
        <div class="card-meta">
          <span class="badge">${escapeHtml(categoryName(recipe.categoryId))}</span>
          ${recipe.favorite ? '<span class="fav-star">⭐</span>' : ""}
        </div>
      </div>
    </div>`;
}

// ---------------- Recipe detail screen ----------------
function openRecipeDetail(id) {
  state.currentRecipeId = id;
  state.screen = "recipeDetail";
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
        ${notes}
        ${source}
        <p class="meta-line">עודכן לאחרונה: ${formatDate(recipe.updatedAt)}</p>
      </div>
      <div class="detail-actions">
        <button class="btn secondary" onclick="openEditRecipe('${recipe.id}')">✏️ עריכה</button>
        <button class="btn danger" onclick="confirmDeleteRecipe('${recipe.id}')">🗑️ מחיקה</button>
      </div>
    </div>`;
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
    imageDataUrl: null
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
function openEditRecipe(id) {
  const recipe = state.recipes.find((r) => r.id === id);
  if (!recipe) return;
  state.editingRecipe = Object.assign({}, recipe, {
    ingredients: (recipe.ingredients || []).slice(),
    instructions: (recipe.instructions || []).slice()
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
        <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none"
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
    state.editingRecipe.imageDataUrl = dataUrl;
    render();
  } catch (e) {
    showToast("שגיאה בטעינת התמונה", true);
  }
}

function removePhoto() {
  state.editingRecipe.imageDataUrl = null;
  render();
}

function cancelForm() {
  const hasContent =
    state.editingRecipe &&
    (state.editingRecipe.title ||
      (state.editingRecipe.ingredients || []).length ||
      (state.editingRecipe.instructions || []).length);
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

        <div class="section about-section">
          <h3>אודות</h3>
          <p class="hint-text">המתכונים שלי - אפליקציה אישית לניהול מתכונים, פועלת כולה על המכשיר שלך.</p>
        </div>
      </div>
      ${renderBottomNav("settings")}
    </div>`;
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
