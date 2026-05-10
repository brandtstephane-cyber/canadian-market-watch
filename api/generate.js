export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  const fbKey = process.env.FIREBASE_API_KEY;
  const fbProject = process.env.FIREBASE_PROJECT_ID || "canadian-american-stock";

  if (!anthropicKey) return res.status(500).json({ error: "API key not configured" });

  // Firebase REST helpers
  const fbBase = `https://firestore.googleapis.com/v1/projects/${fbProject}/databases/(default)/documents`;

  async function fbGet(path) {
    if (!fbKey) return null;
    try {
      const r = await fetch(`${fbBase}/${path}?key=${fbKey}`);
      if (!r.ok) return null;
      return await r.json();
    } catch(e) { return null; }
  }

  async function fbSet(path, data) {
    if (!fbKey) return;
    try {
      const fields = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") fields[k] = { stringValue: v };
        else if (typeof v === "number") fields[k] = { integerValue: v };
        else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(s => ({ stringValue: String(s) })) } };
      }
      await fetch(`${fbBase}/${path}?key=${fbKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
      });
    } catch(e) {}
  }

  async function fbAdd(collectionPath, data) {
    if (!fbKey) return;
    try {
      const fields = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") fields[k] = { stringValue: v };
        else if (typeof v === "number") fields[k] = { integerValue: v };
        else if (typeof v === "object" && v !== null) fields[k] = { stringValue: JSON.stringify(v) };
      }
      await fetch(`${fbBase}/${collectionPath}?key=${fbKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
      });
    } catch(e) {}
  }

  try {
    const today = new Date().toLocaleDateString("fr-CA", { month: "long", year: "numeric" });

    // 1. Récupérer dernière date depuis Firebase
    let lastDate = null;
    let seenTitles = [];
    const meta = await fbGet("market_watch_meta/last_journal");
    if (meta?.fields) {
      lastDate = meta.fields.date?.stringValue || null;
      seenTitles = (meta.fields.titles?.arrayValue?.values || []).map(v => v.stringValue);
    }

    const sinceText = lastDate
      ? `Cherche UNIQUEMENT les produits lancés ou annoncés APRÈS le ${lastDate}. Ne répète pas : ${seenTitles.slice(0, 15).join(", ")}.`
      : "Cherche les produits les plus récents de 2025-2026.";

    // 2. Recherche web via Serper
    const SOURCES = [
      "site:bevindustry.com new beverage launch 2026",
      "site:beveragedaily.com new drink product 2026",
      "site:fooddive.com new beverage launch 2026",
      "site:just-drinks.com new product launch 2026",
      "site:bevnet.com new product 2026",
      "site:sodaspectrum.com new soda 2026",
      "new snack food launch USA Canada 2026",
      "new candy beverage North America spring 2026"
    ];

    let webContext = "";
    if (serperKey) {
      const searchPromises = SOURCES.map(async (q) => {
        try {
          const r = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q, num: 5, gl: "us" }),
            signal: AbortSignal.timeout(5000)
          });
          if (!r.ok) return "";
          const d = await r.json();
          return (d.organic || []).slice(0, 3).map(i => `[${i.link}] ${i.title}: ${i.snippet}`).join("\n");
        } catch(e) { return ""; }
      });
      const results = await Promise.all(searchPromises);
      webContext = results.filter(Boolean).join("\n\n");
    }

    // 3. Générer avec Claude
    const prompt = `Tu es un expert en veille de marché pour les épiceries fines nord-américaines.

${webContext ? `Informations récentes trouvées sur le web :\n\n${webContext}\n\n` : ""}

${sinceText}

Identifie entre 15 et 25 vraies nouveautés récentes du marché alimentaire nord-américain (boissons, snacks, épicerie, tendances).

Ces produits sont pour Canadian American Market, épicerie fine à Vevey et Genève Eaux-Vives, Suisse.

Réponds UNIQUEMENT avec JSON valide sans backticks :
{"edition":"${today}","produits":[{"titre":"Nom","marque":"Marque","pays":"Canada ou USA","categorie":"boissons","date_lancement":"saison année","description":"2-3 phrases en français","interet":"1 phrase pour Genève/Vevey","source":"nom site source"}]}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json(err);
    }

    const claudeData = await claudeRes.json();

    // 4. Parser
    let products = [];
    let parsedEdition = {};
    try {
      let raw = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      raw = raw.replace(/```json|```/g, "").trim();
      // Trouver le JSON le plus proprement possible
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        const jsonStr = raw.substring(start, end + 1);
        parsedEdition = JSON.parse(jsonStr);
        products = parsedEdition.produits || [];
      }
    } catch(e) {
      console.error("JSON parse error:", e.message);
      return res.status(200).json(claudeData);
    }

    // 5. Images
    if (serperKey && products.length) {
      const imagePromises = products.map(async (product) => {
        try {
          const imgRes = await fetch("https://google.serper.dev/images", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: `${product.titre} ${product.marque} product packaging`, num: 3 }),
            signal: AbortSignal.timeout(5000)
          });
          if (!imgRes.ok) return null;
          const imgData = await imgRes.json();
          const images = imgData.images || [];
          for (const img of images) {
            if (img.imageUrl && img.imageUrl.match(/\.(jpg|jpeg|png|webp)/i)) return img.imageUrl;
          }
          return images[0]?.imageUrl || null;
        } catch(e) { return null; }
      });
      const imageUrls = await Promise.all(imagePromises);
      parsedEdition.produits = products.map((p, i) => ({ ...p, image_url: imageUrls[i] || null }));
    }

    // 6. Sauvegarder dans Firebase
    if (fbKey && products.length) {
      const nowStr = new Date().toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
      const newTitles = [...seenTitles, ...products.map(p => p.titre)].slice(-100);
      await fbSet("market_watch_meta/last_journal", { date: nowStr, titles: newTitles, count: products.length });
      await fbAdd("market_watch_journals", { edition: parsedEdition.edition || today, count: products.length, timestamp: Date.now(), data: JSON.stringify(parsedEdition) });
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
