// ─────────────────────────────────────────────
//  Canadian American Market — Market Watch
//  API Proxy (Vercel Serverless Function)
//  Dépendances : ANTHROPIC_API_KEY, SERPER_API_KEY,
//                FIREBASE_API_KEY, FIREBASE_PROJECT_ID
// ─────────────────────────────────────────────

const FIREBASE_BASE = (project) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

// ── Firebase REST ──────────────────────────
async function fbGet(base, path, key) {
  try {
    const r = await fetch(`${base}/${path}?key=${key}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fbSet(base, path, data, key) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string")       fields[k] = { stringValue: v };
    else if (typeof v === "number")  fields[k] = { integerValue: v };
    else if (Array.isArray(v))       fields[k] = { arrayValue: { values: v.map(s => ({ stringValue: String(s) })) } };
  }
  try {
    await fetch(`${base}/${path}?key=${key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });
  } catch {}
}

async function fbAdd(base, col, data, key) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string")      fields[k] = { stringValue: v };
    else if (typeof v === "number") fields[k] = { integerValue: v };
    else                            fields[k] = { stringValue: JSON.stringify(v) };
  }
  try {
    await fetch(`${base}/${col}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });
  } catch {}
}

// ── Serper helpers ─────────────────────────
async function serperSearch(query, serperKey, num = 5) {
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num, gl: "us" }),
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.organic || []).slice(0, 3);
  } catch { return []; }
}

async function serperImage(query, serperKey) {
  try {
    const r = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 3 }),
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    const d = await r.json();
    const images = d.images || [];
    return images.find(img => img.imageUrl?.match(/\.(jpg|jpeg|png|webp)/i))?.imageUrl
      || images[0]?.imageUrl
      || null;
  } catch { return null; }
}

// ── Sources spécialisées ───────────────────
const SOURCES = [
  "site:bevindustry.com new beverage launch 2026",
  "site:beveragedaily.com new drink product 2026",
  "site:fooddive.com new beverage launch 2026",
  "site:just-drinks.com new product launch 2026",
  "site:bevnet.com new product 2026",
  "site:sodaspectrum.com new soda 2026",
  "new snack food launch USA Canada 2026",
  "new candy beverage North America 2026"
];

// ── Handler principal ──────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { ANTHROPIC_API_KEY: anthropicKey, SERPER_API_KEY: serperKey,
          FIREBASE_API_KEY: fbKey, FIREBASE_PROJECT_ID: fbProject = "canadian-american-stock" } = process.env;

  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });

  try {
    const today = new Date().toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
    const fbBase = FIREBASE_BASE(fbProject);

    // 1. Historique Firebase : date + titres déjà vus
    let lastDate = null, seenTitles = [];
    if (fbKey) {
      const meta = await fbGet(fbBase, "market_watch_meta/last_journal", fbKey);
      if (meta?.fields) {
        lastDate = meta.fields.date?.stringValue || null;
        seenTitles = (meta.fields.titles?.arrayValue?.values || []).map(v => v.stringValue);
      }
    }

    const sinceText = lastDate
      ? `Cherche UNIQUEMENT les produits lancés APRÈS le ${lastDate}. Exclus : ${seenTitles.slice(0, 15).join(", ")}.`
      : "Priorité aux lancements 2025-2026.";

    // 2. Recherche web sur les sources spécialisées
    let webContext = "";
    if (serperKey) {
      const results = await Promise.all(SOURCES.map(q => serperSearch(q, serperKey)));
      webContext = results.flat()
        .slice(0, 20) // Max 20 résultats
        .map(i => `- ${i.title}: ${(i.snippet||"").substring(0, 120)}`) // Pas d URL, pas de guillemets
        .join("\n")
        .replace(/[{}\[\]]/g, "") // Supprimer les caractères JSON
        .substring(0, 3000); // Limiter à 3000 caractères max
    }

    // 3. Génération Claude
    const prompt = `Tu es un expert en veille de marché pour les épiceries fines nord-américaines.

${webContext ? `Actualités récentes (2025-2026) :\n${webContext}\n\n` : ""}${sinceText}

Identifie 15 à 25 vraies nouveautés récentes (boissons, snacks, épicerie, tendances) pour Canadian American Market — épicerie fine à Vevey et Genève Eaux-Vives, Suisse.

Réponds UNIQUEMENT avec du JSON valide, sans backticks :
{"edition":"${today}","produits":[{"titre":"Nom","marque":"Marque","pays":"Canada ou USA","categorie":"boissons","date_lancement":"saison année","description":"2-3 phrases en français","interet":"1 phrase pour Genève/Vevey","source":"nom site"}]}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });

    if (!claudeRes.ok) return res.status(claudeRes.status).json(await claudeRes.json().catch(() => ({})));

    const claudeData = await claudeRes.json();

    // 4. Parser le JSON retourné par Claude
    let parsedEdition = {}, products = [];
    try {
      const raw = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim().replace(/```json|```/g, "").trim();
      const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        parsedEdition = JSON.parse(raw.substring(start, end + 1));
        products = parsedEdition.produits || [];
      }
    } catch(e) {
      return res.status(200).json(claudeData);
    }

    // 5. Images produits via Serper
    if (serperKey && products.length) {
      const imageUrls = await Promise.all(
        products.map(p => serperImage(`${p.titre} ${p.marque} product packaging`, serperKey))
      );
      parsedEdition.produits = products.map((p, i) => ({ ...p, image_url: imageUrls[i] || null }));
      products = parsedEdition.produits;
    }

    // 6. Sauvegarder dans Firebase
    if (fbKey && products.length) {
      const nowStr = new Date().toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
      await fbSet(fbBase, "market_watch_meta/last_journal", {
        date: nowStr,
        titles: [...seenTitles, ...products.map(p => p.titre)].slice(-100),
        count: products.length
      }, fbKey);
      await fbAdd(fbBase, "market_watch_journals", {
        edition: parsedEdition.edition || today,
        count: products.length,
        timestamp: Date.now(),
        data: JSON.stringify(parsedEdition)
      }, fbKey);
    }

    parsedEdition.last_search_date = lastDate;

    return res.status(200).json({
      ...claudeData,
      content: [{ type: "text", text: JSON.stringify(parsedEdition) }]
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
