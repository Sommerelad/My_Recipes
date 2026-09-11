// db.js - IndexedDB data layer for "המתכונים שלי"
// Exposes a global `DB` object with async methods for categories, recipes, meta,
// and full export/import (JSON) for backup.

const DB = (() => {
  const DB_NAME = "recipesAppDB";
  const DB_VERSION = 2;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("categories")) {
          const catStore = db.createObjectStore("categories", { keyPath: "id" });
          catStore.createIndex("order", "order", { unique: false });
        }
        if (!db.objectStoreNames.contains("recipes")) {
          const recStore = db.createObjectStore("recipes", { keyPath: "id" });
          recStore.createIndex("categoryId", "categoryId", { unique: false });
          recStore.createIndex("favorite", "favorite", { unique: false });
          recStore.createIndex("updatedAt", "updatedAt", { unique: false });
          recStore.createIndex("title", "title", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        // Added in DB_VERSION 2: a local log of bug reports / feature suggestions,
        // written from the "באגים והצעות" section in Settings.
        if (!db.objectStoreNames.contains("feedback")) {
          const fbStore = db.createObjectStore("feedback", { keyPath: "id" });
          fbStore.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  // ---------- Categories ----------
  async function getAllCategories() {
    const store = await tx("categories", "readonly");
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async function addCategory(name) {
    const store = await tx("categories", "readwrite");
    const all = await reqToPromise(store.getAll());
    const cat = { id: uuid(), name: name.trim(), order: all.length };
    await reqToPromise(store.add(cat));
    return cat;
  }

  async function updateCategory(cat) {
    const store = await tx("categories", "readwrite");
    await reqToPromise(store.put(cat));
  }

  async function deleteCategory(id) {
    const store = await tx("categories", "readwrite");
    await reqToPromise(store.delete(id));
    // Unassign recipes that were in this category
    const recStore = await tx("recipes", "readwrite");
    const all = await reqToPromise(recStore.getAll());
    for (const r of all) {
      if (r.categoryId === id) {
        r.categoryId = null;
        recStore.put(r);
      }
    }
  }

  async function reorderCategories(orderedIds) {
    const store = await tx("categories", "readwrite");
    for (let i = 0; i < orderedIds.length; i++) {
      const cat = await reqToPromise(store.get(orderedIds[i]));
      if (cat) {
        cat.order = i;
        store.put(cat);
      }
    }
  }

  // ---------- Recipes ----------
  async function getAllRecipes() {
    const store = await tx("recipes", "readonly");
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function getRecipe(id) {
    const store = await tx("recipes", "readonly");
    return reqToPromise(store.get(id));
  }

  async function saveRecipe(recipe) {
    const now = Date.now();
    if (!recipe.id) {
      recipe.id = uuid();
      recipe.createdAt = now;
    }
    recipe.updatedAt = now;
    if (typeof recipe.favorite !== "boolean") recipe.favorite = false;
    const store = await tx("recipes", "readwrite");
    await reqToPromise(store.put(recipe));
    return recipe;
  }

  async function deleteRecipe(id) {
    const store = await tx("recipes", "readwrite");
    await reqToPromise(store.delete(id));
  }

  async function toggleFavorite(id) {
    const store = await tx("recipes", "readwrite");
    const recipe = await reqToPromise(store.get(id));
    if (!recipe) return null;
    recipe.favorite = !recipe.favorite;
    recipe.updatedAt = Date.now();
    await reqToPromise(store.put(recipe));
    return recipe;
  }

  // ---------- Meta / settings ----------
  async function getMeta(key) {
    const store = await tx("meta", "readonly");
    const rec = await reqToPromise(store.get(key));
    return rec ? rec.value : undefined;
  }

  async function setMeta(key, value) {
    const store = await tx("meta", "readwrite");
    await reqToPromise(store.put({ key, value }));
  }

  // ---------- Feedback (bug reports / suggestions) ----------
  async function getAllFeedback() {
    const store = await tx("feedback", "readonly");
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function addFeedback({ type, text }) {
    const store = await tx("feedback", "readwrite");
    const entry = { id: uuid(), type: type === "suggestion" ? "suggestion" : "bug", text: String(text || "").trim(), createdAt: Date.now() };
    await reqToPromise(store.add(entry));
    return entry;
  }

  async function deleteFeedback(id) {
    const store = await tx("feedback", "readwrite");
    await reqToPromise(store.delete(id));
  }

  // ---------- Export / Import (backup) ----------
  async function exportAllData() {
    const [categories, recipes, feedback] = await Promise.all([
      getAllCategories(),
      getAllRecipes(),
      getAllFeedback()
    ]);
    return {
      appName: "המתכונים שלי",
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      categories,
      recipes,
      feedback
    };
  }

  function normalizeCategoryName(name) {
    return String(name || "").trim().toLowerCase();
  }

  async function importAllData(data, { mode = "merge" } = {}) {
    if (!data || !Array.isArray(data.categories) || !Array.isArray(data.recipes)) {
      throw new Error("קובץ הגיבוי אינו תקין");
    }

    if (mode === "replace") {
      const catStore = await tx("categories", "readwrite");
      await reqToPromise(catStore.clear());
      for (const cat of data.categories) {
        catStore.put(cat);
      }
      // Open each store's transaction fresh, right before using it - an IndexedDB
      // transaction can auto-commit if it sits idle (no pending request) while
      // other awaited work happens on a different transaction.
      const recStore = await tx("recipes", "readwrite");
      await reqToPromise(recStore.clear());
      for (const rec of data.recipes) {
        recStore.put(rec);
      }
      const fbStore = await tx("feedback", "readwrite");
      await reqToPromise(fbStore.clear());
      for (const fb of data.feedback || []) {
        fbStore.put(fb);
      }
      return { categories: data.categories.length, recipes: data.recipes.length };
    }

    // Merge mode: importing a backup should not create duplicate categories
    // when a category with the same name already exists locally (which happens
    // whenever the imported categories were created with different ids than the
    // ones already on this device/browser - e.g. re-importing your own backup,
    // or importing on a device where initial setup already created the same
    // default topics). Match existing categories by (trimmed, case-insensitive)
    // name, and remap any recipe.categoryId references accordingly.
    const catStore = await tx("categories", "readwrite");
    const existingCats = await reqToPromise(catStore.getAll());
    const byName = new Map(existingCats.map((c) => [normalizeCategoryName(c.name), c]));
    let nextOrder = existingCats.length;
    const idRemap = new Map();
    let addedCategories = 0;

    for (const cat of data.categories || []) {
      const key = normalizeCategoryName(cat.name);
      const existing = byName.get(key);
      if (existing) {
        idRemap.set(cat.id, existing.id);
      } else {
        const newCat = { id: cat.id, name: String(cat.name || "").trim(), order: cat.order ?? nextOrder++ };
        catStore.put(newCat);
        byName.set(key, newCat);
        idRemap.set(cat.id, cat.id);
        addedCategories++;
      }
    }

    // Open the recipes transaction fresh, right before using it (see note above).
    const recStore = await tx("recipes", "readwrite");
    for (const rec of data.recipes || []) {
      const categoryId = rec.categoryId ? (idRemap.get(rec.categoryId) ?? rec.categoryId) : rec.categoryId;
      recStore.put(Object.assign({}, rec, { categoryId }));
    }

    // Feedback entries are just an append-only personal log - no name-based
    // matching needed, put-by-id already avoids duplicates on a re-import.
    const fbStore = await tx("feedback", "readwrite");
    for (const fb of data.feedback || []) {
      fbStore.put(fb);
    }

    return { categories: addedCategories, recipes: (data.recipes || []).length };
  }

  return {
    uuid,
    getAllCategories,
    addCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    getAllRecipes,
    getRecipe,
    saveRecipe,
    deleteRecipe,
    toggleFavorite,
    getMeta,
    setMeta,
    getAllFeedback,
    addFeedback,
    deleteFeedback,
    exportAllData,
    importAllData
  };
})();
