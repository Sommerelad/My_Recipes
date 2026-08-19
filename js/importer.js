// importer.js - fetch a recipe web page (via a public CORS proxy, since almost no
// recipe site allows direct cross-origin fetch) and try to auto-extract a recipe
// from its schema.org "Recipe" structured data (JSON-LD), which the large majority
// of recipe sites embed for Google's rich-snippet support.
//
// If extraction fails for any reason, the caller should fall back to manual entry
// with the URL pre-filled as the source.

const RecipeImporter = (() => {
  // Try a couple of public CORS proxies in order, in case one is down/rate-limited.
  const PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
  ];

  async function fetchHtml(url) {
    let lastErr;
    for (const buildProxyUrl of PROXIES) {
      try {
        const res = await fetch(buildProxyUrl(url), { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        if (text && text.length > 200) return text;
        throw new Error("empty response");
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("לא ניתן להוריד את הדף");
  }

  function textFromInstructionItem(item) {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      if (item["@type"] === "HowToSection" && Array.isArray(item.itemListElement)) {
        return item.itemListElement.map(textFromInstructionItem).join("\n");
      }
      if (item.text) return item.text;
      if (item.name) return item.name;
    }
    return "";
  }

  function normalizeInstructions(raw) {
    if (!raw) return [];
    if (typeof raw === "string") {
      // Sometimes it's one big string; split on periods/newlines heuristically.
      return raw
        .split(/\r?\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(raw)) {
      return raw
        .map(textFromInstructionItem)
        .flatMap((s) => s.split(/\r?\n+/))
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }

  function normalizeIngredients(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
    if (typeof raw === "string") {
      return raw.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }

  function extractImageUrl(raw) {
    if (!raw) return null;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return extractImageUrl(raw[0]);
    if (typeof raw === "object" && raw.url) return raw.url;
    return null;
  }

  function findRecipeNode(json) {
    const candidates = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const type = node["@type"];
      const isRecipe = type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
      if (isRecipe) candidates.push(node);
      if (Array.isArray(node["@graph"])) node["@graph"].forEach(walk);
    }
    walk(json);
    return candidates[0] || null;
  }

  function parseJsonLdRecipe(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent);
        const node = findRecipeNode(json);
        if (node) return node;
      } catch (e) {
        // Malformed JSON-LD on this script tag; try the next one.
      }
    }
    return null;
  }

  async function imageUrlToDataUrl(url) {
    try {
      const res = await fetch(PROXIES[0](url), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error("bad image response");
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  async function importFromUrl(url) {
    const html = await fetchHtml(url);
    const node = parseJsonLdRecipe(html);
    if (!node) {
      const err = new Error("לא נמצא מבנה מתכון מובנה בדף הזה");
      err.code = "NO_STRUCTURED_DATA";
      throw err;
    }

    const draft = {
      title: node.name || "",
      ingredients: normalizeIngredients(node.recipeIngredient || node.ingredients),
      instructions: normalizeInstructions(node.recipeInstructions),
      notes: node.description || "",
      sourceUrl: url,
      imageDataUrl: null
    };

    const imgUrl = extractImageUrl(node.image);
    if (imgUrl) {
      draft.imageDataUrl = await imageUrlToDataUrl(imgUrl);
    }

    return draft;
  }

  return { importFromUrl };
})();
